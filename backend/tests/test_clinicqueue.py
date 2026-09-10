import os
import time
import uuid
from datetime import datetime, timezone, timedelta
import pytest
import requests
import pymongo
from server import hash_otp, normalize_mobile

BASE_URL = os.environ.get("BACKEND_TEST_URL", "http://127.0.0.1:8000").rstrip("/")
API = f"{BASE_URL}/api"

RECEPTION_EMAIL = "reception@clinic.com"
RECEPTION_PASSWORD = "reception123"
DOCTOR_EMAIL = "drrajeshkumar@clinic.com"
DOCTOR_PASSWORD = "doctor123"

sync_client = pymongo.MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
sync_db = sync_client[os.environ.get("DB_NAME", "clinicqueue")]

def set_test_otp(mobile: str, otp: str = "654321", expires_in_sec: int = 300):
    norm = normalize_mobile(mobile)
    exp = (datetime.now(timezone.utc) + timedelta(seconds=expires_in_sec)).isoformat()
    sync_db.otps.update_one(
        {"mobile": norm},
        {"$set": {
            "mobile": norm,
            "otp_hash": hash_otp(otp, norm),
            "expires_at": exp,
            "attempts": 0,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }},
        upsert=True
    )


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def patient_ctx(s):
    email = f"TEST_patient_{uuid.uuid4().hex[:8]}@example.com"
    r = s.post(f"{API}/auth/signup", json={
        "email": email, "password": "pass123", "full_name": "TEST Patient", "role": "patient"
    })
    assert r.status_code == 200, r.text
    data = r.json()
    return {"token": data["access_token"], "user": data["user"], "email": email}


@pytest.fixture(scope="module")
def doctor_token(s, admin_token):
    r = s.post(f"{API}/auth/login", json={"email": DOCTOR_EMAIL, "password": DOCTOR_PASSWORD})
    if r.status_code == 200:
        return r.json()["access_token"]
    # Create test doctor
    doc_email = f"dr_{uuid.uuid4().hex[:6]}@clinic.com"
    r_create = s.post(f"{API}/owner/doctors", headers=h(admin_token), json={
        "full_name": "Dr Rajesh Kumar",
        "email": doc_email,
        "password": "doctor123",
        "specialty": "Cardiologist",
        "hospital_id": "H00001",
    })
    if r_create.status_code == 200:
        r_login = s.post(f"{API}/auth/login", json={"email": doc_email, "password": "doctor123"})
        return r_login.json()["access_token"]
    # Fallback to signup
    s.post(f"{API}/auth/signup", json={"email": DOCTOR_EMAIL, "password": DOCTOR_PASSWORD, "full_name": "Dr Rajesh Kumar", "role": "doctor"})
    r_login = s.post(f"{API}/auth/login", json={"email": DOCTOR_EMAIL, "password": DOCTOR_PASSWORD})
    return r_login.json()["access_token"]


@pytest.fixture(scope="module")
def reception_token(s, admin_token):
    r = s.post(f"{API}/auth/login", json={"email": RECEPTION_EMAIL, "password": RECEPTION_PASSWORD})
    if r.status_code == 200:
        return r.json()["access_token"]
    # Create test receptionist
    rec_email = f"rec_{uuid.uuid4().hex[:6]}@clinic.com"
    r_create = s.post(f"{API}/owner/receptionists", headers=h(admin_token), json={
        "full_name": "Test Receptionist",
        "email": rec_email,
        "password": "reception123",
        "hospital_id": "H00001",
    })
    if r_create.status_code == 200:
        r_login = s.post(f"{API}/auth/login", json={"email": rec_email, "password": "reception123"})
        return r_login.json()["access_token"]
    # Fallback to signup
    s.post(f"{API}/auth/signup", json={"email": RECEPTION_EMAIL, "password": RECEPTION_PASSWORD, "full_name": "Test Receptionist", "role": "receptionist"})
    r_login = s.post(f"{API}/auth/login", json={"email": RECEPTION_EMAIL, "password": RECEPTION_PASSWORD})
    return r_login.json()["access_token"]


def h(token):
    return {"Authorization": f"Bearer {token}"}


# ---------------- AUTH ----------------
class TestAuth:
    def test_login_reception(self, reception_token):
        assert isinstance(reception_token, str) and len(reception_token) > 20

    def test_login_doctor(self, doctor_token):
        assert isinstance(doctor_token, str)

    def test_signup_creates_patient(self, patient_ctx):
        assert patient_ctx["user"]["role"] == "patient"

    def test_me_returns_user(self, s, patient_ctx):
        r = s.get(f"{API}/auth/me", headers=h(patient_ctx["token"]))
        assert r.status_code == 200
        assert r.json()["email"] == patient_ctx["email"]

    def test_me_unauth(self, s):
        r = s.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_login_bad_password(self, s):
        r = s.post(f"{API}/auth/login", json={"email": RECEPTION_EMAIL, "password": "wrong"})
        assert r.status_code == 401

    def test_hospital_id_login(self, s):
        r = s.post(f"{API}/auth/login", json={"email": "ranjeet7421@gmail.com", "password": "Ranjeet@74", "hospital_id": "H00001"})
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data
        assert data["user"]["role"] in ["admin", "owner"]


# ---------------- DOCTORS ----------------
class TestDoctors:
    def test_list_doctors(self, s):
        r = s.get(f"{API}/doctors")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list) and len(data) >= 6
        assert "est_wait_minutes" in data[0]
        assert "_id" not in data[0]

    def test_search_filter(self, s):
        r = s.get(f"{API}/doctors", params={"search": "Rajesh"})
        assert r.status_code == 200
        names = [d["full_name"] for d in r.json()]
        assert any("Rajesh" in n for n in names)

    def test_specialty_filter(self, s):
        r = s.get(f"{API}/doctors", params={"specialty": "Cardiology"})
        assert r.status_code == 200
        for d in r.json():
            assert "cardiology" in d["specialty"].lower()

    def test_get_doctor_by_id(self, s):
        doctors = s.get(f"{API}/doctors").json()
        did = doctors[0]["id"]
        r = s.get(f"{API}/doctors/{did}")
        assert r.status_code == 200
        assert r.json()["id"] == did

    def test_get_doctor_404(self, s):
        r = s.get(f"{API}/doctors/nonexistent-id")
        assert r.status_code == 404

    def test_specialties(self, s):
        r = s.get(f"{API}/specialties")
        assert r.status_code == 200
        assert len(r.json()) >= 6


# ---------------- RBAC ----------------
class TestRBAC:
    def test_patient_cannot_access_doctor_dashboard(self, s, patient_ctx):
        r = s.get(f"{API}/doctor/dashboard", headers=h(patient_ctx["token"]))
        assert r.status_code == 403

    def test_patient_cannot_access_reception_queue(self, s, patient_ctx):
        r = s.get(f"{API}/reception/queue", headers=h(patient_ctx["token"]))
        assert r.status_code == 403

    def test_unauth_appointments_me(self, s):
        r = s.get(f"{API}/appointments/me")
        assert r.status_code == 401

    def test_unauth_doctor_dashboard(self, s):
        r = s.get(f"{API}/doctor/dashboard")
        assert r.status_code == 401


# ---------------- APPOINTMENTS + QUEUE E2E ----------------
class TestAppointmentFlow:
    _shared = {}

    def test_create_appointment(self, s, patient_ctx):
        doctors = s.get(f"{API}/doctors").json()
        # pick Dr. Rajesh Kumar
        doc = next(d for d in doctors if "Rajesh" in d["full_name"])
        today = time.strftime("%Y-%m-%d")
        r = s.post(f"{API}/appointments", headers=h(patient_ctx["token"]), json={
            "doctor_id": doc["id"], "date": today, "slot": "10:00 AM", "payment_method": "pay_at_clinic"
        })
        assert r.status_code == 200, r.text
        appt = r.json()
        assert appt["status"] == "booked"
        assert appt["token_number"] >= 1
        self._shared["appt"] = appt
        self._shared["doctor_id"] = doc["id"]

    def test_online_payment_marks_paid(self, s):
        p = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_online_{uuid.uuid4().hex[:6]}@example.com", "password": "pass123", "full_name": "Online Payee", "role": "patient"
        }).json()
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[1]
        today = time.strftime("%Y-%m-%d")
        r = s.post(f"{API}/appointments", headers=h(p["access_token"]), json={
            "doctor_id": doc["id"], "date": today, "slot": "11:00 AM", "payment_method": "online"
        })
        assert r.status_code == 200
        assert r.json()["payment_status"] == "paid"

    def test_appointments_me(self, s, patient_ctx):
        r = s.get(f"{API}/appointments/me", headers=h(patient_ctx["token"]))
        assert r.status_code == 200
        assert len(r.json()) >= 1

    def test_queue_status_shows_position(self, s, patient_ctx):
        appt = self._shared["appt"]
        r = s.get(f"{API}/appointments/{appt['id']}/queue", headers=h(patient_ctx["token"]))
        assert r.status_code == 200
        data = r.json()
        assert "my_position" in data
        assert "eta_minutes" in data
        assert "currently_serving" in data
        assert "completed_count" in data
        assert data["my_position"] >= 1

    def test_reception_full_flow(self, s, reception_token, patient_ctx):
        appt = self._shared["appt"]
        appt_id = appt["id"]
        # mark arrived
        r = s.post(f"{API}/reception/mark_arrived", headers=h(reception_token), json={"appointment_id": appt_id})
        assert r.status_code == 200
        # start consultation
        r = s.post(f"{API}/reception/start_consultation", headers=h(reception_token), json={"appointment_id": appt_id})
        assert r.status_code == 200
        # queue should now show my_position=0 (in consultation)
        q = s.get(f"{API}/appointments/{appt_id}/queue", headers=h(patient_ctx["token"])).json()
        assert q["my_position"] == 0
        assert q["currently_serving"] == appt["token_number"]
        # complete
        r = s.post(f"{API}/reception/complete", headers=h(reception_token), json={"appointment_id": appt_id})
        assert r.status_code == 200
        # queue shows completed_count increased
        q2 = s.get(f"{API}/appointments/{appt_id}/queue", headers=h(patient_ctx["token"])).json()
        assert q2["completed_count"] >= 1
        assert q2["my_position"] == -1

    def test_cancel_appointment(self, s):
        p = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_cancel_{uuid.uuid4().hex[:6]}@example.com", "password": "pass123", "full_name": "Cancel User", "role": "patient"
        }).json()
        doctors = s.get(f"{API}/doctors").json()
        today = time.strftime("%Y-%m-%d")
        r = s.post(f"{API}/appointments", headers=h(p["access_token"]), json={
            "doctor_id": doctors[2]["id"], "date": today, "slot": "2:00 PM", "payment_method": "pay_at_clinic"
        })
        aid = r.json()["id"]
        r = s.post(f"{API}/appointments/{aid}/cancel", headers=h(p["access_token"]))
        assert r.status_code == 200


# ---------------- DOCTOR endpoints ----------------
class TestDoctorEndpoints:
    def test_dashboard(self, s, doctor_token):
        r = s.get(f"{API}/doctor/dashboard", headers=h(doctor_token))
        assert r.status_code == 200
        d = r.json()
        for k in ("doctor", "total_patients", "completed", "pending", "earnings", "status"):
            assert k in d

    def test_appointments_today(self, s, doctor_token):
        r = s.get(f"{API}/doctor/appointments", headers=h(doctor_token))
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_set_status_valid(self, s, doctor_token):
        for st in ("active", "break", "emergency", "active"):
            r = s.post(f"{API}/doctor/status", headers=h(doctor_token), json={"status": st})
            assert r.status_code == 200
            assert r.json()["status"] == st

    def test_set_status_invalid(self, s, doctor_token):
        r = s.post(f"{API}/doctor/status", headers=h(doctor_token), json={"status": "bogus"})
        assert r.status_code == 400


# ---------------- RECEPTION endpoints ----------------
class TestReception:
    def test_list_doctors(self, s, reception_token):
        r = s.get(f"{API}/reception/doctors", headers=h(reception_token))
        assert r.status_code == 200
        assert len(r.json()) >= 6

    def test_queue_no_filter(self, s, reception_token):
        r = s.get(f"{API}/reception/queue", headers=h(reception_token))
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_emergency_insert(self, s, reception_token):
        doctors = s.get(f"{API}/doctors").json()
        did = doctors[0]["id"]
        r = s.post(f"{API}/reception/emergency_insert", headers=h(reception_token),
                   json={"doctor_id": did, "patient_name": "TEST_Emergency"})
        assert r.status_code == 200
        assert r.json()["token_number"] == 0
        assert r.json()["status"] == "arrived"


# ---------------- Queue position updates for OTHER patients ----------------
class TestQueueUpdatesOtherPatients:
    def test_position_shifts_after_completion(self, s, reception_token):
        # Create two fresh patients booking same doctor
        doctors = s.get(f"{API}/doctors").json()
        did = doctors[3]["id"]  # different doctor to avoid interference
        today = time.strftime("%Y-%m-%d")

        p1 = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_p1_{uuid.uuid4().hex[:6]}@x.com", "password": "pass123", "full_name": "P1", "role": "patient"
        }).json()
        p2 = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_p2_{uuid.uuid4().hex[:6]}@x.com", "password": "pass123", "full_name": "P2", "role": "patient"
        }).json()

        a1 = s.post(f"{API}/appointments", headers=h(p1["access_token"]),
                    json={"doctor_id": did, "date": today, "slot": "3:00 PM", "payment_method": "pay_at_clinic"}).json()
        a2 = s.post(f"{API}/appointments", headers=h(p2["access_token"]),
                    json={"doctor_id": did, "date": today, "slot": "3:15 PM", "payment_method": "pay_at_clinic"}).json()

        # p2 position before
        q_before = s.get(f"{API}/appointments/{a2['id']}/queue", headers=h(p2["access_token"])).json()
        pos_before = q_before["my_position"]

        # Complete a1
        s.post(f"{API}/reception/start_consultation", headers=h(reception_token), json={"appointment_id": a1["id"]})
        s.post(f"{API}/reception/complete", headers=h(reception_token), json={"appointment_id": a1["id"]})

        q_after = s.get(f"{API}/appointments/{a2['id']}/queue", headers=h(p2["access_token"])).json()
        pos_after = q_after["my_position"]
        assert pos_after < pos_before, f"Position should shift down. before={pos_before} after={pos_after}"


# ---------------- MOBILE OTP AUTH (Patient) ----------------
class TestMobileOTP:
    _shared = {}

    def test_send_otp_success_no_plaintext_otp_exposure(self, s):
        mobile_raw = f"98765{str(uuid.uuid4().int)[:5]}"[:10]  # random 10-digit
        r = s.post(f"{API}/auth/send-otp", json={"mobile": mobile_raw})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["mobile"].startswith("+91"), f"expected +91 prefix, got {data['mobile']}"
        assert data["mobile"].endswith(mobile_raw)
        # CRITICAL: OTP must never be returned in plaintext through the API
        assert "otp" not in data
        assert "dev_otp" not in data
        assert data["is_registered"] is False
        self.__class__._shared["mobile_new"] = mobile_raw

    def test_send_otp_bad_mobile(self, s):
        r = s.post(f"{API}/auth/send-otp", json={"mobile": "123"})
        assert r.status_code == 400

    def test_send_otp_accepts_plus91_format(self, s):
        # normalization should accept +91 prefix
        num = f"98765{str(uuid.uuid4().int)[:5]}"[:10]
        r = s.post(f"{API}/auth/send-otp", json={"mobile": f"+91{num}"})
        assert r.status_code == 200
        assert r.json()["mobile"] == f"+91{num}"

    def test_verify_otp_invalid_format(self, s):
        mobile = self._shared["mobile_new"]
        r = s.post(f"{API}/auth/verify-otp", json={"mobile": mobile, "otp": "12"})
        assert r.status_code == 400

    def test_verify_otp_wrong_otp(self, s):
        mobile = self._shared["mobile_new"]
        s.post(f"{API}/auth/send-otp", json={"mobile": mobile})
        r = s.post(f"{API}/auth/verify-otp", json={"mobile": mobile, "otp": "000000"})
        assert r.status_code == 401
        assert "Invalid OTP" in r.json()["detail"]

    def test_verify_otp_expired_otp(self, s):
        mobile = f"98765{str(uuid.uuid4().int)[:5]}"[:10]
        set_test_otp(mobile, otp="999888", expires_in_sec=-10)  # expired 10s ago
        r = s.post(f"{API}/auth/verify-otp", json={"mobile": mobile, "otp": "999888", "full_name": "Expired Test"})
        assert r.status_code == 401
        assert "expired" in r.json()["detail"].lower()

    def test_verify_otp_new_patient_requires_name(self, s):
        mobile = self._shared["mobile_new"]
        set_test_otp(mobile, otp="654321")
        r = s.post(f"{API}/auth/verify-otp", json={"mobile": mobile, "otp": "654321"})
        assert r.status_code == 400
        assert "name" in r.json()["detail"].lower()

    def test_verify_otp_valid_creates_patient(self, s):
        mobile = self._shared["mobile_new"]
        set_test_otp(mobile, otp="654321")
        r = s.post(f"{API}/auth/verify-otp", json={
            "mobile": mobile, "otp": "654321",
            "full_name": "TEST OTP User", "age": 28, "gender": "Male", "address": "TEST addr",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["user"]["role"] == "patient"
        assert data["user"]["mobile"] == f"+91{mobile}"
        assert data["user"]["full_name"] == "TEST OTP User"
        assert data["user"]["age"] == 28
        assert data["user"]["gender"] == "Male"
        assert isinstance(data["access_token"], str)
        self.__class__._shared["token_new"] = data["access_token"]

    def test_verify_otp_second_login_existing_no_name_needed(self, s):
        mobile = self._shared["mobile_new"]
        # existing user should now come back as registered
        r = s.post(f"{API}/auth/send-otp", json={"mobile": mobile})
        assert r.json()["is_registered"] is True
        set_test_otp(mobile, otp="112233")
        r2 = s.post(f"{API}/auth/verify-otp", json={"mobile": mobile, "otp": "112233"})
        assert r2.status_code == 200
        assert r2.json()["user"]["full_name"] == "TEST OTP User"


# ---------------- RECEPTION Add Patient ----------------
class TestReceptionAddPatient:
    _shared = {}

    def test_add_patient_no_appointment(self, s, reception_token):
        num = f"98765{str(uuid.uuid4().int)[:5]}"[:10]
        r = s.post(f"{API}/reception/add-patient", headers=h(reception_token), json={
            "full_name": "TEST Walk-in NoAppt",
            "mobile": num,
            "age": 45,
            "gender": "Female",
            "address": "TEST street",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["patient"]["mobile"] == f"+91{num}"
        assert data["patient"]["full_name"] == "TEST Walk-in NoAppt"
        assert data["appointment"] is None

    def test_add_patient_with_appointment(self, s, reception_token):
        doctors = s.get(f"{API}/doctors").json()
        did = doctors[4]["id"]
        num = f"98765{str(uuid.uuid4().int)[:5]}"[:10]
        r = s.post(f"{API}/reception/add-patient", headers=h(reception_token), json={
            "full_name": "TEST Walk-in Sunita",
            "mobile": num,
            "age": 30,
            "gender": "Female",
            "symptoms": "Fever and headache",
            "address": "TEST addr",
            "doctor_id": did,
            "slot": "11:30 AM",
        })
        assert r.status_code == 200, r.text
        data = r.json()
        appt = data["appointment"]
        assert appt is not None
        assert appt["status"] == "arrived"
        assert appt["token_number"] >= 1
        assert appt["doctor_id"] == did
        assert appt["symptoms"] == "Fever and headache"
        assert appt["patient_name"] == "TEST Walk-in Sunita"
        self.__class__._shared["mobile"] = num
        self.__class__._shared["patient_id"] = data["patient"]["id"]
        self.__class__._shared["appt_id"] = appt["id"]

    def test_added_patient_appears_in_reception_queue(self, s, reception_token):
        appt_id = self._shared["appt_id"]
        r = s.get(f"{API}/reception/queue", headers=h(reception_token))
        assert r.status_code == 200
        ids = [a["id"] for a in r.json()]
        assert appt_id in ids

    def test_added_patient_can_self_login_via_otp(self, s):
        """Same mobile the receptionist used should log in the same patient."""
        num = self._shared["mobile"]
        r = s.post(f"{API}/auth/send-otp", json={"mobile": num})
        assert r.status_code == 200
        assert r.json()["is_registered"] is True, "receptionist-added patient should be marked registered"
        set_test_otp(num, otp="123456")
        r2 = s.post(f"{API}/auth/verify-otp", json={"mobile": num, "otp": "123456"})
        assert r2.status_code == 200
        user = r2.json()["user"]
        assert user["id"] == self._shared["patient_id"], "should return same patient user"
        assert user["full_name"] == "TEST Walk-in Sunita"

    def test_add_patient_missing_name(self, s, reception_token):
        r = s.post(f"{API}/reception/add-patient", headers=h(reception_token), json={
            "full_name": "  ", "mobile": "9876543210"
        })
        assert r.status_code == 400

    def test_add_patient_invalid_mobile(self, s, reception_token):
        r = s.post(f"{API}/reception/add-patient", headers=h(reception_token), json={
            "full_name": "TEST Bad", "mobile": "12"
        })
        assert r.status_code == 400

    def test_add_patient_forbidden_for_non_reception(self, s, patient_ctx):
        r = s.post(f"{API}/reception/add-patient", headers=h(patient_ctx["token"]), json={
            "full_name": "TEST", "mobile": "9876543210"
        })
        assert r.status_code == 403


# ---------------- PUSH REGISTRATION ----------------
class TestPushRegistration:
    def test_register_push_placeholder_key_soft_fail(self, s):
        r = s.post(f"{API}/register-push", json={
            "user_id": "test-user-id",
            "platform": "ios",
            "device_token": "TEST_dummy_token"
        })
        # With placeholder key, we expect graceful degradation (either 201 registered or 201 queued_local)
        assert r.status_code == 201, f"got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("status") in ("registered", "queued_local")


ADMIN_EMAIL = "ranjeet7421@gmail.com"
ADMIN_PASSWORD = "Ranjeet@74"


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD, "hospital_code": "H00001"})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


# ---------------- WEBSOCKET ----------------
class TestWebSocket:
    def _ws_url(self, path: str) -> str:
        return BASE_URL.replace("https://", "wss://").replace("http://", "ws://") + path

    def test_ws_doctor_connect_and_receive_broadcast(self, s, reception_token):
        try:
            from websocket import create_connection  # websocket-client
        except ImportError:
            pytest.skip("websocket-client not installed")

        doctors = s.get(f"{API}/doctors").json()
        did = doctors[0]["id"]
        url = self._ws_url(f"/api/ws/queue/doctor/{did}")
        ws = create_connection(url, timeout=10)
        try:
            # First message should be connected
            import json as _json
            first = _json.loads(ws.recv())
            assert first["type"] == "connected"
            assert first["channel"] == f"doctor:{did}"

            # Trigger a broadcast by inserting an emergency
            r = s.post(f"{API}/reception/emergency_insert", headers=h(reception_token),
                       json={"doctor_id": did, "patient_name": "TEST_WS_Emergency"})
            assert r.status_code == 200

            ws.settimeout(5)
            second = _json.loads(ws.recv())
            assert second["type"] == "emergency_inserted"
            assert second["doctor_id"] == did
        finally:
            ws.close()

    def test_ws_appt_channel_connects(self, s):
        try:
            from websocket import create_connection
        except ImportError:
            pytest.skip("websocket-client not installed")
        import json as _json
        url = self._ws_url("/api/ws/queue/appt/some-appt-id")
        ws = create_connection(url, timeout=10)
        try:
            first = _json.loads(ws.recv())
            assert first["type"] == "connected"
            assert first["channel"] == "appt:some-appt-id"
            # ping/pong
            ws.send("ping")
            pong = _json.loads(ws.recv())
            assert pong["type"] == "pong"
        finally:
            ws.close()


# ---------------- SPECIALIST MANAGEMENT ----------------
class TestSpecialistManagement:
    def test_list_specialties_contains_standard_categories(self, s):
        r = s.get(f"{API}/specialties")
        assert r.status_code == 200
        specs = r.json()
        assert "Cardiologist" in specs
        assert "Dermatologist" in specs
        assert "Neurologist" in specs
        assert "Urologist" in specs
        assert "Pediatrician" in specs

    def test_admin_add_new_specialist_category(self, s, admin_token):
        new_cat = f"Bariatric Specialist {uuid.uuid4().hex[:4]}"
        r = s.post(f"{API}/specialties", headers=h(admin_token), json={"name": new_cat})
        assert r.status_code == 200
        assert r.json()["ok"] is True

        # Check it now appears in list_specialties
        r_list = s.get(f"{API}/specialties")
        assert new_cat in r_list.json()

    def test_add_duplicate_specialist_category_safe(self, s, admin_token):
        r = s.post(f"{API}/specialties", headers=h(admin_token), json={"name": "Cardiologist"})
        assert r.status_code == 200
        assert r.json()["ok"] is True


# ---------------- ADMIN EDIT DOCTOR & RECEPTIONIST ----------------
class TestAdminEditStaff:
    def test_admin_edit_doctor_fields_and_password(self, s, admin_token):
        # Create a test doctor
        doc_email = f"test_edit_doc_{uuid.uuid4().hex[:6]}@example.com"
        r_add = s.post(f"{API}/owner/add-doctor", headers=h(admin_token), json={
            "full_name": "Dr. Before Edit",
            "email": doc_email,
            "password": "DocPass123!",
            "specialty": "Cardiologist",
            "clinic_name": "Care Clinic",
            "city": "Mumbai",
            "fees": 600,
            "timings": "10 AM - 2 PM",
            "hospital_id": "H00001"
        })
        assert r_add.status_code == 200, r_add.text
        doc_id = r_add.json()["doctor"]["id"]

        # Edit doctor details and change password
        new_pwd = "NewDocPass456!"
        r_edit = s.put(f"{API}/owner/doctors/{doc_id}", headers=h(admin_token), json={
            "full_name": "Dr. After Edit",
            "specialty": "Neurologist",
            "fees": 800,
            "password": new_pwd,
            "city": "Delhi"
        })
        assert r_edit.status_code == 200, r_edit.text

        # Verify login with updated password
        r_login = s.post(f"{API}/auth/login", json={"email": doc_email, "password": new_pwd})
        assert r_login.status_code == 200, "Should be able to login with new password"

    def test_admin_edit_receptionist(self, s, admin_token):
        # Create a receptionist
        rec_email = f"test_edit_rec_{uuid.uuid4().hex[:6]}@example.com"
        r_add = s.post(f"{API}/owner/add-receptionist", headers=h(admin_token), json={
            "full_name": "Receptionist Before",
            "email": rec_email,
            "password": "RecPass123!",
            "hospital_id": "H00001"
        })
        assert r_add.status_code == 200
        rec_id = r_add.json()["receptionist"]["id"]

        # Edit receptionist
        new_rec_pwd = "NewRecPass456!"
        r_edit = s.put(f"{API}/owner/receptionists/{rec_id}", headers=h(admin_token), json={
            "full_name": "Receptionist After",
            "password": new_rec_pwd,
            "phone": "9999888877"
        })
        assert r_edit.status_code == 200

        # Verify login with updated password
        r_login = s.post(f"{API}/auth/login", json={"email": rec_email, "password": new_rec_pwd})
        assert r_login.status_code == 200


# ---------------- DOCTOR SELF-UPDATE & PHOTO RESTRICTIONS ----------------
class TestDoctorSelfUpdate:
    def test_doctor_update_own_password_and_photo(self, s):
        # Create doc & login
        email = f"dr_self_{uuid.uuid4().hex[:6]}@example.com"
        s.post(f"{API}/auth/signup", json={
            "email": email, "password": "OriginalPass1!", "full_name": "Dr Self", "role": "doctor"
        })
        r_login = s.post(f"{API}/auth/login", json={"email": email, "password": "OriginalPass1!"})
        token = r_login.json()["access_token"]

        # Valid small base64 photo
        small_photo = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        r_up = s.post(f"{API}/doctor/update_profile", headers=h(token), json={
            "password": "NewDoctorPass99!",
            "photo": small_photo,
            "fees": 750
        })
        assert r_up.status_code == 200

        # Verify login with new password
        r_check = s.post(f"{API}/auth/login", json={"email": email, "password": "NewDoctorPass99!"})
        assert r_check.status_code == 200

    def test_photo_exceeding_5mb_rejected(self, s):
        email = f"dr_largephoto_{uuid.uuid4().hex[:6]}@example.com"
        s.post(f"{API}/auth/signup", json={
            "email": email, "password": "Pass123!", "full_name": "Dr Large", "role": "doctor"
        })
        r_login = s.post(f"{API}/auth/login", json={"email": email, "password": "Pass123!"})
        token = r_login.json()["access_token"]

        # Create oversized fake base64 (> 5 MB)
        oversized_b64 = "data:image/jpeg;base64," + ("A" * (7 * 1024 * 1024))
        r_up = s.post(f"{API}/doctor/update_profile", headers=h(token), json={
            "photo": oversized_b64
        })
        assert r_up.status_code == 400
        assert "5 MB" in r_up.text


# ---------------- PREDICTABLE FUTURE CLOCK TIME ETA & REFERRAL ----------------
class TestQueueETAAndReferral:
    def test_queue_status_returns_predictable_clock_time(self, s, reception_token):
        p = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_eta_{uuid.uuid4().hex[:6]}@example.com", "password": "pass123", "full_name": "ETA User", "role": "patient"
        }).json()
        doctors = s.get(f"{API}/doctors").json()
        did = doctors[0]["id"]
        today = time.strftime("%Y-%m-%d")

        # Book appointment
        r_book = s.post(f"{API}/appointments", headers=h(p["access_token"]), json={
            "doctor_id": did,
            "date": today,
            "slot": "Token Booking",
            "payment_method": "pay_at_clinic"
        })
        assert r_book.status_code == 200
        appt_id = r_book.json()["id"]

        # Check queue status
        r_q = s.get(f"{API}/appointments/{appt_id}/queue", headers=h(p["access_token"]))
        assert r_q.status_code == 200
        qdata = r_q.json()
        assert "expected_turn_time" in qdata
        turn_time = qdata["expected_turn_time"]
        assert turn_time is not None
        # Format should be like "1:00 PM", "10:30 AM", or "Now"
        assert any(ap in turn_time for ap in ["AM", "PM", "Now"])

    def test_refer_appointment_to_another_doctor(self, s, reception_token):
        p = s.post(f"{API}/auth/signup", json={
            "email": f"TEST_refer_{uuid.uuid4().hex[:6]}@example.com", "password": "pass123", "full_name": "Refer User", "role": "patient"
        }).json()
        doctors = s.get(f"{API}/doctors").json()
        assert len(doctors) >= 2
        d1 = doctors[0]["id"]
        d2 = doctors[1]["id"]
        today = time.strftime("%Y-%m-%d")

        r_book = s.post(f"{API}/appointments", headers=h(p["access_token"]), json={
            "doctor_id": d1,
            "date": today,
            "slot": "Token Booking",
            "payment_method": "pay_at_clinic"
        })
        appt_id = r_book.json()["id"]

        # Refer to doctor 2
        r_refer = s.post(f"{API}/reception/refer", headers=h(reception_token), json={
            "appointment_id": appt_id,
            "to_doctor_id": d2,
            "reason": "Referred to senior specialist"
        })
        assert r_refer.status_code == 200
        assert r_refer.json()["ok"] is True
        assert r_refer.json()["new_doctor"] == doctors[1]["full_name"]


# ---------------- ONE APPOINTMENT PER VERIFIED MOBILE PER DAY ----------------
class TestDailyAppointmentRestriction:
    def _create_otp_verified_patient(self, s, mobile: str = None):
        if not mobile:
            mobile = f"98765{str(uuid.uuid4().int)[:5]}"[:10]
        set_test_otp(mobile, otp="123456")
        r = s.post(f"{API}/auth/verify-otp", json={
            "mobile": mobile,
            "otp": "123456",
            "full_name": f"Daily Patient {mobile[-4:]}",
            "age": 30,
            "gender": "Other"
        })
        assert r.status_code == 200, r.text
        return r.json()["access_token"], mobile

    def test_single_appointment_per_mobile_per_day_allowed(self, s):
        token, mobile = self._create_otp_verified_patient(s)
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[0]
        today = time.strftime("%Y-%m-%d")

        r = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": doc["id"],
            "date": today,
            "slot": "10:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r.status_code == 200, r.text
        appt = r.json()
        assert appt["patient_mobile"] == f"+91{mobile}"
        assert appt["status"] == "booked"

    def test_second_appointment_same_day_rejected_with_exact_message(self, s):
        token, mobile = self._create_otp_verified_patient(s)
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[0]
        today = time.strftime("%Y-%m-%d")

        # 1st booking
        r1 = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": doc["id"],
            "date": today,
            "slot": "10:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r1.status_code == 200

        # 2nd booking attempt with same doctor on same day
        r2 = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": doc["id"],
            "date": today,
            "slot": "11:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r2.status_code == 400
        assert r2.json()["detail"] == "You have already booked an appointment for today."

    def test_second_appointment_different_doctor_same_day_rejected(self, s):
        token, mobile = self._create_otp_verified_patient(s)
        doctors = s.get(f"{API}/doctors").json()
        assert len(doctors) >= 2
        d1, d2 = doctors[0], doctors[1]
        today = time.strftime("%Y-%m-%d")

        # 1st booking with Doctor 1
        r1 = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": d1["id"],
            "date": today,
            "slot": "10:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r1.status_code == 200

        # 2nd booking attempt with Doctor 2 on same day
        r2 = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": d2["id"],
            "date": today,
            "slot": "2:00 PM",
            "payment_method": "pay_at_clinic"
        })
        assert r2.status_code == 400
        assert r2.json()["detail"] == "You have already booked an appointment for today."

    def test_appointment_for_tomorrow_allowed(self, s):
        token, mobile = self._create_otp_verified_patient(s)
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[0]
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%d")

        # Booking for today
        r_today = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": doc["id"],
            "date": today,
            "slot": "10:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r_today.status_code == 200

        # Booking for tomorrow with same verified mobile
        r_tomorrow = s.post(f"{API}/appointments", headers=h(token), json={
            "doctor_id": doc["id"],
            "date": tomorrow,
            "slot": "10:00 AM",
            "payment_method": "pay_at_clinic"
        })
        assert r_tomorrow.status_code == 200
        assert r_tomorrow.json()["date"] == tomorrow

    def test_concurrent_same_day_bookings_prevented_by_unique_constraint(self, s):
        import concurrent.futures
        token, mobile = self._create_otp_verified_patient(s)
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[0]
        today = time.strftime("%Y-%m-%d")

        def attempt_booking(slot_name):
            session = requests.Session()
            return session.post(f"{API}/appointments", headers=h(token), json={
                "doctor_id": doc["id"],
                "date": today,
                "slot": slot_name,
                "payment_method": "pay_at_clinic"
            })

        slots = ["10:00 AM", "10:15 AM", "10:30 AM", "10:45 AM"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(attempt_booking, slot) for slot in slots]
            results = [f.result() for f in concurrent.futures.as_completed(futures)]

        status_codes = [r.status_code for r in results]
        assert status_codes.count(200) == 1, f"Expected exactly 1 success, got {status_codes}"
        assert status_codes.count(400) == 3, f"Expected 3 rejections, got {status_codes}"
        for r in results:
            if r.status_code == 400:
                assert r.json()["detail"] == "You have already booked an appointment for today."

