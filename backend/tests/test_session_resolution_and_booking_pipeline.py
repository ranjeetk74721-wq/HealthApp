"""
Focused regression and verification test suite for doctor session resolution,
receptionist patient registration, and appointment booking pipeline.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException
import server
from server import resolve_clinic_session_id, reception_add_patient, create_appointment, AddPatientBody, AppointmentCreate


class MockCollection:
    def __init__(self, items=None):
        self.items = list(items or [])

    async def find_one(self, filter_dict, projection=None, sort=None):
        def matches(doc, flt):
            for k, v in flt.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif k == "$nin":
                    pass
                elif isinstance(v, dict):
                    if "$in" in v:
                        if doc.get(k) not in v["$in"]:
                            return False
                    elif "$ne" in v:
                        if doc.get(k) == v["$ne"]:
                            return False
                elif isinstance(doc.get(k), (list, tuple)) and not isinstance(v, (list, tuple, dict)):
                    if v not in doc.get(k):
                        return False
                else:
                    if doc.get(k) != v:
                        return False
            return True

        matching = [item for item in self.items if matches(item, filter_dict)]
        if not matching:
            return None
        if sort:
            sort_field, sort_dir = sort[0]
            matching.sort(key=lambda x: x.get(sort_field, 0), reverse=(sort_dir == -1))
        res = dict(matching[0])
        if projection and "_id" in projection and projection["_id"] == 0:
            res.pop("_id", None)
        return res

    async def insert_one(self, doc):
        self.items.append(dict(doc))
        return MagicMock(inserted_id="mock_id")

    async def update_one(self, filter_dict, update_dict, upsert=False):
        found = False
        for item in self.items:
            matches_all = True
            for k, v in filter_dict.items():
                if item.get(k) != v:
                    matches_all = False
                    break
            if matches_all:
                found = True
                if "$set" in update_dict:
                    item.update(update_dict["$set"])
                break
        if not found and upsert:
            new_doc = dict(filter_dict)
            if "$setOnInsert" in update_dict:
                new_doc.update(update_dict["$setOnInsert"])
            if "$set" in update_dict:
                new_doc.update(update_dict["$set"])
            self.items.append(new_doc)
        return MagicMock(modified_count=1)

    def find(self, filter_dict=None, projection=None):
        flt = filter_dict or {}
        def matches(doc, flt_d):
            for k, v in flt_d.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif k == "$nin":
                    pass
                elif isinstance(v, dict):
                    if "$in" in v:
                        if doc.get(k) not in v["$in"]:
                            return False
                    elif "$ne" in v:
                        if doc.get(k) == v["$ne"]:
                            return False
                elif isinstance(doc.get(k), (list, tuple)) and not isinstance(v, (list, tuple, dict)):
                    if v not in doc.get(k):
                        return False
                else:
                    if doc.get(k) != v:
                        return False
            return True

        matching = [dict(item) for item in self.items if matches(item, flt)]
        if projection and "_id" in projection and projection["_id"] == 0:
            for m in matching:
                m.pop("_id", None)

        class MockCursor:
            def __init__(self, data):
                self._data = data
            def sort(self, *args, **kwargs):
                return self
            async def to_list(self, length=None):
                return list(self._data[:length] if length else self._data)

        return MockCursor(matching)

    async def count_documents(self, filter_dict):
        return len(self.items)


@pytest.fixture
def session_pipeline_setup(monkeypatch):
    """Sets up an isolated database environment for session resolution and booking tests."""
    mock_doctors = MockCollection([
        {
            "id": "doc-1",
            "full_name": "Dr. Sarah",
            "hospital_id": "hosp-1",
            "hospital_name": "Metro Clinic",
            "clinic_name": "Metro Clinic",
            "timings": "10:00 AM - 06:00 PM",
            "fees": 500,
            "status": "active",
        },
        {
            "id": "doc-2",
            "full_name": "Dr. John",
            "hospital_id": "hosp-2",
            "hospital_name": "City Care",
            "clinic_name": "City Care",
            "timings": "09:00 AM - 05:00 PM",
            "fees": 400,
            "status": "active",
        }
    ])

    mock_clinic_sessions = MockCollection([
        {
            "id": "cs-existing-1",
            "doctor_id": "doc-1",
            "hospital_id": "hosp-1",
            "date": "2026-10-20",
            "session_number": 1,
            "session_name": "Morning OPD",
            "start_time": "10:00 AM",
            "end_time": "02:00 PM",
        }
    ])

    mock_doctor_schedule_configs = MockCollection([
        {
            "id": "sched-evening-1",
            "doctor_id": "doc-1",
            "session_name": "Evening OPD",
            "clinic_id": "hosp-1",
            "date_type": "recurring",
            "days_of_week": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
            "start_time": "05:00 PM",
            "end_time": "09:00 PM",
            "status": "active",
            "date_overrides": {},
        },
        {
            "id": "sched-doc2-1",
            "doctor_id": "doc-2",
            "session_name": "Doc2 Shift",
            "clinic_id": "hosp-2",
            "date_type": "recurring",
            "days_of_week": ["Monday", "Tuesday", "Wednesday"],
            "start_time": "02:00 PM",
            "end_time": "06:00 PM",
            "status": "active",
            "date_overrides": {},
        }
    ])

    mock_appointments = MockCollection([])
    mock_users = MockCollection([])

    monkeypatch.setattr(server.db, "doctors", mock_doctors)
    monkeypatch.setattr(server.db, "clinic_sessions", mock_clinic_sessions)
    monkeypatch.setattr(server.db, "doctor_schedule_configs", mock_doctor_schedule_configs)
    monkeypatch.setattr(server.db, "appointments", mock_appointments)
    monkeypatch.setattr(server.db, "users", mock_users)

    # Mock token sequence allocation
    monkeypatch.setattr(server, "allocate_next_token_for_session", AsyncMock(return_value=1))
    monkeypatch.setattr(server, "calculate_appointment_eta", AsyncMock(return_value={"expected_turn_time": "05:30 PM", "eta_minutes": 15}))
    monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
    monkeypatch.setattr(server, "dispatch_appointment_sms_background", AsyncMock())

    return {
        "doctors": mock_doctors,
        "clinic_sessions": mock_clinic_sessions,
        "schedule_configs": mock_doctor_schedule_configs,
        "appointments": mock_appointments,
        "users": mock_users,
    }


# 1. Existing session found in clinic_sessions resolves successfully
@pytest.mark.asyncio
async def test_case_1_existing_session_in_clinic_sessions(session_pipeline_setup):
    res = await resolve_clinic_session_id("doc-1", "2026-10-20", "cs-existing-1")
    assert res == "cs-existing-1"


# 2. Session created in doctor_schedule_configs resolves successfully
@pytest.mark.asyncio
async def test_case_2_session_created_in_doctor_schedule_configs(session_pipeline_setup):
    res = await resolve_clinic_session_id("doc-1", "2026-10-20", "sched-evening-1")
    assert res == "sched-evening-1"


# 3. Valid <doctor_id>_default session resolves correctly
@pytest.mark.asyncio
async def test_case_3_valid_default_session(session_pipeline_setup):
    res = await resolve_clinic_session_id("doc-1", "2026-10-20", "doc-1_default")
    assert res is not None
    assert res != ""


# 4. Invalid or non-existent session ID returns 404
@pytest.mark.asyncio
async def test_case_4_invalid_session_returns_404(session_pipeline_setup):
    with pytest.raises(HTTPException) as exc_info:
        await resolve_clinic_session_id("doc-1", "2026-10-20", "non_existent_session_uuid")
    assert exc_info.value.status_code == 404
    assert "Session not found" in exc_info.value.detail


# 5. Session belonging to another doctor cannot be used (returns 403)
@pytest.mark.asyncio
async def test_case_5_unauthorized_cross_doctor_session(session_pipeline_setup):
    # sched-doc2-1 belongs to doc-2, not doc-1
    with pytest.raises(HTTPException) as exc_info:
        await resolve_clinic_session_id("doc-1", "2026-10-20", "sched-doc2-1")
    assert exc_info.value.status_code == 403
    assert "Session does not belong to the requested doctor" in exc_info.value.detail


# 6. Valid null-session General Walk-in request still works
@pytest.mark.asyncio
async def test_case_6_null_session_general_walkin(session_pipeline_setup):
    res = await resolve_clinic_session_id("doc-1", "2026-10-20", None)
    assert res is not None


# 7. Receptionist can add a patient to a configured session
@pytest.mark.asyncio
async def test_case_7_receptionist_add_patient_to_configured_session(session_pipeline_setup):
    receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "hosp-1"}
    body = AddPatientBody(
        full_name="Rajesh Kumar",
        mobile="9876543210",
        doctor_id="doc-1",
        session_id="sched-evening-1",
        date="2026-10-20",
    )
    res = await reception_add_patient(body, receptionist_user)
    assert res["ok"] is True
    assert res["appointment"]["session_id"] == "sched-evening-1"
    assert res["appointment"]["session_name"] == "Evening OPD"


# 8. Receptionist can add a consultation without mobile
@pytest.mark.asyncio
async def test_case_8_receptionist_add_consultation_without_mobile(session_pipeline_setup):
    receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "hosp-1"}
    body = AddPatientBody(
        full_name="Walkin NoMobile",
        mobile="",
        doctor_id="doc-1",
        session_id="sched-evening-1",
        date="2026-10-20",
        consultation_mode="no_mobile",
    )
    res = await reception_add_patient(body, receptionist_user)
    assert res["ok"] is True
    assert res["appointment"]["patient_mobile"] is None
    assert res["appointment"]["consultation_mode"] == "no_mobile"
    assert res["appointment"]["session_name"] == "Evening OPD"


# 9. Regular Consultation works with valid configured or default session
@pytest.mark.asyncio
async def test_case_9_regular_consultation_with_default_session(session_pipeline_setup):
    receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "hosp-1"}
    body = AddPatientBody(
        full_name="Sunil Sharma",
        mobile="9123456780",
        doctor_id="doc-1",
        session_id="doc-1_default",
        date="2026-10-20",
        consultation_mode="regular",
    )
    res = await reception_add_patient(body, receptionist_user)
    assert res["ok"] is True
    assert res["appointment"]["session_id"] is not None


# 10. Patient online booking succeeds for a valid configured session
@pytest.mark.asyncio
async def test_case_10_patient_online_booking_configured_session(session_pipeline_setup, monkeypatch):
    patient_user = {"id": "pat-1", "full_name": "Online Patient", "phone": "9876543211", "address": "Jaipur"}
    monkeypatch.setattr(server, "enforce_booking_rate_limit", MagicMock())

    body = AppointmentCreate(
        doctor_id="doc-1",
        date="2026-10-20",
        session_id="sched-evening-1",
        slot="05:00 PM – 09:00 PM",
    )
    req = MagicMock()
    req.client.host = "127.0.0.1"

    res = await create_appointment(req, body, patient_user)
    assert res is not None
    assert res["session_id"] == "sched-evening-1"
    assert res["session_name"] == "Evening OPD"


# 11. Appointment records preserve correct session ID and session name (not "Walk-in")
@pytest.mark.asyncio
async def test_case_11_session_name_preserved_not_walk_in(session_pipeline_setup):
    receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "hosp-1"}
    body = AddPatientBody(
        full_name="Meena Devi",
        mobile="9988776655",
        doctor_id="doc-1",
        session_id="sched-evening-1",
        date="2026-10-20",
        slot="Walk-in", # Even if slot string was generic Walk-in, session_name must be Evening OPD
    )
    res = await reception_add_patient(body, receptionist_user)
    assert res["ok"] is True
    assert res["appointment"]["session_name"] == "Evening OPD"
    assert res["appointment"]["slot"] == "Evening OPD"


# 12. Duplicate appointment detection includes correct session name
@pytest.mark.asyncio
async def test_case_12_duplicate_appointment_shows_session_name(session_pipeline_setup):
    receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "hosp-1"}
    body1 = AddPatientBody(
        full_name="Anil Kumar",
        mobile="9900112233",
        doctor_id="doc-1",
        session_id="sched-evening-1",
        date="2026-10-20",
    )
    res1 = await reception_add_patient(body1, receptionist_user)
    assert res1["ok"] is True

    # Try booking same patient in same session again
    body2 = AddPatientBody(
        full_name="Anil Kumar",
        mobile="9900112233",
        doctor_id="doc-1",
        session_id="sched-evening-1",
        date="2026-10-20",
    )
    with pytest.raises(HTTPException) as exc_info:
        await reception_add_patient(body2, receptionist_user)
    assert exc_info.value.status_code == 409
    assert "Evening OPD" in exc_info.value.detail
