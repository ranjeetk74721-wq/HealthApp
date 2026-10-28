import pytest
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone, timedelta
import server
from server import (
    calculate_appointment_eta,
    update_cabin_presence,
    CabinPresenceBody,
)


class MockCursor:
    def __init__(self, data):
        self._data = data

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length):
        return self._data


class MockDB:
    def __init__(self):
        self.appointments = MagicMock()
        self.doctors = MagicMock()
        self.doctor_sessions = MagicMock()
        self.push_subscriptions = MagicMock()
        self.push_logs = MagicMock()


@pytest.fixture
def mock_db(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
    return mdb


@pytest.mark.asyncio
async def test_scenario_1_patient_before_doctor_arrives(mock_db, monkeypatch):
    """
    Scenario 1:
    Patient has confirmed appointment, but doctor has not arrived in cabin.
    Expected: Expected waiting time and consultation turn time are displayed,
    and doctor_in_cabin is False.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    # Patient booked at 2:30 PM for 3:00 PM doctor session
    fixed_now = datetime(2026, 10, 27, 14, 30, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-wait-1",
        "full_name": "Dr. Sarah",
        "avg_consult_minutes": 5,
        "status": "active",
        "timings": "3:00 PM - 6:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-wait-1_2026-10-27",
        "doctor_id": "doc-wait-1",
        "date": "2026-10-27",
        "original_start_time": "3:00 PM",
        "expected_start_time": "3:00 PM",
        "status": "not_started",
        "doctor_in_cabin": False,
        "cabin_entered_at": None,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 3, "queue_order": 3, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    # Token 1
    eta1 = await calculate_appointment_eta(appts[0])
    assert eta1["doctor_in_cabin"] is False
    assert eta1["expected_turn_time"] == "3:00 PM – 3:30 PM"
    assert eta1["eta_minutes"] == 30  # 3:00 PM - 2:30 PM = 30 minutes
    assert eta1["patients_ahead"] == 0

    # Token 3 (has 2 patients ahead: 2 * 5 min = 10 min)
    eta3 = await calculate_appointment_eta(appts[2])
    assert eta3["doctor_in_cabin"] is False
    assert eta3["expected_turn_time"] == "3:10 PM – 3:40 PM"
    assert eta3["eta_minutes"] == 40  # 3:10 PM - 2:30 PM = 40 minutes
    assert eta3["patients_ahead"] == 2


@pytest.mark.asyncio
async def test_scenario_2_doctor_arrives_in_cabin_before_consultation(mock_db, monkeypatch):
    """
    Scenario 2:
    Doctor arrives in the cabin (doctor_in_cabin = True) before first consultation starts.
    Expected: Consultation start is not yet triggered, but waiting time updates
    from current time with doctor_in_cabin = True and is_estimate_pending = False.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    # Doctor enters cabin at 3:05 PM
    fixed_now = datetime(2026, 10, 27, 15, 5, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-wait-1",
        "full_name": "Dr. Sarah",
        "avg_consult_minutes": 5,
        "status": "active",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-wait-1_2026-10-27",
        "doctor_id": "doc-wait-1",
        "date": "2026-10-27",
        "original_start_time": "3:00 PM",
        "expected_start_time": "3:00 PM",
        "status": "not_started",
        "doctor_in_cabin": True,
        "cabin_entered_at": "3:05 PM",
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 2, "queue_order": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta1 = await calculate_appointment_eta(appts[0])
    assert eta1["doctor_in_cabin"] is True
    assert eta1["cabin_entered_at"] == "3:05 PM"
    assert eta1["is_estimate_pending"] is False
    assert eta1["is_delayed_awaited"] is False
    assert eta1["expected_turn_time"] == "3:05 PM – 3:35 PM"
    assert eta1["eta_minutes"] == 0

    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["doctor_in_cabin"] is True
    assert eta2["expected_turn_time"] == "3:10 PM – 3:40 PM"
    assert eta2["eta_minutes"] == 5
    assert eta2["patients_ahead"] == 1


@pytest.mark.asyncio
async def test_scenario_3_consultation_starts(mock_db, monkeypatch):
    """
    Scenario 3:
    When consultation starts, appointment status transitions to in_consultation.
    Expected: Dashboard displays 'Consultation in progress.' and patients_ahead = 0.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 27, 15, 6, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-wait-1",
        "full_name": "Dr. Sarah",
        "avg_consult_minutes": 5,
        "status": "active",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-wait-1_2026-10-27",
        "doctor_id": "doc-wait-1",
        "date": "2026-10-27",
        "status": "in_consultation",
        "doctor_in_cabin": True,
        "actual_start_time": "3:06 PM",
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 1, "status": "in_consultation", "started_at": "2026-10-27T09:36:00Z"},
        {"id": "a2", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta1 = await calculate_appointment_eta(appts[0])
    assert eta1["expected_turn_time"] == "Consultation in progress."
    assert eta1["patients_ahead"] == 0
    assert eta1["eta_minutes"] == 0

    # Token 2 is waiting, with 1 active patient consulting ahead
    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["patients_ahead"] == 1
    assert eta2["expected_turn_time"] is not None
    assert "Consultation in progress" not in eta2["expected_turn_time"]


@pytest.mark.asyncio
async def test_scenario_4_preceding_consultation_completes(mock_db, monkeypatch):
    """
    Scenario 4:
    Preceding consultation completes.
    Expected: Patients ahead decrements and waiting patient's estimate updates.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 27, 15, 12, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-wait-1",
        "full_name": "Dr. Sarah",
        "avg_consult_minutes": 5,
        "status": "active",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-wait-1_2026-10-27",
        "doctor_id": "doc-wait-1",
        "date": "2026-10-27",
        "status": "not_started",
        "doctor_in_cabin": True,
        "actual_start_time": "3:06 PM",
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 1, "status": "completed", "consultation_completed_at": "3:12 PM"},
        {"id": "a2", "doctor_id": "doc-wait-1", "date": "2026-10-27", "token_number": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["patients_ahead"] == 0
    assert eta2["eta_minutes"] == 0
    assert eta2["doctor_in_cabin"] is True


@pytest.mark.asyncio
async def test_scenario_5_cabin_presence_toggle(mock_db):
    """
    Scenario 5:
    Doctor or receptionist toggles cabin presence.
    Expected: doctor_in_cabin state updates and broadcast_doctor_update is triggered.
    """
    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-cabin-test",
        "user_id": "u-doc-1",
        "hospital_id": "H1",
        "status": "active",
    })
    session_store = {
        "id": "doc-cabin-test_2026-10-27",
        "doctor_id": "doc-cabin-test",
        "date": "2026-10-27",
        "status": "not_started",
        "doctor_in_cabin": False,
        "cabin_entered_at": None,
        "version": 1,
    }
    mock_db.doctor_sessions.find_one = AsyncMock(return_value=session_store)

    async def mock_find_and_update(filter_q, update_q, **kwargs):
        session_store.update(update_q.get("$set", {}))
        return dict(session_store)

    mock_db.doctor_sessions.find_one_and_update = mock_find_and_update

    user = {"id": "u-doc-1", "role": "doctor", "hospital_id": "H1"}
    body = CabinPresenceBody(date="2026-10-27", doctor_in_cabin=True)
    res = await update_cabin_presence("doc-cabin-test", body, user)

    assert res["ok"] is True
    assert res["doctor_in_cabin"] is True
    assert res["session"]["doctor_in_cabin"] is True
    assert res["session"]["cabin_entered_at"] is not None
    # Still not_started (distinct state from consultation start!)
    assert res["session"]["status"] == "not_started"
