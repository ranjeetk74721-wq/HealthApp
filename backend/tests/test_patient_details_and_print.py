import pytest
from unittest.mock import MagicMock
from httpx import AsyncClient, ASGITransport
import uuid

import backend.server as server
from backend.server import app, now_iso, create_token, AppointmentUpdateDetailsBody


class MockCursor:
    def __init__(self, data):
        self.data = list(data)

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return list(self.data)


class MockCollection:
    def __init__(self):
        self.docs = []

    async def find_one(self, query=None, *args, **kwargs):
        if not query:
            return dict(self.docs[0]) if self.docs else None
        for d in self.docs:
            match = True
            for k, v in query.items():
                if k == "$or":
                    match = any(d.get(sub_k) == sub_v for cond in v for sub_k, sub_v in cond.items())
                elif d.get(k) != v:
                    match = False
                    break
            if match:
                return dict(d)
        return None

    def find(self, query=None, *args, **kwargs):
        res = []
        if not query:
            res = list(self.docs)
        else:
            for d in self.docs:
                match = True
                for k, v in query.items():
                    if k == "$ne":
                        continue
                    elif isinstance(v, dict) and "$ne" in v:
                        if d.get(k) == v["$ne"]:
                            match = False
                            break
                    elif d.get(k) != v:
                        match = False
                        break
                if match:
                    res.append(d)
        return MockCursor(res)

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return MagicMock(inserted_id=doc.get("id"))

    async def update_one(self, query, update, upsert=False):
        for d in self.docs:
            match = True
            for k, v in query.items():
                if d.get(k) != v:
                    match = False
                    break
            if match:
                if "$set" in update:
                    d.update(update["$set"])
                return MagicMock(modified_count=1)
        return MagicMock(modified_count=0)

    async def delete_one(self, query):
        initial = len(self.docs)
        self.docs = [d for d in self.docs if not all(d.get(k) == v for k, v in query.items())]
        return MagicMock(deleted_count=initial - len(self.docs))


class MockDB:
    def __init__(self):
        self.appointments = MockCollection()
        self.doctors = MockCollection()
        self.users = MockCollection()
        self.audit_logs = MockCollection()
        self.doctor_sessions = MockCollection()
        self.token_sequences = MockCollection()


@pytest.fixture
def mock_db(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    return mdb


@pytest.mark.asyncio
async def test_patient_details_view_and_edit(mock_db):
    doc_id = "doc-123"
    hosp_id = "hosp-456"
    doc_user_id = "user-doc-1"
    rec_user_id = "user-rec-1"
    patient_user_id = "user-patient-1"
    appt_id = "appt-789"
    original_patient_mobile = "+919999988888"

    await mock_db.users.insert_one({
        "id": doc_user_id,
        "mobile": "+919876543210",
        "full_name": "Dr. Mariya Khan",
        "role": "doctor",
        "hospital_id": hosp_id,
    })
    await mock_db.doctors.insert_one({
        "id": doc_id,
        "user_id": doc_user_id,
        "full_name": "Dr. Mariya Khan",
        "hospital_id": hosp_id,
        "fees": 500,
        "clinic_name": "Mariya Wellness Clinic",
    })
    await mock_db.users.insert_one({
        "id": rec_user_id,
        "mobile": "+919876543211",
        "full_name": "Receptionist Anjali",
        "role": "receptionist",
        "hospital_id": hosp_id,
    })
    await mock_db.users.insert_one({
        "id": patient_user_id,
        "mobile": original_patient_mobile,
        "full_name": "Original Patient Name",
        "role": "patient",
        "address": "123 Old Street, South City",
    })
    await mock_db.appointments.insert_one({
        "id": appt_id,
        "doctor_id": doc_id,
        "doctor_name": "Dr. Mariya Khan",
        "hospital_id": hosp_id,
        "patient_id": patient_user_id,
        "patient_name": "Original Patient Name",
        "patient_mobile": original_patient_mobile,
        "patient_address": "123 Old Street, South City",
        "date": "2026-10-04",
        "slot": "Token Booking",
        "token_number": 5,
        "status": "booked",
        "payment_method": "pay_at_clinic",
        "payment_status": "pending",
        "payment_amount": 500,
        "created_at": now_iso(),
    })

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        rec_token = create_token(rec_user_id, "receptionist")
        headers = {"Authorization": f"Bearer {rec_token}"}

        # 1. View Patient Details
        res = await ac.get(f"/api/appointments/{appt_id}/patient-details", headers=headers)
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["patient_name"] == "Original Patient Name"
        assert data["patient_mobile"] == original_patient_mobile
        assert data["patient_address"] == "123 Old Street, South City"
        assert data["payment_amount"] == 500
        assert data["payment_status"] == "pending"
        assert data["token_number"] == 5

        # 2. Edit Patient Details
        update_payload = {
            "patient_name": "Updated Patient Name",
            "patient_mobile": "9888877777",
            "patient_address": "456 New Colony, North City",
            "payment_amount": 650,
            "payment_status": "paid",
            "payment_method": "online",
        }
        put_res = await ac.put(f"/api/appointments/{appt_id}/patient-details", json=update_payload, headers=headers)
        assert put_res.status_code == 200, put_res.text
        put_data = put_res.json()
        assert put_data["ok"] is True
        updated_appt = put_data["appointment"]
        assert updated_appt["patient_name"] == "Updated Patient Name"
        assert updated_appt["patient_mobile"] == "+919888877777"
        assert updated_appt["patient_address"] == "456 New Colony, North City"
        assert updated_appt["payment_amount"] == 650
        assert updated_appt["payment_status"] == "paid"
        # Token number, status, date must be PRESERVED
        assert updated_appt["token_number"] == 5
        assert updated_appt["status"] == "booked"
        assert updated_appt["date"] == "2026-10-04"

        # 3. Direct DB verification
        db_appt = await mock_db.appointments.find_one({"id": appt_id})
        assert db_appt["patient_name"] == "Updated Patient Name"
        assert db_appt["patient_mobile"] == "+919888877777"
        assert db_appt["payment_amount"] == 650
        assert db_appt["payment_status"] == "paid"
        assert db_appt["token_number"] == 5

        # 4. Critical check: Login credentials untouched
        patient_user_db = await mock_db.users.find_one({"id": patient_user_id})
        assert patient_user_db["mobile"] == original_patient_mobile
        assert patient_user_db["full_name"] == "Updated Patient Name"
        assert patient_user_db["address"] == "456 New Colony, North City"

        # 5. Validation failures
        bad_mobile_res = await ac.put(f"/api/appointments/{appt_id}/patient-details", json={
            "patient_name": "Valid Name",
            "patient_mobile": "123",
        }, headers=headers)
        assert bad_mobile_res.status_code == 400

        bad_name_res = await ac.put(f"/api/appointments/{appt_id}/patient-details", json={
            "patient_name": "",
            "patient_mobile": "9876543210",
        }, headers=headers)
        assert bad_name_res.status_code == 400

        bad_amt_res = await ac.put(f"/api/appointments/{appt_id}/patient-details", json={
            "patient_name": "Valid Name",
            "patient_mobile": "9876543210",
            "payment_amount": -50,
        }, headers=headers)
        assert bad_amt_res.status_code == 400

        # 6. Access boundary failure
        other_doc_user_id = "user-other-doc"
        await mock_db.users.insert_one({
            "id": other_doc_user_id,
            "role": "doctor",
            "hospital_id": "other-hosp",
        })
        await mock_db.doctors.insert_one({
            "id": "doc-other",
            "user_id": other_doc_user_id,
            "hospital_id": "other-hosp",
        })
        other_token = create_token(other_doc_user_id, "doctor")
        forbidden_res = await ac.get(f"/api/appointments/{appt_id}/patient-details", headers={"Authorization": f"Bearer {other_token}"})
        assert forbidden_res.status_code == 403


@pytest.mark.asyncio
async def test_doctor_appointments_date_and_enrichment(mock_db):
    doc_id = "doc-99"
    doc_user_id = "user-doc-99"
    appt_id = "appt-99"

    await mock_db.users.insert_one({
        "id": doc_user_id,
        "mobile": "+919876543299",
        "full_name": "Dr. Sarah",
        "role": "doctor",
    })
    await mock_db.doctors.insert_one({
        "id": doc_id,
        "user_id": doc_user_id,
        "full_name": "Dr. Sarah",
        "fees": 400,
    })
    await mock_db.users.insert_one({
        "id": "patient-99",
        "full_name": "Test Patient",
        "mobile": "+919876543288",
        "address": "77 Palm Grove",
    })
    # Older appointment with missing patient_address and payment_amount
    await mock_db.appointments.insert_one({
        "id": appt_id,
        "doctor_id": doc_id,
        "patient_id": "patient-99",
        "patient_name": "Test Patient",
        "patient_mobile": "+919876543288",
        "date": "2026-10-04",
        "token_number": 1,
        "status": "arrived",
        "payment_method": "pay_at_clinic",
    })

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        doc_token = create_token(doc_user_id, "doctor")
        headers = {"Authorization": f"Bearer {doc_token}"}

        res = await ac.get("/api/doctor/appointments?date=2026-10-04", headers=headers)
        assert res.status_code == 200
        appts = res.json()
        assert len(appts) == 1
        assert appts[0]["patient_address"] == "77 Palm Grove"
        assert appts[0]["payment_amount"] == 400
        assert appts[0]["payment_status"] == "pending"
