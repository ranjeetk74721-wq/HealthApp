"""ClinicQueue end-to-end backend tests: auth, doctors, appointments, queue, RBAC."""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://patient-queue-31.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

RECEPTION_EMAIL = "reception@clinic.com"
RECEPTION_PASSWORD = "reception123"
DOCTOR_EMAIL = "drrajeshkumar@clinic.com"
DOCTOR_PASSWORD = "doctor123"


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
def reception_token(s):
    r = s.post(f"{API}/auth/login", json={"email": RECEPTION_EMAIL, "password": RECEPTION_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def doctor_token(s):
    r = s.post(f"{API}/auth/login", json={"email": DOCTOR_EMAIL, "password": DOCTOR_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


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

    def test_online_payment_marks_paid(self, s, patient_ctx):
        doctors = s.get(f"{API}/doctors").json()
        doc = doctors[1]
        today = time.strftime("%Y-%m-%d")
        r = s.post(f"{API}/appointments", headers=h(patient_ctx["token"]), json={
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

    def test_cancel_appointment(self, s, patient_ctx):
        doctors = s.get(f"{API}/doctors").json()
        today = time.strftime("%Y-%m-%d")
        r = s.post(f"{API}/appointments", headers=h(patient_ctx["token"]), json={
            "doctor_id": doctors[2]["id"], "date": today, "slot": "2:00 PM", "payment_method": "pay_at_clinic"
        })
        aid = r.json()["id"]
        r = s.post(f"{API}/appointments/{aid}/cancel", headers=h(patient_ctx["token"]))
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
