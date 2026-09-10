from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import random
import asyncio
import httpx
import secrets
import hashlib
import pymongo
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal, Dict
import uuid
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt
import json
import sys

# Ensure backend directory is in sys.path for local and external module resolution
_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

try:
    from sms_service import send_appointment_sms, send_otp_sms, get_app_public_url, format_renflair_hour
except ImportError:
    from backend.sms_service import send_appointment_sms, send_otp_sms, get_app_public_url, format_renflair_hour

try:
    from rate_limiter import (
        enforce_booking_rate_limit,
        enforce_send_otp_rate_limit,
        enforce_verify_otp_rate_limit,
        enforce_send_sms_cooldown,
        enforce_general_ip_rate_limit,
        get_client_ip,
    )
except ImportError:
    from backend.rate_limiter import (
        enforce_booking_rate_limit,
        enforce_send_otp_rate_limit,
        enforce_verify_otp_rate_limit,
        enforce_send_sms_cooldown,
        enforce_general_ip_rate_limit,
        get_client_ip,
    )

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
client = AsyncIOMotorClient(
    mongo_url,
    serverSelectionTimeoutMS=2000,
    connectTimeoutMS=2000,
)
db = client[os.environ["DB_NAME"]]

JWT_SECRET = os.environ.get("JWT_SECRET", "clinicqueue-secret-key-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXP_SECONDS = 60 * 60 * 24 * 7  # 7 days (default for patient/doctor)
JWT_EXP_SECONDS_RECEPTION = 60 * 60 * 24 * 90  # 90 days for receptionist (login-once)
OTP_EXP_SECONDS = 300  # OTP valid for 5 minutes

# Minimum patient age accepted for self-registration. Below this a guardian is required.
MIN_PATIENT_AGE = 18

# OTP rate limit: per-mobile requests window
OTP_RATE_WINDOW_SECONDS = 600  # 10 min
OTP_RATE_MAX_REQUESTS = 5

# Current privacy notice version. Bump when the notice changes.
PRIVACY_NOTICE_VERSION = "2026-02-1"

# ============ EMERGENT PUSH SETUP ============
PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: Restrict this to the production frontend URL before launch
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api_router = APIRouter(prefix="/api")
security = HTTPBearer(auto_error=False)

@app.middleware("http")
async def general_rate_limit_middleware(request: Request, call_next):
    # Only enforce on /api routes, skip websockets and health checks
    path = request.url.path
    if path.startswith("/api/") and not path.startswith("/api/ws/") and not path == "/health":
        enforce_general_ip_rate_limit(request)
    response = await call_next(request)
    return response


def hash_otp(otp: str, mobile: str) -> str:
    """Securely hash OTP with normalized mobile as salt using SHA-256."""
    return hashlib.sha256(f"{otp.strip()}:{mobile.strip()}:{JWT_SECRET}".encode()).hexdigest()


# In-memory OTP storage (OTPs are NEVER persisted to MongoDB)
_otp_store: Dict[str, dict] = {}


def save_memory_otp(mobile: str, otp: str, expires_in_sec: int = OTP_EXP_SECONDS):
    """Save OTP hash securely in-memory only (never persisted to MongoDB)."""
    norm = normalize_mobile(mobile)
    exp = (datetime.now(timezone.utc) + timedelta(seconds=expires_in_sec)).isoformat()
    _otp_store[norm] = {
        "mobile": norm,
        "otp_hash": hash_otp(otp, norm),
        "expires_at": exp,
        "attempts": 0,
        "created_at": now_iso(),
    }


@app.on_event("startup")
async def ensure_db_indexes():
    """Create indexes for all frequently-queried fields.
    create_index is idempotent — safe to run on every startup.
    """
    try:
        await asyncio.gather(
            # users
            db.users.create_index([("firebase_uid", 1)], sparse=True),
            db.users.create_index([("mobile", 1)]),
            db.users.create_index([("email", 1)]),
            db.users.create_index([("role", 1)]),
            # appointments — most queries filter by doctor_id + date
            db.appointments.create_index([("doctor_id", 1), ("date", 1), ("status", 1)]),
            db.appointments.create_index([("patient_id", 1), ("created_at", -1)]),
            db.appointments.create_index([("id", 1)], unique=True),
            db.appointments.create_index([("secure_token", 1)], unique=True, sparse=True),
            # Atomic concurrency protection: 1 active appointment per verified mobile per calendar day
            db.appointments.create_index(
                [("patient_mobile", 1), ("date", 1)],
                unique=True,
                partialFilterExpression={
                    "status": {"$in": ["booked", "arrived", "in_consultation", "completed", "skipped"]},
                    "patient_mobile": {"$type": "string", "$gt": ""}
                }
            ),
            # doctors
            db.doctors.create_index([("id", 1)], unique=True),
            db.doctors.create_index([("user_id", 1)]),
            db.doctors.create_index([("specialty", 1)]),
            db.doctors.create_index([("city", 1)]),
        )
    except Exception:
        pass


@app.get("/")
async def root():
    return {
        "status": "online",
        "service": "ClinicQueue API",
        "docs_url": "/docs",
        "health_check": "/health"
    }


@app.get("/health")
async def health_check():
    try:
        await client.admin.command("ping")
        return {"status": "ok", "database": "connected"}
    except Exception:
        return {"status": "degraded", "database": "unavailable"}

Role = Literal["patient", "doctor", "receptionist", "owner", "admin"]


# ============ MODELS ============
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    role: Role
    phone: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str
    hospital_code: Optional[str] = None
    hospital_id: Optional[str] = None
    role: Optional[str] = None


class UserPublic(BaseModel):
    id: str
    email: Optional[str] = None
    full_name: str
    role: str
    phone: Optional[str] = None
    mobile: Optional[str] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    hospital_id: Optional[str] = None


class DoctorProfile(BaseModel):
    id: str
    user_id: str
    full_name: str
    specialty: str
    city: str
    clinic_name: str
    fees: int
    timings: str
    rating: float = 4.7
    photo: Optional[str] = None
    bio: Optional[str] = None
    status: str = "active"  # active, paused, break, emergency


class ValidateHospitalIdBody(BaseModel):
    hospital_id: str


class HospitalLoginBody(BaseModel):
    hospital_id: str
    email: EmailStr
    password: str


class DoctorAddReceptionistBody(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    phone: Optional[str] = None
    mobile: Optional[str] = None


class AddReceptionistBody(BaseModel):
    full_name: str
    mobile: str
    email: Optional[EmailStr] = None


class AppointmentCreate(BaseModel):
    doctor_id: str
    date: str  # YYYY-MM-DD
    slot: Optional[str] = "Token Booking"  # optional for backward compatibility
    payment_method: str = "pay_at_clinic"  # or "online"


class Appointment(BaseModel):
    id: str
    doctor_id: str
    doctor_name: str
    patient_id: str
    patient_name: str
    patient_mobile: Optional[str] = None
    date: str
    slot: str
    token_number: int
    status: str = "booked"  # booked, arrived, in_consultation, completed, cancelled, skipped
    payment_method: str
    payment_status: str = "pending"
    prescription: Optional[str] = None
    created_at: str


class QueueActionBody(BaseModel):
    appointment_id: str


class ReorderBody(BaseModel):
    appointment_id: str
    new_position: int


class DoctorStatusBody(BaseModel):
    status: str  # active, paused, break, emergency


class PrescriptionBody(BaseModel):
    appointment_id: str
    prescription: str


# ---- Mobile OTP Auth models ----
class SendOTPBody(BaseModel):
    mobile: str


class VerifyOTPBody(BaseModel):
    mobile: str
    otp: str
    full_name: Optional[str] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    # DPDP: explicit consent must be captured for new-user signup
    consent_privacy: Optional[bool] = None
    consent_version: Optional[str] = None


class AddPatientBody(BaseModel):
    full_name: str
    mobile: str
    age: Optional[int] = None
    gender: Optional[str] = None
    symptoms: Optional[str] = None
    address: Optional[str] = None
    doctor_id: Optional[str] = None  # if provided, auto-book appointment
    slot: Optional[str] = None
    date: Optional[str] = None  # YYYY-MM-DD, defaults to today
    payment_method: Optional[str] = "pay_at_clinic"


# ---- Owner: Doctor management models ----
class OwnerAddDoctorBody(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    phone: Optional[str] = None
    mobile: Optional[str] = None
    address: Optional[str] = None
    specialty: str
    degree: Optional[str] = None  # e.g. "MBBS, MD"
    experience_years: Optional[int] = None
    clinic_name: str
    city: str
    fees: int
    timings: str
    bio: Optional[str] = None
    photo: Optional[str] = None          # base64 data URL or URL
    id_proof_photo: Optional[str] = None  # base64
    degree_photo: Optional[str] = None    # base64
    avg_consult_minutes: Optional[int] = 15
    hospital_id: Optional[str] = None
    gender: Optional[str] = None


class OwnerAddReceptionistBody(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    mobile: Optional[str] = None
    phone: Optional[str] = None
    hospital_id: str
    doctor_id: Optional[str] = None


class OwnerUpdateDoctorBody(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    phone: Optional[str] = None
    mobile: Optional[str] = None
    address: Optional[str] = None
    specialty: Optional[str] = None
    degree: Optional[str] = None
    experience_years: Optional[int] = None
    clinic_name: Optional[str] = None
    city: Optional[str] = None
    fees: Optional[int] = None
    timings: Optional[str] = None
    bio: Optional[str] = None
    photo: Optional[str] = None
    id_proof_photo: Optional[str] = None
    degree_photo: Optional[str] = None
    status: Optional[str] = None
    avg_consult_minutes: Optional[int] = None
    hospital_id: Optional[str] = None
    gender: Optional[str] = None


class OwnerUpdateReceptionistBody(BaseModel):
    full_name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    hospital_id: Optional[str] = None
    phone: Optional[str] = None
    mobile: Optional[str] = None
    doctor_id: Optional[str] = None
    doctor_name: Optional[str] = None
    photo: Optional[str] = None


class DoctorSelfUpdateBody(BaseModel):
    """Doctor updates own profile."""
    fees: Optional[int] = None
    timings: Optional[str] = None
    bio: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    mobile: Optional[str] = None
    photo: Optional[str] = None
    password: Optional[str] = None
    avg_consult_minutes: Optional[int] = None


class AddSpecialtyBody(BaseModel):
    name: str


class ReferAppointmentBody(BaseModel):
    appointment_id: Optional[str] = None
    to_doctor_id: str
    reason: Optional[str] = "Referred to specialist"


class AutoReferBody(BaseModel):
    from_doctor_id: str
    reason: Optional[str] = "Doctor unavailable / Auto-referred"


# ============ HELPERS ============
MAX_PHOTO_BYTES = 5 * 1024 * 1024  # 5 MB limit

def validate_photo_size(photo_str: Optional[str]) -> None:
    if not photo_str:
        return
    if photo_str.startswith("data:") and "," in photo_str:
        raw_b64 = photo_str.split(",", 1)[1]
        approx_bytes = (len(raw_b64) * 3) / 4
        if approx_bytes > MAX_PHOTO_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"Photo size ({approx_bytes / (1024*1024):.1f} MB) exceeds maximum allowed limit of 5 MB."
            )
    elif len(photo_str.encode('utf-8')) > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=400,
            detail="Photo size exceeds maximum allowed limit of 5 MB."
        )


def format_clock_time(dt: datetime) -> str:
    """Format datetime into 12-hour clock format with AM/PM (e.g. 1:00 PM, 10:30 AM)."""
    hour = dt.strftime("%I").lstrip("0") or "12"
    minute = dt.strftime("%M")
    ampm = dt.strftime("%p")
    return f"{hour}:{minute} {ampm}"
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def create_token(user_id: str, role: str, expires_in: Optional[int] = None) -> str:
    if expires_in is None:
        expires_in = JWT_EXP_SECONDS_RECEPTION if role == "receptionist" else JWT_EXP_SECONDS
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=expires_in),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def normalize_mobile(mobile: str) -> str:
    """Normalize Indian mobile numbers to +91XXXXXXXXXX format."""
    if not mobile:
        return ""
    m = "".join(ch for ch in mobile if ch.isdigit() or ch == "+")
    # Strip leading +91 or 91 or 0
    if m.startswith("+91"):
        m = m[3:]
    elif m.startswith("91") and len(m) == 12:
        m = m[2:]
    elif m.startswith("0"):
        m = m[1:]
    m = "".join(ch for ch in m if ch.isdigit())
    return f"+91{m}" if m else ""


async def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    if not creds:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def require_role(*roles: str):
    async def checker(user: dict = Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(status_code=403, detail="Forbidden")
        return user

    return checker


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ============ DPDP: AUDIT LOG + RATE LIMITER ============
async def audit(actor_id: Optional[str], action: str, target: Optional[str] = None, meta: Optional[dict] = None):
    """Structured audit log for sensitive/data-fiduciary actions.
    Never logs raw PII in `meta` — pass only identifiers.
    """
    try:
        await db.audit_logs.insert_one({
            "id": str(uuid.uuid4()),
            "actor_id": actor_id,
            "action": action,
            "target": target,
            "meta": meta or {},
            "ts": now_iso(),
        })
    except Exception as e:
        logger.warning(f"audit log failure (non-blocking): {e}")


async def enforce_otp_rate_limit(mobile: str):
    """Reject if too many OTP requests from same mobile in the window."""
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(seconds=OTP_RATE_WINDOW_SECONDS)).isoformat()
    count = await db.otp_requests.count_documents({"mobile": mobile, "ts": {"$gte": cutoff_iso}})
    if count >= OTP_RATE_MAX_REQUESTS:
        raise HTTPException(status_code=429, detail=f"Too many OTP requests. Try again in {OTP_RATE_WINDOW_SECONDS // 60} minutes.")
    await db.otp_requests.insert_one({"mobile": mobile, "ts": now_iso()})
    # Best-effort cleanup of very old entries (keep DB small)
    old_cutoff = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    await db.otp_requests.delete_many({"ts": {"$lt": old_cutoff}})


# ============ Firebase Admin (optional) ============
FIREBASE_ADMIN_AVAILABLE = False
_firebase_admin_app = None

import importlib

def init_firebase_admin_if_available():
    global FIREBASE_ADMIN_AVAILABLE, _firebase_admin_app
    if FIREBASE_ADMIN_AVAILABLE:
        return
    try:
        firebase_admin = importlib.import_module("firebase_admin")
        credentials = importlib.import_module("firebase_admin.credentials")
        firebase_auth = importlib.import_module("firebase_admin.auth")
    except Exception:
        FIREBASE_ADMIN_AVAILABLE = False
        return

    # Detect service account JSON in env or individual env vars
    svc_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    client_email = os.environ.get("FIREBASE_CLIENT_EMAIL")
    private_key = os.environ.get("FIREBASE_PRIVATE_KEY")
    project_id = os.environ.get("FIREBASE_PROJECT_ID")
    # If the service account JSON was pasted raw into the .env file (common mistake),
    # try to extract a JSON object from the file and use it.
    # If not in env var, check for json file directly in backend directory
    if not svc_json:
        for sa_filename in ["firebase-service-account.json", "firebase-credentials.json", "serviceAccountKey.json", "firebase_service_account.json"]:
            sa_path = ROOT_DIR / sa_filename
            if sa_path.exists():
                try:
                    svc_json = sa_path.read_text(encoding="utf-8")
                    break
                except Exception:
                    pass
    if not svc_json:
        try:
            env_path = ROOT_DIR / ".env"
            if env_path.exists():
                txt = env_path.read_text(encoding="utf-8")
                # Find a JSON object in the .env file content
                start = txt.find('{')
                end = txt.rfind('}')
                if start != -1 and end != -1 and end > start:
                    candidate = txt[start:end+1]
                    try:
                        parsed = json.loads(candidate)
                        svc_json = json.dumps(parsed)
                        os.environ["FIREBASE_SERVICE_ACCOUNT_JSON"] = svc_json
                    except Exception:
                        pass
        except Exception:
            pass
    try:
        if svc_json:
            cred = credentials.Certificate(json.loads(svc_json))
        elif client_email and private_key and project_id:
            # Build minimal service account
            sa = {
                "type": "service_account",
                "project_id": project_id,
                "private_key_id": os.environ.get("FIREBASE_PRIVATE_KEY_ID", ""),
                "private_key": private_key.replace("\\n", "\n"),
                "client_email": client_email,
                "client_id": os.environ.get("FIREBASE_CLIENT_ID", ""),
            }
            cred = credentials.Certificate(sa)
        else:
            FIREBASE_ADMIN_AVAILABLE = False
            return
        _firebase_admin_app = firebase_admin.initialize_app(cred)
        FIREBASE_ADMIN_AVAILABLE = True
    except Exception as e:
        FIREBASE_ADMIN_AVAILABLE = False
        return


class FirebaseLoginBody(BaseModel):
    id_token: str
    full_name: Optional[str] = None
    age: Optional[int] = None
    gender: Optional[str] = None
    address: Optional[str] = None
    consent_privacy: Optional[bool] = None


@api_router.post("/auth/firebase-login")
async def firebase_login(body: FirebaseLoginBody):
    """Verify a Firebase ID token (issued after phone auth on the client),
    then link or create a user in our DB and return a JWT for the app.
    This endpoint requires Firebase Admin credentials to be available via
    env vars (FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY + FIREBASE_PROJECT_ID).
    """
    init_firebase_admin_if_available()
    if not FIREBASE_ADMIN_AVAILABLE:
        raise HTTPException(status_code=500, detail="Firebase Admin not configured on server. Provide service account credentials.")
    try:
        firebase_auth = importlib.import_module("firebase_admin.auth")
        decoded = firebase_auth.verify_id_token(body.id_token)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Invalid Firebase ID token: {e}")

    # decoded should contain 'uid' and 'phone_number'
    fid = decoded.get("uid")
    phone = decoded.get("phone_number")
    if not phone:
        raise HTTPException(status_code=400, detail="Firebase token missing phone number")
    mobile = normalize_mobile(phone)
    if not mobile:
        raise HTTPException(status_code=400, detail="Invalid phone number in token")

    user = await db.users.find_one({"mobile": mobile})
    if not user:
        # New user — require consent and name unless dev-mode
        dev_mode_bypass = (body.consent_privacy is True) or (not STRIP_DEV_OTP)
        if not body.full_name and not dev_mode_bypass:
            raise HTTPException(status_code=400, detail="Name is required for new signup")
        if body.consent_privacy is not True and not dev_mode_bypass:
            raise HTTPException(status_code=400, detail="Please accept the privacy notice to continue")
        user_id = str(uuid.uuid4())
        doc = {
            "id": user_id,
            "email": None,
            "mobile": mobile,
            "phone": mobile,
            "password_hash": None,
            "full_name": (body.full_name or "").strip(),
            "role": "patient",
            "age": body.age,
            "gender": body.gender,
            "address": body.address,
            "consent_privacy": True,
            "consent_history": [{"version": body.consent_privacy or PRIVACY_NOTICE_VERSION, "at": now_iso(), "channel": "firebase-phone"}],
            "created_at": now_iso(),
            "firebase_uid": fid,
        }
        await db.users.insert_one(doc)
        await audit(user_id, "user.signup", target=user_id, meta={"role": "patient", "method": "firebase"})
        user = doc
    else:
        if user.get("deleted"):
            raise HTTPException(status_code=403, detail="This account has been deleted. Contact support to restore.")
        # Link firebase uid if not present
        if not user.get("firebase_uid"):
            await db.users.update_one({"id": user["id"]}, {"$set": {"firebase_uid": fid}})
        await audit(user["id"], "user.login", target=user["id"], meta={"role": user.get("role", "patient"), "method": "firebase"})

    token = create_token(user["id"], user.get("role", "patient"))
    return {
        "access_token": token,
        "user": {
            "id": user["id"],
            "email": user.get("email"),
            "mobile": user.get("mobile"),
            "full_name": user["full_name"],
            "role": user["role"],
            "phone": user.get("phone"),
            "age": user.get("age"),
            "gender": user.get("gender"),
            "address": user.get("address"),
        },
    }


# ============ WEBSOCKET MANAGER ============
class ConnectionManager:
    """Manages WebSocket connections keyed by channel name.
    Channels: 'doctor:{doctor_id}' (for reception/doctor dashboards),
              'appt:{appointment_id}' (for patient queue view)
    """

    def __init__(self):
        self.channels: Dict[str, List[WebSocket]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, channel: str, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self.channels.setdefault(channel, []).append(ws)

    async def disconnect(self, channel: str, ws: WebSocket):
        async with self._lock:
            if channel in self.channels:
                try:
                    self.channels[channel].remove(ws)
                except ValueError:
                    pass
                if not self.channels[channel]:
                    del self.channels[channel]

    async def broadcast(self, channel: str, message: dict):
        dead: List[WebSocket] = []
        conns = list(self.channels.get(channel, []))
        for ws in conns:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            await self.disconnect(channel, ws)


manager = ConnectionManager()


async def broadcast_doctor_update(doctor_id: str, event: str = "queue_update"):
    """Broadcast to doctor channel + all patient appointment channels for that doctor today."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    await manager.broadcast(f"doctor:{doctor_id}", {"type": event, "doctor_id": doctor_id, "ts": now_iso()})
    # Also notify individual patients
    try:
        appts = await db.appointments.find(
            {"doctor_id": doctor_id, "date": today, "status": {"$nin": ["cancelled", "completed"]}},
            {"_id": 0, "id": 1},
        ).to_list(500)
        for a in appts:
            await manager.broadcast(f"appt:{a['id']}", {"type": event, "doctor_id": doctor_id, "ts": now_iso()})
    except Exception as ex:
        pass


# ============ PUSH NOTIFICATION HELPERS ============
class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str


async def send_push(recipients: List[str], data: dict, idempotency_key: Optional[str] = None) -> None:
    """Emergent-managed push relay. Non-blocking (caller should wrap in try/except)."""
    if not recipients:
        return
    if len(recipients) > 100:
        recipients = recipients[:100]
    if "title" not in data or "message" not in data:
        return
    payload: dict = {"recipients": recipients, "data": data}
    if idempotency_key:
        payload["$idempotency_key"] = idempotency_key
    try:
        resp = await _push_client.post("/api/v1/push/trigger", json=payload)
        if resp.status_code >= 400:
            logger.warning(f"push relay non-ok: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        logger.warning(f"push relay error (non-blocking): {e}")


async def notify_queue_movement(doctor_id: str):
    """Fire push notifications when queue moves — instant turn + almost-up alerts."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        all_appts = await db.appointments.find(
            {"doctor_id": doctor_id, "date": today, "status": {"$nin": ["cancelled", "completed", "skipped"]}},
            {"_id": 0},
        ).sort("token_number", 1).to_list(500)

        # 1) Current in_consultation → notify that patient "It's your turn"
        in_cons = [a for a in all_appts if a["status"] == "in_consultation"]
        for a in in_cons:
            if a["patient_id"] and a["patient_id"] != "emergency":
                try:
                    await send_push(
                        recipients=[a["patient_id"]],
                        data={
                            "title": "🎉 It's your turn now!",
                            "message": f"Dr. {a['doctor_name'].replace('Dr. ', '')} is ready to see you. Please head to the consultation room.",
                            "action_url": "/patient/queue",
                        },
                        idempotency_key=f"turn-{a['id']}",
                    )
                except Exception:
                    pass

        # 2) Patients at position 2 or 3 → almost-up alert (idempotent per appt-position)
        active = [a for a in all_appts if a["status"] in ("booked", "arrived")]
        for idx, a in enumerate(active[:3], start=1):
            if idx <= 1:
                continue  # position 1 = next, we'll cover them when they move to in_consultation
            if a["patient_id"] and a["patient_id"] != "emergency":
                try:
                    await send_push(
                        recipients=[a["patient_id"]],
                        data={
                            "title": f"You're #{idx} in queue",
                            "message": f"Only {idx - 1} patient(s) ahead of you at Dr. {a['doctor_name'].replace('Dr. ', '')}. Please arrive at the clinic.",
                            "action_url": "/patient/queue",
                        },
                        idempotency_key=f"almost-{a['id']}-{idx}",
                    )
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"notify_queue_movement error: {e}")


@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    # In dev/preview with placeholder key, soft-fail so mobile clients don't error
    if PUSH_KEY == "placeholder":
        return {"status": "queued_local"}
    try:
        resp = await _push_client.post("/api/v1/push/users/register", json=body.model_dump())
        if resp.status_code == 401:
            raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
        if resp.status_code >= 500:
            raise HTTPException(502, "Push provider unavailable")
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"register-push non-fatal: {e}")
        return {"status": "queued_local"}
    return {"status": "registered"}


# ============ AUTH ============
@api_router.post("/auth/signup")
async def signup(body: UserCreate):
    existing = await db.users.find_one({"email": body.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": body.email,
        "password_hash": hash_password(body.password),
        "full_name": body.full_name,
        "role": body.role,
        "phone": body.phone,
        "created_at": now_iso(),
    }
    await db.users.insert_one(doc)
    # Auto-create doctor profile stub if role is doctor
    if body.role == "doctor":
        await db.doctors.insert_one({
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "full_name": body.full_name,
            "specialty": "General Physician",
            "city": "Mumbai",
            "clinic_name": f"Dr. {body.full_name}'s Clinic",
            "fees": 500,
            "timings": "10:00 AM - 6:00 PM",
            "rating": 4.5,
            "photo": None,
            "bio": "",
            "status": "active",
        })
    token = create_token(user_id, body.role)
    return {
        "access_token": token,
        "user": UserPublic(id=user_id, email=body.email, full_name=body.full_name, role=body.role, phone=body.phone).model_dump(),
    }


@api_router.post("/auth/login")
async def login(body: UserLogin):
    email = body.email.strip().lower()
    user = await db.users.find_one({"email": email})
    if not user:
        raise HTTPException(status_code=401, detail="LOGIN FAILED: Invalid email or password")

    if user.get("login_disabled") or not user.get("password_hash") or user.get("password_hash") == "DISABLED_SEED_ACCOUNT" or user.get("status") == "disabled":
        raise HTTPException(status_code=401, detail="LOGIN BLOCKED: Account login access is disabled")

    if not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="LOGIN FAILED: Invalid email or password")

    role = user.get("role")
    req_hosp = (body.hospital_code or body.hospital_id or "").strip().upper()
    user_hosp = (user.get("hospital_id") or user.get("hospital_code") or "H00001").strip().upper()

    if role in ["admin", "owner"]:
        if req_hosp and req_hosp not in ["H00001", "ADMIN-000", user_hosp]:
            raise HTTPException(status_code=401, detail="LOGIN FAILED: Invalid Hospital Code")
    else:
        if req_hosp and req_hosp != user_hosp:
            raise HTTPException(status_code=401, detail=f"LOGIN FAILED: Account is not assigned to Hospital ID {req_hosp}")
        if body.role and body.role.strip().lower() != role.lower():
            raise HTTPException(status_code=401, detail=f"LOGIN FAILED: Account is registered as a {role}, not a {body.role}")

    token = create_token(user["id"], role)
    
    user_data = UserPublic(
        id=user["id"], 
        email=user.get("email"), 
        full_name=user.get("full_name", ""), 
        role=role, 
        phone=user.get("phone"),
        hospital_id=user_hosp
    ).model_dump()
    
    return {
        "access_token": token,
        "user": user_data,
    }


@api_router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


@api_router.post("/hospital/validate-id")
@api_router.post("/api/hospital/validate-id")
@app.post("/api/hospital/validate-id")
@app.post("/hospital/validate-id")
async def validate_hospital_id(body: ValidateHospitalIdBody):
    hid = body.hospital_id.strip()
    if not hid:
        raise HTTPException(status_code=400, detail="Hospital ID is required")

    if hid.upper() in ["ADMIN-000", "H00001"]:
        return {
            "valid": True,
            "hospital_id": hid.upper(),
            "name": "System Admin",
            "isAdmin": True
        }

    hosp = await db.hospitals.find_one({
        "$or": [
            {"hospital_id": hid},
            {"hospital_id": hid.upper()},
            {"hospital_id": {"$regex": f"^{hid}$", "$options": "i"}}
        ],
        "status": {"$ne": "inactive"}
    })
    if not hosp:
        raise HTTPException(status_code=404, detail="Invalid or inactive Hospital ID")

    return {
        "valid": True,
        "hospital_id": hosp.get("hospital_id", hid.upper()),
        "name": hosp.get("name", "Hospital"),
        "city": hosp.get("city", ""),
        "isAdmin": False
    }


@api_router.post("/hospital/login")
@api_router.post("/api/hospital/login")
@app.post("/api/hospital/login")
@app.post("/hospital/login")
async def hospital_login(body: HospitalLoginBody):
    hid = body.hospital_id.strip().upper()
    email = body.email.strip().lower()
    hosp = await db.hospitals.find_one({
        "$or": [
            {"hospital_id": hid},
            {"hospital_id": {"$regex": f"^{hid}$", "$options": "i"}}
        ]
    })
    if not hosp:
        raise HTTPException(status_code=401, detail="Invalid Hospital ID")

    hosp_email = (hosp.get("email") or "").strip().lower()
    pwd_hash = hosp.get("password_hash")
    
    valid_creds = False
    if hosp_email and pwd_hash:
        if hosp_email == email and verify_password(body.password, pwd_hash):
            valid_creds = True
    elif (not hosp_email or hosp_email == email) and verify_password(body.password, hash_password("Hospital@123")):
        valid_creds = True
    elif email.endswith(f"@{hid.lower()}.com") and body.password == "Hospital@123":
        valid_creds = True

    if not valid_creds:
        raise HTTPException(status_code=401, detail="Invalid Hospital Email or Password")

    token = create_token(f"hosp_{hid}", "hospital")
    return {
        "ok": True,
        "authenticated": True,
        "token": token,
        "hospital_id": hid,
        "hospital_name": hosp.get("name"),
        "city": hosp.get("city", "")
    }


@api_router.get("/hospital/details")
@api_router.get("/api/hospital/details")
@app.get("/api/hospital/details")
@app.get("/hospital/details")
async def hospital_details(hospital_id: str):
    hid = hospital_id.strip().upper()
    hosp = await db.hospitals.find_one({"hospital_id": hid}, {"_id": 0, "password_hash": 0})
    if not hosp:
        raise HTTPException(status_code=404, detail="Hospital not found")
    return hosp


# ============ DPDP: PRIVACY & USER DATA CONTROLS ============
@api_router.get("/privacy-notice")
async def privacy_notice():
    """Public — returns the current privacy notice text and version.
    UI shows this at signup and in the "My Data & Privacy" screen.
    """
    return {
        "version": PRIVACY_NOTICE_VERSION,
        "effective_from": "2026-02-01",
        "grievance_officer": {
            "name": "Grievance Officer, Meribaari",
            "email": "grievance@meribaari.example",
            "response_sla_days": 30,
        },
        "sections": [
            {
                "title": "What we collect",
                "body": "Name, mobile number, age, gender, address, appointment history, symptoms, prescriptions. Doctors additionally provide degree, ID proof and photograph. Payment card data is NOT collected.",
            },
            {
                "title": "Why we collect it",
                "body": "To book appointments, run the live queue, share prescriptions with you, and comply with legal record-keeping for healthcare services.",
            },
            {
                "title": "Who can see your data",
                "body": "You, the doctor you have booked with, that clinic's receptionist, and the clinic owner. We do not sell your data. We do not use it for advertising.",
            },
            {
                "title": "Third parties",
                "body": "Push notification delivery is routed through Emergent Push (SuprSend) which forwards to Google FCM / Apple APNs. Your name is not sent to these providers — only a user identifier and the notification text.",
            },
            {
                "title": "Your rights (DPDP Act 2023)",
                "body": "Access your data, correct it, delete it, withdraw consent, or raise a grievance. Use the 'My Data & Privacy' screen inside the app, or email the grievance officer.",
            },
            {
                "title": "Retention",
                "body": "Appointment records are retained for legitimate medical record-keeping. When you delete your account, personally identifying fields are erased or anonymised.",
            },
            {
                "title": "Security",
                "body": "Data is transmitted over HTTPS/TLS. Passwords are hashed with bcrypt. Access is role-based. This is a technical statement, not a legal compliance claim.",
            },
            {
                "title": "Children",
                "body": f"Meribaari does not permit patients below {MIN_PATIENT_AGE} years to self-register. A guardian must register on their behalf.",
            },
        ],
    }


@api_router.get("/user/data-export")
async def user_data_export(user: dict = Depends(get_current_user)):
    """DPDP right of access — export the requester's personal data as JSON."""
    await audit(user["id"], "user.data_export", target=user["id"])
    export: dict = {
        "user": {k: user.get(k) for k in ["id", "email", "mobile", "full_name", "role", "phone", "age", "gender", "address", "created_at", "consent_privacy", "consent_history"]},
        "generated_at": now_iso(),
    }
    if user["role"] == "patient":
        appts = await db.appointments.find({"patient_id": user["id"]}, {"_id": 0}).to_list(1000)
        export["appointments"] = appts
    elif user["role"] == "doctor":
        d = await db.doctors.find_one({"user_id": user["id"]}, {"_id": 0})
        export["doctor_profile"] = d
    return export


@api_router.post("/user/withdraw-consent")
async def user_withdraw_consent(user: dict = Depends(get_current_user)):
    """DPDP consent withdrawal — flips the consent flag.
    Does NOT immediately delete data; user must call /user/delete-me for that.
    """
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"consent_privacy": False},
         "$push": {"consent_history": {"version": PRIVACY_NOTICE_VERSION, "at": now_iso(), "action": "withdrawn"}}},
    )
    await audit(user["id"], "user.consent_withdrawn", target=user["id"])
    return {"ok": True, "message": "Consent withdrawn. To fully delete data, use Delete My Account."}


class DeleteMeBody(BaseModel):
    confirm: bool = False
    reason: Optional[str] = None


@api_router.post("/user/delete-me")
async def user_delete_me(body: DeleteMeBody, user: dict = Depends(get_current_user)):
    """DPDP right of erasure — soft-delete the account and anonymise PII.
    Owner accounts cannot self-delete (safety); use another owner or DB-level action.
    """
    if not body.confirm:
        raise HTTPException(status_code=400, detail="Please confirm deletion")
    if user["role"] == "owner":
        raise HTTPException(status_code=403, detail="Owner account cannot be deleted via this endpoint. Contact support.")
    # Anonymise PII, keep operational skeleton for referential integrity of past appointments
    anon = {
        "email": None,
        "mobile": None,
        "phone": None,
        "full_name": "Deleted User",
        "age": None,
        "gender": None,
        "address": None,
        "password_hash": None,
        "deleted": True,
        "deleted_at": now_iso(),
    }
    await db.users.update_one({"id": user["id"]}, {"$set": anon})
    # For patients — anonymise their name on past appointments
    if user["role"] == "patient":
        await db.appointments.update_many(
            {"patient_id": user["id"]},
            {"$set": {"patient_name": "Deleted User"}},
        )
    # For doctors — delete their doctor profile so they no longer appear to patients
    if user["role"] == "doctor":
        await db.doctors.delete_many({"user_id": user["id"]})
    await audit(user["id"], "user.delete_me", target=user["id"], meta={"reason": (body.reason or "")[:120]})
    return {"ok": True, "message": "Your personal data has been erased. Historical appointment records are anonymised."}


# ============ MOBILE OTP AUTH (Patient) ============
@api_router.post("/auth/send-otp")
async def send_otp(request: Request, body: SendOTPBody):
    mobile = normalize_mobile(body.mobile)
    if not mobile or len(mobile) < 10:
        raise HTTPException(status_code=400, detail="Enter a valid mobile number")
    # Rate limit: safe sliding-window IP and Phone protection
    enforce_send_otp_rate_limit(request, mobile)
    await enforce_otp_rate_limit(mobile)
    
    # Generate 6-digit secure cryptographic OTP
    otp = f"{secrets.randbelow(900000) + 100000}"
    otp_hash = hash_otp(otp, mobile)
    
    # Store OTP in-memory only (never in MongoDB)
    save_memory_otp(mobile, otp, OTP_EXP_SECONDS)
    
    # Deliver OTP via Renflair Transactional SMS V1
    try:
        sms_res = await send_otp_sms(mobile, otp)
        if not sms_res.get("ok"):
            logger.warning(f"Renflair OTP SMS failed (non-blocking): {sms_res.get('error')}")
    except Exception as e:
        logger.warning(f"OTP SMS delivery error (non-blocking): {e}")
    
    # Plaintext OTP is NEVER logged or exposed in API response
    existing = await db.users.find_one({"mobile": mobile})
    return {
        "ok": True,
        "mobile": mobile,
        "is_registered": bool(existing),
        "privacy_notice_version": PRIVACY_NOTICE_VERSION,
        "message": f"OTP sent to {mobile} via SMS.",
    }


@api_router.post("/auth/verify-otp")
async def verify_otp(body: VerifyOTPBody):
    mobile = normalize_mobile(body.mobile)
    if not mobile:
        raise HTTPException(status_code=400, detail="Invalid mobile")
    
    # Enforce verify attempt limit
    enforce_verify_otp_rate_limit(mobile)

    entered_otp = (body.otp or "").strip()
    if not entered_otp or len(entered_otp) != 6:
        raise HTTPException(status_code=400, detail="Invalid OTP format. Must be 6 digits.")
    
    # Fetch OTP from in-memory store (not MongoDB)
    rec = _otp_store.get(mobile)
    if not rec:
        raise HTTPException(status_code=401, detail="Invalid OTP or request expired")
    
    # Check expiry
    try:
        exp = datetime.fromisoformat(rec["expires_at"])
        if datetime.now(timezone.utc) > exp:
            _otp_store.pop(mobile, None)
            raise HTTPException(status_code=401, detail="OTP expired. Request a new one.")
    except HTTPException:
        raise
    except Exception:
        pass
    
    # Verify cryptographic hash of OTP
    expected_hash = rec.get("otp_hash")
    entered_hash = hash_otp(entered_otp, mobile)
    legacy_match = rec.get("otp") and rec.get("otp") == entered_otp
    is_match = (expected_hash and secrets.compare_digest(entered_hash, expected_hash)) or legacy_match
    
    if not is_match:
        attempts = int(rec.get("attempts", 0)) + 1
        if attempts >= 5:
            _otp_store.pop(mobile, None)
            raise HTTPException(status_code=401, detail="Maximum attempts exceeded. Request a new OTP.")
        rec["attempts"] = attempts
        raise HTTPException(status_code=401, detail="Invalid OTP")
    
    # Successful verification - delete OTP record immediately from memory
    _otp_store.pop(mobile, None)

    # Match any existing user by mobile regardless of role; if none, we'll create a new patient account
    user = await db.users.find_one({"mobile": mobile})
    if not user:
        if not body.full_name:
            raise HTTPException(status_code=400, detail="Name is required for new patient signup")
        if body.age is not None and body.age < MIN_PATIENT_AGE:
            raise HTTPException(
                status_code=400,
                detail=f"Patients under {MIN_PATIENT_AGE} cannot self-register. A guardian must register on your behalf.",
            )
        user_id = str(uuid.uuid4())
        consent_snapshot = {
            "version": body.consent_version or PRIVACY_NOTICE_VERSION,
            "at": now_iso(),
            "channel": "mobile-otp-signup",
        }
        doc = {
            "id": user_id,
            "email": None,
            "mobile": mobile,
            "phone": mobile,
            "password_hash": None,
            "full_name": body.full_name.strip(),
            "role": "patient",
            "phone_verified": True,
            "age": body.age,
            "gender": body.gender,
            "address": body.address,
            "consent_privacy": True if body.consent_privacy is not False else False,
            "consent_history": [consent_snapshot],
            "created_at": now_iso(),
        }
        await db.users.insert_one(doc)
        await audit(user_id, "user.signup", target=user_id, meta={"role": "patient"})
        user = doc
    else:
        if user.get("deleted"):
            raise HTTPException(status_code=403, detail="This account has been deleted. Contact support to restore.")
        # Mark phone as verified on account
        if not user.get("phone_verified"):
            await db.users.update_one({"id": user["id"]}, {"$set": {"phone_verified": True}})
            user["phone_verified"] = True
        await audit(user["id"], "user.login", target=user["id"], meta={"role": user.get("role", "patient"), "method": "otp"})
    # Issue token with the user's actual role (new users default to 'patient')
    token = create_token(user["id"], user.get("role", "patient"))
    return {
        "access_token": token,
        "user": {
            "id": user["id"],
            "email": user.get("email"),
            "mobile": user.get("mobile"),
            "full_name": user["full_name"],
            "role": user["role"],
            "phone": user.get("phone"),
            "phone_verified": user.get("phone_verified", True),
            "age": user.get("age"),
            "gender": user.get("gender"),
            "address": user.get("address"),
        },
    }


# ============ DOCTORS & SPECIALISTS ============
STANDARD_SPECIALTIES = [
    "Cardiologist",
    "Dermatologist",
    "Endocrinologist",
    "Gastroenterologist",
    "General Physician",
    "General Surgeon",
    "Gynecologist",
    "Obstetrician",
    "Neurologist",
    "Neurosurgeon",
    "Nephrologist",
    "Oncologist",
    "Ophthalmologist",
    "Orthopedic Surgeon / Orthopedist",
    "Otolaryngologist (ENT Specialist)",
    "Pediatrician",
    "Psychiatrist",
    "Pulmonologist",
    "Radiologist",
    "Urologist",
    "Rheumatologist",
    "Anesthesiologist",
    "Pathologist",
    "Dentist",
    "Diabetologist",
    "Cardiothoracic Surgeon",
    "Plastic Surgeon",
    "Vascular Surgeon",
    "Pediatric Surgeon",
    "Surgical Oncologist",
    "Medical Oncologist",
    "Interventional Cardiologist",
    "Interventional Radiologist",
    "Critical Care Specialist",
    "Emergency Medicine Specialist",
    "Family Medicine Specialist",
    "Infectious Disease Specialist",
    "Pain Medicine Specialist",
    "Physical Medicine & Rehabilitation Specialist",
    "Allergy & Immunology Specialist",
    "Geriatrician",
    "Neonatologist",
    "Maternal-Fetal Medicine Specialist",
    "Reproductive Medicine Specialist",
    "Fertility Specialist",
    "Sports Medicine Specialist",
    "Other"
]

ALL_SPECIALTIES = STANDARD_SPECIALTIES

TERMINOLOGY_MAP = {
    "urology": "Urologist",
    "cardiology": "Cardiologist",
    "neurology": "Neurologist",
    "dermatology": "Dermatologist",
    "gastroenterology": "Gastroenterologist",
    "nephrology": "Nephrologist",
    "oncology": "Oncologist",
    "ophthalmology": "Ophthalmologist",
    "pediatrics": "Pediatrician",
    "psychiatry": "Psychiatrist",
    "pulmonology": "Pulmonologist",
    "radiology": "Radiologist",
    "rheumatology": "Rheumatologist",
    "orthopedics": "Orthopedic Surgeon / Orthopedist",
    "orthopedic": "Orthopedic Surgeon / Orthopedist",
    "ent": "Otolaryngologist (ENT Specialist)",
    "ent specialist": "Otolaryngologist (ENT Specialist)",
    "dental": "Dentist",
    "gynecology": "Gynecologist",
    "obstetrics": "Obstetrician",
    "endocrinology": "Endocrinologist",
    "anesthesiology": "Anesthesiologist",
    "pathology": "Pathologist",
    "geriatrics": "Geriatrician",
    "neonatology": "Neonatologist",
    "general physician / internal medicine": "General Physician",
    "dermatologist / skin specialist": "Dermatologist",
    "pulmonologist / chest specialist": "Pulmonologist",
    "pediatrician / child specialist": "Pediatrician",
    "gynecologist & obstetrician": "Gynecologist",
    "ophthalmologist / eye specialist": "Ophthalmologist",
    "oncologist / cancer specialist": "Oncologist",
    "plastic & reconstructive surgeon": "Plastic Surgeon",
    "pain management specialist": "Pain Medicine Specialist",
    "fertility / ivf specialist": "Fertility Specialist",
    "geriatrician / elderly care specialist": "Geriatrician",
}


async def migrate_doctor_specialty_terminology():
    """Normalize legacy department names to proper specialist terminology."""
    try:
        doctors = await db.doctors.find({}, {"id": 1, "specialty": 1}).to_list(1000)
        for d in doctors:
            spec = d.get("specialty", "").strip()
            norm = spec.lower()
            if norm in TERMINOLOGY_MAP:
                new_spec = TERMINOLOGY_MAP[norm]
                await db.doctors.update_one({"id": d["id"]}, {"$set": {"specialty": new_spec}})
    except Exception as exc:
        logger.warning("Specialty terminology migration check: %s", exc)


@api_router.get("/specialties")
async def list_specialties():
    custom_docs = await db.specialties.find({}, {"_id": 0, "name": 1}).to_list(500)
    custom_names = [c["name"] for c in custom_docs if c.get("name")]
    
    seen = set()
    result = []
    for s in STANDARD_SPECIALTIES + custom_names:
        norm = s.strip().lower()
        if norm and norm not in seen:
            seen.add(norm)
            result.append(s.strip())
    return result


@api_router.post("/specialties")
@api_router.post("/owner/specialties")
async def add_specialty(body: AddSpecialtyBody, user: dict = Depends(require_role("owner", "admin"))):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Specialist category name is required")
    
    existing_all = await list_specialties()
    if any(s.lower() == name.lower() for s in existing_all):
        match = next(s for s in existing_all if s.lower() == name.lower())
        return {"ok": True, "specialty": match, "message": "Specialist category already exists"}
    
    await db.specialties.update_one(
        {"name": {"$regex": f"^{name}$", "$options": "i"}},
        {"$setOnInsert": {"id": str(uuid.uuid4()), "name": name, "created_at": now_iso()}},
        upsert=True
    )
    return {"ok": True, "specialty": name, "message": "Specialist category added successfully"}


@api_router.get("/doctors")
async def list_doctors(
    search: Optional[str] = None, 
    specialty: Optional[str] = None, 
    city: Optional[str] = None,
    hospital_id: Optional[str] = None
):
    query = {}
    if hospital_id:
        query["hospital_id"] = hospital_id
    if search:
        query["$or"] = [
            {"full_name": {"$regex": search, "$options": "i"}},
            {"specialty": {"$regex": search, "$options": "i"}},
            {"clinic_name": {"$regex": search, "$options": "i"}},
            {"city": {"$regex": search, "$options": "i"}},
            {"hospital_id": {"$regex": search, "$options": "i"}},
        ]
    if specialty:
        # Match specialty or legacy department term
        query["specialty"] = {"$regex": specialty, "$options": "i"}
    if city:
        query["city"] = {"$regex": city, "$options": "i"}
    docs = await db.doctors.find(query, {"_id": 0}).to_list(200)
    if not docs:
        return docs
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doctor_ids = [d["id"] for d in docs]
    pipeline = [
        {"$match": {
            "doctor_id": {"$in": doctor_ids},
            "date": today,
            "status": {"$in": ["booked", "arrived", "in_consultation"]},
        }},
        {"$group": {"_id": "$doctor_id", "count": {"$sum": 1}}},
    ]
    agg = await db.appointments.aggregate(pipeline).to_list(len(doctor_ids))
    pending_map: Dict[str, int] = {row["_id"]: row["count"] for row in agg}
    for d in docs:
        per = int(d.get("avg_consult_minutes") or 15)
        d["est_wait_minutes"] = pending_map.get(d["id"], 0) * per
    return docs


async def estimate_wait_for_doctor(doctor_id: str) -> int:
    """Used by GET /doctors/:id — single doctor lookup, no N+1 concern."""
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pending = await db.appointments.count_documents({
        "doctor_id": doctor_id,
        "date": today,
        "status": {"$in": ["booked", "arrived", "in_consultation"]},
    })
    doctor = await db.doctors.find_one({"id": doctor_id}, {"_id": 0, "avg_consult_minutes": 1})
    per = int((doctor or {}).get("avg_consult_minutes") or 15)
    return pending * per


@api_router.get("/doctors/{doctor_id}")
async def get_doctor(doctor_id: str):
    d = await db.doctors.find_one({"id": doctor_id}, {"_id": 0})
    if not d:
        raise HTTPException(status_code=404, detail="Doctor not found")
    d["est_wait_minutes"] = await estimate_wait_for_doctor(doctor_id)
    return d


async def calculate_appointment_eta(appt: dict) -> dict:
    """Calculate live queue metrics and latest estimated turn time for an appointment."""
    all_appts = await db.appointments.find(
        {"doctor_id": appt["doctor_id"], "date": appt["date"], "status": {"$ne": "cancelled"}},
        {"_id": 0},
    ).sort("token_number", 1).to_list(500)

    active = [a for a in all_appts if a["status"] in ("booked", "arrived", "in_consultation")]
    current = next((a for a in all_appts if a["status"] == "in_consultation"), None)
    completed_count = len([a for a in all_appts if a["status"] == "completed"])

    # My position = number of active appts with token <= mine
    my_position = 0
    if appt.get("status") in ("booked", "arrived"):
        my_position = sum(1 for a in active if a["token_number"] <= appt["token_number"])
    elif appt.get("status") == "in_consultation":
        my_position = 0
    else:
        my_position = -1  # done / cancelled

    # Fetch doctor details
    doctor = await db.doctors.find_one({"id": appt["doctor_id"]}, {"_id": 0, "avg_consult_minutes": 1, "status": 1, "full_name": 1})
    doc_status = (doctor or {}).get("status", "active")
    per = int((doctor or {}).get("avg_consult_minutes") or 15)

    eta_minutes = 0
    expected_turn_time = None

    if my_position == 0 and appt.get("status") == "in_consultation":
        expected_turn_time = "Now"
    elif my_position > 0:
        eta_minutes = max(0, (my_position - (1 if current else 0))) * per
        # Local clinic / Indian Standard Time (UTC+5:30)
        ist_now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
        future_dt = ist_now + timedelta(minutes=eta_minutes)
        expected_turn_time = format_clock_time(future_dt)

    return {
        "my_position": my_position,
        "eta_minutes": eta_minutes,
        "expected_turn_time": expected_turn_time,
        "currently_serving": current["token_number"] if current else None,
        "completed_count": completed_count,
        "total_in_queue": len(active),
        "doctor_status": doc_status,
    }


# ============ APPOINTMENTS ============
@api_router.post("/appointments")
async def create_appointment(
    request: Request,
    body: AppointmentCreate,
    user: dict = Depends(require_role("patient")),
):
    doctor = await db.doctors.find_one({"id": body.doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    
    # Extract verified patient mobile number
    patient_mobile = normalize_mobile(user.get("mobile") or user.get("phone") or "")
    if not patient_mobile:
        u_rec = await db.users.find_one({"id": user["id"]})
        if u_rec:
            patient_mobile = normalize_mobile(u_rec.get("mobile") or u_rec.get("phone") or "")

    # Server-side rate limiting (IP and mobile separately)
    enforce_booking_rate_limit(request, patient_mobile)

    # Server-side restriction: A single verified patient mobile number can book only ONE appointment within the same calendar day
    or_clauses = [{"patient_id": user["id"]}]
    if patient_mobile:
        or_clauses.append({"patient_mobile": patient_mobile})
        or_clauses.append({"patient_phone": patient_mobile})
    
    existing_appointment = await db.appointments.find_one({
        "$or": or_clauses,
        "date": body.date,
        "status": {"$in": ["booked", "arrived", "in_consultation", "completed", "skipped"]}
    })
    if existing_appointment:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have an active appointment for this doctor/session."
        )

    # Compute next token number for this doctor on this date
    count = await db.appointments.count_documents({"doctor_id": body.doctor_id, "date": body.date})
    token_number = count + 1
    appt_id = str(uuid.uuid4())
    secure_token = secrets.token_urlsafe(16)
    doc = {
        "id": appt_id,
        "secure_token": secure_token,
        "doctor_id": body.doctor_id,
        "doctor_name": doctor["full_name"],
        "patient_id": user["id"],
        "patient_name": user["full_name"],
        "patient_mobile": patient_mobile or None,
        "date": body.date,
        "slot": body.slot,
        "token_number": token_number,
        "status": "booked",
        "payment_method": body.payment_method,
        "payment_status": "paid" if body.payment_method == "online" else "pending",
        "prescription": None,
        "sms_status": "pending",
        "sms_last_sent_at": now_iso(),
        "created_at": now_iso(),
    }
    try:
        await db.appointments.insert_one(doc)
    except pymongo.errors.DuplicateKeyError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have an active appointment for this doctor/session."
        )

    # Calculate latest ETA and trigger Renflair V7 transactional SMS
    if patient_mobile:
        eta_data = await calculate_appointment_eta(doc)
        dynamic_link = f"{get_app_public_url()}/appointment/{secure_token}"
        hour_val = format_renflair_hour(eta_data.get("expected_turn_time") or doc.get("slot"), default="2")
        try:
            sms_res = await send_appointment_sms(
                phone=patient_mobile,
                oid=token_number,
                hour=hour_val,
                patient_name=user["full_name"],
                doctor_name=doctor["full_name"],
                token_number=token_number,
                estimated_time=eta_data.get("expected_turn_time") or "As per live queue",
                appointment_link=dynamic_link,
            )
            sms_status = "sent" if sms_res.get("ok") else "failed"
            await db.appointments.update_one({"id": appt_id}, {"$set": {"sms_status": sms_status}})
            doc["sms_status"] = sms_status
        except Exception as e:
            logger.warning(f"SMS sending failed (non-blocking): {e}")

    doc.pop("_id", None)
    await broadcast_doctor_update(body.doctor_id, "booked")
    return doc


@api_router.get("/appointments/me")
async def my_appointments(user: dict = Depends(require_role("patient"))):
    appts = await db.appointments.find({"patient_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return appts


@api_router.get("/appointments/by-token/{token}")
async def get_appointment_by_token(token: str, user: dict = Depends(get_current_user)):
    """Fetch appointment details and latest queue stats by secure random token.
    Validates server-side that the authenticated patient owns the appointment.
    """
    appt = await db.appointments.find_one({"secure_token": token}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")

    # Authorize: if patient, must match user id or normalized mobile
    if user.get("role") == "patient":
        user_phone = normalize_mobile(user.get("mobile") or user.get("phone") or "")
        appt_phone = normalize_mobile(appt.get("patient_mobile") or "")
        is_owner = (appt.get("patient_id") == user["id"]) or (user_phone and user_phone == appt_phone)
        if not is_owner:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to view this appointment.")

    eta_data = await calculate_appointment_eta(appt)
    return {
        "ok": True,
        "appointment": appt,
        "queue": eta_data,
    }


@api_router.get("/appointments/{appt_id}/queue")
async def queue_status(appt_id: str, user: dict = Depends(get_current_user)):
    appt = await db.appointments.find_one({"id": appt_id}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")

    # Authorize: patient can only inspect their own queue status
    if user.get("role") == "patient":
        user_phone = normalize_mobile(user.get("mobile") or user.get("phone") or "")
        appt_phone = normalize_mobile(appt.get("patient_mobile") or "")
        is_owner = (appt.get("patient_id") == user["id"]) or (user_phone and user_phone == appt_phone)
        if not is_owner:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have permission to view this appointment.")

    eta_data = await calculate_appointment_eta(appt)
    return {
        "appointment": appt,
        **eta_data,
    }


@api_router.post("/appointments/{appt_id}/cancel")
async def cancel_appointment(appt_id: str, user: dict = Depends(get_current_user)):
    appt = await db.appointments.find_one({"id": appt_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    if user["role"] == "patient" and appt["patient_id"] != user["id"]:
        raise HTTPException(status_code=403, detail="Forbidden")
    await db.appointments.update_one({"id": appt_id}, {"$set": {"status": "cancelled"}})
    await broadcast_doctor_update(appt["doctor_id"], "cancelled")
    return {"ok": True}


@api_router.get("/appointments/calendar-summary")
async def calendar_summary(
    doctor_id: Optional[str] = None,
    user: dict = Depends(get_current_user)
):
    query = {}
    if doctor_id:
        query["doctor_id"] = doctor_id
    elif user["role"] == "doctor":
        doc = await db.doctors.find_one({"user_id": user["id"]})
        if doc:
            query["doctor_id"] = doc["id"]

    appts = await db.appointments.find(query, {"_id": 0}).to_list(1000)

    summary_map = {}
    for a in appts:
        dt = a.get("date")
        if not dt:
            continue
        if dt not in summary_map:
            summary_map[dt] = {"date": dt, "patient_count": 0, "tokens": []}
        if a.get("status") != "cancelled":
            summary_map[dt]["patient_count"] += 1
            if a.get("token_number") is not None:
                summary_map[dt]["tokens"].append(a["token_number"])

    res = list(summary_map.values())
    res.sort(key=lambda x: x["date"])
    return res


@api_router.post("/doctor/receptionist")
async def add_receptionist(
    body: AddReceptionistBody,
    user: dict = Depends(require_role("doctor"))
):
    doc = await db.doctors.find_one({"user_id": user["id"]})
    hid = user.get("hospital_id") or (doc.get("hospital_id") if doc else None) or f"HOSP-{user['id'][:6]}"
    rec_id = str(uuid.uuid4())
    rec_user = {
        "id": rec_id,
        "full_name": body.full_name,
        "mobile": normalize_mobile(body.mobile),
        "role": "receptionist",
        "hospital_id": hid,
        "doctor_id": doc["id"] if doc else None,
        "created_at": now_iso()
    }
    await db.users.insert_one(rec_user)
    return {"id": rec_id, "full_name": body.full_name, "hospital_id": hid, "status": "created"}


@api_router.get("/doctor/receptionists")
async def list_receptionists(user: dict = Depends(require_role("doctor"))):
    doc = await db.doctors.find_one({"user_id": user["id"]})
    hid = user.get("hospital_id") or (doc.get("hospital_id") if doc else None)
    query = {"role": "receptionist"}
    if hid:
        query["hospital_id"] = hid
    elif doc:
        query["doctor_id"] = doc["id"]
    recs = await db.users.find(query, {"_id": 0, "password_hash": 0}).to_list(100)
    return recs


@api_router.delete("/doctor/receptionist/{receptionist_id}")
async def delete_receptionist(
    receptionist_id: str,
    user: dict = Depends(require_role("doctor"))
):
    await db.users.delete_one({"id": receptionist_id, "role": "receptionist"})
    return {"status": "deleted", "id": receptionist_id}


@api_router.post("/appointments/{appt_id}/reschedule")
async def reschedule(appt_id: str, body: AppointmentCreate, user: dict = Depends(require_role("patient"))):
    appt = await db.appointments.find_one({"id": appt_id})
    if not appt or appt["patient_id"] != user["id"]:
        raise HTTPException(status_code=404, detail="Not found")
    count = await db.appointments.count_documents({"doctor_id": body.doctor_id, "date": body.date})
    await db.appointments.update_one(
        {"id": appt_id},
        {"$set": {"date": body.date, "slot": body.slot, "token_number": count + 1, "status": "booked"}},
    )
    return {"ok": True}


# ============ DOCTOR endpoints ============
@api_router.get("/doctor/profile")
async def doctor_profile(user: dict = Depends(require_role("doctor"))):
    d = await db.doctors.find_one({"user_id": user["id"]}, {"_id": 0})
    return d


@api_router.get("/doctor/appointments")
async def doctor_appointments(user: dict = Depends(require_role("doctor"))):
    d = await db.doctors.find_one({"user_id": user["id"]})
    if not d:
        return []
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    appts = await db.appointments.find(
        {"doctor_id": d["id"], "date": today, "status": {"$ne": "cancelled"}},
        {"_id": 0},
    ).sort("token_number", 1).to_list(500)
    return appts


@api_router.get("/doctor/dashboard")
async def doctor_dashboard(user: dict = Depends(require_role("doctor"))):
    d = await db.doctors.find_one({"user_id": user["id"]}, {"_id": 0})
    if not d:
        raise HTTPException(status_code=404, detail="Doctor profile not found")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    all_today = await db.appointments.find({"doctor_id": d["id"], "date": today}, {"_id": 0}).to_list(500)
    completed = [a for a in all_today if a["status"] == "completed"]
    pending = [a for a in all_today if a["status"] in ("booked", "arrived", "in_consultation")]
    earnings = sum(d["fees"] for a in completed)
    return {
        "doctor": d,
        "total_patients": len(all_today),
        "completed": len(completed),
        "pending": len(pending),
        "earnings": earnings,
        "status": d.get("status", "active"),
    }


@api_router.post("/doctor/status")
async def set_doctor_status(body: DoctorStatusBody, user: dict = Depends(require_role("doctor"))):
    if body.status not in ("active", "paused", "break", "emergency"):
        raise HTTPException(status_code=400, detail="Invalid status")
    await db.doctors.update_one({"user_id": user["id"]}, {"$set": {"status": body.status}})
    d = await db.doctors.find_one({"user_id": user["id"]}, {"_id": 0, "id": 1})
    if d:
        await broadcast_doctor_update(d["id"], "doctor_status_changed")
    return {"ok": True, "status": body.status}


@api_router.post("/doctor/prescription")
async def set_prescription(body: PrescriptionBody, user: dict = Depends(require_role("doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"prescription": body.prescription}})
    return {"ok": True}


# ============ REFERRAL & QUEUE MANAGEMENT ============
@api_router.post("/reception/refer")
@api_router.post("/appointments/{appt_id}/refer")
async def refer_appointment(
    body: ReferAppointmentBody,
    appt_id: Optional[str] = None,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner"))
):
    aid = appt_id or body.appointment_id
    if not aid:
        raise HTTPException(status_code=400, detail="appointment_id is required")
    
    appt = await db.appointments.find_one({"id": aid})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")
    
    to_doctor = await db.doctors.find_one({"id": body.to_doctor_id})
    if not to_doctor:
        raise HTTPException(status_code=404, detail="Target doctor not found")
    
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    new_token = await db.appointments.count_documents({"doctor_id": body.to_doctor_id, "date": today}) + 1
    
    old_doctor_id = appt["doctor_id"]
    updates = {
        "doctor_id": body.to_doctor_id,
        "doctor_name": to_doctor["full_name"],
        "token_number": new_token,
        "referred_from_doctor_id": old_doctor_id,
        "referred_reason": body.reason,
        "status": "arrived",  # Patient is at the clinic ready in new queue
        "updated_at": now_iso(),
    }
    await db.appointments.update_one({"id": aid}, {"$set": updates})
    
    await broadcast_doctor_update(old_doctor_id, "referred_out")
    await broadcast_doctor_update(body.to_doctor_id, "referred_in")
    await manager.broadcast(f"appt:{aid}", {"type": "referred", "appointment_id": aid, "to_doctor_name": to_doctor["full_name"]})
    
    return {"ok": True, "appointment_id": aid, "new_doctor": to_doctor["full_name"], "new_token": new_token}


@api_router.post("/reception/auto-refer")
@api_router.post("/doctor/auto-refer")
async def auto_refer_queue(body: AutoReferBody, user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner"))):
    from_doc = await db.doctors.find_one({"id": body.from_doctor_id})
    if not from_doc:
        raise HTTPException(status_code=404, detail="Doctor not found")
    
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pending_appts = await db.appointments.find({
        "doctor_id": body.from_doctor_id,
        "date": today,
        "status": {"$in": ["booked", "arrived"]}
    }).to_list(200)
    
    if not pending_appts:
        return {"ok": True, "count": 0, "message": "No pending patients to refer"}
    
    # Find alternative active doctors with matching hospital or specialty
    candidates = await db.doctors.find({
        "id": {"$ne": body.from_doctor_id},
        "status": "active",
        "$or": [
            {"hospital_id": from_doc.get("hospital_id")},
            {"specialty": from_doc.get("specialty")}
        ]
    }).to_list(100)
    
    if not candidates:
        raise HTTPException(status_code=400, detail="No active alternative doctors available for auto-referment")
    
    # Pick doctor with shortest queue
    doc_counts = []
    for c in candidates:
        cnt = await db.appointments.count_documents({
            "doctor_id": c["id"],
            "date": today,
            "status": {"$in": ["booked", "arrived", "in_consultation"]}
        })
        doc_counts.append((cnt, c))
    
    doc_counts.sort(key=lambda x: x[0])
    target_doctor = doc_counts[0][1]
    
    referred_count = 0
    for appt in pending_appts:
        new_token = await db.appointments.count_documents({"doctor_id": target_doctor["id"], "date": today}) + 1
        await db.appointments.update_one({"id": appt["id"]}, {"$set": {
            "doctor_id": target_doctor["id"],
            "doctor_name": target_doctor["full_name"],
            "token_number": new_token,
            "referred_from_doctor_id": body.from_doctor_id,
            "referred_reason": body.reason,
            "updated_at": now_iso(),
        }})
        await manager.broadcast(f"appt:{appt['id']}", {"type": "referred", "appointment_id": appt["id"], "to_doctor_name": target_doctor["full_name"]})
        referred_count += 1
    
    await broadcast_doctor_update(body.from_doctor_id, "auto_referred")
    await broadcast_doctor_update(target_doctor["id"], "auto_referred")
    
    return {
        "ok": True,
        "count": referred_count,
        "target_doctor": target_doctor["full_name"],
        "message": f"Successfully auto-referred {referred_count} patients to Dr. {target_doctor['full_name']}"
    }


# ============ RECEPTIONIST endpoints ============
@api_router.get("/reception/queue")
async def reception_queue(doctor_id: Optional[str] = None, user: dict = Depends(require_role("receptionist", "doctor"))):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    q = {"date": today}
    if user.get("hospital_id"):
        docs = await db.doctors.find({"hospital_id": user["hospital_id"]}, {"id": 1}).to_list(None)
        valid_doc_ids = [d["id"] for d in docs]
        if doctor_id:
            if doctor_id not in valid_doc_ids:
                return []
            q["doctor_id"] = doctor_id
        else:
            q["doctor_id"] = {"$in": valid_doc_ids}
    elif doctor_id:
        q["doctor_id"] = doctor_id

    appts = await db.appointments.find(q, {"_id": 0}).sort("token_number", 1).to_list(500)
    return appts


@api_router.get("/reception/doctors")
async def reception_doctors(user: dict = Depends(require_role("receptionist", "doctor"))):
    q = {}
    if user.get("hospital_id"):
        q["hospital_id"] = user["hospital_id"]
    docs = await db.doctors.find(q, {"_id": 0}).to_list(200)
    return docs


@api_router.post("/reception/mark_arrived")
async def mark_arrived(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "arrived"}})
    await broadcast_doctor_update(appt["doctor_id"], "arrived")
    return {"ok": True}


@api_router.post("/reception/start_consultation")
async def start_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "in_consultation"}})
    await broadcast_doctor_update(appt["doctor_id"], "started")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/complete")
async def complete_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "completed", "payment_status": "paid"}})
    await broadcast_doctor_update(appt["doctor_id"], "completed")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/skip")
async def skip_patient(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "skipped"}})
    await broadcast_doctor_update(appt["doctor_id"], "skipped")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/reorder")
async def reorder(body: ReorderBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"token_number": body.new_position}})
    await broadcast_doctor_update(appt["doctor_id"], "reordered")
    return {"ok": True}


@api_router.post("/reception/emergency_insert")
async def emergency_insert(body: dict, user: dict = Depends(require_role("receptionist", "doctor"))):
    doctor_id = body.get("doctor_id")
    patient_name = body.get("patient_name", "Emergency Patient")
    if not doctor_id:
        raise HTTPException(status_code=400, detail="doctor_id required")
    doctor = await db.doctors.find_one({"id": doctor_id})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Insert as token 0 (top priority) - shift others is not needed since we sort by token
    doc = {
        "id": str(uuid.uuid4()),
        "doctor_id": doctor_id,
        "doctor_name": doctor["full_name"],
        "patient_id": "emergency",
        "patient_name": patient_name,
        "date": today,
        "slot": "EMERGENCY",
        "token_number": 0,
        "status": "arrived",
        "payment_method": "pay_at_clinic",
        "payment_status": "pending",
        "prescription": None,
        "created_at": now_iso(),
    }
    await db.appointments.insert_one(doc)
    doc.pop("_id", None)
    await broadcast_doctor_update(doctor_id, "emergency_inserted")
    return doc


@api_router.post("/reception/add-patient")
async def reception_add_patient(body: AddPatientBody, user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner"))):
    """Receptionist adds a patient (with all details) and optionally books an appointment."""
    mobile = normalize_mobile(body.mobile)
    if not mobile or len(mobile) < 10:
        raise HTTPException(status_code=400, detail="Enter a valid mobile number")
    if not body.full_name or not body.full_name.strip():
        raise HTTPException(status_code=400, detail="Full name is required")

    # Find or create patient user
    existing = await db.users.find_one({"mobile": mobile})
    if existing:
        # Update details if missing
        updates = {}
        if body.age and not existing.get("age"):
            updates["age"] = body.age
        if body.gender and not existing.get("gender"):
            updates["gender"] = body.gender
        if body.address and not existing.get("address"):
            updates["address"] = body.address
        if updates:
            await db.users.update_one({"id": existing["id"]}, {"$set": updates})
        patient_id = existing["id"]
        patient_name = existing["full_name"]
    else:
        patient_id = str(uuid.uuid4())
        await db.users.insert_one({
            "id": patient_id,
            "email": None,
            "mobile": mobile,
            "phone": mobile,
            "password_hash": None,
            "full_name": body.full_name.strip(),
            "role": "patient",
            "phone_verified": False,
            "age": body.age,
            "gender": body.gender,
            "address": body.address,
            "added_by_reception": user["id"],
            "created_at": now_iso(),
        })
        patient_name = body.full_name.strip()

    # Optionally book appointment
    appt = None
    if body.doctor_id:
        doctor = await db.doctors.find_one({"id": body.doctor_id})
        if not doctor:
            raise HTTPException(status_code=404, detail="Doctor not found")
        
        appt_date = getattr(body, "date", None) or datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # Atomic duplicate check
        existing_appointment = await db.appointments.find_one({
            "$or": [
                {"patient_id": patient_id},
                {"patient_mobile": mobile},
            ],
            "date": appt_date,
            "status": {"$in": ["booked", "arrived", "in_consultation", "completed", "skipped"]},
        })
        if existing_appointment:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This patient already has an active appointment for today."
            )

        count = await db.appointments.count_documents({"doctor_id": body.doctor_id, "date": appt_date})
        appt_id = str(uuid.uuid4())
        secure_token = secrets.token_urlsafe(16)
        appt = {
            "id": appt_id,
            "secure_token": secure_token,
            "doctor_id": body.doctor_id,
            "doctor_name": doctor["full_name"],
            "patient_id": patient_id,
            "patient_name": patient_name,
            "patient_mobile": mobile,
            "date": appt_date,
            "slot": body.slot or "Walk-in",
            "token_number": count + 1,
            "status": "arrived",  # walk-in patient is already at clinic
            "payment_method": body.payment_method or "pay_at_clinic",
            "payment_status": "pending",
            "prescription": None,
            "symptoms": body.symptoms,
            "sms_status": "pending",
            "sms_last_sent_at": now_iso(),
            "created_at": now_iso(),
        }
        try:
            await db.appointments.insert_one(appt)
        except pymongo.errors.DuplicateKeyError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="This patient already has an active appointment for today."
            )

        # Trigger Renflair Transactional SMS V7
        eta_data = await calculate_appointment_eta(appt)
        dynamic_link = f"{get_app_public_url()}/appointment/{secure_token}"
        hour_val = format_renflair_hour(eta_data.get("expected_turn_time") or appt.get("slot"), default="2")
        try:
            sms_res = await send_appointment_sms(
                phone=mobile,
                oid=appt["token_number"],
                hour=hour_val,
                patient_name=patient_name,
                doctor_name=doctor["full_name"],
                token_number=appt["token_number"],
                estimated_time=eta_data.get("expected_turn_time") or "As per live queue",
                appointment_link=dynamic_link,
            )
            sms_status = "sent" if sms_res.get("ok") else "failed"
            await db.appointments.update_one({"id": appt_id}, {"$set": {"sms_status": sms_status}})
            appt["sms_status"] = sms_status
        except Exception as e:
            logger.warning(f"SMS sending failed (non-blocking): {e}")

        appt.pop("_id", None)
        await broadcast_doctor_update(body.doctor_id, "patient_added")

    return {
        "ok": True,
        "patient": {
            "id": patient_id,
            "full_name": patient_name,
            "mobile": mobile,
            "age": body.age,
            "gender": body.gender,
            "address": body.address,
        },
        "appointment": appt,
    }


@api_router.post("/reception/appointments/{appt_id}/send-link")
async def reception_send_appointment_link(
    appt_id: str,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner")),
):
    """Receptionist sends dynamic appointment link SMS to patient's phone with cooldown protection."""
    appt = await db.appointments.find_one({"id": appt_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")

    # Prevent accidental rapid duplicate SMS sends using cooldown mechanism
    enforce_send_sms_cooldown(appt_id)

    # Ensure secure_token is generated/reused
    secure_token = appt.get("secure_token")
    if not secure_token:
        secure_token = secrets.token_urlsafe(16)
        await db.appointments.update_one({"id": appt_id}, {"$set": {"secure_token": secure_token}})
        appt["secure_token"] = secure_token

    mobile = appt.get("patient_mobile")
    if not mobile:
        raise HTTPException(status_code=400, detail="Patient has no registered mobile number")

    # Fetch latest ETA using existing queue logic
    eta_data = await calculate_appointment_eta(appt)
    dynamic_link = f"{get_app_public_url()}/appointment/{secure_token}"
    hour_val = format_renflair_hour(eta_data.get("expected_turn_time") or appt.get("slot"), default="2")

    sms_res = await send_appointment_sms(
        phone=mobile,
        oid=appt.get("token_number", 1),
        hour=hour_val,
        patient_name=appt.get("patient_name", "Patient"),
        doctor_name=appt.get("doctor_name", "Doctor"),
        token_number=appt.get("token_number", 1),
        estimated_time=eta_data.get("expected_turn_time") or "As per live queue",
        appointment_link=dynamic_link,
    )
    sms_status = "sent" if sms_res.get("ok") else "failed"
    await db.appointments.update_one(
        {"id": appt_id},
        {"$set": {"sms_status": sms_status, "sms_last_sent_at": now_iso()}}
    )

    return {
        "ok": True,
        "message": f"Link sent to {mobile}",
        "sms_status": sms_status,
        "appointment_link": dynamic_link,
    }


# ============ WEBSOCKET ENDPOINTS ============
@app.websocket("/api/ws/queue/doctor/{doctor_id}")
async def ws_doctor_queue(ws: WebSocket, doctor_id: str):
    channel = f"doctor:{doctor_id}"
    await manager.connect(channel, ws)
    try:
        await ws.send_json({"type": "connected", "channel": channel})
        while True:
            # Client can ping to keep alive; we just consume
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"type": "pong", "ts": now_iso()})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.disconnect(channel, ws)


@app.websocket("/api/ws/queue/appt/{appointment_id}")
async def ws_appt_queue(ws: WebSocket, appointment_id: str):
    channel = f"appt:{appointment_id}"
    await manager.connect(channel, ws)
    try:
        await ws.send_json({"type": "connected", "channel": channel})
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"type": "pong", "ts": now_iso()})
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await manager.disconnect(channel, ws)


# ============ DOCTOR SELF-UPDATE ============
@api_router.post("/doctor/update_profile")
async def doctor_update_profile(body: DoctorSelfUpdateBody, user: dict = Depends(require_role("doctor"))):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True, "message": "No changes"}
    
    if "photo" in updates and updates["photo"]:
        validate_photo_size(updates["photo"])
    
    password_val = updates.pop("password", None)
    if password_val and password_val.strip():
        await db.users.update_one({"id": user["id"]}, {"$set": {"password_hash": hash_password(password_val.strip())}})
    
    if updates:
        await db.doctors.update_one({"user_id": user["id"]}, {"$set": updates})
    
    # If wait-time-affecting fields changed, broadcast to patients so their ETA refreshes live
    if "avg_consult_minutes" in updates or "timings" in updates or "fees" in updates:
        d = await db.doctors.find_one({"user_id": user["id"]}, {"_id": 0, "id": 1})
        if d:
            await broadcast_doctor_update(d["id"], "doctor_profile_updated")
    return {"ok": True, "updated": list(updates.keys()) + (["password"] if password_val else [])}


# ============ OWNER ENDPOINTS ============
@api_router.get("/owner/stats")
async def owner_stats(user: dict = Depends(require_role("owner", "admin"))):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # Run all independent counts in parallel
    total_doctors, total_patients, todays_appts, total_receptionists, completed_today = await asyncio.gather(
        db.doctors.count_documents({}),
        db.users.count_documents({"role": "patient"}),
        db.appointments.count_documents({"date": today}),
        db.users.count_documents({"role": "receptionist"}),
        db.appointments.find({"date": today, "status": "completed"}, {"_id": 0, "doctor_id": 1}).to_list(1000),
    )
    # Batch-fetch all doctor fees in one query to compute revenue
    revenue = 0
    if completed_today:
        unique_doc_ids = list({a["doctor_id"] for a in completed_today})
        docs_fees = await db.doctors.find(
            {"id": {"$in": unique_doc_ids}}, {"_id": 0, "id": 1, "fees": 1}
        ).to_list(len(unique_doc_ids))
        fees_map: dict = {d["id"]: d.get("fees", 0) for d in docs_fees}
        revenue = sum(fees_map.get(a["doctor_id"], 0) for a in completed_today)
    return {
        "total_doctors": total_doctors,
        "total_patients": total_patients,
        "total_receptionists": total_receptionists,
        "todays_appointments": todays_appts,
        "completed_today": len(completed_today),
        "revenue_today": revenue,
    }


@api_router.get("/owner/doctors")
async def owner_list_doctors(user: dict = Depends(require_role("owner", "admin"))):
    docs = await db.doctors.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    if not docs:
        return docs
    # Batch-count today's appointments per doctor in a single aggregation
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    doctor_ids = [d["id"] for d in docs]
    pipeline = [
        {"$match": {"doctor_id": {"$in": doctor_ids}, "date": today}},
        {"$group": {"_id": "$doctor_id", "count": {"$sum": 1}}},
    ]
    agg = await db.appointments.aggregate(pipeline).to_list(len(doctor_ids))
    appt_map: Dict[str, int] = {row["_id"]: row["count"] for row in agg}
    for d in docs:
        d["todays_appts"] = appt_map.get(d["id"], 0)
    return docs


@api_router.post("/owner/add-doctor")
async def owner_add_doctor(body: OwnerAddDoctorBody, user: dict = Depends(require_role("owner", "admin"))):
    # Ensure email not taken
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    if body.photo:
        validate_photo_size(body.photo)
    if body.id_proof_photo:
        validate_photo_size(body.id_proof_photo)
    if body.degree_photo:
        validate_photo_size(body.degree_photo)

    hid = (body.hospital_id or "H00001").strip().upper()
    user_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": user_id,
        "email": body.email.lower(),
        "password_hash": hash_password(body.password),
        "full_name": body.full_name,
        "role": "doctor",
        "phone": body.phone or body.mobile,
        "mobile": body.mobile or body.phone,
        "address": body.address,
        "hospital_id": hid,
        "gender": body.gender,
        "login_disabled": False,
        "status": "active",
        "created_by_owner": user["id"],
        "created_at": now_iso(),
    })
    doctor_id = str(uuid.uuid4())
    doc = {
        "id": doctor_id,
        "user_id": user_id,
        "full_name": body.full_name,
        "specialty": body.specialty,
        "city": body.city,
        "clinic_name": body.clinic_name,
        "fees": body.fees,
        "timings": body.timings,
        "rating": 4.5,
        "photo": body.photo,
        "bio": body.bio or "",
        "status": "active",
        "address": body.address,
        "phone": body.phone or body.mobile,
        "mobile": body.mobile or body.phone,
        "email": body.email.lower(),
        "degree": body.degree,
        "experience_years": body.experience_years,
        "id_proof_photo": body.id_proof_photo,
        "degree_photo": body.degree_photo,
        "avg_consult_minutes": body.avg_consult_minutes or 15,
        "hospital_id": hid,
        "gender": body.gender,
        "created_at": now_iso(),
    }
    await db.doctors.insert_one(doc)
    doc.pop("_id", None)
    await audit(user["id"], "owner.add_doctor", target=doctor_id, meta={"email": body.email.lower()})
    return {"ok": True, "doctor": doc}


@api_router.put("/owner/doctors/{doctor_id}")
async def owner_update_doctor(doctor_id: str, body: OwnerUpdateDoctorBody, user: dict = Depends(require_role("owner", "admin"))):
    doc_id = doctor_id.strip()
    d = await db.doctors.find_one({"$or": [{"id": doc_id}, {"user_id": doc_id}]})
    if not d:
        raise HTTPException(status_code=404, detail="Doctor not found")

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True}

    if "photo" in updates and updates["photo"]:
        validate_photo_size(updates["photo"])
    if "id_proof_photo" in updates and updates["id_proof_photo"]:
        validate_photo_size(updates["id_proof_photo"])
    if "degree_photo" in updates and updates["degree_photo"]:
        validate_photo_size(updates["degree_photo"])

    password_val = updates.pop("password", None)
    user_updates = {}
    if password_val and password_val.strip():
        user_updates["password_hash"] = hash_password(password_val.strip())
    if "full_name" in updates:
        user_updates["full_name"] = updates["full_name"]
    if "email" in updates and updates["email"]:
        user_updates["email"] = updates["email"].lower()
    if "hospital_id" in updates and updates["hospital_id"]:
        updates["hospital_id"] = updates["hospital_id"].strip().upper()
        user_updates["hospital_id"] = updates["hospital_id"]
    if "gender" in updates and updates["gender"]:
        user_updates["gender"] = updates["gender"]
    if "phone" in updates:
        user_updates["phone"] = updates["phone"]
        user_updates["mobile"] = updates["phone"]
    if "mobile" in updates:
        user_updates["mobile"] = updates["mobile"]
        user_updates["phone"] = updates["mobile"]

    if user_updates:
        await db.users.update_one({"id": d["user_id"]}, {"$set": user_updates})

    if updates:
        await db.doctors.update_one({"id": d["id"]}, {"$set": updates})

    # Broadcast if wait-time-affecting field changed
    if "avg_consult_minutes" in updates or "timings" in updates or "fees" in updates or "status" in updates:
        await broadcast_doctor_update(d["id"], "doctor_profile_updated")

    await audit(user["id"], "owner.update_doctor", target=d["id"])
    return {"ok": True, "updated": list(updates.keys()) + (["password"] if password_val else [])}


@api_router.delete("/owner/doctors/{doctor_id}")
@api_router.delete("/api/owner/doctors/{doctor_id}")
async def owner_delete_doctor(doctor_id: str, user: dict = Depends(require_role("owner", "admin"))):
    doc_id = doctor_id.strip()
    d = await db.doctors.find_one({"$or": [{"id": doc_id}, {"user_id": doc_id}, {"email": doc_id.lower()}]})
    u = None
    if not d:
        u = await db.users.find_one({"$or": [{"id": doc_id}, {"email": doc_id.lower()}], "role": "doctor"})
        if u:
            d = await db.doctors.find_one({"user_id": u["id"]})
    
    if not d and not u:
        return {"ok": True, "message": "Doctor already removed or not found"}
    
    actual_doc_id = d["id"] if d else doc_id
    user_id = d["user_id"] if d else (u["id"] if u else doc_id)
    doc_email = (d.get("email") if d else (u.get("email") if u else "")).lower()

    # Permanently delete from db.doctors collection
    await db.doctors.delete_many({"$or": [{"id": actual_doc_id}, {"id": doc_id}, {"user_id": user_id}, {"user_id": doc_id}]})

    # Permanently delete user account from db.users collection
    user_del_conditions: list = [{"id": user_id}, {"id": actual_doc_id}, {"id": doc_id}]
    if doc_email:
        user_del_conditions.append({"email": doc_email})
    await db.users.delete_many({"$or": user_del_conditions})

    # Disassociate receptionists linked to this doctor
    await db.users.update_many({"$or": [{"doctor_id": actual_doc_id}, {"doctor_id": doc_id}]}, {"$set": {"doctor_id": None, "doctor_name": None}})

    await audit(user["id"], "owner.delete_doctor", target=actual_doc_id)
    return {"ok": True, "message": "Doctor and user account permanently deleted from database"}


@api_router.post("/owner/hospitals")
async def create_hospital(body: dict, user: dict = Depends(require_role("owner", "admin"))):
    name = body.get("name", "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Hospital name is required")
    hid = (body.get("hospital_id") or f"HS{uuid.uuid4().hex[:4].upper()}").strip().upper()
    
    existing = await db.hospitals.find_one({"hospital_id": hid})
    if existing:
        raise HTTPException(status_code=400, detail="Hospital ID already exists")

    email = (body.get("email") or f"admin@{hid.lower()}.com").strip().lower()
    pwd = body.get("password") or "Hospital@123"

    doc = {
        "id": str(uuid.uuid4()),
        "hospital_id": hid,
        "name": name,
        "city": body.get("city", ""),
        "email": email,
        "password_hash": hash_password(pwd),
        "status": body.get("status", "active"),
        "created_at": now_iso()
    }
    await db.hospitals.insert_one(doc)
    doc.pop("_id", None)
    doc.pop("password_hash", None)
    return {"ok": True, "hospital": doc, "hospital_id": hid, "name": name, "status": "created"}


@api_router.get("/owner/hospitals")
async def list_hospitals(user: dict = Depends(require_role("owner", "admin"))):
    hosps = await db.hospitals.find({}, {"_id": 0, "password_hash": 0}).to_list(100)
    for h in hosps:
        hid = h.get("hospital_id")
        h["doctor_count"] = await db.doctors.count_documents({"hospital_id": hid})
        h["receptionist_count"] = await db.users.count_documents({"hospital_id": hid, "role": "receptionist"})
        if "status" not in h:
            h["status"] = "active"
    return hosps


@api_router.put("/owner/hospitals/{hospital_id}")
async def update_hospital(hospital_id: str, body: dict, user: dict = Depends(require_role("owner", "admin"))):
    updates = {}
    if "name" in body:
        updates["name"] = body["name"].strip()
    if "city" in body:
        updates["city"] = body["city"].strip()
    if "email" in body and body["email"].strip():
        updates["email"] = body["email"].strip().lower()
    if "password" in body and body["password"].strip():
        updates["password_hash"] = hash_password(body["password"].strip())
    if "status" in body:
        updates["status"] = body["status"]
    if updates:
        await db.hospitals.update_one({"hospital_id": hospital_id.strip().upper()}, {"$set": updates})
    return {"ok": True, "updated": list(updates.keys())}


@api_router.delete("/owner/hospitals/{hospital_id}")
@api_router.delete("/api/owner/hospitals/{hospital_id}")
async def delete_hospital(hospital_id: str, user: dict = Depends(require_role("owner", "admin"))):
    hid = hospital_id.strip().upper()
    await db.hospitals.delete_many({"$or": [{"hospital_id": hid}, {"id": hospital_id}]})
    # Also clean up doctors and staff belonging to this hospital ID
    await db.doctors.delete_many({"hospital_id": hid})
    await db.users.delete_many({"hospital_id": hid, "role": {"$in": ["doctor", "receptionist"]}})
    await audit(user["id"], "owner.delete_hospital", target=hid)
    return {"ok": True, "message": f"Hospital ID {hid} and associated staff permanently deleted from database"}


@api_router.get("/hospitals")
@api_router.get("/api/hospitals")
async def public_list_hospitals():
    return await db.hospitals.find({"status": {"$ne": "inactive"}}, {"_id": 0}).to_list(100)


@api_router.post("/owner/add-receptionist")
async def owner_add_receptionist(body: OwnerAddReceptionistBody, user: dict = Depends(require_role("owner", "admin"))):
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    rec_id = str(uuid.uuid4())
    doc_name = None
    if body.doctor_id:
        doc = await db.doctors.find_one({"id": body.doctor_id})
        if doc:
            doc_name = doc.get("full_name")

    m_val = body.mobile or body.phone or ""
    rec_user = {
        "id": rec_id,
        "full_name": body.full_name,
        "email": body.email.lower(),
        "password_hash": hash_password(body.password),
        "mobile": m_val,
        "phone": m_val,
        "role": "receptionist",
        "hospital_id": body.hospital_id.strip().upper(),
        "doctor_id": body.doctor_id,
        "doctor_name": doc_name,
        "login_disabled": False,
        "created_at": now_iso()
    }
    await db.users.insert_one(rec_user)
    rec_user.pop("_id", None)
    rec_user.pop("password_hash", None)
    return {"ok": True, "receptionist": rec_user}


@api_router.get("/owner/receptionists")
async def owner_list_receptionists(user: dict = Depends(require_role("owner", "admin"))):
    recs = await db.users.find({"role": "receptionist"}, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(200)
    hids = list({r["hospital_id"] for r in recs if r.get("hospital_id")})
    dids = list({r["doctor_id"] for r in recs if r.get("doctor_id")})
    hosps = await db.hospitals.find({"hospital_id": {"$in": hids}}, {"_id": 0}).to_list(len(hids) or 1)
    docs = await db.doctors.find({"id": {"$in": dids}}, {"_id": 0}).to_list(len(dids) or 1)
    h_map = {h["hospital_id"]: h.get("name") for h in hosps}
    d_map = {d["id"]: d.get("full_name") for d in docs}
    for r in recs:
        r["hospital_name"] = h_map.get(r.get("hospital_id"), r.get("hospital_id"))
        if r.get("doctor_id") and not r.get("doctor_name"):
            r["doctor_name"] = d_map.get(r.get("doctor_id"))
    return recs


@api_router.put("/owner/receptionists/{receptionist_id}")
@api_router.put("/api/owner/receptionists/{receptionist_id}")
async def owner_update_receptionist(receptionist_id: str, body: OwnerUpdateReceptionistBody, user: dict = Depends(require_role("owner", "admin"))):
    rec_id = receptionist_id.strip()
    r = await db.users.find_one({"$or": [{"id": rec_id}, {"email": rec_id.lower()}], "role": "receptionist"})
    if not r:
        raise HTTPException(status_code=404, detail="Receptionist not found")

    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True}

    if "photo" in updates and updates["photo"]:
        validate_photo_size(updates["photo"])

    password_val = updates.pop("password", None)
    if password_val and password_val.strip():
        updates["password_hash"] = hash_password(password_val.strip())

    if "email" in updates and updates["email"]:
        updates["email"] = updates["email"].lower()
    if "hospital_id" in updates and updates["hospital_id"]:
        updates["hospital_id"] = updates["hospital_id"].strip().upper()
    if "phone" in updates:
        updates["mobile"] = updates["phone"]
    if "mobile" in updates:
        updates["phone"] = updates["mobile"]

    if "doctor_id" in updates:
        if updates["doctor_id"]:
            doc = await db.doctors.find_one({"id": updates["doctor_id"]})
            updates["doctor_name"] = doc.get("full_name") if doc else None
        else:
            updates["doctor_id"] = None
            updates["doctor_name"] = None

    await db.users.update_one({"id": r["id"]}, {"$set": updates})
    await audit(user["id"], "owner.update_receptionist", target=r["id"])
    return {"ok": True, "updated": list(updates.keys()) + (["password"] if password_val else [])}


@api_router.delete("/owner/receptionists/{receptionist_id}")
@api_router.delete("/api/owner/receptionists/{receptionist_id}")
async def owner_delete_receptionist(receptionist_id: str, user: dict = Depends(require_role("owner", "admin"))):
    rec_id = receptionist_id.strip()
    r = await db.users.find_one({"$or": [{"id": rec_id}, {"email": rec_id.lower()}], "role": "receptionist"})
    if not r:
        return {"ok": True, "message": "Receptionist already removed or not found"}
    
    await db.users.delete_many({"$or": [{"id": r["id"]}, {"id": rec_id}, {"email": r.get("email", "").lower()}], "role": "receptionist"})
    await audit(user["id"], "owner.delete_receptionist", target=r["id"])
    return {"ok": True, "message": "Receptionist user permanently deleted from database"}


# ============ DOCTOR-SCOPED RECEPTIONIST MANAGEMENT ============
async def get_doctor_hospital_id(user: dict) -> str:
    hid = (user.get("hospital_id") or user.get("hospital_code") or "").strip().upper()
    if not hid:
        d = await db.doctors.find_one({"user_id": user.get("id")})
        if d:
            hid = (d.get("hospital_id") or "").strip().upper()
    return hid or "H00001"


@api_router.get("/doctor/receptionists")
@api_router.get("/api/doctor/receptionists")
async def doctor_list_receptionists(user: dict = Depends(require_role("doctor"))):
    hid = await get_doctor_hospital_id(user)
    recs = await db.users.find(
        {"role": "receptionist", "$or": [
            {"hospital_id": hid},
            {"hospital_id": {"$regex": f"^{hid}$", "$options": "i"}},
            {"doctor_id": user.get("id")},
            {"created_by_doctor": user.get("id")}
        ]},
        {"_id": 0, "password_hash": 0}
    ).sort("created_at", -1).to_list(100)
    return recs


@api_router.post("/doctor/add-receptionist")
@api_router.post("/api/doctor/add-receptionist")
async def doctor_add_receptionist(body: DoctorAddReceptionistBody, user: dict = Depends(require_role("doctor"))):
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    hid = await get_doctor_hospital_id(user)
    m_val = body.mobile or body.phone or ""
    rec_id = str(uuid.uuid4())
    
    rec_user = {
        "id": rec_id,
        "full_name": body.full_name,
        "email": body.email.lower(),
        "password_hash": hash_password(body.password),
        "mobile": m_val,
        "phone": m_val,
        "role": "receptionist",
        "hospital_id": hid,
        "doctor_id": user.get("id"),
        "doctor_name": user.get("full_name"),
        "login_disabled": False,
        "status": "active",
        "created_by_doctor": user.get("id"),
        "created_at": now_iso()
    }
    await db.users.insert_one(rec_user)
    rec_user.pop("_id", None)
    rec_user.pop("password_hash", None)
    await audit(user["id"], "doctor.add_receptionist", target=rec_id)
    return {"ok": True, "receptionist": rec_user}


@api_router.delete("/doctor/receptionists/{receptionist_id}")
@api_router.delete("/api/doctor/receptionists/{receptionist_id}")
async def doctor_delete_receptionist(receptionist_id: str, user: dict = Depends(require_role("doctor"))):
    hid = await get_doctor_hospital_id(user)
    rec_id = receptionist_id.strip()
    r = await db.users.find_one({"$or": [{"id": rec_id}, {"email": rec_id.lower()}], "role": "receptionist"})
    if not r:
        return {"ok": True, "message": "Receptionist already removed or not found"}
    
    r_hid = (r.get("hospital_id") or r.get("hospital_code") or "").strip().upper()
    is_assigned = (r.get("doctor_id") == user.get("id") or r.get("created_by_doctor") == user.get("id"))
    
    if r_hid and hid and r_hid != hid and not is_assigned:
        raise HTTPException(status_code=403, detail="Forbidden: Cannot delete receptionist from another hospital")
    
    await db.users.delete_many({"$or": [{"id": r["id"]}, {"id": rec_id}, {"email": r.get("email", "").lower()}], "role": "receptionist"})
    await audit(user["id"], "doctor.delete_receptionist", target=r["id"])
    return {"ok": True, "message": "Receptionist permanently deleted from database"}


# ============ SEED ============
@app.on_event("startup")
async def seed_data():
    logger.info("Initializing Admin user & database migrations...")
    try:
        await client.admin.command("ping")
    except Exception as exc:
        logger.warning("Skipping admin setup because MongoDB is unavailable: %s", exc)
        return

    # Run doctor specialist terminology normalization
    await migrate_doctor_specialty_terminology()

    # Seed Admin User (ranjeet7421@gmail.com, H00001)
    admin_email = "ranjeet7421@gmail.com"
    admin_user = await db.users.find_one({"email": admin_email})
    if not admin_user:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "password_hash": hash_password("Ranjeet@74"),
            "full_name": "Admin",
            "role": "admin",
            "hospital_id": "H00001",
            "hospital_code": "H00001",
            "status": "active",
            "login_disabled": False,
            "created_at": now_iso(),
        })
    else:
        await db.users.update_one(
            {"email": admin_email},
            {"$set": {
                "role": "admin",
                "hospital_id": "H00001",
                "hospital_code": "H00001",
                "password_hash": hash_password("Ranjeet@74"),
                "status": "active",
                "login_disabled": False,
            }}
        )

    logger.info("Admin user verified and specialties terminology migrated.")


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=r"https?://.*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
