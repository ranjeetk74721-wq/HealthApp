from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import re
import logging
import random
import asyncio
import httpx
import secrets
import hashlib
import pymongo
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal, Dict, Any
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
    from sms_service import send_appointment_sms, send_otp_sms, get_app_public_url, format_renflair_hour, get_sms_provider
except ImportError:
    from backend.sms_service import send_appointment_sms, send_otp_sms, get_app_public_url, format_renflair_hour, get_sms_provider

try:
    from rate_limiter import (
        enforce_booking_rate_limit,
        enforce_send_otp_rate_limit,
        enforce_verify_otp_rate_limit,
        enforce_send_sms_cooldown,
        enforce_general_ip_rate_limit,
        enforce_dev_test_sms_rate_limit,
        get_client_ip,
    )
except ImportError:
    from backend.rate_limiter import (
        enforce_booking_rate_limit,
        enforce_send_otp_rate_limit,
        enforce_verify_otp_rate_limit,
        enforce_send_sms_cooldown,
        enforce_general_ip_rate_limit,
        enforce_dev_test_sms_rate_limit,
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

def get_database():
    global client
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None

    try:
        motor_loop = client.get_io_loop()
        if motor_loop.is_closed() or (current_loop and motor_loop != current_loop):
            client = AsyncIOMotorClient(
                mongo_url,
                serverSelectionTimeoutMS=2000,
                connectTimeoutMS=2000,
            )
    except Exception:
        client = AsyncIOMotorClient(
            mongo_url,
            serverSelectionTimeoutMS=2000,
            connectTimeoutMS=2000,
        )
    return client[os.environ["DB_NAME"]]

class _DatabaseProxy:
    def __getattr__(self, name: str):
        return getattr(get_database(), name)
    def __getitem__(self, name: str):
        return get_database()[name]

db = _DatabaseProxy()

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

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    for err in errors:
        if err.get("type") in ("json_invalid", "value_error.jsondecode"):
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content={"ok": False, "detail": "Invalid or empty JSON body in request."}
            )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"ok": False, "detail": errors}
    )

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
    # LiveAir configuration validation at backend startup (Requirement 3)
    if os.environ.get("SMS_PROVIDER", "").strip().lower() == "liveair":
        try:
            from liveair_sms_service import validate_liveair_startup_config
            validate_liveair_startup_config()
        except Exception as e:
            logger.warning(f"LiveAir startup validation warning: {e}")

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
            # push subscriptions
            db.push_subscriptions.create_index([("token", 1)], unique=True),
            db.push_subscriptions.create_index([("user_id", 1), ("active", 1)]),
            db.push_subscriptions.create_index([("appointment_id", 1)]),
            # doctor sessions
            db.doctor_sessions.create_index([("id", 1)], unique=True),
            db.doctor_sessions.create_index([("doctor_id", 1), ("date", 1)]),
            db.doctor_sessions.create_index([("hospital_id", 1), ("date", 1)]),
            # token sequences: atomic sequential numbering per hospital, doctor, and date
            db.token_sequences.create_index([("id", 1)], unique=True),
            db.token_sequences.create_index([("hospital_id", 1), ("doctor_id", 1), ("date", 1)]),
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
    reason: Optional[str] = None


class ReorderBody(BaseModel):
    appointment_id: str
    new_position: int


class DoctorStatusBody(BaseModel):
    status: str  # active, paused, break, emergency


class PrescriptionBody(BaseModel):
    appointment_id: str
    prescription: str


class DoctorTimingAdjustBody(BaseModel):
    date: Optional[str] = None  # YYYY-MM-DD, defaults to today in IST
    new_start_time: Optional[str] = None  # e.g. "11:00 AM" or "11:30"
    delay_minutes: Optional[int] = None  # shortcut: 15, 30, or 60 minutes
    reason: Optional[str] = None
    expected_version: Optional[int] = None


class DoctorSessionStartBody(BaseModel):
    date: Optional[str] = None


class DoctorSessionPauseBody(BaseModel):
    date: Optional[str] = None
    expected_resume_time: Optional[str] = None
    pause_reason: Optional[str] = None


class DoctorSessionResumeBody(BaseModel):
    date: Optional[str] = None


class DoctorSessionEndBody(BaseModel):
    date: Optional[str] = None


class DoctorAvailabilityBody(BaseModel):
    status: Literal["available", "delayed", "on_break", "unavailable"]
    expected_time: Optional[str] = None  # Expected arrival or return time (e.g. "11:30 AM")
    reason: Optional[str] = None
    date: Optional[str] = None


class ReceptionRescheduleBody(BaseModel):
    appointment_id: str
    new_date: str
    new_slot: Optional[str] = "Walk-in"



# ---- Mobile OTP Auth models ----
class SendOTPBody(BaseModel):
    mobile: str
    force_otp: Optional[bool] = False


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


class DevTestSMSBody(BaseModel):
    phone: str



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


def format_12hr_time(val: Any) -> str:
    """Format datetime or time string into standard 12-hour AM/PM format (e.g. 2:00 PM, 11:30 AM).
    Guarantees:
    - 12-hour clock with AM/PM
    - Minutes always two digits
    - No 24-hour format
    - No minutes/hours wording like '120 min'
    - Accurate conversions:
      00:30 -> 12:30 AM
      12:00 -> 12:00 PM
      13:00 -> 1:00 PM
      14:30 -> 2:30 PM
      23:30 -> 11:30 PM
    """
    if val is None:
        return ""
    if isinstance(val, datetime):
        hr = val.strftime("%I").lstrip("0") or "12"
        return f"{hr}:{val.strftime('%M')} {val.strftime('%p')}"

    val_str = str(val).strip()
    if not val_str:
        return ""
    if val_str.lower() in ("now", "consultation completed", "completed"):
        return val_str

    # 12hr format: e.g. "2:30 PM" or "02:30 PM"
    m_12 = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$", val_str, re.IGNORECASE)
    if m_12:
        hr = str(int(m_12.group(1)))
        return f"{hr}:{m_12.group(2)} {m_12.group(3).upper()}"

    # 24hr format: e.g. "14:30" or "00:30" or "13:00:00"
    m_24 = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", val_str)
    if m_24:
        hr_24 = int(m_24.group(1))
        minute = m_24.group(2)
        ampm = "PM" if hr_24 >= 12 else "AM"
        hr_12 = hr_24 % 12
        if hr_12 == 0:
            hr_12 = 12
        return f"{hr_12}:{minute} {ampm}"

    return val_str


def format_expected_time_range(start: Any, end: Optional[Any] = None) -> str:
    """Format start and end times into standard 12-hour AM/PM time range:
    '2:00 PM – 2:30 PM'
    Rule: If start and end are identical, returns '2:00 PM' without duplicate.
    Also handles single string range inputs like '14:00 - 14:30' or '10:00 – 10:45'.
    If start is a minute duration (e.g. 15, '15m', '15 min'), computes clock window from current IST time.
    """
    if start is None and end is None:
        return ""

    # If start is a minute number or duration string like 15 or '15 min' or '~15m'
    if isinstance(start, (int, float)) or (isinstance(start, str) and re.match(r"^~?\d+\s*(?:m|min|mins|minute|minutes)?$", str(start).strip(), re.I)):
        m_val = int(re.sub(r"\D", "", str(start)) or 0)
        if m_val <= 0:
            return "Available Now"
        ist_now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
        f_dt = ist_now + timedelta(minutes=m_val)
        e_dt = f_dt + timedelta(minutes=30)
        return f"{format_12hr_time(f_dt)} – {format_12hr_time(e_dt)}"

    if isinstance(start, str) and not end:
        sep = " – " if " – " in start else (" - " if " - " in start else None)
        if sep:
            parts = start.split(sep, 1)
            s_part = format_12hr_time(parts[0].strip())
            e_part = format_12hr_time(parts[1].strip())
            if not e_part or s_part == e_part:
                return s_part
            return f"{s_part} – {e_part}"

    start_str = format_12hr_time(start)
    if not end:
        return start_str
    end_str = format_12hr_time(end)

    if not start_str:
        return end_str
    if not end_str or start_str == end_str:
        return start_str

    return f"{start_str} – {end_str}"


def format_clock_time(dt: datetime) -> str:
    """Format datetime into 12-hour clock format with AM/PM (e.g. 1:00 PM, 10:30 AM)."""
    return format_12hr_time(dt)


def parse_time_to_ist_dt(date_str: str, time_str: str) -> Optional[datetime]:
    """Parse date ('YYYY-MM-DD') and time string ('10:00 AM', '10 AM', '14:30', etc.) into an IST-aware datetime."""
    if not date_str or not time_str:
        return None
    time_str = str(time_str).strip()
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
    except Exception:
        return None

    # Check 12-hour format: 10:00 AM, 10 AM, 02:30 PM, 2 PM, 10:00AM
    m12 = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$", time_str, re.IGNORECASE)
    if m12:
        hr = int(m12.group(1))
        minute = int(m12.group(2) or 0)
        meridiem = m12.group(3).upper()
        if meridiem == "PM" and hr < 12:
            hr += 12
        elif meridiem == "AM" and hr == 12:
            hr = 0
        try:
            return datetime(d.year, d.month, d.day, hr, minute, 0, tzinfo=tz_ist)
        except Exception:
            return None

    # Check 24-hour format: 14:30, 09:15, 10:00, 10
    m24 = re.match(r"^(\d{1,2})(?::(\d{2}))?$", time_str)
    if m24:
        hr = int(m24.group(1))
        minute = int(m24.group(2) or 0)
        try:
            return datetime(d.year, d.month, d.day, hr, minute, 0, tzinfo=tz_ist)
        except Exception:
            return None

    return None


def extract_session_start_time(timings_str: Optional[str]) -> str:
    """Extract standard 12-hour start time from timings string (e.g. '10:00 AM - 6:00 PM' -> '10:00 AM')."""
    if not timings_str:
        return "10:00 AM"
    m = re.search(r"(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)", timings_str, re.IGNORECASE)
    if m:
        extracted = m.group(1).strip()
        formatted = format_12hr_time(extracted)
        if formatted:
            return formatted
    return "10:00 AM"

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


async def get_current_user_optional(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Optional[dict]:
    if not creds:
        return None
    try:
        payload = jwt.decode(creds.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
        return user
    except Exception:
        return None


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


# ============ PUSH NOTIFICATION HELPERS & WEB PUSH ============
def get_ist_now() -> datetime:
    """Return current Indian Standard Time (UTC+5:30)."""
    return datetime.now(timezone(timedelta(hours=5, minutes=30)))


def format_ist_12hr(dt: Optional[datetime] = None) -> str:
    """Format datetime into standard 12-hour AM/PM string in clinic timezone: e.g. '3:50 PM'."""
    if dt is None:
        dt = get_ist_now()
    formatted = dt.strftime("%I:%M %p")
    return formatted.lstrip("0") if formatted.startswith("0") else formatted


class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str


class PushSubscribeBody(BaseModel):
    token: str
    platform: str = "web"
    user_agent: Optional[str] = None
    appointment_id: Optional[str] = None
    appointment_token: Optional[str] = None


class PushUnsubscribeBody(BaseModel):
    token: str


async def allocate_next_token(hospital_id: Optional[str], doctor_id: str, appt_date: str) -> int:
    """
    Atomically allocates sequential token (starting from 1) for a doctor on a specific date in Asia/Kolkata timezone.
    Guarantees no duplicate tokens during simultaneous online bookings and walk-ins.
    """
    if not hospital_id:
        doc = await db.doctors.find_one({"id": doctor_id}, {"_id": 0, "hospital_id": 1})
        hospital_id = (doc or {}).get("hospital_id") or "default"

    seq_id = f"{hospital_id}_{doctor_id}_{appt_date}"

    # If sequence document does not exist, initialize last_token from existing max token in appointments
    existing_seq = await db.token_sequences.find_one({"id": seq_id})
    if existing_seq is None:
        max_appt = await db.appointments.find(
            {"doctor_id": doctor_id, "date": appt_date},
            {"token_number": 1}
        ).sort("token_number", -1).to_list(1)
        initial_val = max_appt[0]["token_number"] if max_appt and max_appt[0].get("token_number") else 0
        try:
            await db.token_sequences.update_one(
                {"id": seq_id},
                {"$setOnInsert": {
                    "id": seq_id,
                    "hospital_id": hospital_id,
                    "doctor_id": doctor_id,
                    "date": appt_date,
                    "last_token": initial_val,
                    "created_at": now_iso(),
                }},
                upsert=True,
            )
        except Exception:
            pass

    res = await db.token_sequences.find_one_and_update(
        {"id": seq_id},
        {"$inc": {"last_token": 1}, "$set": {"updated_at": now_iso()}},
        upsert=True,
        return_document=pymongo.ReturnDocument.AFTER,
    )
    return int(res.get("last_token", 1))


async def get_or_create_doctor_session(doctor_id: str, date: str) -> dict:
    """Fetch existing doctor session for given date or create and persist default session."""
    session_id = f"{doctor_id}_{date}"
    if not hasattr(db, "doctor_sessions") or not hasattr(db.doctor_sessions, "find_one"):
        return {
            "id": session_id,
            "doctor_id": doctor_id,
            "date": date,
            "original_start_time": "10:00 AM",
            "expected_start_time": "10:00 AM",
            "status": "not_started",
            "version": 1,
        }
    session = await db.doctor_sessions.find_one({"id": session_id}, {"_id": 0})
    if session:
        return session

    # Fetch doctor profile to seed original start time and hospital_id
    doctor = await db.doctors.find_one(
        {"id": doctor_id},
        {"_id": 0, "timings": 1, "hospital_id": 1, "full_name": 1, "clinic_name": 1, "status": 1}
    )
    timings = (doctor or {}).get("timings", "10:00 AM - 6:00 PM")
    orig_start = extract_session_start_time(timings)
    hospital_id = (doctor or {}).get("hospital_id")

    # Check appointments for today
    all_appts = await db.appointments.find(
        {"doctor_id": doctor_id, "date": date, "status": {"$ne": "cancelled"}},
        {"_id": 0, "status": 1}
    ).to_list(500)

    has_in_consult = any(a.get("status") == "in_consultation" for a in all_appts)
    has_completed = any(a.get("status") == "completed" for a in all_appts)
    all_completed = bool(all_appts and all(a.get("status") == "completed" for a in all_appts))

    init_status = "not_started"
    if all_completed:
        init_status = "completed"
    elif has_in_consult or has_completed:
        init_status = "in_consultation"
    elif (doctor or {}).get("status") == "paused":
        init_status = "paused"

    session = {
        "id": session_id,
        "doctor_id": doctor_id,
        "hospital_id": hospital_id,
        "date": date,
        "original_start_time": orig_start,
        "expected_start_time": orig_start,
        "actual_start_time": format_ist_12hr() if (has_in_consult or has_completed) else None,
        "status": init_status,
        "delay_reason": None,
        "paused_at": None,
        "expected_resume_time": None,
        "pause_reason": None,
        "version": 1,
        "history": [],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    try:
        await db.doctor_sessions.update_one({"id": session_id}, {"$setOnInsert": session}, upsert=True)
    except Exception:
        pass

    saved = await db.doctor_sessions.find_one({"id": session_id}, {"_id": 0})
    return saved or session


async def calculate_appointment_eta(appt: dict) -> dict:
    """Calculate live queue metrics and latest estimated turn time for an appointment."""
    all_appts = await db.appointments.find(
        {"doctor_id": appt["doctor_id"], "date": appt["date"], "status": {"$ne": "cancelled"}},
        {"_id": 0},
    ).sort([("queue_order", 1), ("token_number", 1)]).to_list(500)

    # Exclude completed, cancelled, and skipped patients from active waiting-time calculation
    active = [a for a in all_appts if a.get("status") in ("booked", "arrived", "in_consultation")]
    current = next((a for a in all_appts if a.get("status") == "in_consultation"), None)
    completed_count = len([a for a in all_appts if a.get("status") == "completed"])

    my_token = appt.get("token_number", 0)
    my_order = appt.get("queue_order", my_token)

    # Active waiting patients ahead of this appointment
    active_waiting = [a for a in active if a.get("status") in ("booked", "arrived")]
    active_ahead = [
        a for a in active_waiting
        if (a.get("queue_order", a.get("token_number", 0)) < my_order)
    ]

    # Separate values: Your token, Now consulting, Patients ahead
    if appt.get("status") == "in_consultation":
        patients_ahead = 0
        my_position = 0
    elif appt.get("status") in ("booked", "arrived"):
        patients_ahead = len(active_ahead) + (1 if current and current.get("id") != appt.get("id") else 0)
        my_position = sum(1 for a in active if a.get("token_number", 0) <= appt.get("token_number", 0))
    else:
        patients_ahead = 0
        my_position = -1

    # Fetch doctor details (duration estimate: configurable, 5-minute default)
    doctor = await db.doctors.find_one({"id": appt["doctor_id"]}, {"_id": 0, "avg_consult_minutes": 1, "status": 1, "full_name": 1, "clinic_name": 1})
    doc_status = (doctor or {}).get("status", "active")
    per = int((doctor or {}).get("avg_consult_minutes") or 5)

    # Fetch doctor session
    appt_date = appt.get("date") or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(appt["doctor_id"], appt_date)

    eta_minutes = 0
    expected_turn_time = None
    is_delayed_awaited = False
    is_estimate_pending = False
    is_delayed = bool(
        session.get("expected_start_time")
        and session.get("original_start_time")
        and session.get("expected_start_time") != session.get("original_start_time")
    )

    ist_now = get_ist_now()

    # Progress of current consultation
    rem_current = per
    if current:
        started_iso = current.get("started_at")
        if started_iso:
            try:
                st_dt = datetime.fromisoformat(started_iso.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=5, minutes=30)))
                elapsed_min = max(0, int((ist_now - st_dt).total_seconds() / 60))
                rem_current = max(1, per - elapsed_min)
            except Exception:
                rem_current = max(1, per // 2)

    has_consultation_occurred = bool(completed_count > 0 or current is not None or session.get("actual_start_time"))
    session_status = session.get("status", "not_started")
    if current is not None or session.get("actual_start_time"):
        if session_status != "paused":
            session_status = "in_consultation"
    elif doc_status in ("paused", "unavailable"):
        session_status = doc_status

    if my_position == 0 and appt.get("status") == "in_consultation":
        expected_turn_time = "Now"
        eta_minutes = 0
    elif my_position > 0:
        if doc_status == "unavailable" or session_status == "unavailable":
            # Requirement: If doctor return time is unknown, show "Doctor unavailable — estimate pending"
            expected_turn_time = "Doctor unavailable — estimate pending"
            is_estimate_pending = True
            is_delayed_awaited = True
            eta_minutes = 0
        elif session_status == "paused" or doc_status == "paused":
            exp_resume_str = session.get("expected_resume_time")
            resume_dt = parse_time_to_ist_dt(appt_date, exp_resume_str) if exp_resume_str else None
            if resume_dt and resume_dt > ist_now:
                pos = len(active_ahead)
                if not has_consultation_occurred:
                    if pos == 0:
                        patient_start_dt = resume_dt
                        patient_end_dt = resume_dt + timedelta(minutes=10)
                    else:
                        patient_start_dt = resume_dt + timedelta(minutes=10 + (pos - 1) * 20)
                        patient_end_dt = patient_start_dt + timedelta(minutes=20)
                else:
                    patient_start_dt = resume_dt + timedelta(minutes=pos * 20)
                    patient_end_dt = patient_start_dt + timedelta(minutes=20)
                expected_turn_time = format_expected_time_range(patient_start_dt, patient_end_dt)
                eta_minutes = max(0, int((patient_start_dt - ist_now).total_seconds() / 60))
            else:
                expected_turn_time = "Doctor paused — resume time awaited"
                is_delayed_awaited = True
                is_estimate_pending = True
                eta_minutes = 0
        elif not has_consultation_occurred:
            exp_start_str = session.get("expected_start_time") or session.get("original_start_time") or "10:00 AM"
            start_dt = parse_time_to_ist_dt(appt_date, exp_start_str)
            if not start_dt:
                start_dt = ist_now
            is_today = (appt_date == ist_now.strftime("%Y-%m-%d"))

            is_first_eligible = (len(active_ahead) == 0)
            if is_today and start_dt < ist_now:
                expected_turn_time = "Doctor delayed—updated time awaited"
                is_delayed_awaited = True
                is_estimate_pending = True
                eta_minutes = 0
            elif is_first_eligible:
                # Requirement 4: First eligible waiting token gets initial expected consultation window of exactly 10 minutes from configured start time
                patient_start_dt = start_dt
                patient_end_dt = start_dt + timedelta(minutes=10)
                expected_turn_time = format_expected_time_range(patient_start_dt, patient_end_dt)
                eta_minutes = max(0, int((patient_start_dt - ist_now).total_seconds() / 60)) if is_today else 0
            else:
                # Remaining waiting tokens sequenced with 20-minute gap/consultation window
                pos = len(active_ahead)
                patient_start_dt = start_dt + timedelta(minutes=10 + (pos - 1) * 20)
                patient_end_dt = patient_start_dt + timedelta(minutes=20)
                expected_turn_time = format_expected_time_range(patient_start_dt, patient_end_dt)
                eta_minutes = max(0, int((patient_start_dt - ist_now).total_seconds() / 60)) if is_today else 0
        else:
            # Active in_consultation queue: driven by actual consultation events and progression
            if current:
                started_iso = current.get("started_at")
                elapsed_min = 0
                if started_iso:
                    try:
                        st_dt = datetime.fromisoformat(started_iso.replace("Z", "+00:00")).astimezone(timezone(timedelta(hours=5, minutes=30)))
                        elapsed_min = max(0, int((ist_now - st_dt).total_seconds() / 60))
                    except Exception:
                        pass
                rem_current = max(1, 20 - elapsed_min)
                base_dt = ist_now + timedelta(minutes=rem_current)
            else:
                base_dt = ist_now

            pos = len(active_ahead)
            patient_start_dt = base_dt + timedelta(minutes=pos * 20)
            patient_end_dt = patient_start_dt + timedelta(minutes=20)
            expected_turn_time = format_expected_time_range(patient_start_dt, patient_end_dt)
            eta_minutes = max(0, int((patient_start_dt - ist_now).total_seconds() / 60))
    elif appt.get("slot") and appt.get("slot") != "Walk-in":
        slot_str = appt.get("slot", "")
        expected_turn_time = format_12hr_time(slot_str) or None
    else:
        expected_turn_time = None
        eta_minutes = 0

    # Construct delay notice
    delay_notice = None
    if session_status in ("unavailable",):
        delay_notice = "Doctor unavailable — estimate pending. डॉक्टर फिलहाल उपलब्ध नहीं हैं — समय की प्रतीक्षा है।"
    elif session.get("status") == "not_started":
        if is_delayed_awaited:
            delay_notice = "Doctor delayed—updated time awaited. डॉक्टर के परामर्श शुरू होने में देरी है—नए समय की प्रतीक्षा है।"
        elif is_delayed:
            delay_notice = (
                f"Doctor ke consultation start hone mein deri hai. "
                f"Naya expected start time: {session.get('expected_start_time')}. "
                f"Aapka updated estimated time: {expected_turn_time}."
            )
    elif session.get("status") == "paused":
        delay_notice = (
            f"Doctor consultation is paused. "
            f"{'Reason: ' + session['pause_reason'] + '. ' if session.get('pause_reason') else ''}"
            f"{'Expected resume: ' + session['expected_resume_time'] + '.' if session.get('expected_resume_time') else 'Resume time awaited.'}"
        )
    elif is_estimate_pending:
        delay_notice = "Doctor unavailable — estimate pending. डॉक्टर फिलहाल उपलब्ध नहीं हैं — समय की प्रतीक्षा है।"

    eta_label = expected_turn_time
    if expected_turn_time and ("AM" in expected_turn_time or "PM" in expected_turn_time):
        eta_label = f"Estimated {expected_turn_time}"

    return {
        "your_token": appt.get("token_number"),
        "now_consulting": current["token_number"] if current else None,
        "patients_ahead": patients_ahead,
        "expected_turn_time": expected_turn_time,
        "eta_label": eta_label,
        "is_estimate_pending": is_estimate_pending,
        "my_position": my_position,
        "eta_minutes": eta_minutes,
        "currently_serving": current["token_number"] if current else None,
        "completed_count": completed_count,
        "total_in_queue": len(active),
        "doctor_status": doc_status,
        "session_status": session_status,
        "original_start_time": session.get("original_start_time"),
        "expected_start_time": session.get("expected_start_time"),
        "actual_start_time": session.get("actual_start_time"),
        "delay_reason": session.get("delay_reason"),
        "is_delayed": is_delayed,
        "is_delayed_awaited": is_delayed_awaited,
        "delay_notice": delay_notice,
        "expected_resume_time": session.get("expected_resume_time"),
        "pause_reason": session.get("pause_reason"),
        "session_version": session.get("version", 1),
    }


async def send_fcm_web_push(
    recipients: List[str],
    title: str,
    body: str,
    action_url: str = "/patient/queue",
    tag: Optional[str] = None,
    extra_data: Optional[dict] = None,
) -> dict:
    """Delivers Web Push notification to active device tokens of recipient users via Firebase Cloud Messaging."""
    if not recipients:
        return {"sent": 0, "failed": 0}

    init_firebase_admin_if_available()

    # Query active subscriptions for these users or appointments
    subs = await db.push_subscriptions.find(
        {
            "$or": [
                {"user_id": {"$in": recipients}},
                {"appointment_id": {"$in": recipients}},
            ],
            "active": True,
        },
        {"_id": 0, "token": 1, "user_id": 1, "platform": 1},
    ).to_list(500)

    # Deduplicate subscriptions by device token so the same physical device never receives duplicate notifications
    seen_tokens = set()
    unique_subs = []
    for sub in subs:
        t = sub.get("token")
        if t and t not in seen_tokens:
            seen_tokens.add(t)
            unique_subs.append(sub)

    if not unique_subs:
        logger.debug(f"[WebPush] No valid tokens for recipients: {recipients}")
        return {"sent": 0, "failed": 0}

    # Record push attempt in log for auditing and tracking
    log_doc = {
        "id": str(uuid.uuid4()),
        "recipients": recipients,
        "title": title,
        "body": body,
        "action_url": action_url,
        "token_count": len(unique_subs),
        "sent_at": now_iso(),
    }
    try:
        await db.push_notifications_log.insert_one(log_doc)
    except Exception:
        pass

    global FIREBASE_ADMIN_AVAILABLE, _firebase_admin_app
    if not FIREBASE_ADMIN_AVAILABLE:
        logger.error(
            f"[WebPush Configuration Error] Firebase Admin SDK or credentials not configured. "
            f"Cannot deliver Web Push notifications to {len(unique_subs)} device(s)."
        )
        return {
            "sent": 0,
            "failed": len(unique_subs),
            "simulated": True,
            "error": "Firebase Admin SDK not configured",
        }

    try:
        from firebase_admin import messaging
    except Exception as e:
        logger.warning(f"firebase_admin.messaging import error: {e}")
        return {"sent": 0, "failed": len(unique_subs), "error": str(e)}

    # Ensure canonical URL for FCM options link
    public_base = get_app_public_url()
    full_action_url = action_url if action_url.startswith("http") else f"{public_base}{action_url}"

    sent_count = 0
    failed_count = 0
    invalid_tokens = []

    for sub in unique_subs:
        token = sub.get("token")
        if not token:
            continue
        try:
            webpush_config = messaging.WebpushConfig(
                notification=messaging.WebpushNotification(
                    title=title,
                    body=body,
                    icon="/assets/images/icon.png",
                    badge="/assets/images/favicon.png",
                    tag=tag or "meribaari-queue",
                    renotify=True,
                    require_interaction=True,
                    custom_data={"url": action_url, "full_url": full_action_url, **(extra_data or {})},
                ),
                fcm_options=messaging.WebpushFCMOptions(link=full_action_url),
                headers={"Urgency": "high", "TTL": "86400"},
            )
            msg = messaging.Message(
                token=token,
                notification=messaging.Notification(title=title, body=body),
                data={"title": title, "body": body, "url": action_url, "full_url": full_action_url, **(extra_data or {})},
                webpush=webpush_config,
            )
            messaging.send(msg)
            sent_count += 1
        except (messaging.UnregisteredError, messaging.SenderIdMismatchError) as err:
            logger.info(f"Push token expired/unregistered: {token[:12]}... ({err})")
            invalid_tokens.append(token)
            failed_count += 1
        except Exception as e:
            err_str = str(e).lower()
            if "invalid registration token" in err_str or "registration-token-not-registered" in err_str:
                invalid_tokens.append(token)
            logger.warning(f"Push delivery error for token {token[:12]}...: {e}")
            failed_count += 1

    # Cleanup expired or unregistered device tokens automatically
    if invalid_tokens:
        try:
            await db.push_subscriptions.update_many(
                {"token": {"$in": invalid_tokens}},
                {"$set": {"active": False, "deactivated_at": now_iso()}},
            )
        except Exception as e:
            logger.warning(f"Error marking invalid push tokens: {e}")

    return {"sent": sent_count, "failed": failed_count}



async def send_push(recipients: List[str], data: dict, idempotency_key: Optional[str] = None) -> None:
    """Unified push dispatcher — sends via FCM Web Push to registered devices."""
    if not recipients or not data:
        return
    title = data.get("title", "MeriBaari Queue Alert")
    message = data.get("message") or data.get("body") or ""
    action_url = data.get("action_url") or data.get("url") or "/patient/queue"
    try:
        await send_fcm_web_push(
            recipients=recipients,
            title=title,
            body=message,
            action_url=action_url,
            tag=idempotency_key,
            extra_data=data,
        )
    except Exception as e:
        logger.warning(f"send_push error: {e}")


async def notify_appointment_booked(appt: dict, doctor: dict, eta_data: dict) -> None:
    """Send push notification on successful booking if patient has active push subscriptions."""
    try:
        pid = appt.get("patient_id")
        if not pid or pid == "emergency":
            return
        sub_count = await db.push_subscriptions.count_documents({"user_id": pid, "active": True})
        if sub_count == 0:
            return

        hospital_name = doctor.get("hospital_name") or doctor.get("clinic_name") or "MeriBaari Clinic"
        token_num = appt.get("token_number")
        current_serving = eta_data.get("currently_serving")
        serving_display = f"#{current_serving}" if current_serving is not None else "Not started yet"
        eta_display = eta_data.get("expected_turn_time") or "Estimated time updating"
        time_str = format_ist_12hr()
        sec_token = appt.get("secure_token")
        target_url = f"/appointment/{sec_token}" if sec_token else "/patient/queue"

        body_lines = [
            f"Your Token: {token_num}",
            f"Now Serving: {serving_display}",
            f"Estimated Turn: {eta_display}",
            f"Updated: {time_str}",
            "Tap to view live queue.",
        ]
        await send_fcm_web_push(
            recipients=[pid],
            title=f"{hospital_name} — MeriBaari",
            body="\n".join(body_lines),
            action_url=target_url,
            tag=f"booking-{appt['id']}",
            extra_data={"token_number": str(token_num), "event": "booked"},
        )
        await db.appointments.update_one(
            {"id": appt["id"]},
            {"$set": {
                "notifications_sent.booked": True,
                "notifications_sent.last_eta_minutes": eta_data.get("eta_minutes", 0),
            }},
        )
    except Exception as e:
        logger.warning(f"notify_appointment_booked error: {e}")


async def send_welcome_status_if_needed(
    user_id: str,
    device_token: str,
    appointment_id: Optional[str] = None,
    secure_token: Optional[str] = None,
) -> None:
    """If patient enables notifications after booking, send one current appointment-status
    notification instead of a duplicate booking confirmation.
    """
    try:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        query: dict = {}
        if appointment_id:
            query["id"] = appointment_id
        elif secure_token:
            query["secure_token"] = secure_token
        else:
            query = {
                "patient_id": user_id,
                "date": today,
                "status": {"$in": ["booked", "arrived", "in_consultation"]},
            }

        appt = await db.appointments.find_one(query)
        if not appt:
            return

        notifs = appt.get("notifications_sent") or {}
        if notifs.get("status_welcomed") or notifs.get("booked"):
            return

        doctor = await db.doctors.find_one({"id": appt["doctor_id"]}, {"_id": 0})
        hospital_name = (doctor or {}).get("hospital_name") or (doctor or {}).get("clinic_name") or "MeriBaari Clinic"
        token_num = appt.get("token_number")
        eta_data = await calculate_appointment_eta(appt)
        current_serving = eta_data.get("currently_serving")
        serving_display = f"#{current_serving}" if current_serving is not None else "Not started yet"
        eta_display = eta_data.get("expected_turn_time") or "Estimated time updating"
        time_str = format_ist_12hr()
        sec_token = appt.get("secure_token")
        target_url = f"/appointment/{sec_token}" if sec_token else "/patient/queue"

        body_lines = [
            f"Your Token: {token_num}",
            f"Now Serving: {serving_display}",
            f"Estimated Turn: {eta_display}",
            f"Updated: {time_str}",
            "Tap to view live queue.",
        ]
        recipients = [r for r in [appt.get("patient_id"), appt.get("id"), user_id] if r and r != "emergency"]
        await send_fcm_web_push(
            recipients=recipients,
            title=f"{hospital_name} — MeriBaari",
            body="\n".join(body_lines),
            action_url=target_url,
            tag=f"status-{appt['id']}",
            extra_data={"token_number": str(token_num), "event": "status_welcomed"},
        )
        await db.appointments.update_one(
            {"id": appt["id"]},
            {"$set": {
                "notifications_sent.status_welcomed": True,
                "notifications_sent.last_eta_minutes": eta_data.get("eta_minutes", 0),
            }},
        )
    except Exception as e:
        logger.warning(f"send_welcome_status_if_needed error: {e}")


async def notify_queue_movement(doctor_id: str) -> None:
    """Fire Web Push notifications when queue moves:
    - Exactly 5 patients ahead
    - Exactly 2 patients ahead
    - Next patient (1 ahead)
    - Patient called (in_consultation)
    - Meaningful ETA change (>= 10 min threshold)
    Authoritative queue order is derived from actual eligible appointments.
    """
    today = get_ist_now().strftime("%Y-%m-%d")
    try:
        doctor = await db.doctors.find_one({"id": doctor_id}, {"_id": 0})
        if not doctor:
            return
        hospital_name = doctor.get("hospital_name") or doctor.get("clinic_name") or "MeriBaari Clinic"
        doc_name = doctor.get("full_name", "").replace("Dr. ", "")

        # Fetch all today's appointments for this doctor, ordered by queue_order and token_number
        all_appts = await db.appointments.find(
            {"doctor_id": doctor_id, "date": today, "status": {"$nin": ["cancelled"]}},
            {"_id": 0},
        ).sort([("queue_order", 1), ("token_number", 1)]).to_list(500)

        # Active eligible queue: booked, arrived
        # Completed / skipped / cancelled are excluded from ahead count
        current_in_consultation = next((a for a in all_appts if a.get("status") == "in_consultation"), None)
        currently_serving_token = current_in_consultation.get("token_number") if current_in_consultation else None
        serving_display = f"#{currently_serving_token}" if currently_serving_token is not None else "Not started yet"

        # 1. Check current in_consultation patient: called notification
        if current_in_consultation and current_in_consultation.get("patient_id") and current_in_consultation["patient_id"] != "emergency":
            c_notifs = current_in_consultation.get("notifications_sent") or {}
            if not c_notifs.get("called"):
                time_str = format_ist_12hr()
                token_num = current_in_consultation.get("token_number")
                body_lines = [
                    "🎉 It's your turn now! Doctor is ready for you.",
                    f"Your Token: {token_num}",
                    f"Now Consulting: #{token_num}",
                    f"Patients Ahead: 0",
                    f"Estimated Consultation: Now Consulting",
                    "Tap to view your live queue.",
                ]
                sec_token = current_in_consultation.get("secure_token")
                target_url = f"/appointment/{sec_token}" if sec_token else "/patient/queue"
                recipients = [r for r in [current_in_consultation.get("patient_id"), current_in_consultation.get("id")] if r and r != "emergency"]
                await send_fcm_web_push(
                    recipients=recipients,
                    title="MeriBaari — Queue Update",
                    body="\n".join(body_lines),
                    action_url=target_url,
                    tag=f"meribaari-queue-{current_in_consultation['id']}",
                    extra_data={
                        "token_number": str(token_num),
                        "status": "in_consultation",
                        "doctor_id": doctor_id,
                    },
                )
                await db.appointments.update_one(
                    {"id": current_in_consultation["id"]},
                    {"$set": {"notifications_sent.called": True, "notifications_sent.called_at": now_iso()}},
                )

        # 2. Waiting patients in active queue (booked, arrived)
        active_waiting = [a for a in all_appts if a.get("status") in ("booked", "arrived")]

        for appt in active_waiting:
            pid = appt.get("patient_id")
            if not pid or pid == "emergency":
                continue

            notifs = appt.get("notifications_sent") or {}
            token_num = appt.get("token_number")
            sec_token = appt.get("secure_token")
            target_url = f"/appointment/{sec_token}" if sec_token else "/patient/queue"

            # Actual eligible patients ahead
            my_order = appt.get("queue_order", token_num or 0)
            patients_ahead = sum(
                1 for a in active_waiting
                if a.get("queue_order", a.get("token_number", 0)) < my_order
            ) + (1 if current_in_consultation else 0)

            # Calculate ETA
            eta_data = await calculate_appointment_eta(appt)
            eta_display = eta_data.get("expected_turn_time") or "Estimate pending"
            current_eta_min = eta_data.get("eta_minutes", 0)

            alert_prefix = ""
            should_send = False
            notif_flag = None

            if patients_ahead == 5 and not notifs.get("five_ahead"):
                should_send = True
                notif_flag = "five_ahead"
                alert_prefix = "5 patients ahead. Please be ready."
            elif patients_ahead == 2 and not notifs.get("two_ahead"):
                should_send = True
                notif_flag = "two_ahead"
                alert_prefix = "Only 2 patients ahead! Please reach the clinic now."
            elif patients_ahead == 1 and not notifs.get("one_ahead"):
                should_send = True
                notif_flag = "one_ahead"
                alert_prefix = "You are next in line! Please wait outside the cabin."
            else:
                last_eta = notifs.get("last_eta_minutes")
                threshold = int(os.environ.get("QUEUE_ETA_CHANGE_THRESHOLD_MINUTES", "10"))
                if last_eta is not None and abs(current_eta_min - last_eta) >= threshold and patients_ahead > 0:
                    should_send = True
                    alert_prefix = "Estimated consultation time updated."

            body_lines = []
            if alert_prefix:
                body_lines.append(alert_prefix)
            body_lines.extend([
                f"Your Token: {token_num}",
                f"Now Consulting: {serving_display}",
                f"Patients Ahead: {patients_ahead}",
                f"Estimated Consultation: {eta_display}",
                "Tap to view your live queue.",
            ])

            if should_send:
                recipients = [r for r in [pid, appt.get("id")] if r and r != "emergency"]
                await send_fcm_web_push(
                    recipients=recipients,
                    title="MeriBaari — Queue Update",
                    body="\n".join(body_lines),
                    action_url=target_url,
                    tag=f"meribaari-queue-{appt['id']}",
                    extra_data={
                        "token_number": str(token_num),
                        "patients_ahead": str(patients_ahead),
                        "eta_minutes": str(current_eta_min),
                    },
                )
                updates_to_set = {"notifications_sent.last_eta_minutes": current_eta_min}
                if notif_flag:
                    updates_to_set[f"notifications_sent.{notif_flag}"] = True
                await db.appointments.update_one(
                    {"id": appt["id"]},
                    {"$set": updates_to_set},
                )
    except Exception as e:
        logger.warning(f"notify_queue_movement error: {e}")
    except Exception as e:
        logger.warning(f"notify_queue_movement error: {e}")


async def notify_doctor_status_change(doctor_id: str, new_status: str) -> None:
    """Notify active waiting patients when doctor status is paused, on break, emergency, or resumed active."""
    today = get_ist_now().strftime("%Y-%m-%d")
    try:
        doctor = await db.doctors.find_one({"id": doctor_id}, {"_id": 0})
        if not doctor:
            return
        hospital_name = doctor.get("hospital_name") or doctor.get("clinic_name") or "MeriBaari Clinic"
        doc_name = doctor.get("full_name", "").replace("Dr. ", "")

        waiting_appts = await db.appointments.find(
            {"doctor_id": doctor_id, "date": today, "status": {"$in": ["booked", "arrived"]}},
            {"_id": 0},
        ).to_list(300)

        current = await db.appointments.find_one(
            {"doctor_id": doctor_id, "date": today, "status": "in_consultation"},
            {"_id": 0},
        )
        serving_display = f"#{current['token_number']}" if current else "Not started yet"
        time_str = format_ist_12hr()

        status_messages = {
            "paused": f"Notice: Consultations with Dr. {doc_name} are briefly paused. Queue will resume shortly.",
            "break": f"Notice: Dr. {doc_name} is on a short break. Queue will resume shortly.",
            "emergency": f"Notice: Dr. {doc_name} is attending to an emergency. Queue will resume shortly.",
            "active": f"Notice: Dr. {doc_name} has resumed consultations.",
            "unavailable": f"Notice: Dr. {doc_name} is currently unavailable. Updated time will be announced shortly.",
        }
        msg = status_messages.get(new_status, f"Notice: Dr. {doc_name} status is {new_status}.")

        for appt in waiting_appts:
            pid = appt.get("patient_id")
            if not pid or pid == "emergency":
                continue
            token_num = appt.get("token_number")
            sec_token = appt.get("secure_token")
            target_url = f"/appointment/{sec_token}" if sec_token else "/patient/queue"
            body_lines = [
                f"Your Token: #{token_num}",
                f"Now Serving: {serving_display}",
                msg,
                f"Updated: {time_str}",
                "Tap to view live queue.",
            ]
            await send_fcm_web_push(
                recipients=[pid, appt["id"]],
                title=f"{hospital_name} — MeriBaari",
                body="\n".join(body_lines),
                action_url=target_url,
                tag=f"meribaari-queue-{appt['id']}",
                extra_data={"doctor_status": new_status, "token_number": str(token_num)},
            )
    except Exception as e:
        logger.warning(f"notify_doctor_status_change error: {e}")


async def notify_timing_adjusted(doctor_id: str, date: str, new_start_time: str, reason: Optional[str] = None) -> None:
    """Notify all active waiting patients about the doctor's revised timing."""
    try:
        doctor = await db.doctors.find_one({"id": doctor_id}, {"_id": 0, "full_name": 1, "clinic_name": 1, "hospital_name": 1})
        hospital_name = (doctor or {}).get("hospital_name") or (doctor or {}).get("clinic_name") or "MeriBaari Clinic"
        doc_name = (doctor or {}).get("full_name", "").replace("Dr. ", "")

        # Only notify waiting patients (booked or arrived)
        appts = await db.appointments.find(
            {"doctor_id": doctor_id, "date": date, "status": {"$in": ["booked", "arrived"]}},
            {"_id": 0}
        ).sort("token_number", 1).to_list(500)

        time_str = format_ist_12hr()
        for a in appts:
            pid = a.get("patient_id")
            recipients = []
            if pid and pid != "emergency":
                recipients.append(pid)
            if a.get("id"):
                recipients.append(a["id"])
            if not recipients:
                continue

            eta_data = await calculate_appointment_eta(a)
            token_num = a.get("token_number")
            serving = eta_data.get("currently_serving")
            serving_display = f"#{serving}" if serving is not None else "Waiting"
            eta_display = eta_data.get("expected_turn_time") or "Updating"

            reason_line = f"Reason: {reason}" if reason else None
            body_lines = [
                f"Your Token: #{token_num}",
                f"Now Serving: {serving_display}",
                f"Dr. {doc_name} revised start: {new_start_time}",
            ]
            if reason_line:
                body_lines.append(reason_line)
            body_lines.extend([
                f"Estimated Turn: {eta_display}",
                f"Updated: {time_str}",
                "Tap to view live queue.",
            ])
            target_url = f"/appointment/{a['secure_token']}" if a.get("secure_token") else "/patient/queue"
            tag = f"timing-{doctor_id}-{date}-{new_start_time.replace(' ', '')}"

            await send_fcm_web_push(
                recipients=recipients,
                title=f"{hospital_name} — MeriBaari",
                body="\n".join(body_lines),
                action_url=target_url,
                tag=tag,
                extra_data={
                    "type": "timing_adjusted",
                    "doctor_id": doctor_id,
                    "revised_start_time": new_start_time,
                    "expected_turn_time": eta_display,
                    "token_number": str(token_num),
                },
            )
    except Exception as e:
        logger.warning(f"notify_timing_adjusted error: {e}")


async def notify_appointment_cancelled(appt: dict) -> None:
    """Notify patient when an appointment is cancelled."""
    try:
        pid = appt.get("patient_id")
        recipients = [r for r in [pid, appt.get("id")] if r and r != "emergency"]
        if not recipients:
            return
        doctor = await db.doctors.find_one({"id": appt["doctor_id"]}, {"_id": 0})
        hospital_name = (doctor or {}).get("hospital_name") or (doctor or {}).get("clinic_name") or "MeriBaari Clinic"
        doc_name = (doctor or {}).get("full_name", "").replace("Dr. ", "")
        token_num = appt.get("token_number")
        time_str = format_ist_12hr()
        body_lines = [
            f"Your appointment (Token #{token_num}) with Dr. {doc_name} has been cancelled.",
            f"Updated: {time_str}",
        ]
        await send_fcm_web_push(
            recipients=recipients,
            title=f"{hospital_name} — MeriBaari",
            body="\n".join(body_lines),
            action_url="/patient/history",
            tag=f"appt-cancel-{appt['id']}",
            extra_data={"appointment_id": appt["id"], "status": "cancelled"},
        )
    except Exception as e:
        logger.warning(f"notify_appointment_cancelled error: {e}")


@api_router.post("/push/subscribe")
async def push_subscribe(body: PushSubscribeBody, user: Optional[dict] = Depends(get_current_user_optional)):
    """Register or refresh a device FCM Web Push token for the authenticated patient or guest appointment-token holder."""
    token = body.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token is required")

    now = now_iso()
    user_id = user["id"] if user else None
    target_appt = None

    if body.appointment_token:
        # Validate guest access token against database
        clean_token = body.appointment_token.strip()
        target_appt = await db.appointments.find_one({"secure_token": clean_token})
        if not target_appt:
            raise HTTPException(status_code=404, detail="Invalid appointment token")
        if target_appt.get("status") == "cancelled":
            raise HTTPException(status_code=410, detail="Appointment has been cancelled")
    elif body.appointment_id:
        # If no appointment_token, caller must be authenticated to associate by appointment_id
        if not user:
            raise HTTPException(status_code=401, detail="Authentication or valid appointment token required to subscribe.")
        target_appt = await db.appointments.find_one({"id": body.appointment_id})
        if not target_appt:
            raise HTTPException(status_code=404, detail="Appointment not found")
        if user.get("role") == "patient":
            user_phone = normalize_mobile(user.get("mobile") or user.get("phone") or "")
            appt_phone = normalize_mobile(target_appt.get("patient_mobile") or "")
            is_owner = (target_appt.get("patient_id") == user["id"]) or (bool(user_phone) and user_phone == appt_phone)
            if not is_owner:
                raise HTTPException(status_code=403, detail="Forbidden: You do not own this appointment.")
    elif not user:
        raise HTTPException(status_code=401, detail="Authentication or appointment token required to subscribe.")

    # Determine user_id to store
    if not user_id and target_appt:
        user_id = target_appt.get("patient_id") or f"guest_{target_appt['id']}"
    if not user_id:
        user_id = f"device_{token[:16]}"

    appt_id_to_store = target_appt["id"] if target_appt else body.appointment_id

    # Deduplicated per device token by MongoDB unique index {"token": 1}
    doc = {
        "user_id": user_id,
        "token": token,
        "platform": body.platform or "web",
        "user_agent": body.user_agent,
        "appointment_id": appt_id_to_store,
        "active": True,
        "updated_at": now,
        "last_seen_at": now,
    }
    await db.push_subscriptions.update_one(
        {"token": token},
        {"$set": doc, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
        upsert=True,
    )

    # If the patient enabled notifications after booking, send one current appointment status notification
    if appt_id_to_store:
        asyncio.create_task(
            send_welcome_status_if_needed(
                user_id,
                token,
                appointment_id=appt_id_to_store,
                secure_token=body.appointment_token,
            )
        )

    return {"ok": True, "status": "subscribed"}



@api_router.post("/push/unsubscribe")
async def push_unsubscribe(body: PushUnsubscribeBody, user: Optional[dict] = Depends(get_current_user_optional)):
    """Deactivate device Web Push token on logout or explicit unsubscribe."""
    token = body.token.strip()
    if not token:
        return {"ok": True, "status": "ignored"}

    now = now_iso()
    q: dict = {"token": token}
    if user:
        q["user_id"] = user["id"]
    await db.push_subscriptions.update_many(q, {"$set": {"active": False, "updated_at": now}})
    return {"ok": True, "status": "unsubscribed"}


@api_router.get("/push/status")
async def push_status(token: str, user: dict = Depends(get_current_user)):
    """Check subscription status for a device token."""
    sub = await db.push_subscriptions.find_one({"token": token, "user_id": user["id"], "active": True})
    return {"ok": True, "active": sub is not None}


@api_router.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    """Backward-compatible endpoint: stores device push token in MongoDB push_subscriptions."""
    now = now_iso()
    await db.push_subscriptions.update_one(
        {"token": body.device_token},
        {
            "$set": {
                "user_id": body.user_id,
                "platform": body.platform,
                "active": True,
                "updated_at": now,
                "last_seen_at": now,
            },
            "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now},
        },
        upsert=True,
    )
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
            "email": os.environ.get("SUPPORT_EMAIL", "easehealthcareapp@gmail.com"),
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

    existing = await db.users.find_one({"mobile": mobile, "deleted": {"$ne": True}})

    # Returning Patient Direct Login:
    # If the user previously verified their phone with OTP and their account is created,
    # allow direct login without verification unless force_otp is explicitly requested.
    if existing and existing.get("phone_verified") is True and not body.force_otp:
        token = create_token(existing["id"], existing.get("role", "patient"))
        await audit(existing["id"], "user.login", target=existing["id"], meta={"role": existing.get("role", "patient"), "method": "direct_mobile"})

        # Also generate in-memory OTP to keep secondary test verifications or legacy flows non-breaking
        otp = f"{secrets.randbelow(900000) + 100000}"
        save_memory_otp(mobile, otp, OTP_EXP_SECONDS)

        return {
            "ok": True,
            "mobile": mobile,
            "is_registered": True,
            "direct_login": True,
            "access_token": token,
            "user": {
                "id": existing["id"],
                "email": existing.get("email"),
                "mobile": existing.get("mobile"),
                "full_name": existing.get("full_name", "Patient"),
                "role": existing.get("role", "patient"),
                "phone": existing.get("phone", existing.get("mobile")),
                "phone_verified": True,
                "age": existing.get("age"),
                "gender": existing.get("gender"),
                "address": existing.get("address"),
            },
            "privacy_notice_version": PRIVACY_NOTICE_VERSION,
            "message": "Welcome back! Logged in directly.",
        }

    # First-Time User or Forced OTP Resend:
    # Rate limit: safe sliding-window IP and Phone protection
    enforce_send_otp_rate_limit(request, mobile)
    await enforce_otp_rate_limit(mobile)
    
    # Generate 6-digit secure cryptographic OTP
    otp = f"{secrets.randbelow(900000) + 100000}"
    save_memory_otp(mobile, otp, OTP_EXP_SECONDS)
    
    # Deliver OTP via configured SMS/WhatsApp provider
    try:
        sms_res = await send_otp_sms(mobile, otp)
        if not sms_res.get("ok"):
            logger.warning(f"OTP delivery failed: {sms_res.get('error')}")
            if get_sms_provider() in ("liveair", "aisensy") and os.environ.get("ALLOW_DEV_OTP") != "1":
                err_msg = sms_res.get("error") or "Failed to deliver OTP via gateway."
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Unable to send verification SMS: {err_msg}"
                )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OTP delivery error: {e}")
        if get_sms_provider() in ("liveair", "aisensy") and os.environ.get("ALLOW_DEV_OTP") != "1":
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Gateway connection error. Please try again later."
            )
    
    # Plaintext OTP is NEVER logged or exposed in API response
    channel_name = "WhatsApp" if get_sms_provider() == "aisensy" else "SMS"
    return {
        "ok": True,
        "mobile": mobile,
        "is_registered": bool(existing),
        "direct_login": False,
        "privacy_notice_version": PRIVACY_NOTICE_VERSION,
        "message": f"OTP sent to {mobile} via {channel_name}.",
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

    # Atomically allocate sequential token number for this doctor and date
    token_number = await allocate_next_token(doctor.get("hospital_id"), body.doctor_id, body.date)
    appt_id = str(uuid.uuid4())
    secure_token = secrets.token_urlsafe(16)
    doc = {
        "id": appt_id,
        "secure_token": secure_token,
        "doctor_id": body.doctor_id,
        "doctor_name": doctor["full_name"],
        "hospital_id": doctor.get("hospital_id"),
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
    eta_data = await calculate_appointment_eta(doc)
    expected_time_val = eta_data.get("expected_turn_time") or "As per live queue"
    doc["expected_turn_time"] = expected_time_val
    doc["expected_time"] = expected_time_val
    doc["eta_minutes"] = eta_data.get("eta_minutes", 0)

    if patient_mobile:
        dynamic_link = f"{get_app_public_url()}/appointment/{secure_token}"
        hour_val = expected_time_val if (" – " in expected_time_val or " - " in expected_time_val) else format_renflair_hour(expected_time_val, default="2")
        hospital_name = doctor.get("hospital_name") or doctor.get("clinic_name") or "MeriBaari Clinic"
        appt_date = doc.get("date") or getattr(body, "date", None)
        try:
            sms_res = await send_appointment_sms(
                phone=patient_mobile,
                oid=token_number,
                hour=hour_val,
                hospital_name=hospital_name,
                patient_name=user["full_name"],
                doctor_name=doctor["full_name"],
                token_number=token_number,
                expected_time=expected_time_val,
                estimated_time=expected_time_val,
                live_queue_link=dynamic_link,
                appointment_link=dynamic_link,
                appointment_date=appt_date,
            )
            sms_ok = sms_res.get("ok", False)
            sms_provider_name = sms_res.get("provider") or get_sms_provider()
            sms_status = "SENT_TO_PROVIDER" if sms_ok else "FAILED"
            sms_updates = {
                "sms_provider": sms_provider_name,
                "sms_status": sms_status,
                "sms_last_attempt_at": now_iso(),
            }
            if sms_res.get("message_id"):
                sms_updates["sms_provider_message_id"] = sms_res["message_id"]
                doc["sms_provider_message_id"] = sms_res["message_id"]
            if sms_res.get("error_code") or sms_res.get("code"):
                sms_updates["sms_error_code"] = sms_res.get("error_code") or sms_res.get("code")
            if sms_res.get("sms_text"):
                sms_updates["sms_text"] = sms_res["sms_text"]
                doc["sms_text"] = sms_res["sms_text"]
            await db.appointments.update_one({"id": appt_id}, {"$set": sms_updates})
            doc["sms_status"] = sms_status
            doc["sms_provider"] = sms_provider_name

            masked_num = f"******{patient_mobile[-4:]}" if len(patient_mobile) >= 6 else "*****"
            logger.info(
                f"[BOOKING_SMS]\n"
                f"Booking created: YES\n"
                f"SMS function called: YES\n"
                f"Provider: {sms_provider_name.title()}\n"
                f"Recipient: {masked_num}\n"
                f"Route: {os.environ.get('LIVEAIR_ROUTE', '3')}\n"
                f"Template configured: {'YES' if os.environ.get('LIVEAIR_TEMPLATE_ID') else 'NO'}\n"
                f"Provider response: {sms_res.get('message_id') or sms_res.get('error') or 'NONE'}\n"
                f"Delivery status: {'PENDING' if sms_ok else 'FAILED'}"
            )
        except Exception as e:
            logger.warning(f"SMS sending failed (non-blocking): {e}")

    doc.pop("_id", None)
    await broadcast_doctor_update(body.doctor_id, "booked")
    asyncio.create_task(notify_appointment_booked(doc, doctor, eta_data))
    return doc


@api_router.get("/appointments/me")
async def my_appointments(user: dict = Depends(require_role("patient"))):
    appts = await db.appointments.find({"patient_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    for a in appts:
        if a.get("status") in ("booked", "arrived", "in_consultation"):
            eta = await calculate_appointment_eta(a)
            a["expected_turn_time"] = eta.get("expected_turn_time")
            a["eta_minutes"] = eta.get("eta_minutes")
    return appts


@api_router.get("/appointments/by-token/{token}")
async def get_appointment_by_token(token: str, user: Optional[dict] = Depends(get_current_user_optional)):
    """Fetch appointment details and latest queue stats by secure random token.
    - If user is authenticated as owner or clinic staff, returns full details.
    - If accessed as a guest (e.g. walk-in patient via SMS link), validates the high-entropy
      access token and returns ONLY minimal non-PII queue details (token number, doctor name,
      date, slot, status, and ETA stats). Does NOT expose patient names, phone numbers,
      symptoms, prescriptions, or other patients' details.
    - Rejects invalid, expired, or cancelled tokens.
    """
    clean_token = token.strip() if token else ""
    if not clean_token or len(clean_token) < 8:
        raise HTTPException(status_code=404, detail="Invalid appointment token")

    appt = await db.appointments.find_one({"secure_token": clean_token}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found or link has expired")

    # Reject revoked/cancelled tokens
    if appt.get("status") == "cancelled":
        raise HTTPException(status_code=410, detail="This appointment was cancelled")

    # Reject expired completed appointments from previous dates
    today_str = get_ist_now().strftime("%Y-%m-%d")
    appt_date = appt.get("date")
    if appt_date and appt_date < today_str and appt.get("status") == "completed":
        raise HTTPException(status_code=410, detail="This appointment link has expired")

    # Determine caller authorization
    is_staff = bool(user and user.get("role") in ("receptionist", "doctor", "admin", "owner", "developer"))
    is_authenticated_patient = bool(user and user.get("role") == "patient")
    is_owner = False

    if is_authenticated_patient:
        user_phone = normalize_mobile(user.get("mobile") or user.get("phone") or "")
        appt_phone = normalize_mobile(appt.get("patient_mobile") or "")
        is_owner = (appt.get("patient_id") == user["id"]) or (bool(user_phone) and user_phone == appt_phone)

    # Calculate queue stats (non-PII queue statistics)
    eta_data = await calculate_appointment_eta(appt)

    # If clinic staff or verified owner, return full record
    if is_staff or is_owner:
        return {
            "ok": True,
            "appointment": appt,
            "queue": eta_data,
            "is_guest": False,
        }

    # If guest (unauthenticated walk-in or other caller with token):
    # Return MINIMAL NON-PII queue representation.
    # Exclude patient name, mobile, symptoms, prescription, medical notes, etc.
    minimal_appt = {
        "id": appt.get("id"),
        "token_number": appt.get("token_number"),
        "secure_token": appt.get("secure_token"),
        "doctor_id": appt.get("doctor_id"),
        "doctor_name": appt.get("doctor_name"),
        "hospital_id": appt.get("hospital_id"),
        "date": appt.get("date"),
        "slot": appt.get("slot"),
        "status": appt.get("status"),
        "created_at": appt.get("created_at"),
        "is_guest": True,
    }

    return {
        "ok": True,
        "appointment": minimal_appt,
        "queue": eta_data,
        "is_guest": True,
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
    asyncio.create_task(notify_appointment_cancelled(appt))
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.get("/appointments/calendar-summary")
async def calendar_summary(
    doctor_id: Optional[str] = None,
    user: dict = Depends(get_current_user)
):
    query: dict = {"status": {"$ne": "cancelled"}}
    if doctor_id:
        query["doctor_id"] = doctor_id
    elif user.get("role") == "doctor":
        doc = await db.doctors.find_one({"user_id": user["id"]})
        if doc:
            query["doctor_id"] = doc["id"]
    elif user.get("hospital_id"):
        docs = await db.doctors.find({"hospital_id": user["hospital_id"]}, {"id": 1}).to_list(None)
        valid_doc_ids = [d["id"] for d in docs]
        query["doctor_id"] = {"$in": valid_doc_ids}

    appts = await db.appointments.find(query, {"_id": 0, "date": 1, "token_number": 1, "status": 1}).to_list(2000)

    summary_map = {}
    for a in appts:
        dt = a.get("date")
        if not dt or a.get("status") == "cancelled":
            continue
        if dt not in summary_map:
            summary_map[dt] = {"date": dt, "patient_count": 0, "tokens": []}
        summary_map[dt]["patient_count"] += 1
        if a.get("token_number") is not None:
            summary_map[dt]["tokens"].append(a["token_number"])

    res = [item for item in summary_map.values() if item["patient_count"] > 0]
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
    old_doctor_id = appt["doctor_id"]
    new_token = await allocate_next_token(appt.get("hospital_id"), body.doctor_id, body.date)
    await db.appointments.update_one(
        {"id": appt_id},
        {"$set": {"doctor_id": body.doctor_id, "date": body.date, "slot": body.slot, "token_number": new_token, "status": "booked", "notifications_sent": {}}},
    )
    asyncio.create_task(notify_queue_movement(old_doctor_id))
    if body.doctor_id != old_doctor_id:
        asyncio.create_task(notify_queue_movement(body.doctor_id))
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
        asyncio.create_task(notify_doctor_status_change(d["id"], body.status))
    return {"ok": True, "status": body.status}


@api_router.post("/doctor/prescription")
async def set_prescription(body: PrescriptionBody, user: dict = Depends(require_role("doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"prescription": body.prescription}})
    return {"ok": True}


# ============ DOCTOR SESSION & TIMING ADJUSTMENT ============

async def verify_doctor_session_access(doctor_id: str, user: dict, write: bool = False) -> dict:
    """Validate user permissions to view or edit doctor session timing."""
    doc = await db.doctors.find_one({"id": doctor_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Doctor not found")

    role = user.get("role")
    if role == "doctor":
        if doc.get("user_id") != user.get("id") and doc.get("id") != user.get("id"):
            raise HTTPException(status_code=403, detail="Forbidden: You can only adjust your own session")
    elif role == "receptionist":
        user_hosp = (user.get("hospital_id") or "").strip().upper()
        doc_hosp = (doc.get("hospital_id") or "").strip().upper()
        if user_hosp and doc_hosp and user_hosp != doc_hosp:
            raise HTTPException(status_code=403, detail="Forbidden: Doctor does not belong to your hospital")
    elif role in ("admin", "owner", "developer"):
        user_hosp = (user.get("hospital_id") or "").strip().upper()
        doc_hosp = (doc.get("hospital_id") or "").strip().upper()
        if user_hosp and doc_hosp and user_hosp != doc_hosp:
            raise HTTPException(status_code=403, detail="Forbidden: Doctor does not belong to your hospital")
    elif role == "patient":
        if write:
            raise HTTPException(status_code=403, detail="Patients cannot modify doctor timing")
    else:
        raise HTTPException(status_code=403, detail="Unauthorized")
    return doc


@api_router.get("/doctor/{doctor_id}/session")
async def get_doctor_session(
    doctor_id: str,
    date: Optional[str] = None,
    user: dict = Depends(get_current_user)
):
    """Retrieve session timings and consultation status for a doctor on a specific date."""
    doc = await verify_doctor_session_access(doctor_id, user, write=False)
    session_date = date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    # Count waiting patients affected
    waiting_count = await db.appointments.count_documents({
        "doctor_id": doctor_id,
        "date": session_date,
        "status": {"$in": ["booked", "arrived"]}
    })
    total_active = await db.appointments.count_documents({
        "doctor_id": doctor_id,
        "date": session_date,
        "status": {"$in": ["booked", "arrived", "in_consultation"]}
    })

    return {
        "ok": True,
        "session": session,
        "doctor_name": doc.get("full_name"),
        "clinic_name": doc.get("clinic_name"),
        "timings": doc.get("timings"),
        "waiting_patients_count": waiting_count,
        "total_active_patients": total_active,
    }


@api_router.post("/doctor/{doctor_id}/session/adjust-timing")
async def adjust_doctor_timing(
    doctor_id: str,
    body: DoctorTimingAdjustBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """Receptionist or Doctor adjusts session expected start time with reason and audit history."""
    doc = await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    # Reject adjustments to closed / completed sessions
    if session.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Cannot adjust timing for a completed session")

    # Determine revised expected start time
    current_expected = session.get("expected_start_time") or session.get("original_start_time") or "10:00 AM"

    if body.delay_minutes:
        # Shortcut: +15, +30, +60 minutes
        base_dt = parse_time_to_ist_dt(session_date, current_expected)
        if not base_dt:
            base_dt = parse_time_to_ist_dt(session_date, "10:00 AM")
        revised_dt = base_dt + timedelta(minutes=body.delay_minutes)
        revised_start_time = format_12hr_time(revised_dt)
    elif body.new_start_time:
        parsed_dt = parse_time_to_ist_dt(session_date, body.new_start_time)
        if not parsed_dt:
            raise HTTPException(
                status_code=400,
                detail="Invalid time format. Please provide a valid time (e.g. '11:00 AM' or '02:30 PM')"
            )
        revised_start_time = format_12hr_time(parsed_dt)
    else:
        raise HTTPException(status_code=400, detail="Either new_start_time or delay_minutes is required")

    # Optimistic concurrency check
    current_version = int(session.get("version") or 1)
    if body.expected_version is not None and body.expected_version != current_version:
        raise HTTPException(
            status_code=409,
            detail="Session timing was updated concurrently by another user. Please refresh and retry."
        )

    # Prepare audit history entry
    history_entry = {
        "previous_time": current_expected,
        "revised_time": revised_start_time,
        "reason": body.reason,
        "changed_by": user.get("id"),
        "changed_by_name": user.get("full_name") or user.get("email"),
        "changed_by_role": user.get("role"),
        "timestamp": now_iso(),
    }

    # Atomically update session document
    update_res = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"], "version": current_version},
        {
            "$set": {
                "expected_start_time": revised_start_time,
                "delay_reason": body.reason,
                "updated_at": now_iso(),
            },
            "$inc": {"version": 1},
            "$push": {"history": history_entry},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    if not update_res:
        # Fallback if optimistic concurrency failed during race
        update_res = await db.doctor_sessions.find_one_and_update(
            {"id": session["id"]},
            {
                "$set": {
                    "expected_start_time": revised_start_time,
                    "delay_reason": body.reason,
                    "updated_at": now_iso(),
                },
                "$inc": {"version": 1},
                "$push": {"history": history_entry},
            },
            return_document=pymongo.ReturnDocument.AFTER,
        )

    # Count affected waiting patients
    waiting_count = await db.appointments.count_documents({
        "doctor_id": doctor_id,
        "date": session_date,
        "status": {"$in": ["booked", "arrived"]}
    })

    # Broadcast real-time update
    await broadcast_doctor_update(doctor_id, "timing_adjusted")

    # Asynchronously dispatch Web Push notification to waiting patients
    asyncio.create_task(notify_timing_adjusted(doctor_id, session_date, revised_start_time, body.reason))

    # Remove internal _id for JSON serialization
    if update_res and "_id" in update_res:
        del update_res["_id"]

    return {
        "ok": True,
        "message": f"Doctor expected start time updated to {revised_start_time}",
        "session": update_res,
        "affected_patients_count": waiting_count,
    }


@api_router.post("/doctor/{doctor_id}/session/start-consultation")
async def start_doctor_session(
    doctor_id: str,
    body: DoctorSessionStartBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """Start consultation session for doctor, recording actual start time and transitioning status."""
    await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    if session.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Session is already completed")

    actual_time = format_ist_12hr()
    updated = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"]},
        {
            "$set": {
                "status": "in_consultation",
                "actual_start_time": session.get("actual_start_time") or actual_time,
                "paused_at": None,
                "expected_resume_time": None,
                "pause_reason": None,
                "updated_at": now_iso(),
            },
            "$inc": {"version": 1},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    # Sync doctor status to active
    await db.doctors.update_one({"id": doctor_id}, {"$set": {"status": "active"}})

    await broadcast_doctor_update(doctor_id, "consultation_started")
    asyncio.create_task(notify_queue_movement(doctor_id))

    if updated and "_id" in updated:
        del updated["_id"]

    return {"ok": True, "session": updated, "actual_start_time": actual_time}


@api_router.post("/doctor/{doctor_id}/session/pause")
async def pause_doctor_session(
    doctor_id: str,
    body: DoctorSessionPauseBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """Pause consultation session with optional expected resume time and reason."""
    await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    if session.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Cannot pause a completed session")

    paused_time = format_ist_12hr()
    formatted_resume = format_12hr_time(body.expected_resume_time) if body.expected_resume_time else None

    updated = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"]},
        {
            "$set": {
                "status": "paused",
                "paused_at": paused_time,
                "expected_resume_time": formatted_resume,
                "pause_reason": body.pause_reason or "Doctor break",
                "updated_at": now_iso(),
            },
            "$inc": {"version": 1},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    # Sync doctor status to paused
    await db.doctors.update_one({"id": doctor_id}, {"$set": {"status": "paused"}})

    await broadcast_doctor_update(doctor_id, "consultation_paused")
    asyncio.create_task(notify_doctor_status_change(doctor_id, "paused"))

    if updated and "_id" in updated:
        del updated["_id"]

    return {"ok": True, "session": updated}


@api_router.post("/doctor/{doctor_id}/session/resume")
async def resume_doctor_session(
    doctor_id: str,
    body: DoctorSessionResumeBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """Resume a paused consultation session."""
    await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    updated = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"]},
        {
            "$set": {
                "status": "in_consultation",
                "paused_at": None,
                "expected_resume_time": None,
                "pause_reason": None,
                "updated_at": now_iso(),
            },
            "$inc": {"version": 1},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    # Sync doctor status to active
    await db.doctors.update_one({"id": doctor_id}, {"$set": {"status": "active"}})

    await broadcast_doctor_update(doctor_id, "consultation_resumed")
    asyncio.create_task(notify_doctor_status_change(doctor_id, "active"))
    asyncio.create_task(notify_queue_movement(doctor_id))

    if updated and "_id" in updated:
        del updated["_id"]

    return {"ok": True, "session": updated}


@api_router.post("/doctor/{doctor_id}/session/end")
async def end_doctor_session(
    doctor_id: str,
    body: DoctorSessionEndBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """End consultation session for the doctor."""
    await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    updated = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"]},
        {
            "$set": {
                "status": "completed",
                "ended_at": now_iso(),
                "updated_at": now_iso(),
            },
            "$inc": {"version": 1},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    await db.doctors.update_one({"id": doctor_id}, {"$set": {"status": "inactive"}})
    await broadcast_doctor_update(doctor_id, "consultation_ended")
    if updated and "_id" in updated:
        del updated["_id"]
    return {"ok": True, "session": updated}


@api_router.post("/doctor/{doctor_id}/session/availability")
async def set_doctor_availability(
    doctor_id: str,
    body: DoctorAvailabilityBody,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer"))
):
    """Update doctor availability status (available, delayed, on_break, unavailable) with audit trail."""
    await verify_doctor_session_access(doctor_id, user, write=True)
    session_date = body.date or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(doctor_id, session_date)

    now = now_iso()
    history_entry = {
        "status": body.status,
        "expected_time": body.expected_time,
        "reason": body.reason,
        "changed_by": user.get("id"),
        "changed_by_name": user.get("full_name") or user.get("email"),
        "changed_by_role": user.get("role"),
        "timestamp": now,
    }

    updates: dict = {"updated_at": now}
    doc_status = "active"

    if body.status == "available":
        updates["status"] = "in_consultation" if session.get("actual_start_time") else "not_started"
        updates["paused_at"] = None
        updates["expected_resume_time"] = None
        updates["pause_reason"] = None
        doc_status = "active"
    elif body.status == "delayed":
        updates["status"] = "not_started"
        if body.expected_time:
            updates["expected_start_time"] = format_12hr_time(body.expected_time)
        if body.reason:
            updates["delay_reason"] = body.reason
        doc_status = "active"
    elif body.status == "on_break":
        updates["status"] = "paused"
        updates["paused_at"] = format_ist_12hr()
        if body.expected_time:
            updates["expected_resume_time"] = format_12hr_time(body.expected_time)
        updates["pause_reason"] = body.reason or "Doctor break"
        doc_status = "paused"
    elif body.status == "unavailable":
        updates["status"] = "unavailable"
        updates["expected_resume_time"] = None
        updates["pause_reason"] = body.reason or "Doctor unavailable"
        doc_status = "unavailable"

    updated = await db.doctor_sessions.find_one_and_update(
        {"id": session["id"]},
        {
            "$set": updates,
            "$inc": {"version": 1},
            "$push": {"history": history_entry},
        },
        return_document=pymongo.ReturnDocument.AFTER,
    )
    await db.doctors.update_one({"id": doctor_id}, {"$set": {"status": doc_status}})

    await broadcast_doctor_update(doctor_id, f"availability_{body.status}")
    asyncio.create_task(notify_doctor_status_change(doctor_id, doc_status))
    asyncio.create_task(notify_queue_movement(doctor_id))

    if updated and "_id" in updated:
        del updated["_id"]
    return {"ok": True, "session": updated, "doctor_status": doc_status}


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
    
    today = get_ist_now().strftime("%Y-%m-%d")
    new_token = await allocate_next_token(to_doctor.get("hospital_id"), body.to_doctor_id, today)
    
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
    
    today = get_ist_now().strftime("%Y-%m-%d")
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
        new_token = await allocate_next_token(target_doctor.get("hospital_id"), target_doctor["id"], today)
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
async def reception_queue(
    doctor_id: Optional[str] = None,
    date: Optional[str] = None,
    user: dict = Depends(require_role("receptionist", "doctor"))
):
    today = get_ist_now().strftime("%Y-%m-%d")
    target_date = date or today

    # Rollover check for day-end: mark any past date unfinished appointments as 'unserved'
    # Requirement: "At day-end, move the previous day’s queue out of today’s active view while preserving history.
    # Unfinished appointments must remain identifiable as unserved or unfinished; never automatically mark them completed."
    if target_date == today:
        try:
            await db.appointments.update_many(
                {"date": {"$lt": today}, "status": {"$in": ["booked", "arrived"]}},
                {"$set": {"status": "unserved", "unserved_at": now_iso()}}
            )
        except Exception:
            pass

    q: dict = {"date": target_date}
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

    appts = await db.appointments.find(q, {"_id": 0}).sort([("queue_order", 1), ("token_number", 1)]).to_list(500)

    # Midnight crossover requirement:
    # "Keep any consultation crossing midnight accessible until the receptionist completes it."
    if target_date == today:
        crossover_q = {"status": "in_consultation", "date": {"$lt": today}}
        if q.get("doctor_id"):
            crossover_q["doctor_id"] = q["doctor_id"]
        crossover_appts = await db.appointments.find(crossover_q, {"_id": 0}).to_list(50)
        for ca in crossover_appts:
            if not any(a["id"] == ca["id"] for a in appts):
                appts.insert(0, ca)

    # Enrich active appointments with real-time dynamic ETAs
    for a in appts:
        if a.get("status") in ("booked", "arrived", "in_consultation", "skipped"):
            try:
                eta_data = await calculate_appointment_eta(a)
                a["expected_turn_time"] = eta_data.get("expected_turn_time")
                a["expected_time"] = eta_data.get("expected_turn_time")
                a["eta_minutes"] = eta_data.get("eta_minutes", 0)
                a["patients_ahead"] = eta_data.get("patients_ahead", 0)
                a["is_estimate_pending"] = eta_data.get("is_estimate_pending", False)
                a["is_delayed_awaited"] = eta_data.get("is_delayed_awaited", False)
            except Exception:
                pass

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
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "arrived", "updated_at": now_iso()}})
    await broadcast_doctor_update(appt["doctor_id"], "arrived")
    return {"ok": True}


@api_router.post("/reception/start_consultation")
async def start_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")

    # Idempotency check: prevent duplicate requests or double-clicks
    if appt.get("status") == "in_consultation":
        return {"ok": True, "already_started": True}

    now = now_iso()
    time_12 = format_ist_12hr()
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {
            "status": "in_consultation",
            "consultation_started_at": appt.get("consultation_started_at") or time_12,
            "started_at": appt.get("started_at") or now,
            "updated_at": now,
        }}
    )

    # Auto-sync doctor session to in_consultation and record actual_start_time
    appt_date = appt.get("date") or get_ist_now().strftime("%Y-%m-%d")
    session = await get_or_create_doctor_session(appt["doctor_id"], appt_date)
    if session.get("status") == "not_started" or not session.get("actual_start_time"):
        await db.doctor_sessions.update_one(
            {"id": session["id"]},
            {
                "$set": {
                    "status": "in_consultation",
                    "actual_start_time": session.get("actual_start_time") or time_12,
                    "updated_at": now,
                },
                "$inc": {"version": 1},
            }
        )
    await db.doctors.update_one({"id": appt["doctor_id"]}, {"$set": {"status": "active"}})

    await broadcast_doctor_update(appt["doctor_id"], "started")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/complete")
async def complete_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")

    # Idempotency check: prevent repeated taps from completing twice
    if appt.get("status") == "completed":
        return {"ok": True, "already_completed": True}

    now = now_iso()
    time_12 = format_ist_12hr()
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {
            "status": "completed",
            "payment_status": "paid",
            "consultation_completed_at": time_12,
            "completed_at": now,
            "updated_at": now,
        }}
    )

    # Notify completed patient once that their consultation is complete
    pid = appt.get("patient_id")
    recipients = [r for r in [pid, appt["id"]] if r and r != "emergency"]
    if recipients:
        doctor = await db.doctors.find_one({"id": appt["doctor_id"]}, {"_id": 0, "full_name": 1, "hospital_name": 1, "clinic_name": 1})
        hospital_name = (doctor or {}).get("hospital_name") or (doctor or {}).get("clinic_name") or "MeriBaari Clinic"
        sec_token = appt.get("secure_token")
        action_url = f"/appointment/{sec_token}" if sec_token else "/patient/history"
        try:
            await send_fcm_web_push(
                recipients=recipients,
                title=f"{hospital_name} — Consultation Complete",
                body="Your consultation is complete. Thank you for visiting!",
                action_url=action_url,
                tag=f"meribaari-complete-{appt['id']}",
            )
        except Exception as e:
            logger.warning(f"Error sending completion push (non-fatal): {e}")

    # Deactivate push subscriptions for this completed appointment so subsequent queue notifications stop
    await db.push_subscriptions.update_many({"appointment_id": appt["id"]}, {"$set": {"active": False}})


    # Check if remaining queue for today is complete
    appt_date = appt.get("date") or get_ist_now().strftime("%Y-%m-%d")
    remaining = await db.appointments.count_documents({
        "doctor_id": appt["doctor_id"],
        "date": appt_date,
        "status": {"$in": ["booked", "arrived", "in_consultation"]}
    })
    if remaining == 0:
        await db.doctor_sessions.update_one(
            {"id": f"{appt['doctor_id']}_{appt_date}"},
            {"$set": {"status": "completed", "updated_at": now}}
        )

    await broadcast_doctor_update(appt["doctor_id"], "completed")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/skip")
async def skip_patient(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    if appt.get("status") == "skipped":
        return {"ok": True, "already_skipped": True}

    now = now_iso()
    # Keep assigned token number fixed; mark status skipped
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {"status": "skipped", "skipped_at": now, "updated_at": now}}
    )
    await broadcast_doctor_update(appt["doctor_id"], "skipped")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/rejoin")
async def rejoin_queue(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")

    now = now_iso()
    # Keep assigned token number fixed; patient returns to arrived status
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {"status": "arrived", "rejoined_at": now, "updated_at": now}}
    )
    await broadcast_doctor_update(appt["doctor_id"], "rejoined")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True}


@api_router.post("/reception/cancel")
async def reception_cancel_appointment(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")

    if appt.get("status") == "completed":
        raise HTTPException(status_code=400, detail="Cannot cancel an already completed consultation")
    if appt.get("status") == "in_consultation":
        raise HTTPException(status_code=400, detail="Cannot cancel an appointment currently in consultation")

    now = now_iso()
    reason = body.reason or "Cancelled by reception"
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {
            "status": "cancelled",
            "cancelled_at": now,
            "cancellation_reason": reason,
            "cancelled_by": user.get("id"),
            "updated_at": now,
        }}
    )
    await broadcast_doctor_update(appt["doctor_id"], "cancelled")
    try:
        await notify_appointment_cancelled(appt)
    except Exception as e:
        logger.warning(f"Failed to send cancellation push (non-fatal): {e}")

    await db.push_subscriptions.update_many({"appointment_id": appt["id"]}, {"$set": {"active": False}})
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True, "message": "Appointment cancelled successfully"}



@api_router.post("/reception/reschedule")
async def reception_reschedule_appointment(body: ReceptionRescheduleBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")

    now = now_iso()
    new_token = await allocate_next_token(appt.get("hospital_id"), appt["doctor_id"], body.new_date)
    await db.appointments.update_one(
        {"id": body.appointment_id},
        {"$set": {
            "date": body.new_date,
            "slot": body.new_slot or "Walk-in",
            "token_number": new_token,
            "status": "booked",
            "rescheduled_at": now,
            "updated_at": now,
            "notifications_sent": {},
        }}
    )
    await broadcast_doctor_update(appt["doctor_id"], "rescheduled")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
    return {"ok": True, "new_date": body.new_date, "token_number": new_token}


@api_router.post("/reception/reorder")
async def reorder(body: ReorderBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    appt = await db.appointments.find_one({"id": body.appointment_id})
    if not appt:
        raise HTTPException(status_code=404, detail="Not found")
    # Keep assigned token number fixed! Update queue_order position only.
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"queue_order": body.new_position, "updated_at": now_iso()}})
    await broadcast_doctor_update(appt["doctor_id"], "reordered")
    asyncio.create_task(notify_queue_movement(appt["doctor_id"]))
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
    today = get_ist_now().strftime("%Y-%m-%d")
    # Insert as token 0 (top priority) - shift others is not needed since we sort by token
    doc = {
        "id": str(uuid.uuid4()),
        "doctor_id": doctor_id,
        "doctor_name": doctor["full_name"],
        "hospital_id": doctor.get("hospital_id"),
        "patient_id": "emergency",
        "patient_name": patient_name,
        "date": today,
        "slot": "EMERGENCY",
        "token_number": 0,
        "queue_order": 0,
        "status": "arrived",
        "payment_method": "pay_at_clinic",
        "payment_status": "pending",
        "prescription": None,
        "created_at": now_iso(),
    }
    await db.appointments.insert_one(doc)
    doc.pop("_id", None)
    await broadcast_doctor_update(doctor_id, "emergency_inserted")
    asyncio.create_task(notify_queue_movement(doctor_id))
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

        appt_date = getattr(body, "date", None) or get_ist_now().strftime("%Y-%m-%d")

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

        hosp_id = user.get("hospital_id") or doctor.get("hospital_id")
        token_number = await allocate_next_token(hosp_id, body.doctor_id, appt_date)
        appt_id = str(uuid.uuid4())
        secure_token = secrets.token_urlsafe(16)
        appt = {
            "id": appt_id,
            "secure_token": secure_token,
            "doctor_id": body.doctor_id,
            "doctor_name": doctor["full_name"],
            "hospital_id": hosp_id,
            "patient_id": patient_id,
            "patient_name": patient_name,
            "patient_mobile": mobile,
            "date": appt_date,
            "slot": body.slot or "Walk-in",
            "token_number": token_number,
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
        expected_time_val = eta_data.get("expected_turn_time") or "As per live queue"
        hour_val = expected_time_val if (" – " in expected_time_val or " - " in expected_time_val) else format_renflair_hour(expected_time_val, default="2")
        appt["expected_turn_time"] = expected_time_val
        appt["expected_time"] = expected_time_val
        appt["eta_minutes"] = eta_data.get("eta_minutes", 0)
        hospital_name = doctor.get("hospital_name") or doctor.get("clinic_name") or "MeriBaari Clinic"
        appt_date = appt.get("date")
        try:
            sms_res = await send_appointment_sms(
                phone=mobile,
                oid=appt["token_number"],
                hour=hour_val,
                hospital_name=hospital_name,
                patient_name=patient_name,
                doctor_name=doctor["full_name"],
                token_number=appt["token_number"],
                expected_time=expected_time_val,
                estimated_time=expected_time_val,
                live_queue_link=dynamic_link,
                appointment_link=dynamic_link,
                appointment_date=appt_date,
            )
            sms_ok = sms_res.get("ok", False)
            sms_provider_name = sms_res.get("provider") or get_sms_provider()
            sms_status = "SENT_TO_PROVIDER" if sms_ok else "FAILED"
            sms_updates = {
                "sms_provider": sms_provider_name,
                "sms_status": sms_status,
                "sms_last_attempt_at": now_iso(),
            }
            if sms_res.get("message_id"):
                sms_updates["sms_provider_message_id"] = sms_res["message_id"]
                appt["sms_provider_message_id"] = sms_res["message_id"]
            if sms_res.get("error_code") or sms_res.get("code"):
                sms_updates["sms_error_code"] = sms_res.get("error_code") or sms_res.get("code")
            if sms_res.get("sms_text"):
                sms_updates["sms_text"] = sms_res["sms_text"]
                appt["sms_text"] = sms_res["sms_text"]
            await db.appointments.update_one({"id": appt_id}, {"$set": sms_updates})
            appt["sms_status"] = sms_status
            appt["sms_provider"] = sms_provider_name

            masked_num = f"******{mobile[-4:]}" if len(mobile) >= 6 else "*****"
            logger.info(
                f"[BOOKING_SMS]\n"
                f"Booking created: YES\n"
                f"SMS function called: YES\n"
                f"Provider: {sms_provider_name.title()}\n"
                f"Recipient: {masked_num}\n"
                f"Route: {os.environ.get('LIVEAIR_ROUTE', '3')}\n"
                f"Template configured: {'YES' if os.environ.get('LIVEAIR_TEMPLATE_ID') else 'NO'}\n"
                f"Provider response: {sms_res.get('message_id') or sms_res.get('error') or 'NONE'}\n"
                f"Delivery status: {'PENDING' if sms_ok else 'FAILED'}"
            )
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
    expected_time_val = eta_data.get("expected_turn_time") or "As per live queue"
    hour_val = expected_time_val if (" – " in expected_time_val or " - " in expected_time_val) else format_renflair_hour(expected_time_val, default="2")
    doctor = await db.doctors.find_one({"id": appt.get("doctor_id")}) if appt.get("doctor_id") else None
    hospital_name = (doctor or {}).get("hospital_name") or (doctor or {}).get("clinic_name") or "MeriBaari Clinic"
    appt_date = appt.get("date")

    sms_res = await send_appointment_sms(
        phone=mobile,
        oid=appt.get("token_number", 1),
        hour=hour_val,
        hospital_name=hospital_name,
        patient_name=appt.get("patient_name", "Patient"),
        doctor_name=appt.get("doctor_name", "Doctor"),
        token_number=appt.get("token_number", 1),
        expected_time=expected_time_val,
        estimated_time=expected_time_val,
        live_queue_link=dynamic_link,
        appointment_link=dynamic_link,
        appointment_date=appt_date,
    )
    sms_ok = sms_res.get("ok", False)
    sms_provider_name = sms_res.get("provider") or get_sms_provider()
    sms_status = "SENT_TO_PROVIDER" if sms_ok else "FAILED"
    sms_updates = {
        "sms_provider": sms_provider_name,
        "sms_status": sms_status,
        "sms_last_sent_at": now_iso(),
        "sms_last_attempt_at": now_iso(),
    }
    if sms_res.get("message_id"):
        sms_updates["sms_provider_message_id"] = sms_res["message_id"]
    if sms_res.get("error_code") or sms_res.get("code"):
        sms_updates["sms_error_code"] = sms_res.get("error_code") or sms_res.get("code")
    if sms_res.get("sms_text"):
        sms_updates["sms_text"] = sms_res["sms_text"]
    await db.appointments.update_one(
        {"id": appt_id},
        {"$set": sms_updates}
    )

    masked_num = f"******{mobile[-4:]}" if len(mobile) >= 6 else "*****"
    logger.info(
        f"[BOOKING_SMS]\n"
        f"Booking created: YES\n"
        f"SMS function called: YES\n"
        f"Provider: {sms_provider_name.title()}\n"
        f"Recipient: {masked_num}\n"
        f"Route: {os.environ.get('LIVEAIR_ROUTE', '3')}\n"
        f"Template configured: {'YES' if os.environ.get('LIVEAIR_TEMPLATE_ID') else 'NO'}\n"
        f"Provider response: {sms_res.get('message_id') or sms_res.get('error') or 'NONE'}\n"
        f"Delivery status: {'PENDING' if sms_ok else 'FAILED'}"
    )

    return {
        "ok": True,
        "message": f"Link sent to {mobile}" if sms_ok else "Appointment link attempted, but SMS delivery failed.",
        "warning": None if sms_ok else "Appointment created successfully, but SMS delivery failed.",
        "sms_status": sms_status,
        "provider_message_id": sms_res.get("message_id"),
        "sms_text": sms_res.get("sms_text"),
        "appointment_link": dynamic_link,
    }


# ============ EXCEL REPORT EXPORT ENDPOINT ============
@api_router.get("/reception/export-excel")
@api_router.get("/api/reception/export-excel")
async def reception_export_excel(
    doctor_id: Optional[str] = None,
    date: Optional[str] = None,
    user: dict = Depends(require_role("receptionist", "doctor", "admin", "owner", "developer")),
):
    """Database-backed Excel report export for receptionist (Requirement 8)."""
    import io
    import openpyxl
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    today = get_ist_now().strftime("%Y-%m-%d")
    target_date = date or today

    q: dict = {"date": target_date}
    if user.get("hospital_id"):
        docs = await db.doctors.find({"hospital_id": user["hospital_id"]}, {"id": 1}).to_list(None)
        valid_doc_ids = [d["id"] for d in docs]
        if doctor_id:
            if doctor_id not in valid_doc_ids:
                raise HTTPException(status_code=403, detail="Doctor does not belong to your clinic")
            q["doctor_id"] = doctor_id
        else:
            q["doctor_id"] = {"$in": valid_doc_ids}
    elif doctor_id:
        q["doctor_id"] = doctor_id

    appts = await db.appointments.find(q, {"_id": 0}).sort([("token_number", 1)]).to_list(2000)

    doc_name = "All_Doctors"
    clinic_name = "Clinic"
    if doctor_id:
        doc_obj = await db.doctors.find_one({"id": doctor_id}, {"_id": 0, "full_name": 1, "hospital_name": 1, "clinic_name": 1})
        if doc_obj:
            doc_name = doc_obj.get("full_name") or "Doctor"
            clinic_name = doc_obj.get("hospital_name") or doc_obj.get("clinic_name") or "MeriBaari Clinic"
    elif user.get("hospital_id"):
        hosp = await db.hospitals.find_one({"id": user["hospital_id"]}, {"_id": 0, "name": 1})
        if hosp:
            clinic_name = hosp.get("name") or "MeriBaari Clinic"

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Appointments Report"

    header_fill = PatternFill(start_color="0F766E", end_color="0F766E", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    data_font = Font(name="Calibri", size=10)
    center_align = Alignment(horizontal="center", vertical="center")
    left_align = Alignment(horizontal="left", vertical="center")
    thin_border = Border(
        left=Side(style="thin", color="CBD5E1"),
        right=Side(style="thin", color="CBD5E1"),
        top=Side(style="thin", color="CBD5E1"),
        bottom=Side(style="thin", color="CBD5E1"),
    )

    headers = [
        "Booking Date",
        "Appointment ID",
        "Token #",
        "Patient Name",
        "Mobile Number",
        "Age",
        "Gender",
        "Doctor Name",
        "Clinic / Hospital",
        "Booking Source",
        "Status",
        "Recorded ETA / Expected Window",
        "Consultation Started",
        "Consultation Completed",
        "Consultation Duration",
        "Cancellation Timestamp",
        "Cancellation Reason",
    ]

    ws.append(headers)
    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center_align

    def calc_duration(start_val, end_val):
        if not start_val or not end_val or start_val == "Unavailable" or end_val == "Unavailable":
            return "Unavailable"
        try:
            def parse_time(v):
                s = str(v).strip()
                if "T" in s:
                    return datetime.fromisoformat(s.replace("Z", "+00:00"))
                m = re.match(r"^(\d{1,2}):(\d{2})\s*(AM|PM)$", s, re.I)
                if m:
                    h, mi, meridiem = int(m.group(1)), int(m.group(2)), m.group(3).upper()
                    if meridiem == "PM" and h < 12: h += 12
                    if meridiem == "AM" and h == 12: h = 0
                    return datetime(2000, 1, 1, h, mi)
                return None
            t1 = parse_time(start_val)
            t2 = parse_time(end_val)
            if t1 and t2:
                mins = max(0, int((t2 - t1).total_seconds() / 60))
                return f"{mins} mins"
        except Exception:
            pass
        return "Unavailable"

    if not appts:
        ws.append(["No appointment records found for this date", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""])
    else:
        for r_idx, a in enumerate(appts, start=2):
            source = "Walk-in (Reception)" if (a.get("slot") == "Walk-in" or a.get("added_by_reception")) else "Online App Booking"
            status_label = str(a.get("status", "booked")).replace("_", " ").title()
            eta_val = str(a.get("expected_turn_time") or a.get("expected_time") or a.get("slot") or "Unavailable")
            start_val = str(a.get("consultation_started_at") or a.get("started_at") or "Unavailable")
            end_val = str(a.get("consultation_completed_at") or a.get("completed_at") or "Unavailable")
            duration_val = calc_duration(a.get("consultation_started_at") or a.get("started_at"), a.get("consultation_completed_at") or a.get("completed_at"))
            cancel_time = str(a.get("cancelled_at") or "Unavailable")
            cancel_reason = str(a.get("cancellation_reason") or "Unavailable")

            row_data = [
                str(a.get("date") or target_date),
                str(a.get("id") or ""),
                int(a.get("token_number", 0)),
                str(a.get("patient_name") or ""),
                str(a.get("patient_mobile") or ""),
                str(a.get("age") or "Unavailable"),
                str(a.get("gender") or "Unavailable"),
                str(a.get("doctor_name") or doc_name),
                clinic_name,
                source,
                status_label,
                eta_val,
                start_val,
                end_val,
                duration_val,
                cancel_time,
                cancel_reason,
            ]
            ws.append(row_data)

            row_fill = PatternFill(start_color="F8FAFC" if r_idx % 2 == 0 else "FFFFFF", fill_type="solid")
            for c_idx in range(1, len(headers) + 1):
                cell = ws.cell(row=r_idx, column=c_idx)
                cell.font = data_font
                cell.border = thin_border
                cell.fill = row_fill
                if c_idx in (1, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16):
                    cell.alignment = center_align
                else:
                    cell.alignment = left_align

    for col in ws.columns:
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            val_str = str(cell.value or "")
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

    stream = io.BytesIO()
    wb.save(stream)
    stream.seek(0)

    clean_doc = re.sub(r"[^\w\-]", "_", doc_name)
    filename = f"ClinicQueue_Report_{clean_doc}_{target_date}.xlsx"
    return Response(
        content=stream.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )



# ============ DEV TEST SMS & DELIVERY STATUS ENDPOINTS ============

@api_router.post("/dev/test-sms")
async def dev_test_sms(
    request: Request,
    body: DevTestSMSBody,
    user: dict = Depends(get_current_user),
):
    """Development/testing endpoint to verify provider connectivity (Requirement 10).
    - Enabled only when DEV_TEST_SMS_ENABLED=1 or ENVIRONMENT=development
    - Admin/Developer authorization required
    - Rate limited (3 req / 10 min per test user)
    - Hardcoded safe test message generated by server (no client injection)
    - Returns provider status & message ID, NEVER leaks API tokens
    """
    dev_enabled = (
        os.environ.get("DEV_TEST_SMS_ENABLED", "0").strip() in ("1", "true", "True")
        or os.environ.get("ENVIRONMENT", "").lower() in ("development", "test", "dev")
    )
    if not dev_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Development test SMS endpoint is disabled."
        )

    # Require admin, owner, developer, doctor, or receptionist role
    if user.get("role") not in ("owner", "admin", "developer", "doctor", "receptionist"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or developer privileges required for test SMS."
        )

    enforce_dev_test_sms_rate_limit(request, user.get("id", ""))

    provider = get_sms_provider()
    test_message = "Meribaari SMS integration test successful."

    if provider == "aisensy":
        sample_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        res = await send_appointment_sms(
            phone=body.phone,
            oid=999,
            hour="12:00 PM",
            hospital_name="MeriBaari Clinic",
            doctor_name="Doctor Test",
            token_number=999,
            expected_time="12:00 PM",
            live_queue_link=f"{get_app_public_url()}/appointment/test-link",
            patient_name="Test Patient",
            appointment_date=sample_date,
        )
        return {
            "ok": res.get("ok", False),
            "provider": "aisensy",
            "message_id": res.get("message_id"),
            "status": "sent" if res.get("ok") else "failed",
            "error": res.get("error"),
            "error_code": res.get("error_code"),
            "response": res.get("response"),
        }
    elif provider == "liveair":
        try:
            from liveair_sms_service import execute_liveair_test_sms
        except ImportError:
            from backend.liveair_sms_service import execute_liveair_test_sms
            
        test_report = await execute_liveair_test_sms(body.phone)
        send_res = test_report.get("send_response") or {}
        return {
            "ok": test_report.get("success", False),
            "provider": "liveair",
            "message_id": send_res.get("message_id"),
            "status": "sent" if test_report.get("success") else "failed",
            "error": test_report.get("error") or send_res.get("error"),
            "code": send_res.get("code"),
            "credits": test_report.get("credits"),
            "delivery_report": test_report.get("delivery_report"),
        }
    elif provider == "brevo":
        try:
            from sms_service import send_sms_via_brevo
        except ImportError:
            from backend.sms_service import send_sms_via_brevo
            
        res = await send_sms_via_brevo(body.phone, test_message)
        return {
            "ok": res.get("ok", False),
            "provider": "brevo",
            "message_id": res.get("message_id"),
            "status": "sent" if res.get("ok") else "failed",
            "error": res.get("error"),
        }
    else:
        # Default Renflair
        sample_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        res = await send_appointment_sms(
            phone=body.phone,
            oid=999,
            hour="12:00 PM",
            hospital_name="MeriBaari Test",
            doctor_name="Doctor Test",
            token_number=999,
            expected_time="12:00 PM",
            live_queue_link=f"{get_app_public_url()}/appointment/test-link",
            appointment_date=sample_date,
        )
        return {
            "ok": res.get("ok", False),
            "provider": res.get("provider", "renflair"),
            "message_id": res.get("message_id"),
            "status": "sent" if res.get("ok") else "failed",
            "error": res.get("error"),
        }


@api_router.get("/dev/sms-delivery/{message_id}")
async def dev_sms_delivery_status(
    message_id: str,
    user: dict = Depends(get_current_user),
):
    """Check SMS delivery status report via LiveAir Delivery Report API (Requirement 11)."""
    dev_enabled = (
        os.environ.get("DEV_TEST_SMS_ENABLED", "0").strip() in ("1", "true", "True")
        or os.environ.get("ENVIRONMENT", "").lower() in ("development", "test", "dev")
    )
    if not dev_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Development test SMS endpoint is disabled."
        )

    if user.get("role") not in ("owner", "admin", "developer", "doctor", "receptionist"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or developer privileges required to check delivery status."
        )

    try:
        from liveair_sms_service import get_liveair_delivery_status
    except ImportError:
        from backend.liveair_sms_service import get_liveair_delivery_status
        
    return await get_liveair_delivery_status(message_id)


@api_router.get("/dev/liveair-credits")
async def dev_liveair_credits(
    route: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """Check LiveAir available credits for configured route (Requirement 10)."""
    dev_enabled = (
        os.environ.get("DEV_TEST_SMS_ENABLED", "0").strip() in ("1", "true", "True")
        or os.environ.get("ENVIRONMENT", "").lower() in ("development", "test", "dev")
    )
    if not dev_enabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Development test SMS endpoint is disabled."
        )

    if user.get("role") not in ("owner", "admin", "developer", "doctor", "receptionist"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin or developer privileges required."
        )

    try:
        from liveair_sms_service import get_liveair_credits
    except ImportError:
        from backend.liveair_sms_service import get_liveair_credits
        
    return await get_liveair_credits(route)




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
        admin_update = {
            "role": "admin",
            "hospital_id": "H00001",
            "hospital_code": "H00001",
            "status": "active",
            "login_disabled": False,
        }
        if not admin_user.get("password_hash"):
            admin_update["password_hash"] = hash_password(os.environ.get("ADMIN_INITIAL_PASSWORD", "Ranjeet@74"))
        await db.users.update_one(
            {"email": admin_email},
            {"$set": admin_update}
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
    if "pytest" not in sys.modules and os.environ.get("TESTING") != "1":
        client.close()
