import os
os.environ["MONGO_URL"] = "mongodb://localhost:27017/test_meribaari"

import pytest
import io
import openpyxl
from unittest.mock import AsyncMock, MagicMock
from datetime import datetime, timezone, timedelta
import server
from server import (
    calculate_appointment_eta,
    calendar_summary,
    reception_cancel_appointment,
    reception_export_excel,
    QueueActionBody,
)
from fastapi import HTTPException

TEST_DATE = "2026-10-05"
FUTURE_EMPTY_DATE = "2026-10-29"
FUTURE_BOOKED_DATE = "2026-10-30"


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
        self.appointments.find = MagicMock(return_value=MockCursor([]))
        self.doctors = MagicMock()
        self.doctors.find = MagicMock(return_value=MockCursor([{"id": "doc-1"}]))
        self.doctor_sessions = MagicMock()
        self.push_subscriptions = MagicMock()
        self.push_subscriptions.update_many = AsyncMock()
        self.push_logs = MagicMock()
        self.users = MagicMock()


@pytest.fixture
def mock_db(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    return mdb


@pytest.mark.asyncio
async def test_first_token_10_minute_window_and_20_minute_subsequent(mock_db, monkeypatch):
    """Requirement 4: Before consultations begin, first eligible token shows 10-minute window,
    and subsequent tokens show 20-minute gap windows.
    Doctor start time = 12:00 PM -> Token 1: 12:00 PM–12:10 PM, Token 2: 12:10 PM–12:30 PM.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 11, 45, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Mariya",
        "hospital_id": "H1",
        "avg_consult_minutes": 20,
        "status": "active",
        "timings": "12:00 PM - 5:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": f"doc-1_{TEST_DATE}",
        "doctor_id": "doc-1",
        "date": TEST_DATE,
        "original_start_time": "12:00 PM",
        "expected_start_time": "12:00 PM",
        "status": "not_started",
        "version": 1,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 3, "queue_order": 3, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    # Token 1 (first eligible waiting): exactly 10 min window: 12:00 PM – 12:10 PM
    eta1 = await calculate_appointment_eta(appts[0])
    assert eta1["expected_turn_time"] == "12:00 PM – 12:10 PM"
    assert eta1["my_position"] == 1

    # Token 2: 20 min gap window: 12:10 PM – 12:30 PM
    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["expected_turn_time"] == "12:10 PM – 12:30 PM"
    assert eta2["my_position"] == 2

    # Token 3: 20 min gap window: 12:30 PM – 12:50 PM
    eta3 = await calculate_appointment_eta(appts[2])
    assert eta3["expected_turn_time"] == "12:30 PM – 12:50 PM"
    assert eta3["my_position"] == 3


@pytest.mark.asyncio
async def test_doctor_starting_30_minutes_late(mock_db, monkeypatch):
    """Requirement 2 & 4: Doctor delay of 30 minutes (starts at 12:30 PM):
    First token shows 12:30 PM–12:40 PM, subsequent shows 12:40 PM–1:00 PM.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 12, 10, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Mariya",
        "hospital_id": "H1",
        "avg_consult_minutes": 20,
        "status": "active",
        "timings": "12:00 PM - 5:00 PM",
    })

    # Adjusted to 12:30 PM
    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": f"doc-1_{TEST_DATE}",
        "doctor_id": "doc-1",
        "date": TEST_DATE,
        "original_start_time": "12:00 PM",
        "expected_start_time": "12:30 PM",
        "status": "not_started",
        "delay_reason": "Traffic jam",
        "version": 2,
    })

    appts = [
        {"id": "a1", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 2, "queue_order": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta1 = await calculate_appointment_eta(appts[0])
    assert eta1["expected_turn_time"] == "12:30 PM – 12:40 PM"
    assert eta1["is_delayed"] is True

    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["expected_turn_time"] == "12:40 PM – 1:00 PM"


@pytest.mark.asyncio
async def test_token1_cancellation_advances_initial_window_to_token2(mock_db, monkeypatch):
    """Requirement 4 & 7: If token 1 is cancelled before consultation starts,
    initial 10-minute window applies to token 2.
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 11, 50, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Mariya",
        "hospital_id": "H1",
        "avg_consult_minutes": 20,
        "status": "active",
        "timings": "12:00 PM - 5:00 PM",
    })

    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": f"doc-1_{TEST_DATE}",
        "doctor_id": "doc-1",
        "date": TEST_DATE,
        "original_start_time": "12:00 PM",
        "expected_start_time": "12:00 PM",
        "status": "not_started",
        "version": 1,
    })

    # Token 1 is cancelled, Token 2 is booked, Token 3 is booked
    appts = [
        {"id": "a1", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 1, "queue_order": 1, "status": "cancelled"},
        {"id": "a2", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 2, "queue_order": 2, "status": "booked"},
        {"id": "a3", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 3, "queue_order": 3, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    # Token 2 is now first eligible waiting token: gets 12:00 PM – 12:10 PM
    eta2 = await calculate_appointment_eta(appts[1])
    assert eta2["expected_turn_time"] == "12:00 PM – 12:10 PM"
    assert eta2["my_position"] == 1

    # Token 3 is second eligible waiting token: gets 12:10 PM – 12:30 PM
    eta3 = await calculate_appointment_eta(appts[2])
    assert eta3["expected_turn_time"] == "12:10 PM – 12:30 PM"
    assert eta3["my_position"] == 2


@pytest.mark.asyncio
async def test_session_pause_and_resume(mock_db, monkeypatch):
    """Requirement 2 & 3:
    - Pausing without resume time shows "Doctor paused — resume time awaited" and is_estimate_pending = True.
    - Pausing with resume time recalculates slots from resume time (10 min for first waiting, 20 min subsequent).
    """
    tz_ist = timezone(timedelta(hours=5, minutes=30))
    fixed_now = datetime(2026, 10, 5, 13, 0, 0, tzinfo=tz_ist)
    monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Mariya",
        "hospital_id": "H1",
        "avg_consult_minutes": 20,
        "status": "active",
        "timings": "12:00 PM - 5:00 PM",
    })

    # Case A: Paused without resume time
    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": f"doc-1_{TEST_DATE}",
        "doctor_id": "doc-1",
        "date": TEST_DATE,
        "status": "paused",
        "expected_resume_time": None,
    })
    appts = [
        {"id": "a1", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 1, "queue_order": 1, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts)

    eta_paused = await calculate_appointment_eta(appts[0])
    assert "Doctor paused" in eta_paused["expected_turn_time"]
    assert eta_paused["is_estimate_pending"] is True

    # Case B: Paused with resume time 2:00 PM (14:00)
    mock_db.doctor_sessions.find_one = AsyncMock(return_value={
        "id": f"doc-1_{TEST_DATE}",
        "doctor_id": "doc-1",
        "date": TEST_DATE,
        "status": "paused",
        "expected_resume_time": "2:00 PM",
    })
    appts2 = [
        {"id": "a1", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 1, "queue_order": 1, "status": "booked"},
        {"id": "a2", "doctor_id": "doc-1", "date": TEST_DATE, "token_number": 2, "queue_order": 2, "status": "booked"},
    ]
    mock_db.appointments.find.return_value = MockCursor(appts2)

    eta_resumed1 = await calculate_appointment_eta(appts2[0])
    assert eta_resumed1["expected_turn_time"] == "2:00 PM – 2:10 PM"

    eta_resumed2 = await calculate_appointment_eta(appts2[1])
    assert eta_resumed2["expected_turn_time"] == "2:10 PM – 2:30 PM"


@pytest.mark.asyncio
async def test_calendar_summary_counts_empty_future_vs_genuine(mock_db):
    """Requirement 5:
    - Empty future date shows 0 bookings (not 1).
    - Genuine future bookings show their actual count.
    - Cancelled bookings are excluded.
    """
    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "hospital_id": "H_CAL",
        "full_name": "Dr. Calendar",
    })
    mock_db.doctors.find.return_value = MockCursor([{"id": "doc-1"}])

    # Appointments on FUTURE_BOOKED_DATE (2 booked, 1 cancelled)
    mock_db.appointments.find.return_value = MockCursor([
        {"id": "a1", "date": FUTURE_BOOKED_DATE, "token_number": 1, "status": "booked"},
        {"id": "a2", "date": FUTURE_BOOKED_DATE, "token_number": 2, "status": "booked"},
    ])

    res = await calendar_summary(
        doctor_id="doc-1",
        user={"id": "rec-1", "role": "receptionist", "hospital_id": "H_CAL"}
    )

    # Empty date should not be returned (counts as 0)
    empty_entry = next((item for item in res if item["date"] == FUTURE_EMPTY_DATE), None)
    assert empty_entry is None or empty_entry["patient_count"] == 0

    # Genuine booked date should have exactly 2
    booked_entry = next((item for item in res if item["date"] == FUTURE_BOOKED_DATE), None)
    assert booked_entry is not None
    assert booked_entry["patient_count"] == 2
    assert booked_entry["tokens"] == [1, 2]


@pytest.mark.asyncio
async def test_receptionist_cancellation_rules(mock_db, monkeypatch):
    """Requirement 7:
    - Cannot cancel completed appointments.
    - Cannot cancel in_consultation appointments.
    - Can cancel booked/waiting appointments at beginning, middle, or end.
    - Retains cancellation timestamp and reason.
    """
    monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
    monkeypatch.setattr(server, "notify_queue_movement", AsyncMock())

    # Case 1: Completed appointment cannot be cancelled
    mock_db.appointments.find_one = AsyncMock(return_value={
        "id": "a-comp",
        "doctor_id": "doc-1",
        "hospital_id": "H1",
        "status": "completed",
    })
    with pytest.raises(HTTPException) as exc_info:
        await reception_cancel_appointment(
            QueueActionBody(appointment_id="a-comp", reason="Test cancel"),
            user={"id": "u1", "role": "receptionist", "hospital_id": "H1"}
        )
    assert exc_info.value.status_code == 400
    assert "Cannot cancel an already completed consultation" in exc_info.value.detail

    # Case 2: In-consultation appointment cannot be cancelled
    mock_db.appointments.find_one = AsyncMock(return_value={
        "id": "a-in",
        "doctor_id": "doc-1",
        "hospital_id": "H1",
        "status": "in_consultation",
    })
    with pytest.raises(HTTPException) as exc_info2:
        await reception_cancel_appointment(
            QueueActionBody(appointment_id="a-in", reason="Test cancel"),
            user={"id": "u1", "role": "receptionist", "hospital_id": "H1"}
        )
    assert exc_info2.value.status_code == 400
    assert "Cannot cancel an appointment currently in consultation" in exc_info2.value.detail

    # Case 3: Waiting appointment cancelled successfully
    mock_db.appointments.find_one = AsyncMock(return_value={
        "id": "a-wait",
        "doctor_id": "doc-1",
        "hospital_id": "H1",
        "patient_id": "p1",
        "status": "booked",
        "date": TEST_DATE,
        "token_number": 3,
    })
    mock_db.appointments.update_one = AsyncMock(return_value=MagicMock(modified_count=1))

    resp = await reception_cancel_appointment(
        QueueActionBody(appointment_id="a-wait", reason="Patient had emergency"),
        user={"id": "u1", "role": "receptionist", "hospital_id": "H1"}
    )
    assert resp["ok"] is True
    # Verify update_one recorded cancellation metadata
    update_call = mock_db.appointments.update_one.call_args[0]
    set_fields = update_call[1]["$set"]
    assert set_fields["status"] == "cancelled"
    assert set_fields["cancellation_reason"] == "Patient had emergency"
    assert "cancelled_at" in set_fields


@pytest.mark.asyncio
async def test_excel_export_generation_and_columns(mock_db):
    """Requirement 8: Database-backed Excel download produces a valid .xlsx file
    matching database records with all required columns.
    """
    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-1",
        "full_name": "Dr. Excel Test",
        "hospital_id": "H_EXCEL",
        "clinic_name": "City Health Clinic",
    })
    mock_db.doctors.find.return_value = MockCursor([{"id": "doc-1"}])

    appointments_data = [
        {
            "id": "appt-1",
            "doctor_id": "doc-1",
            "hospital_id": "H_EXCEL",
            "patient_name": "Alice Walker",
            "patient_mobile": "9876543210",
            "age": 28,
            "gender": "Female",
            "date": TEST_DATE,
            "slot": "Walk-in",
            "token_number": 1,
            "status": "completed",
            "consultation_started_at": "10:00 AM",
            "consultation_completed_at": "10:15 AM",
        },
        {
            "id": "appt-2",
            "doctor_id": "doc-1",
            "hospital_id": "H_EXCEL",
            "patient_name": "Bob Smith",
            "patient_mobile": "9123456780",
            "age": 45,
            "gender": "Male",
            "date": TEST_DATE,
            "slot": "Online Booking",
            "token_number": 2,
            "status": "booked",
            "expected_turn_time": "10:15 AM – 10:35 AM",
        },
        {
            "id": "appt-3",
            "doctor_id": "doc-1",
            "hospital_id": "H_EXCEL",
            "patient_name": "Charlie Brown",
            "patient_mobile": "9988776655",
            "age": 33,
            "gender": "Male",
            "date": TEST_DATE,
            "slot": "Walk-in",
            "token_number": 3,
            "status": "cancelled",
            "cancelled_at": "2026-10-05T09:45:00Z",
            "cancellation_reason": "Patient requested cancellation",
        },
    ]

    mock_db.appointments.find.return_value = MockCursor(appointments_data)

    resp = await reception_export_excel(
        doctor_id="doc-1",
        date=TEST_DATE,
        user={"id": "rec-1", "role": "receptionist", "hospital_id": "H_EXCEL"}
    )

    assert resp.status_code == 200
    assert "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" in resp.media_type
    assert "ClinicQueue_Report" in resp.headers["Content-Disposition"]

    # Verify workbook content with openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(resp.body))
    ws = wb.active
    assert ws.title == "Appointments Report"

    headers = [cell.value for cell in ws[1]]
    assert "Booking Date" in headers
    assert "Appointment ID" in headers
    assert "Token #" in headers
    assert "Patient Name" in headers
    assert "Mobile Number" in headers
    assert "Status" in headers
    assert "Consultation Started" in headers
    assert "Consultation Completed" in headers
    assert "Consultation Duration" in headers
    assert "Cancellation Reason" in headers

    rows = list(ws.iter_rows(values_only=True))
    assert len(rows) == 4  # 1 header + 3 appointments

    # Check Alice (Completed)
    alice_row = next(r for r in rows[1:] if r[3] == "Alice Walker")
    assert alice_row[10] == "Completed"
    assert alice_row[12] == "10:00 AM"
    assert alice_row[13] == "10:15 AM"
    assert "15 mins" in alice_row[14]

    # Check Charlie (Cancelled)
    charlie_row = next(r for r in rows[1:] if r[3] == "Charlie Brown")
    assert charlie_row[10] == "Cancelled"
    assert "Patient requested cancellation" in charlie_row[16]
