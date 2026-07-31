from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
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
JWT_EXP_SECONDS = 60 * 60 * 24 * 7  # 7 days

app = FastAPI()
api_router = APIRouter(prefix="/api")
security = HTTPBearer(auto_error=False)

Role = Literal["patient", "doctor", "receptionist"]


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
    email: str
    full_name: str
    role: str
    phone: Optional[str] = None


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


# ============ HELPERS ============
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def create_token(user_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(seconds=JWT_EXP_SECONDS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


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
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "arrived"}})
    return {"ok": True}


@api_router.post("/reception/start_consultation")
async def start_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "in_consultation"}})
    return {"ok": True}


@api_router.post("/reception/complete")
async def complete_consultation(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "completed", "payment_status": "paid"}})
    return {"ok": True}


@api_router.post("/reception/skip")
async def skip_patient(body: QueueActionBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"status": "skipped"}})
    return {"ok": True}


@api_router.post("/reception/reorder")
async def reorder(body: ReorderBody, user: dict = Depends(require_role("receptionist", "doctor"))):
    await db.appointments.update_one({"id": body.appointment_id}, {"$set": {"token_number": body.new_position}})
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
    return doc


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
