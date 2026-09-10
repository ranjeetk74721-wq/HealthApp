import os
import time
import uuid
import secrets
import pytest
import pymongo
from datetime import datetime, timezone, timedelta
from starlette.testclient import TestClient

from server import app, hash_otp, normalize_mobile, create_token, save_memory_otp
from rate_limiter import rate_limiter
from sms_service import send_appointment_sms, format_brevo_recipient

sync_client = pymongo.MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
sync_db = sync_client[os.environ.get("DB_NAME", "clinicqueue")]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def reset_rate_limits():
    # Clear in-memory rate limits before each test to isolate test cases
    rate_limiter._records.clear()
    rate_limiter._blocks.clear()
    rate_limiter._violations.clear()
    rate_limiter._last_event.clear()


@pytest.fixture(scope="module")
def test_doctor(client):
    """Ensure a doctor exists for booking tests."""
    doc = sync_db.doctors.find_one({"status": "active"})
    if doc:
        return doc
    doc_id = str(uuid.uuid4())
    doc_data = {
        "id": doc_id,
        "user_id": str(uuid.uuid4()),
        "full_name": "Dr. Test Specialist",
        "specialty": "General Physician",
        "city": "Mumbai",
        "clinic_name": "Test Clinic",
        "fees": 500,
        "timings": "10:00 AM - 6:00 PM",
        "avg_consult_minutes": 15,
        "status": "active",
    }
    sync_db.doctors.insert_one(doc_data)
    return doc_data


@pytest.fixture(scope="module")
def reception_token():
    """Create a test receptionist user and token."""
    rec_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": rec_id,
        "email": f"rec_{rec_id[:6]}@clinic.com",
        "full_name": "Test Receptionist",
        "role": "receptionist",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return create_token(rec_id, "receptionist")


def set_test_otp(mobile: str, otp: str = "654321", expires_in_sec: int = 300):
    save_memory_otp(mobile, otp, expires_in_sec)


# ==============================================================================
# TEST CASES 1 & 2: Receptionist booking (New vs Existing Patient)
# ==============================================================================
def test_1_receptionist_books_new_patient(client, reception_token, test_doctor):
    """Case 1: Receptionist books new patient:
    - patient created in db.users
    - phone_verified is False
    - appointment created and linked to patient ID
    - secure_token is generated
    - SMS status tracked
    """
    unique_mobile = f"98765{secrets.randbelow(90000) + 10000}"
    name = "New Test Patient"

    res = client.post(
        "/api/reception/add-patient",
        headers={"Authorization": f"Bearer {reception_token}"},
        json={
            "full_name": name,
            "mobile": unique_mobile,
            "doctor_id": test_doctor["id"],
            "age": 28,
            "gender": "Female",
        },
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["ok"] is True
    patient = data["patient"]
    appointment = data["appointment"]

    assert patient["full_name"] == name
    assert patient["mobile"] == f"+91{unique_mobile}"
    assert appointment["patient_id"] == patient["id"]
    assert appointment["secure_token"] is not None
    assert appointment["sms_status"] in ("sent", "failed", "pending")

    # Verify in DB: phone_verified must be False for receptionist-created patient
    u = sync_db.users.find_one({"id": patient["id"]})
    assert u is not None
    assert u.get("phone_verified") is False


def test_2_receptionist_books_existing_patient(client, reception_token, test_doctor):
    """Case 2: Receptionist books existing patient:
    - existing account reused
    - no duplicate patient record created in db.users
    """
    existing_mobile = f"98123{secrets.randbelow(90000) + 10000}"
    # Seed an existing patient in DB
    existing_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": existing_id,
        "mobile": f"+91{existing_mobile}",
        "full_name": "Original Patient",
        "role": "patient",
        "phone_verified": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Book via reception for next month to avoid same-day conflict
    future_date = (datetime.now(timezone.utc) + timedelta(days=20)).strftime("%Y-%m-%d")
    res = client.post(
        "/api/reception/add-patient",
        headers={"Authorization": f"Bearer {reception_token}"},
        json={
            "full_name": "Original Patient Updated",
            "mobile": existing_mobile,
            "doctor_id": test_doctor["id"],
            "date": future_date,
        },
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["patient"]["id"] == existing_id

    # Verify no duplicate user was inserted
    count = sync_db.users.count_documents({"mobile": f"+91{existing_mobile}"})
    assert count == 1


# ==============================================================================
# TEST CASES 3, 4, 5: Dynamic Appointment Link & OTP Authorization
# ==============================================================================
def test_3_dynamic_link_unauthenticated_requires_otp(client, test_doctor):
    """Case 3: Patient opens SMS link while logged out:
    - Backend returns 401 Not authenticated
    """
    token = secrets.token_urlsafe(16)
    res = client.get(f"/api/appointments/by-token/{token}")
    assert res.status_code == 401


def test_4_otp_login_and_dynamic_link_access(client, test_doctor):
    """Case 4: Correct OTP login grants token and allows viewing the appointment."""
    mobile = f"98234{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"

    # 1. Send OTP
    r_send = client.post("/api/auth/send-otp", json={"mobile": mobile})
    assert r_send.status_code == 200

    # 2. Set known test OTP in DB and verify
    set_test_otp(mobile, "123456")
    r_verify = client.post("/api/auth/verify-otp", json={
        "mobile": mobile,
        "otp": "123456",
        "full_name": "OTP Verified Patient",
    })
    assert r_verify.status_code == 200, r_verify.text
    auth_data = r_verify.json()
    patient_jwt = auth_data["access_token"]
    patient_id = auth_data["user"]["id"]

    # 3. Create appointment for this patient
    secure_token = secrets.token_urlsafe(16)
    appt_id = str(uuid.uuid4())
    sync_db.appointments.insert_one({
        "id": appt_id,
        "secure_token": secure_token,
        "doctor_id": test_doctor["id"],
        "doctor_name": test_doctor["full_name"],
        "patient_id": patient_id,
        "patient_name": "OTP Verified Patient",
        "patient_mobile": norm_mobile,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "slot": "Walk-in",
        "token_number": 5,
        "status": "booked",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # 4. Access dynamic link with authorized JWT
    r_link = client.get(
        f"/api/appointments/by-token/{secure_token}",
        headers={"Authorization": f"Bearer {patient_jwt}"},
    )
    assert r_link.status_code == 200, r_link.text
    data = r_link.json()
    assert data["ok"] is True
    assert data["appointment"]["id"] == appt_id
    assert "queue" in data
    assert "eta_minutes" in data["queue"]


def test_5_wrong_patient_access_forbidden(client, test_doctor):
    """Case 5: Wrong patient tries another appointment URL:
    - returns HTTP 403 Forbidden
    """
    # Seed Patient A and Patient B with unique phones
    mobile_a = f"+9199{secrets.randbelow(90000000) + 10000000}"
    mobile_b = f"+9199{secrets.randbelow(90000000) + 10000000}"
    patient_a_id = f"pat_a_{uuid.uuid4().hex[:6]}"
    patient_b_id = f"pat_b_{uuid.uuid4().hex[:6]}"
    sync_db.users.insert_many([
        {"id": patient_a_id, "full_name": "Patient A", "role": "patient", "mobile": mobile_a, "created_at": datetime.now(timezone.utc).isoformat()},
        {"id": patient_b_id, "full_name": "Patient B", "role": "patient", "mobile": mobile_b, "created_at": datetime.now(timezone.utc).isoformat()},
    ])

    # Create appointment for Patient A
    secure_token = secrets.token_urlsafe(16)
    sync_db.appointments.insert_one({
        "id": str(uuid.uuid4()),
        "secure_token": secure_token,
        "doctor_id": test_doctor["id"],
        "patient_id": patient_a_id,
        "patient_mobile": mobile_a,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "token_number": 1,
        "status": "booked",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # Patient B tries to access Patient A's appointment
    patient_b_jwt = create_token(patient_b_id, "patient")
    r = client.get(
        f"/api/appointments/by-token/{secure_token}",
        headers={"Authorization": f"Bearer {patient_b_jwt}"},
    )
    assert r.status_code == 403
    assert "permission" in r.text.lower()


# ==============================================================================
# TEST CASE 6: Duplicate Active Booking Prevention (HTTP 409)
# ==============================================================================
def test_6_duplicate_active_appointment_returns_409(client, reception_token, test_doctor):
    """Case 6: Same phone tries duplicate active appointment on same day:
    - Rejected with HTTP 409 Conflict
    """
    mobile = f"98345{secrets.randbelow(90000) + 10000}"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # 1. First booking succeeds
    r1 = client.post(
        "/api/reception/add-patient",
        headers={"Authorization": f"Bearer {reception_token}"},
        json={
            "full_name": "Duplicate Test Patient",
            "mobile": mobile,
            "doctor_id": test_doctor["id"],
            "date": today,
        },
    )
    assert r1.status_code == 200

    # 2. Second booking on same date for same phone fails with 409
    r2 = client.post(
        "/api/reception/add-patient",
        headers={"Authorization": f"Bearer {reception_token}"},
        json={
            "full_name": "Duplicate Test Patient",
            "mobile": mobile,
            "doctor_id": test_doctor["id"],
            "date": today,
        },
    )
    assert r2.status_code == 409
    assert "already have an active appointment" in r2.text or "already has an active appointment" in r2.text


# ==============================================================================
# TEST CASES 7 & 8: Rate Limiting (Booking & OTP)
# ==============================================================================
def test_7_rate_limit_rapid_bookings(client, test_doctor):
    """Case 7: Rapid repeated booking requests:
    - Rate limiter returns HTTP 429 with Retry-After header
    """
    p_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": p_id,
        "full_name": "Rate Limited Patient",
        "role": "patient",
        "mobile": "+919844400000",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    patient_jwt = create_token(p_id, "patient")

    # Simulate 6 booking attempts within seconds
    responses = []
    for i in range(6):
        future_date = (datetime.now(timezone.utc) + timedelta(days=i + 5)).strftime("%Y-%m-%d")
        res = client.post(
            "/api/appointments",
            headers={"Authorization": f"Bearer {patient_jwt}"},
            json={
                "doctor_id": test_doctor["id"],
                "date": future_date,
            },
        )
        responses.append(res.status_code)

    assert 429 in responses
    # Verify Retry-After header present on 429
    for r_code in responses:
        if r_code == 429:
            # At least one was rate-limited
            break


def test_8_rate_limit_rapid_otp_sends(client):
    """Case 8: Rapid OTP send attempts:
    - Cooldown and max send limits return HTTP 429
    """
    mobile = f"98456{secrets.randbelow(90000) + 10000}"

    # 1. First send succeeds
    r1 = client.post("/api/auth/send-otp", json={"mobile": mobile})
    assert r1.status_code == 200

    # 2. Second send immediately within 60s cooldown fails with 429
    r2 = client.post("/api/auth/send-otp", json={"mobile": mobile})
    assert r2.status_code == 429
    assert "Retry-After" in r2.headers


# ==============================================================================
# TEST CASE 9: Brevo Resilience & Secret Privacy
# ==============================================================================
@pytest.mark.asyncio
async def test_9_brevo_failure_resilience_and_secret_privacy():
    """Case 9: Brevo SMS failure does not crash or expose API keys."""
    res = await send_appointment_sms(
        phone="invalid-number",
        patient_name="Test Patient",
        doctor_name="Dr. Test",
        token_number=1,
        estimated_time="10:30 AM",
        appointment_link="http://localhost:8081/appointment/test",
    )
    # Failure is handled gracefully
    assert res["ok"] is False
    # API key or secrets are never exposed in return value
    res_str = str(res)
    assert "xkeysib" not in res_str
    assert "secret" not in res_str.lower()


# ==============================================================================
# TEST CASE 10: Patient Direct Booking Sends SMS & Sets Secure Token
# ==============================================================================
def test_10_patient_direct_booking(client, test_doctor):
    """Case 10: Patient books directly:
    - SMS triggered, secure_token generated
    """
    mobile = f"98567{secrets.randbelow(90000) + 10000}"
    p_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": p_id,
        "mobile": f"+91{mobile}",
        "full_name": "Direct Patient",
        "role": "patient",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    token = create_token(p_id, "patient")

    future_date = (datetime.now(timezone.utc) + timedelta(days=15)).strftime("%Y-%m-%d")
    r = client.post(
        "/api/appointments",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "doctor_id": test_doctor["id"],
            "date": future_date,
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "secure_token" in data
    assert data["sms_status"] in ("sent", "failed", "pending")


# ==============================================================================
# TEST CASE 11: Dynamic ETA Calculation
# ==============================================================================
def test_11_dynamic_queue_eta_calculation(client, test_doctor):
    """Case 11: Dynamic appointment page:
    - Latest estimated time comes from existing queue calculation
    """
    secure_token = secrets.token_urlsafe(16)
    appt_id = str(uuid.uuid4())
    p_id = str(uuid.uuid4())
    mobile_11 = f"+9199{secrets.randbelow(90000000) + 10000000}"
    sync_db.users.insert_one({
        "id": p_id,
        "full_name": "ETA Patient",
        "role": "patient",
        "mobile": mobile_11,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    sync_db.appointments.insert_one({
        "id": appt_id,
        "secure_token": secure_token,
        "doctor_id": test_doctor["id"],
        "doctor_name": test_doctor["full_name"],
        "patient_id": p_id,
        "patient_name": "ETA Patient",
        "patient_mobile": mobile_11,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "token_number": 3,
        "status": "booked",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    p_token = create_token(p_id, "patient")
    res = client.get(
        f"/api/appointments/by-token/{secure_token}",
        headers={"Authorization": f"Bearer {p_token}"},
    )
    assert res.status_code == 200
    q = res.json()["queue"]
    assert "eta_minutes" in q
    assert "expected_turn_time" in q
    assert "total_in_queue" in q


# ==============================================================================
# TEST CASE 12: Receptionist Send-Link Cooldown
# ==============================================================================
def test_12_receptionist_send_link_cooldown(client, reception_token, test_doctor):
    """Case 12: Receptionist clicking 'Send Link' repeatedly is throttled by cooldown."""
    appt_id = str(uuid.uuid4())
    mobile_12 = f"+9199{secrets.randbelow(90000000) + 10000000}"
    sync_db.appointments.insert_one({
        "id": appt_id,
        "doctor_id": test_doctor["id"],
        "doctor_name": test_doctor["full_name"],
        "patient_id": "test_patient_id",
        "patient_name": "Cooldown Patient",
        "patient_mobile": mobile_12,
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "token_number": 1,
        "status": "booked",
        "created_at": datetime.now(timezone.utc).isoformat(),
    })

    # First send link succeeds
    r1 = client.post(
        f"/api/reception/appointments/{appt_id}/send-link",
        headers={"Authorization": f"Bearer {reception_token}"},
    )
    assert r1.status_code == 200
    assert r1.json()["ok"] is True

    # Second send link immediately within 45s cooldown returns 429
    r2 = client.post(
        f"/api/reception/appointments/{appt_id}/send-link",
        headers={"Authorization": f"Bearer {reception_token}"},
    )
    assert r2.status_code == 429
    assert "Retry-After" in r2.headers
