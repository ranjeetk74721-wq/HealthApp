"""
Unit and integration tests for Sunday session creation, validation,
conflict checking, session resolution, and booking queue compatibility.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock
from fastapi import HTTPException
import server
from server import (
    DoctorScheduleSessionCreate,
    create_doctor_session,
    check_doctor_session_conflicts,
    resolve_doctor_sessions_for_date,
    reception_add_patient,
    AddPatientBody,
)


class MockCollection:
    def __init__(self, items=None):
        self.items = list(items or [])

    async def find_one(self, filter_dict, projection=None, sort=None):
        def matches(doc, flt):
            for k, v in flt.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif k == "$ne":
                    pass
                elif isinstance(v, dict):
                    if "$ne" in v:
                        if doc.get(k) == v["$ne"]:
                            return False
                    elif "$in" in v:
                        if doc.get(k) not in v["$in"]:
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

    def find(self, filter_dict, projection=None):
        def matches(doc, flt):
            for k, v in flt.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif isinstance(v, dict):
                    if "$ne" in v:
                        if doc.get(k) == v["$ne"]:
                            return False
                    elif "$in" in v:
                        if doc.get(k) not in v["$in"]:
                            return False
                elif isinstance(doc.get(k), (list, tuple)) and not isinstance(v, (list, tuple, dict)):
                    if v not in doc.get(k):
                        return False
                else:
                    if doc.get(k) != v:
                        return False
            return True

        matching = [dict(item) for item in self.items if matches(item, filter_dict)]
        cursor = MagicMock()
        cursor.to_list = AsyncMock(return_value=matching)
        return cursor

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
            if "$set" in update_dict:
                new_doc.update(update_dict["$set"])
            self.items.append(new_doc)
        return MagicMock(modified_count=1 if found else 0)

    async def count_documents(self, filter_dict):
        def matches(doc, flt):
            for k, v in flt.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif k == "status" and isinstance(v, dict) and "$nin" in v:
                    if doc.get("status") in v["$nin"]:
                        return False
                elif isinstance(doc.get(k), (list, tuple)) and not isinstance(v, (list, tuple, dict)):
                    if v not in doc.get(k):
                        return False
                else:
                    if doc.get(k) != v:
                        return False
            return True
        return sum(1 for item in self.items if matches(item, filter_dict))


class MockDatabase:
    def __init__(self):
        self.doctors = MockCollection()
        self.doctor_schedule_configs = MockCollection()
        self.doctor_sessions = MockCollection()
        self.appointments = MockCollection()
        self.users = MockCollection()
        self.counters = MockCollection()
        self.clinics = MockCollection()
        self.push_subscriptions = MockCollection()
        self.push_logs = MockCollection()


@pytest.fixture
def mock_backend(monkeypatch):
    mdb = MockDatabase()
    monkeypatch.setattr(server, "db", mdb)
    monkeypatch.setattr(server, "allocate_next_token_for_session", AsyncMock(return_value=1))
    monkeypatch.setattr(server, "calculate_appointment_eta", AsyncMock(return_value={"expected_turn_time": "10:15 AM", "eta_minutes": 15}))
    monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
    monkeypatch.setattr(server, "dispatch_appointment_sms_background", AsyncMock())

    # Pre-seed doctor
    mdb.doctors.items.append({
        "id": "doc-sun-1",
        "full_name": "Dr. Sun Test",
        "clinic_name": "Sunday Wellness Clinic",
        "hospital_id": "hosp-1",
        "city": "Mumbai",
        "address": "Bandra West",
        "timings": "10:00 AM - 02:00 PM",
        "status": "active",
    })

    # Pre-seed receptionist user
    mdb.users.items.append({
        "id": "user-rec-1",
        "role": "receptionist",
        "hospital_id": "hosp-1",
        "doctor_id": "doc-sun-1",
    })

    return mdb


@pytest.mark.asyncio
async def test_sunday_recurring_session_creation(mock_backend):
    """Verify that a session configured for Sunday (or including Sunday) creates successfully without booking_windows."""
    rec_user = {"id": "user-rec-1", "role": "receptionist", "hospital_id": "hosp-1"}

    session_data = DoctorScheduleSessionCreate(
        session_name="Sunday Morning Special",
        start_time="09:00 AM",
        end_time="01:00 PM",
        date_type="recurring",
        days_of_week=["Sunday"],
        is_unlimited_capacity=True,
    )

    res = await create_doctor_session("doc-sun-1", session_data, rec_user)
    assert res["ok"] is True
    assert res["session"]["session_name"] == "Sunday Morning Special"
    assert "Sunday" in res["session"]["days_of_week"]
    assert len(res["session"]["days_of_week"]) == 1


@pytest.mark.asyncio
async def test_sunday_single_date_session_creation(mock_backend):
    """Verify that a single-date session on a Sunday date creates successfully."""
    rec_user = {"id": "user-rec-1", "role": "receptionist", "hospital_id": "hosp-1"}

    # 2026-10-25 is a Sunday
    session_data = DoctorScheduleSessionCreate(
        session_name="Sunday Oct 25 Clinic",
        start_time="10:00 AM",
        end_time="02:00 PM",
        date_type="date",
        date="2026-10-25",
        is_unlimited_capacity=True,
    )

    res = await create_doctor_session("doc-sun-1", session_data, rec_user)
    assert res["ok"] is True
    assert res["session"]["date"] == "2026-10-25"
    assert res["session"]["date_type"] == "date"


@pytest.mark.asyncio
async def test_sunday_session_overlap_conflict(mock_backend):
    """Verify overlap conflict detection raises 400 when two Sunday sessions overlap in time."""
    # Seed an existing Sunday recurring session: 09:00 AM - 01:00 PM
    mock_backend.doctor_schedule_configs.items.append({
        "id": "sess-sun-existing",
        "doctor_id": "doc-sun-1",
        "session_name": "Sunday Existing",
        "clinic_name": "Sunday Wellness Clinic",
        "date_type": "recurring",
        "days_of_week": ["Sunday"],
        "start_time": "09:00 AM",
        "end_time": "01:00 PM",
        "status": "active",
    })

    # Overlapping recurring Sunday session (12:00 PM - 03:00 PM)
    with pytest.raises(HTTPException) as exc_info:
        await check_doctor_session_conflicts(
            doctor_id="doc-sun-1",
            start_time="12:00 PM",
            end_time="03:00 PM",
            date_type="recurring",
            days_of_week=["Sunday"],
        )
    assert exc_info.value.status_code == 400
    assert "overlaps with existing session" in exc_info.value.detail

    # Overlapping single-date session on Sunday 2026-10-25 (10:00 AM - 11:30 AM)
    with pytest.raises(HTTPException) as exc_info2:
        await check_doctor_session_conflicts(
            doctor_id="doc-sun-1",
            start_time="10:00 AM",
            end_time="11:30 AM",
            date_type="date",
            date_val="2026-10-25",
        )
    assert exc_info2.value.status_code == 400
    assert "overlaps with existing session" in exc_info2.value.detail

    # Non-overlapping Sunday session (02:00 PM - 05:00 PM) should pass
    await check_doctor_session_conflicts(
        doctor_id="doc-sun-1",
        start_time="02:00 PM",
        end_time="05:00 PM",
        date_type="recurring",
        days_of_week=["Sunday"],
    )


@pytest.mark.asyncio
async def test_resolve_sessions_for_sunday_and_booking_window_fallback(mock_backend):
    """Verify resolve_doctor_sessions_for_date resolves Sunday sessions and provides open category 'all' window when booking_windows is empty."""
    mock_backend.doctor_schedule_configs.items.append({
        "id": "sess-sun-1",
        "doctor_id": "doc-sun-1",
        "session_name": "Sunday OPD",
        "date_type": "recurring",
        "days_of_week": ["Sunday"],
        "start_time": "10:00 AM",
        "end_time": "02:00 PM",
        "booking_windows": [], # Receptionist form omits booking_windows
        "status": "active",
        "is_unlimited_capacity": True,
    })

    # 2026-10-25 is a Sunday
    resolved = await resolve_doctor_sessions_for_date("doc-sun-1", "2026-10-25", is_staff=True)
    assert len(resolved) == 1
    session = resolved[0]
    assert session["id"] == "sess-sun-1"
    assert session["session_name"] == "Sunday OPD"
    # Booking window fallback should exist and be 'all'
    assert len(session["booking_windows"]) >= 1
    assert session["booking_windows"][0]["category"] == "all"


@pytest.mark.asyncio
async def test_receptionist_appointment_in_sunday_session(mock_backend):
    """Verify receptionist can add a walk-in patient directly to the Sunday session."""
    rec_user = {"id": "user-rec-1", "role": "receptionist", "hospital_id": "hosp-1"}

    mock_backend.doctor_schedule_configs.items.append({
        "id": "sess-sun-1",
        "doctor_id": "doc-sun-1",
        "session_name": "Sunday OPD",
        "date_type": "recurring",
        "days_of_week": ["Sunday"],
        "start_time": "10:00 AM",
        "end_time": "02:00 PM",
        "status": "active",
    })

    body = AddPatientBody(
        full_name="Rajesh Sunday",
        mobile="9822334455",
        doctor_id="doc-sun-1",
        session_id="sess-sun-1",
        date="2026-10-25",
    )

    res = await reception_add_patient(body, rec_user)
    assert res["ok"] is True
    appt = res["appointment"]
    assert appt["session_id"] == "sess-sun-1"
    assert appt["session_name"] == "Sunday OPD"
    assert appt["date"] == "2026-10-25"
    assert appt["token_number"] == 1
