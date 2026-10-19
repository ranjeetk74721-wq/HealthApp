import os
os.environ["MONGO_URL"] = "mongodb://localhost:27017/test_meribaari"

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone
import backend.server as server
from backend.server import (
    AddPatientBody,
    AppointmentUpdateDetailsBody,
    reception_add_patient,
    reception_queue,
    doctor_appointments,
    doctor_dashboard,
    get_or_create_doctor_session,
    update_patient_details,
    db,
)
from fastapi import HTTPException


class MockCursor:
    def __init__(self, data):
        self._data = list(data)

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return list(self._data)


class MockCollection:
    def __init__(self, initial_docs=None):
        self.docs = list(initial_docs or [])
        self.find_one = AsyncMock(side_effect=self._find_one)
        self.insert_one = AsyncMock(side_effect=self._insert_one)
        self.update_one = AsyncMock(side_effect=self._update_one)
        self.find_one_and_update = AsyncMock(side_effect=self._find_one_and_update)
        self.update_many = AsyncMock(return_value=MagicMock(matched_count=0, modified_count=0))
        self.count_documents = AsyncMock(side_effect=self._count_documents)

    def find(self, query=None, *args, **kwargs):
        if not query:
            return MockCursor(list(self.docs))
        filtered = []
        for d in self.docs:
            if self._matches(d, query):
                filtered.append(d)
        return MockCursor(filtered)

    def _matches(self, doc, query):
        for k, v in query.items():
            if k == "$or":
                if not any(self._matches(doc, cond) for cond in v):
                    return False
            elif isinstance(v, dict):
                if "$in" in v and doc.get(k) not in v["$in"]:
                    return False
                if "$ne" in v and doc.get(k) == v["$ne"]:
                    return False
                if "$regex" in v:
                    import re
                    val = str(doc.get(k) or "")
                    pattern = v["$regex"]
                    flags = re.IGNORECASE if v.get("$options") == "i" else 0
                    if not re.search(pattern, val, flags):
                        return False
            elif doc.get(k) != v:
                return False
        return True

    async def _find_one(self, query=None, *args, **kwargs):
        if not query:
            return dict(self.docs[0]) if self.docs else None
        for d in self.docs:
            if self._matches(d, query):
                return dict(d)
        return None

    async def _insert_one(self, doc):
        stored = dict(doc)
        if "_id" not in stored:
            stored["_id"] = f"mock_{len(self.docs) + 1}"
        self.docs.append(stored)
        res = MagicMock()
        res.inserted_id = stored["_id"]
        return res

    async def _update_one(self, query, update, upsert=False):
        for i, d in enumerate(self.docs):
            if self._matches(d, query):
                updated = dict(d)
                if "$set" in update:
                    updated.update(update["$set"])
                self.docs[i] = updated
                res = MagicMock()
                res.matched_count = 1
                res.modified_count = 1
                return res
        if upsert:
            new_doc = dict(query)
            if "$set" in update:
                new_doc.update(update["$set"])
            if "$setOnInsert" in update:
                new_doc.update(update["$setOnInsert"])
            if "_id" not in new_doc:
                new_doc["_id"] = f"mock_{len(self.docs) + 1}"
            self.docs.append(new_doc)
            res = MagicMock()
            res.matched_count = 0
            res.upserted_id = new_doc["_id"]
            return res
        res = MagicMock()
        res.matched_count = 0
        res.modified_count = 0
        return res

    async def _find_one_and_update(self, query, update, upsert=False, return_document=None):
        for i, d in enumerate(self.docs):
            if self._matches(d, query):
                updated = dict(d)
                if "$inc" in update:
                    for inc_k, inc_v in update["$inc"].items():
                        updated[inc_k] = updated.get(inc_k, 0) + inc_v
                if "$set" in update:
                    updated.update(update["$set"])
                self.docs[i] = updated
                return dict(updated)
        if upsert:
            new_doc = dict(query)
            if "$inc" in update:
                for inc_k, inc_v in update["$inc"].items():
                    new_doc[inc_k] = inc_v
            if "$set" in update:
                new_doc.update(update["$set"])
            if "$setOnInsert" in update:
                new_doc.update(update["$setOnInsert"])
            if "_id" not in new_doc:
                new_doc["_id"] = f"mock_{len(self.docs) + 1}"
            self.docs.append(new_doc)
            return dict(new_doc)
        return None

    async def _count_documents(self, query):
        if not query:
            return len(self.docs)
        return sum(1 for d in self.docs if self._matches(d, query))


@pytest.fixture
def test_env(monkeypatch):
    """Sets up an isolated mock database with doctor and receptionist accounts."""
    doctor = {
        "id": "doc_101",
        "doctor_id": "doc_101",
        "user_id": "user_doc_101",
        "full_name": "Dr. Mariya Khan",
        "hospital_id": "HOSP_ABC",
        "hospital_name": "ABC Care Clinic",
        "clinic_name": "ABC Care Clinic",
        "role": "doctor",
        "consultation_fee": 500,
        "timings": "10:00 AM - 02:00 PM",
        "avg_consultation_time": 15,
        "is_active": True,
    }
    receptionist = {
        "id": "rec_201",
        "user_id": "rec_201",
        "full_name": "Receptionist Rita",
        "hospital_id": "hosp_abc",  # intentionally lowercase to test case-insensitive hospital matching
        "role": "receptionist",
        "doctor_id": "doc_101",
    }
    mock_doctors = MockCollection([doctor])
    mock_users = MockCollection([receptionist])
    mock_appts = MockCollection([])
    mock_sessions = MockCollection([])
    mock_token_seq = MockCollection([])
    mock_clinic_sessions = MockCollection([])
    mock_push_subs = MockCollection([])
    mock_push_logs = MockCollection([])
    mock_schedule_configs = MockCollection([])

    monkeypatch.setattr(server.db, "doctors", mock_doctors)
    monkeypatch.setattr(server.db, "users", mock_users)
    monkeypatch.setattr(server.db, "appointments", mock_appts)
    monkeypatch.setattr(server.db, "doctor_sessions", mock_sessions)
    monkeypatch.setattr(server.db, "token_sequences", mock_token_seq)
    monkeypatch.setattr(server.db, "clinic_sessions", mock_clinic_sessions)
    monkeypatch.setattr(server.db, "push_subscriptions", mock_push_subs)
    monkeypatch.setattr(server.db, "push_logs", mock_push_logs)
    monkeypatch.setattr(server.db, "doctor_schedule_configs", mock_schedule_configs)

    return {
        "doctor": doctor,
        "receptionist": receptionist,
        "doctors": mock_doctors,
        "users": mock_users,
        "appointments": mock_appts,
        "doctor_sessions": mock_sessions,
        "clinic_sessions": mock_clinic_sessions,
    }


# =====================================================================
# 1. Validation Schema Tests (Optional Mobile)
# =====================================================================

def test_add_patient_schema_validation():
    # Valid with 10-digit mobile
    body_with_mobile = AddPatientBody(
        full_name="Rahul Sharma",
        mobile="9876543210",
        doctor_id="doc_101",
    )
    assert body_with_mobile.mobile == "9876543210"

    # Valid without mobile (None)
    body_none_mobile = AddPatientBody(
        full_name="Anita Roy",
        mobile=None,
        doctor_id="doc_101",
    )
    assert body_none_mobile.mobile is None

    # Valid without mobile (Empty string)
    body_empty_mobile = AddPatientBody(
        full_name="Anita Roy",
        mobile="",
        doctor_id="doc_101",
    )
    assert body_empty_mobile.mobile == ""


@pytest.mark.asyncio
async def test_appointment_update_details_validation(test_env):
    appt = {
        "id": "appt_test_1",
        "doctor_id": "doc_101",
        "hospital_id": "HOSP_ABC",
        "patient_name": "Sita Devi",
        "patient_mobile": "9876543210",
        "status": "booked",
        "token_number": 1,
    }
    await test_env["appointments"].insert_one(appt)
    rec_user = test_env["receptionist"]

    # 1. Valid without mobile (None)
    update_no_mobile = AppointmentUpdateDetailsBody(
        patient_name="Sita Devi Updated",
        patient_mobile=None,
    )
    res_none = await update_patient_details("appt_test_1", update_no_mobile, rec_user)
    assert res_none["ok"] is True
    assert res_none["appointment"]["patient_mobile"] is None

    # 2. Valid with 10-digit mobile
    update_with_mobile = AppointmentUpdateDetailsBody(
        patient_name="Sita Devi Updated",
        patient_mobile="9876501234",
    )
    res_mob = await update_patient_details("appt_test_1", update_with_mobile, rec_user)
    assert res_mob["ok"] is True
    assert res_mob["appointment"]["patient_mobile"] in ("+919876501234", "9876501234")

    # 3. Invalid mobile (< 10 digits or bad format) raises HTTPException 400
    update_invalid_mob = AppointmentUpdateDetailsBody(
        patient_name="Sita Devi",
        patient_mobile="12345",
    )
    with pytest.raises(HTTPException) as exc_info:
        await update_patient_details("appt_test_1", update_invalid_mob, rec_user)
    assert exc_info.value.status_code == 400
    assert "valid 10-digit" in str(exc_info.value.detail)


# =====================================================================
# 2. Registration With and Without Mobile & Sequential Token Integrity
# =====================================================================

@pytest.mark.asyncio
async def test_receptionist_registers_patient_with_mobile(test_env, monkeypatch):
    rec_user = test_env["receptionist"]

    body = AddPatientBody(
        full_name="Pooja Verma",
        mobile="9988776655",
        doctor_id="doc_101",
        date="2026-10-19",
        age=28,
        gender="Female",
    )

    res = await reception_add_patient(body, rec_user)
    assert res["ok"] is True
    assert res["appointment"]["token_number"] == 1
    assert res["appointment"]["patient_name"] == "Pooja Verma"
    assert res["appointment"]["patient_mobile"] in ("+919988776655", "9988776655")
    assert res["appointment"]["status"] == "arrived"


@pytest.mark.asyncio
async def test_receptionist_registers_patient_without_mobile(test_env, monkeypatch):
    rec_user = test_env["receptionist"]

    body = AddPatientBody(
        full_name="Walkin Patient",
        mobile=None,
        doctor_id="doc_101",
        date="2026-10-19",
        age=45,
        gender="Male",
    )

    res = await reception_add_patient(body, rec_user)
    assert res["ok"] is True
    assert res["appointment"]["token_number"] == 1
    assert res["appointment"]["patient_name"] == "Walkin Patient"
    assert res["appointment"]["patient_mobile"] is None
    assert res["appointment"]["status"] == "arrived"

    # Verify patient record was saved in db
    saved_appt = await test_env["appointments"].find_one({"patient_name": "Walkin Patient"})
    assert saved_appt is not None
    assert saved_appt["patient_mobile"] is None


@pytest.mark.asyncio
async def test_sequential_tokens_for_multiple_patients_with_and_without_mobile(test_env):
    rec_user = test_env["receptionist"]

    # Patient 1: With Mobile
    p1 = await reception_add_patient(
        AddPatientBody(full_name="Patient One", mobile="9876543210", doctor_id="doc_101", date="2026-10-19"),
        rec_user,
    )
    assert p1["appointment"]["token_number"] == 1

    # Patient 2: Without Mobile
    p2 = await reception_add_patient(
        AddPatientBody(full_name="Patient Two (No Phone)", mobile=None, doctor_id="doc_101", date="2026-10-19"),
        rec_user,
    )
    assert p2["appointment"]["token_number"] == 2
    assert p2["appointment"]["patient_mobile"] is None

    # Patient 3: Another Walkin Without Mobile (no duplicate collision!)
    p3 = await reception_add_patient(
        AddPatientBody(full_name="Patient Three (No Phone)", mobile=None, doctor_id="doc_101", date="2026-10-19"),
        rec_user,
    )
    assert p3["appointment"]["token_number"] == 3
    assert p3["appointment"]["patient_mobile"] is None


# =====================================================================
# 3. Patient List Visibility BEFORE Doctor Session Starts
# =====================================================================

@pytest.mark.asyncio
async def test_patient_list_and_tokens_visible_before_doctor_session_starts(test_env):
    rec_user = test_env["receptionist"]
    doc_user = {
        "id": "user_doc_101",
        "role": "doctor",
    }

    # Register two patients
    await reception_add_patient(
        AddPatientBody(full_name="Patient Alpha", mobile="9111111111", doctor_id="doc_101", date="2026-10-19"),
        rec_user,
    )
    await reception_add_patient(
        AddPatientBody(full_name="Patient Beta", mobile=None, doctor_id="doc_101", date="2026-10-19"),
        rec_user,
    )

    # Check Doctor Session status is NOT started
    session = await get_or_create_doctor_session("doc_101", "2026-10-19")
    assert session["status"] == "not_started"

    # 1. Verify Receptionist Queue returns registered patients and assigned tokens
    queue_res = await reception_queue(date="2026-10-19", doctor_id="doc_101", user=rec_user)
    assert isinstance(queue_res, list)
    assert len(queue_res) == 2
    tokens = [a["token_number"] for a in queue_res]
    assert tokens == [1, 2]

    # 2. Verify Doctor Panel gets the appointments list before starting session
    doc_appts = await doctor_appointments(date="2026-10-19", user=doc_user)
    assert len(doc_appts) == 2
    assert doc_appts[0]["patient_name"] == "Patient Alpha"
    assert doc_appts[0]["token_number"] == 1
    assert doc_appts[1]["patient_name"] == "Patient Beta"
    assert doc_appts[1]["token_number"] == 2

    # 3. Verify Doctor Dashboard stats accurately count the registered patients
    doc_dash = await doctor_dashboard(date="2026-10-19", user=doc_user)
    assert doc_dash["total_patients"] == 2
    assert doc_dash["pending"] == 2
    assert doc_dash["completed"] == 0


# =====================================================================
# 4. Multi-Tenant and Doctor Isolation Protection
# =====================================================================

@pytest.mark.asyncio
async def test_hospital_and_doctor_isolation(test_env):
    rec_user_hosp_b = {
        "id": "rec_other",
        "hospital_id": "HOSP_XYZ",
        "role": "receptionist",
    }

    # Register patient in Hospital ABC
    await reception_add_patient(
        AddPatientBody(full_name="Private Patient", mobile="9222222222", doctor_id="doc_101", date="2026-10-19"),
        test_env["receptionist"],
    )

    # Receptionist from another hospital should see 0 appointments
    other_queue = await reception_queue(date="2026-10-19", doctor_id="doc_101", user=rec_user_hosp_b)
    assert isinstance(other_queue, list)
    assert len(other_queue) == 0
