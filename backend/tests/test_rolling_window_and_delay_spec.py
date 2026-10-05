import pytest
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone, timedelta
import server
from server import (
    calculate_appointment_eta,
    update_cabin_presence,
    adjust_doctor_timing,
    complete_consultation,
    CabinPresenceBody,
    DoctorTimingAdjustBody,
    QueueActionBody,
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
    monkeypatch.setattr(server, "notify_timing_adjusted", AsyncMock())
    monkeypatch.setattr(server, "notify_queue_movement", AsyncMock())
    return mdb


@pytest.mark.asyncio
async def test_rolling_30_min_window_exact_prompt_example(mock_db, monkeypatch):
    """
    Prompt Requirement 2:
    Exact display pattern when doctor starts at 3:00 PM and estimated duration is 5 minutes:
    - Token 1: 3:00 PM – 3:30 PM
    - Token 2: 3:05 PM – 3:35 PM
    - Token 3: 3:10 PM – 3:40 PM
    - Token 4: 3:15 PM – 3:45 PM
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    # Morning booking: patient booked in morning (10:00 AM) for 3:00 PM doctor start
    fixed_now = datetime(2026, 10, 5, 10, 0, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-3pm",
        "full_name": "Dr. Mariya",
        "avg_consult_minutes": 5,
        "status": "active",
        "timings": "3:00 PM - 7:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-3pm_2026-10-05",
        "doctor_id": "doc-3pm",
        "date": "2026-10-05",
        "original_start_time": "3:00 PM",
        "expected_start_time": "3:00 PM",
        "status": "not_started",
        "version": 1,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 3, "queue_order": 3, "status": "booked"},
        {"id": "a4", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 4, "queue_order": 4, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta1 = await calculate_appointment_eta(appts[0])
    eta2 = await calculate_appointment_eta(appts[1])
    eta3 = await calculate_appointment_eta(appts[2])
    eta4 = await calculate_appointment_eta(appts[3])

    assert eta1["expected_turn_time"] == "3:00 PM – 3:30 PM"
    assert eta2["expected_turn_time"] == "3:05 PM – 3:35 PM"
    assert eta3["expected_turn_time"] == "3:10 PM – 3:40 PM"
    assert eta4["expected_turn_time"] == "3:15 PM – 3:45 PM"


@pytest.mark.asyncio
async def test_completion_at_3_12_pm_exact_prompt_example(mock_db, monkeypatch):
    """
    Prompt Requirement 3:
    Example: Token 1 starts at 3:00 PM but finishes at 3:12 PM.
    If the doctor remains available and average consultation duration is 5 minutes:
    - Token 2: 3:12 PM – 3:42 PM
    - Token 3: 3:17 PM – 3:47 PM
    - Token 4: 3:22 PM – 3:52 PM
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 15, 12, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-3pm",
        "full_name": "Dr. Mariya",
        "avg_consult_minutes": 5,
        "status": "active",
        "timings": "3:00 PM - 7:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-3pm_2026-10-05",
        "doctor_id": "doc-3pm",
        "date": "2026-10-05",
        "original_start_time": "3:00 PM",
        "actual_start_time": "3:00 PM",
        "status": "in_consultation",
        "version": 2,
    })

    # Token 1 completed at 3:12 PM; Tokens 2, 3, 4 waiting
    appts = [
        {"id": "a1", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 1, "queue_order": 1, "status": "completed", "consultation_completed_at": "3:12 PM"},
        {"id": "a2", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 3, "queue_order": 3, "status": "booked"},
        {"id": "a4", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 4, "queue_order": 4, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta2 = await calculate_appointment_eta(appts[1])
    eta3 = await calculate_appointment_eta(appts[2])
    eta4 = await calculate_appointment_eta(appts[3])

    assert eta2["expected_turn_time"] == "3:12 PM – 3:42 PM"
    assert eta3["expected_turn_time"] == "3:17 PM – 3:47 PM"
    assert eta4["expected_turn_time"] == "3:22 PM – 3:52 PM"


@pytest.mark.asyncio
async def test_doctor_delay_from_3_00_to_3_30_exact_prompt_example(mock_db, monkeypatch):
    """
    Prompt Requirement 4:
    Example: If planned start changes from 3:00 PM to 3:30 PM:
    - Token 1: 3:30 PM – 4:00 PM
    - Token 2: 3:35 PM – 4:05 PM
    - Token 3: 3:40 PM – 4:10 PM
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 14, 45, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-3pm",
        "full_name": "Dr. Mariya",
        "avg_consult_minutes": 5,
        "status": "active",
        "timings": "3:00 PM - 7:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-3pm_2026-10-05",
        "doctor_id": "doc-3pm",
        "date": "2026-10-05",
        "original_start_time": "3:00 PM",
        "expected_start_time": "3:30 PM",
        "delay_reason": "Emergency surgery",
        "status": "not_started",
        "version": 2,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-3pm", "date": "2026-10-05", "token_number": 3, "queue_order": 3, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta1 = await calculate_appointment_eta(appts[0])
    eta2 = await calculate_appointment_eta(appts[1])
    eta3 = await calculate_appointment_eta(appts[2])

    assert eta1["expected_turn_time"] == "3:30 PM – 4:00 PM"
    assert eta2["expected_turn_time"] == "3:35 PM – 4:05 PM"
    assert eta3["expected_turn_time"] == "3:40 PM – 4:10 PM"
    assert "Emergency surgery" in eta1["delay_notice"]


@pytest.mark.asyncio
async def test_active_consultation_shows_in_progress(mock_db, monkeypatch):
    """
    Prompt Requirement 3:
    For the patient currently being examined, show “Consultation in progress.”
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 15, 5, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Mariya",
        "avg_consult_minutes": 5,
        "status": "active",
    })
    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-1_2026-10-05",
        "status": "in_consultation",
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-1", "date": "2026-10-05", "token_number": 1, "queue_order": 1, "status": "in_consultation", "started_at": "2026-10-05T15:00:00+05:30"},
        {"id": "a2", "doctor_id": "doc-1", "date": "2026-10-05", "token_number": 2, "queue_order": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta_active = await calculate_appointment_eta(appts[0])
    assert eta_active["expected_turn_time"] == "Consultation in progress."


@pytest.mark.asyncio
async def test_cabin_presence_distinct_from_consultation_start(mock_db):
    """
    Prompt Requirement 1:
    Doctor presence in the cabin and actual consultation start should remain distinct states.
    """
    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-cabin",
        "user_id": "u-doc",
        "hospital_id": "H1",
        "status": "active",
    })
    session_data = {
        "id": "doc-cabin_2026-10-05",
        "doctor_id": "doc-cabin",
        "date": "2026-10-05",
        "status": "not_started",
        "doctor_in_cabin": False,
        "version": 1,
    }
    mock_db.doctor_sessions.find_one = AsyncMock(return_value=session_data)

    async def mock_find_and_update(filter_q, update_q, **kwargs):
        return {**session_data, **update_q["$set"]}
    mock_db.doctor_sessions.find_one_and_update = mock_find_and_update

    user = {"id": "u-doc", "role": "doctor", "hospital_id": "H1"}
    body = CabinPresenceBody(date="2026-10-05", doctor_in_cabin=True)
    res = await update_cabin_presence("doc-cabin", body, user)

    assert res["ok"] is True
    assert res["doctor_in_cabin"] is True
    assert res["session"]["status"] == "not_started"  # Still not_started, distinct from in_consultation!


@pytest.mark.asyncio
async def test_unknown_consultation_start_notice(mock_db, monkeypatch):
    """
    Prompt Requirement 1:
    If the start time is unknown, show:
    “Doctor ke consultation shuru karne ka samay abhi confirm nahi hai.”
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 10, 0, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-unknown",
        "full_name": "Dr. Mariya",
        "avg_consult_minutes": 5,
        "status": "active",
    })
    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": "doc-unknown_2026-10-05",
        "doctor_id": "doc-unknown",
        "date": "2026-10-05",
        "status": "not_started",
        "start_time_unconfirmed": True,
        "expected_start_time": None,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-unknown", "date": "2026-10-05", "token_number": 1, "queue_order": 1, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta = await calculate_appointment_eta(appts[0])
    assert eta["expected_turn_time"] == "Doctor ke consultation shuru karne ka samay abhi confirm nahi hai."
    assert eta["is_delayed_awaited"] is True
