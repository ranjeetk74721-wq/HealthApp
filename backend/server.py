from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, WebSocket, WebSocketDisconnect
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import random
import asyncio
import httpx
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal, Dict
import uuid
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

JWT_SECRET = os.environ.get("JWT_SECRET", "clinicqueue-secret-key-change-in-prod")
JWT_ALGORITHM = "HS256"
JWT_EXP_SECONDS = 60 * 60 * 24 * 7  # 7 days (default for patient/doctor)
JWT_EXP_SECONDS_RECEPTION = 60 * 60 * 24 * 90  # 90 days for receptionist (login-once)
OTP_EXP_SECONDS = 300  # OTP valid for 5 minutes
UNIVERSAL_DEV_OTP = "123456"  # Always accepted OTP in mock mode

# ============ EMERGENT PUSH SETUP ============
PUSH_BASE_URL = "https://integrations.emergentagent.com"
PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
_push_client = httpx.AsyncClient(
    base_url=PUSH_BASE_URL,
    headers={"X-Push-Key": PUSH_KEY},
    timeout=10.0,
)

app = FastAPI()
api_router = APIRouter(prefix="/api")
security = HTTPBearer(auto_error=False)

Role = Literal["patient", "doctor", "receptionist", "owner"]


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


class AppointmentCreate(BaseModel):
    doctor_id: str
    date: str  # YYYY-MM-DD
    slot: str  # e.g. "10:00 AM"
    payment_method: str = "pay_at_clinic"  # or "online"


class Appointment(BaseModel):
    id: str
    doctor_id: str
    doctor_name: str
    patient_id: str
    patient_name: str
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


class AddPatientBody(BaseModel):
    full_name: str
    mobile: str
    age: Optional[int] = None
    gender: Optional[str] = None
    symptoms: Optional[str] = None
    address: Optional[str] = None
    doctor_id: Optional[str] = None  # if provided, auto-book appointment
    slot: Optional[str] = None
    payment_method: Optional[str] = "pay_at_clinic"


# ---- Owner: Doctor management models ----
class OwnerAddDoctorBody(BaseModel):
    full_name: str
    email: EmailStr
    password: str
    phone: Optional[str] = None
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


class OwnerUpdateDoctorBody(BaseModel):
    full_name: Optional[str] = None
    phone: Optional[str] = None
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


class DoctorSelfUpdateBody(BaseModel):
    """Doctor updates own profile — limited fields."""
    fees: Optional[int] = None
    timings: Optional[str] = None
    bio: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    photo: Optional[str] = None


# ============ HELPERS ============
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
    user = await db.users.find_one({"email": body.email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(user["id"], user["role"])
    return {
        "access_token": token,
        "user": UserPublic(id=user["id"], email=user["email"], full_name=user["full_name"], role=user["role"], phone=user.get("phone")).model_dump(),
    }


@api_router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return user


# ============ MOBILE OTP AUTH (Patient) ============
@api_router.post("/auth/send-otp")
async def send_otp(body: SendOTPBody):
    mobile = normalize_mobile(body.mobile)
    if not mobile or len(mobile) < 10:
        raise HTTPException(status_code=400, detail="Enter a valid mobile number")
    # Generate 6-digit OTP (MOCK: universal 123456 also accepted)
    otp = f"{random.randint(100000, 999999)}"
    await db.otps.update_one(
        {"mobile": mobile},
        {"$set": {
            "mobile": mobile,
            "otp": otp,
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=OTP_EXP_SECONDS)).isoformat(),
            "attempts": 0,
            "created_at": now_iso(),
        }},
        upsert=True,
    )
    # Check if user already exists to indicate flow (login vs signup)
    existing = await db.users.find_one({"mobile": mobile, "role": "patient"})
    return {
        "ok": True,
        "mobile": mobile,
        "is_registered": bool(existing),
        # MOCK: return OTP in response so UI can autofill (dev/demo only)
        "dev_otp": otp,
        "message": f"OTP sent to {mobile}. (Dev mode: any OTP works or use {UNIVERSAL_DEV_OTP})",
    }


@api_router.post("/auth/verify-otp")
async def verify_otp(body: VerifyOTPBody):
    mobile = normalize_mobile(body.mobile)
    if not mobile:
        raise HTTPException(status_code=400, detail="Invalid mobile")
    rec = await db.otps.find_one({"mobile": mobile})
    # In mock mode: accept universal OTP OR the stored one
    stored_otp = rec.get("otp") if rec else None
    if body.otp not in (UNIVERSAL_DEV_OTP, stored_otp or ""):
        # increment attempts
        if rec:
            await db.otps.update_one({"mobile": mobile}, {"$inc": {"attempts": 1}})
        raise HTTPException(status_code=401, detail="Invalid OTP")
    # Check expiry (skip for universal)
    if body.otp != UNIVERSAL_DEV_OTP and rec:
        try:
            exp = datetime.fromisoformat(rec["expires_at"])
            if datetime.now(timezone.utc) > exp:
                raise HTTPException(status_code=401, detail="OTP expired. Request a new one.")
        except HTTPException:
            raise
        except Exception:
            pass
    # Consume OTP
    if rec:
        await db.otps.delete_one({"mobile": mobile})

    # Login or create patient user
    user = await db.users.find_one({"mobile": mobile, "role": "patient"})
    if not user:
        # Create new patient
        if not body.full_name:
            raise HTTPException(status_code=400, detail="Name is required for new patient signup")
        user_id = str(uuid.uuid4())
        doc = {
            "id": user_id,
            "email": None,
            "mobile": mobile,
            "phone": mobile,
            "password_hash": None,
            "full_name": body.full_name.strip(),
            "role": "patient",
            "age": body.age,
            "gender": body.gender,
            "address": body.address,
            "created_at": now_iso(),
        }
        await db.users.insert_one(doc)
        user = doc
    token = create_token(user["id"], "patient")
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


# ============ DOCTORS ============
@api_router.get("/doctors")
async def list_doctors(search: Optional[str] = None, specialty: Optional[str] = None, city: Optional[str] = None):
    query = {}
    if search:
        query["$or"] = [
            {"full_name": {"$regex": search, "$options": "i"}},
            {"specialty": {"$regex": search, "$options": "i"}},
            {"clinic_name": {"$regex": search, "$options": "i"}},
            {"city": {"$regex": search, "$options": "i"}},
        ]
    if specialty:
        query["specialty"] = {"$regex": specialty, "$options": "i"}
    if city:
        query["city"] = {"$regex": city, "$options": "i"}
    docs = await db.doctors.find(query, {"_id": 0}).to_list(200)
    # Attach estimated wait time
    for d in docs:
        d["est_wait_minutes"] = await estimate_wait_for_doctor(d["id"])
    return docs


async def estimate_wait_for_doctor(doctor_id: str) -> int:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    pending = await db.appointments.count_documents({
        "doctor_id": doctor_id,
        "date": today,
        "status": {"$in": ["booked", "arrived", "in_consultation"]},
    })
    return pending * 15  # 15 minutes per patient


@api_router.get("/doctors/{doctor_id}")
async def get_doctor(doctor_id: str):
    d = await db.doctors.find_one({"id": doctor_id}, {"_id": 0})
    if not d:
        raise HTTPException(status_code=404, detail="Doctor not found")
    d["est_wait_minutes"] = await estimate_wait_for_doctor(doctor_id)
    return d


@api_router.get("/specialties")
async def specialties():
    return [
        {"name": "Cardiology", "icon": "heart"},
        {"name": "Dental", "icon": "tooth"},
        {"name": "Dermatology", "icon": "hand"},
        {"name": "Pediatrics", "icon": "baby"},
        {"name": "General Physician", "icon": "stethoscope"},
        {"name": "Orthopedics", "icon": "bone"},
        {"name": "ENT", "icon": "ear"},
        {"name": "Ophthalmology", "icon": "eye"},
    ]


# ============ APPOINTMENTS ============
@api_router.post("/appointments")
async def create_appointment(body: AppointmentCreate, user: dict = Depends(require_role("patient"))):
    doctor = await db.doctors.find_one({"id": body.doctor_id}, {"_id": 0})
    if not doctor:
        raise HTTPException(status_code=404, detail="Doctor not found")
    # Compute next token number for this doctor on this date
    count = await db.appointments.count_documents({"doctor_id": body.doctor_id, "date": body.date})
    token_number = count + 1
    appt_id = str(uuid.uuid4())
    doc = {
        "id": appt_id,
        "doctor_id": body.doctor_id,
        "doctor_name": doctor["full_name"],
        "patient_id": user["id"],
        "patient_name": user["full_name"],
        "date": body.date,
        "slot": body.slot,
        "token_number": token_number,
        "status": "booked",
        "payment_method": body.payment_method,
        "payment_status": "paid" if body.payment_method == "online" else "pending",
        "prescription": None,
        "created_at": now_iso(),
    }
    await db.appointments.insert_one(doc)
    doc.pop("_id", None)
    await broadcast_doctor_update(body.doctor_id, "booked")
    return doc


@api_router.get("/appointments/me")
async def my_appointments(user: dict = Depends(require_role("patient"))):
    appts = await db.appointments.find({"patient_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return appts


@api_router.get("/appointments/{appt_id}/queue")
async def queue_status(appt_id: str, user: dict = Depends(get_current_user)):
    appt = await db.appointments.find_one({"id": appt_id}, {"_id": 0})
    if not appt:
        raise HTTPException(status_code=404, detail="Appointment not found")
    # Find all appointments for that doctor on that date
    all_appts = await db.appointments.find(
        {"doctor_id": appt["doctor_id"], "date": appt["date"], "status": {"$ne": "cancelled"}},
        {"_id": 0},
    ).sort("token_number", 1).to_list(500)

    active = [a for a in all_appts if a["status"] in ("booked", "arrived", "in_consultation")]
    current = next((a for a in all_appts if a["status"] == "in_consultation"), None)
    completed_count = len([a for a in all_appts if a["status"] == "completed"])

    # My position = number of active appts with token <= mine (excluding completed/skipped/cancelled)
    my_position = 0
    if appt["status"] in ("booked", "arrived"):
        my_position = sum(1 for a in active if a["token_number"] <= appt["token_number"])
    elif appt["status"] == "in_consultation":
        my_position = 0
    else:
        my_position = -1  # done / cancelled

    eta_minutes = max(0, (my_position - (1 if current else 0))) * 15 if my_position > 0 else 0

    return {
        "appointment": appt,
        "my_position": my_position,
        "eta_minutes": eta_minutes,
        "currently_serving": current["token_number"] if current else None,
        "completed_count": completed_count,
        "total_in_queue": len(active),
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
    return {"ok": True, "status": body.status}


@api_router.post("/doctor/prescription")
async def set_prescription(body: PrescriptionBody, user: dict = Depends(require_role("doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"prescription": body.prescription}})
    return {"ok": True}


# ============ RECEPTIONIST endpoints ============
@api_router.get("/reception/queue")
async def reception_queue(doctor_id: Optional[str] = None, user: dict = Depends(require_role("receptionist", "doctor"))):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    q = {"date": today}
    if doctor_id:
        q["doctor_id"] = doctor_id
    appts = await db.appointments.find(q, {"_id": 0}).sort("token_number", 1).to_list(500)
    return appts


@api_router.get("/reception/doctors")
async def reception_doctors(user: dict = Depends(require_role("receptionist", "doctor"))):
    docs = await db.doctors.find({}, {"_id": 0}).to_list(200)
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
async def reception_add_patient(body: AddPatientBody, user: dict = Depends(require_role("receptionist"))):
    """Receptionist adds a patient (with all details) and optionally books an appointment."""
    mobile = normalize_mobile(body.mobile)
    if not mobile or len(mobile) < 10:
        raise HTTPException(status_code=400, detail="Enter a valid mobile number")
    if not body.full_name or not body.full_name.strip():
        raise HTTPException(status_code=400, detail="Full name is required")

    # Find or create patient user
    existing = await db.users.find_one({"mobile": mobile, "role": "patient"})
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
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        count = await db.appointments.count_documents({"doctor_id": body.doctor_id, "date": today})
        appt_id = str(uuid.uuid4())
        appt = {
            "id": appt_id,
            "doctor_id": body.doctor_id,
            "doctor_name": doctor["full_name"],
            "patient_id": patient_id,
            "patient_name": patient_name,
            "date": today,
            "slot": body.slot or "Walk-in",
            "token_number": count + 1,
            "status": "arrived",  # walk-in patient is already at clinic
            "payment_method": body.payment_method or "pay_at_clinic",
            "payment_status": "pending",
            "prescription": None,
            "symptoms": body.symptoms,
            "created_at": now_iso(),
        }
        await db.appointments.insert_one(appt)
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
    await db.doctors.update_one({"user_id": user["id"]}, {"$set": updates})
    return {"ok": True, "updated": list(updates.keys())}


# ============ OWNER ENDPOINTS ============
@api_router.get("/owner/stats")
async def owner_stats(user: dict = Depends(require_role("owner"))):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total_doctors = await db.doctors.count_documents({})
    total_patients = await db.users.count_documents({"role": "patient"})
    todays_appts = await db.appointments.count_documents({"date": today})
    completed_today = await db.appointments.find({"date": today, "status": "completed"}, {"_id": 0}).to_list(1000)
    # Compute revenue: sum of doctor fees for each completed appt
    doctor_fees_cache: dict = {}
    revenue = 0
    for a in completed_today:
        did = a["doctor_id"]
        if did not in doctor_fees_cache:
            d = await db.doctors.find_one({"id": did}, {"_id": 0, "fees": 1})
            doctor_fees_cache[did] = (d or {}).get("fees", 0)
        revenue += doctor_fees_cache[did]
    total_receptionists = await db.users.count_documents({"role": "receptionist"})
    return {
        "total_doctors": total_doctors,
        "total_patients": total_patients,
        "total_receptionists": total_receptionists,
        "todays_appointments": todays_appts,
        "completed_today": len(completed_today),
        "revenue_today": revenue,
    }


@api_router.get("/owner/doctors")
async def owner_list_doctors(user: dict = Depends(require_role("owner"))):
    docs = await db.doctors.find({}, {"_id": 0}).sort("created_at", -1).to_list(500)
    # Attach today's appointment count per doctor
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    for d in docs:
        d["todays_appts"] = await db.appointments.count_documents({"doctor_id": d["id"], "date": today})
    return docs


@api_router.post("/owner/add-doctor")
async def owner_add_doctor(body: OwnerAddDoctorBody, user: dict = Depends(require_role("owner"))):
    # Ensure email not taken
    existing = await db.users.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    user_id = str(uuid.uuid4())
    await db.users.insert_one({
        "id": user_id,
        "email": body.email.lower(),
        "password_hash": hash_password(body.password),
        "full_name": body.full_name,
        "role": "doctor",
        "phone": body.phone,
        "address": body.address,
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
        "phone": body.phone,
        "email": body.email.lower(),
        "degree": body.degree,
        "experience_years": body.experience_years,
        "id_proof_photo": body.id_proof_photo,
        "degree_photo": body.degree_photo,
        "created_at": now_iso(),
    }
    await db.doctors.insert_one(doc)
    doc.pop("_id", None)
    return {"ok": True, "doctor": doc}


@api_router.put("/owner/doctors/{doctor_id}")
async def owner_update_doctor(doctor_id: str, body: OwnerUpdateDoctorBody, user: dict = Depends(require_role("owner"))):
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        return {"ok": True}
    await db.doctors.update_one({"id": doctor_id}, {"$set": updates})
    # Also sync full_name to user record
    if "full_name" in updates:
        d = await db.doctors.find_one({"id": doctor_id})
        if d:
            await db.users.update_one({"id": d["user_id"]}, {"$set": {"full_name": updates["full_name"]}})
    return {"ok": True, "updated": list(updates.keys())}


@api_router.delete("/owner/doctors/{doctor_id}")
async def owner_delete_doctor(doctor_id: str, user: dict = Depends(require_role("owner"))):
    d = await db.doctors.find_one({"id": doctor_id})
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    await db.doctors.delete_one({"id": doctor_id})
    # Also delete the user account
    await db.users.delete_one({"id": d["user_id"]})
    return {"ok": True}


# ============ SEED ============
@app.on_event("startup")
async def seed_data():
    logger.info("Seeding data...")
    # Seed sample doctors if none
    if await db.doctors.count_documents({}) == 0:
        sample_doctors = [
            {"name": "Dr. Rajesh Kumar", "specialty": "Cardiology", "city": "Mumbai", "clinic": "Heart Care Clinic", "fees": 800, "timings": "10:00 AM - 2:00 PM", "photo": "https://images.pexels.com/photos/5722160/pexels-photo-5722160.jpeg?auto=compress&cs=tinysrgb&w=400"},
            {"name": "Dr. Priya Sharma", "specialty": "Dermatology", "city": "Delhi", "clinic": "SkinGlow Clinic", "fees": 600, "timings": "11:00 AM - 4:00 PM", "photo": "https://images.pexels.com/photos/5407206/pexels-photo-5407206.jpeg?auto=compress&cs=tinysrgb&w=400"},
            {"name": "Dr. Amit Patel", "specialty": "Pediatrics", "city": "Ahmedabad", "clinic": "Little Angels Clinic", "fees": 500, "timings": "9:00 AM - 1:00 PM", "photo": "https://images.pexels.com/photos/6098051/pexels-photo-6098051.jpeg?auto=compress&cs=tinysrgb&w=400"},
            {"name": "Dr. Neha Reddy", "specialty": "Dental", "city": "Bengaluru", "clinic": "Smile Dental Care", "fees": 700, "timings": "10:00 AM - 6:00 PM", "photo": "https://images.pexels.com/photos/6749772/pexels-photo-6749772.jpeg?auto=compress&cs=tinysrgb&w=400"},
            {"name": "Dr. Suresh Iyer", "specialty": "General Physician", "city": "Chennai", "clinic": "Family Health Clinic", "fees": 400, "timings": "8:00 AM - 12:00 PM", "photo": "https://images.pexels.com/photos/5722164/pexels-photo-5722164.jpeg?auto=compress&cs=tinysrgb&w=400"},
            {"name": "Dr. Kavita Joshi", "specialty": "Orthopedics", "city": "Pune", "clinic": "BoneCare Ortho", "fees": 900, "timings": "12:00 PM - 6:00 PM", "photo": "https://images.pexels.com/photos/5327585/pexels-photo-5327585.jpeg?auto=compress&cs=tinysrgb&w=400"},
        ]
        for sd in sample_doctors:
            user_id = str(uuid.uuid4())
            email = sd["name"].lower().replace(" ", "").replace(".", "") + "@clinic.com"
            await db.users.insert_one({
                "id": user_id,
                "email": email,
                "password_hash": hash_password("doctor123"),
                "full_name": sd["name"],
                "role": "doctor",
                "phone": "+91-9999999999",
                "created_at": now_iso(),
            })
            await db.doctors.insert_one({
                "id": str(uuid.uuid4()),
                "user_id": user_id,
                "full_name": sd["name"],
                "specialty": sd["specialty"],
                "city": sd["city"],
                "clinic_name": sd["clinic"],
                "fees": sd["fees"],
                "timings": sd["timings"],
                "rating": 4.6,
                "photo": sd["photo"],
                "bio": f"Experienced {sd['specialty']} specialist with 10+ years of practice.",
                "status": "active",
            })

    # Seed a demo receptionist
    if not await db.users.find_one({"email": "reception@clinic.com"}):
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": "reception@clinic.com",
            "password_hash": hash_password("reception123"),
            "full_name": "Front Desk",
            "role": "receptionist",
            "phone": "+91-9000000000",
            "created_at": now_iso(),
        })

    # Seed the app owner (admin)
    if not await db.users.find_one({"email": "owner@meribaari.com"}):
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": "owner@meribaari.com",
            "password_hash": hash_password("owner123"),
            "full_name": "App Owner",
            "role": "owner",
            "phone": "+91-9000000001",
            "created_at": now_iso(),
        })
    logger.info("Seed complete.")


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
