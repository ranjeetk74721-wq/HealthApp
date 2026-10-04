import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone, timedelta
import server
from server import (
    parse_time_to_ist_dt,
    extract_session_start_time,
    format_12hr_time,
    get_or_create_doctor_session,
    calculate_appointment_eta,
    verify_doctor_session_access,
    adjust_doctor_timing,
    start_doctor_session,
    pause_doctor_session,
    resume_doctor_session,
    DoctorTimingAdjustBody,
    DoctorSessionStartBody,
    DoctorSessionPauseBody,
    DoctorSessionResumeBody,
)
from fastapi import HTTPException


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
    return mdb


class TestDoctorTimingParsing:
    def test_extract_session_start_time(self):
        assert extract_session_start_time("10:00 AM - 6:00 PM") == "10:00 AM"
        assert extract_session_start_time("09:30 AM - 01:30 PM") == "9:30 AM"
        assert extract_session_start_time("2:00 PM - 8:00 PM") == "2:00 PM"
        assert extract_session_start_time("") == "10:00 AM"
        assert extract_session_start_time(None) == "10:00 AM"

    def test_parse_time_to_ist_dt_12hr(self):
        dt = parse_time_to_ist_dt("2026-10-02", "11:00 AM")
        assert dt is not None
        assert dt.year == 2026 and dt.month == 10 and dt.day == 2
        assert dt.hour == 11 and dt.minute == 0
        assert dt.tzinfo is not None

        dt_pm = parse_time_to_ist_dt("2026-10-02", "02:30 PM")
        assert dt_pm is not None
        assert dt_pm.hour == 14 and dt_pm.minute == 30

    def test_parse_time_to_ist_dt_24hr(self):
        dt = parse_time_to_ist_dt("2026-10-02", "14:45")
        assert dt is not None
        assert dt.hour == 14 and dt.minute == 45

    def test_parse_time_invalid_returns_none(self):
        assert parse_time_to_ist_dt("2026-10-02", "invalid_time") is None
        assert parse_time_to_ist_dt("", "10:00 AM") is None


class TestDoctorSessionRecalculation:
    @pytest.mark.asyncio
    async def test_recalculated_eta_moves_with_revised_start_time(self, mock_db, monkeypatch):
        # Fix current time to 2026-10-02 09:00 AM IST (before 10:00 AM and 11:00 AM)
        tz_ist = timezone(timedelta(hours=5, minutes=30))
        fixed_now = datetime(2026, 10, 2, 9, 0, 0, tzinfo=tz_ist)
        monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

        # Doctor has 15 min consultations
        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "full_name": "Dr. Rajesh Kumar",
            "avg_consult_minutes": 15,
            "status": "active",
            "timings": "10:00 AM - 2:00 PM",
            "clinic_name": "Murti Clinic",
        })

        # Session was adjusted to 11:00 AM
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "11:00 AM",
            "status": "not_started",
            "delay_reason": "Doctor arriving late",
            "version": 2,
        })

        # 3 appointments in queue
        appts = [
            {"id": "a1", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 1, "status": "booked"},
            {"id": "a2", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 2, "status": "booked"},
            {"id": "a3", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 3, "status": "booked"},
        ]
        mock_db.appointments.find.return_value = MockCursor(appts)

        # Patient 1 ETA should start at 11:00 AM (10-minute initial window per Req 4)
        eta1 = await calculate_appointment_eta(appts[0])
        assert eta1["expected_turn_time"] == "11:00 AM – 11:10 AM"
        assert eta1["my_position"] == 1
        assert eta1["is_delayed"] is True
        assert eta1["is_delayed_awaited"] is False
        assert "Doctor ke consultation start hone mein deri hai" in eta1["delay_notice"]

        # Patient 2 ETA should start at 11:10 AM (20-minute gap window per Req 4)
        eta2 = await calculate_appointment_eta(appts[1])
        assert eta2["expected_turn_time"] == "11:10 AM – 11:30 AM"
        assert eta2["my_position"] == 2

        # Patient 3 ETA should start at 11:30 AM (20-minute gap window per Req 4)
        eta3 = await calculate_appointment_eta(appts[2])
        assert eta3["expected_turn_time"] == "11:30 AM – 11:50 AM"
        assert eta3["my_position"] == 3

    @pytest.mark.asyncio
    async def test_overdue_start_shows_delayed_updated_time_awaited(self, mock_db, monkeypatch):
        # Current time is 11:15 AM IST, but session was expected at 11:00 AM and still not started!
        tz_ist = timezone(timedelta(hours=5, minutes=30))
        fixed_now = datetime(2026, 10, 2, 11, 15, 0, tzinfo=tz_ist)
        monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "full_name": "Dr. Rajesh Kumar",
            "avg_consult_minutes": 15,
            "status": "active",
            "timings": "10:00 AM - 2:00 PM",
        })

        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "11:00 AM",
            "status": "not_started",
            "delay_reason": "Emergency",
            "version": 2,
        })

        appts = [
            {"id": "a1", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 1, "status": "booked"},
        ]
        mock_db.appointments.find.return_value = MockCursor(appts)

        eta = await calculate_appointment_eta(appts[0])
        assert eta["expected_turn_time"] == "Doctor delayed—updated time awaited"
        assert eta["is_delayed_awaited"] is True
        assert "Doctor delayed—updated time awaited" in eta["delay_notice"]

    @pytest.mark.asyncio
    async def test_completed_cancelled_skipped_not_recalculated(self, mock_db):
        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "full_name": "Dr. Rajesh Kumar",
            "avg_consult_minutes": 15,
            "status": "active",
        })
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "not_started",
            "expected_start_time": "11:00 AM",
            "original_start_time": "10:00 AM",
        })
        completed_appt = {"id": "c1", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 1, "status": "completed"}
        mock_db.appointments.find.return_value = MockCursor([completed_appt])

        eta = await calculate_appointment_eta(completed_appt)
        assert eta["my_position"] == -1
        assert eta["expected_turn_time"] is None


class TestDoctorSessionEndpointsAndAccessControl:
    @pytest.mark.asyncio
    async def test_receptionist_can_adjust_doctor_in_same_hospital(self, mock_db, monkeypatch):
        monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
        monkeypatch.setattr(server, "notify_timing_adjusted", AsyncMock())

        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "hospital_id": "HOSP-A",
            "full_name": "Dr. Same Hospital",
        })
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "not_started",
            "original_start_time": "10:00 AM",
            "expected_start_time": "10:00 AM",
            "version": 1,
        })
        mock_db.doctor_sessions.find_one_and_update = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "expected_start_time": "10:30 AM",
            "status": "not_started",
            "version": 2,
        })
        mock_db.appointments.count_documents = AsyncMock(return_value=3)

        receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "HOSP-A", "full_name": "Pooja"}
        body = DoctorTimingAdjustBody(date="2026-10-02", delay_minutes=30, reason="Traffic delay", expected_version=1)

        res = await adjust_doctor_timing("doc-1", body, receptionist_user)
        assert res["ok"] is True
        assert res["affected_patients_count"] == 3
        assert "10:30 AM" in res["message"]

    @pytest.mark.asyncio
    async def test_receptionist_rejected_for_different_hospital(self, mock_db):
        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-2",
            "hospital_id": "HOSP-B",
            "full_name": "Dr. Other Hospital",
        })
        receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "HOSP-A"}
        body = DoctorTimingAdjustBody(date="2026-10-02", delay_minutes=15)

        with pytest.raises(HTTPException) as exc_info:
            await adjust_doctor_timing("doc-2", body, receptionist_user)
        assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_adjust_timing_rejects_completed_session(self, mock_db):
        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "hospital_id": "HOSP-A",
        })
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "completed",
            "version": 3,
        })
        receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "HOSP-A"}
        body = DoctorTimingAdjustBody(date="2026-10-02", new_start_time="11:00 AM")

        with pytest.raises(HTTPException) as exc_info:
            await adjust_doctor_timing("doc-1", body, receptionist_user)
        assert exc_info.value.status_code == 400
        assert "completed" in exc_info.value.detail

    @pytest.mark.asyncio
    async def test_optimistic_concurrency_conflict_returns_409(self, mock_db):
        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "hospital_id": "HOSP-A",
        })
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "not_started",
            "version": 5,  # current version is 5
        })
        receptionist_user = {"id": "rec-1", "role": "receptionist", "hospital_id": "HOSP-A"}
        body = DoctorTimingAdjustBody(date="2026-10-02", new_start_time="11:00 AM", expected_version=4)  # stale version 4

        with pytest.raises(HTTPException) as exc_info:
            await adjust_doctor_timing("doc-1", body, receptionist_user)
        assert exc_info.value.status_code == 409
        assert "concurrently" in exc_info.value.detail


class TestDoctorSessionStartPauseResume:
    @pytest.mark.asyncio
    async def test_start_consultation_records_actual_start(self, mock_db, monkeypatch):
        monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
        monkeypatch.setattr(server, "notify_queue_movement", AsyncMock())

        mock_db.doctors.find_one = AsyncMock(return_value={"id": "doc-1", "hospital_id": "HOSP-A"})
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "not_started",
            "version": 1,
            "actual_start_time": None,
        })
        mock_db.doctor_sessions.find_one_and_update = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "in_consultation",
            "actual_start_time": "10:15 AM",
        })
        mock_db.doctors.update_one = AsyncMock()

        user = {"id": "doc-1", "role": "doctor", "hospital_id": "HOSP-A"}
        res = await start_doctor_session("doc-1", DoctorSessionStartBody(date="2026-10-02"), user)
        assert res["ok"] is True
        assert res["session"]["status"] == "in_consultation"
        assert res["actual_start_time"] is not None

    @pytest.mark.asyncio
    async def test_pause_and_resume_session(self, mock_db, monkeypatch):
        monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
        monkeypatch.setattr(server, "notify_doctor_status_change", AsyncMock())
        monkeypatch.setattr(server, "notify_queue_movement", AsyncMock())

        mock_db.doctors.find_one = AsyncMock(return_value={"id": "doc-1", "hospital_id": "HOSP-A"})
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "in_consultation",
            "version": 2,
        })
        mock_db.doctor_sessions.find_one_and_update = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "paused",
            "expected_resume_time": "12:30 PM",
            "pause_reason": "Emergency round",
        })
        mock_db.doctors.update_one = AsyncMock()

        user = {"id": "rec-1", "role": "receptionist", "hospital_id": "HOSP-A"}
        # Pause
        pause_res = await pause_doctor_session(
            "doc-1",
            DoctorSessionPauseBody(date="2026-10-02", expected_resume_time="12:30 PM", pause_reason="Emergency round"),
            user
        )
        assert pause_res["ok"] is True
        assert pause_res["session"]["status"] == "paused"

        # Resume
        mock_db.doctor_sessions.find_one_and_update = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "status": "in_consultation",
            "delay_reason": None,
            "return_time_unconfirmed": False,
        })
        resume_res = await resume_doctor_session("doc-1", DoctorSessionResumeBody(date="2026-10-02"), user)
        assert resume_res["ok"] is True
        assert resume_res["session"]["status"] == "in_consultation"


class TestNewDelayAndTimingFeatures:
    @pytest.mark.asyncio
    async def test_unconfirmed_return_time_adjust_and_eta(self, mock_db, monkeypatch):
        monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
        monkeypatch.setattr(server, "notify_timing_adjusted", AsyncMock())

        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "user_id": "u-doc-1",
            "full_name": "Dr. Sharma",
            "hospital_id": "HOSP-A",
            "avg_consult_minutes": 15,
            "status": "active",
        })
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "10:00 AM",
            "status": "not_started",
            "version": 1,
        })
        mock_db.doctor_sessions.find_one_and_update = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "10:00 AM",
            "delay_reason": "Doctor attending an emergency",
            "return_time_unconfirmed": True,
            "status": "not_started",
            "version": 2,
        })
        mock_db.appointments.count_documents = AsyncMock(return_value=2)

        doctor_user = {"id": "u-doc-1", "role": "doctor", "hospital_id": "HOSP-A"}
        body = DoctorTimingAdjustBody(
            date="2026-10-02",
            return_time_unconfirmed=True,
            reason="Doctor attending an emergency",
            expected_version=1,
        )
        res = await adjust_doctor_timing("doc-1", body, doctor_user)
        assert res["ok"] is True
        assert res["session"]["return_time_unconfirmed"] is True
        assert res["session"]["delay_reason"] == "Doctor attending an emergency"

        # Check ETA calculation when return time is unconfirmed
        mock_db.doctor_sessions.find_one = AsyncMock(return_value=res["session"])
        appts = [
            {"id": "a1", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 1, "status": "booked"},
        ]
        mock_db.appointments.find.return_value = MockCursor(appts)
        eta = await calculate_appointment_eta(appts[0])
        assert eta["is_delayed_awaited"] is True
        assert eta["is_estimate_pending"] is True
        assert eta["expected_turn_time"] == "Doctor delayed—updated time awaited"
        assert "Doctor attending an emergency" in eta["delay_notice"]
        assert "The consultation resume time is not yet confirmed" in eta["delay_notice"]

    @pytest.mark.asyncio
    async def test_repeated_saves_do_not_compound_delay(self, mock_db, monkeypatch):
        monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
        monkeypatch.setattr(server, "notify_timing_adjusted", AsyncMock())

        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "user_id": "u-doc-1",
            "hospital_id": "HOSP-A",
        })
        # Baseline original start is 10:00 AM
        session_doc = {
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "10:30 AM",
            "status": "not_started",
            "version": 2,
        }
        mock_db.doctor_sessions.find_one = AsyncMock(return_value=session_doc)
        mock_db.appointments.count_documents = AsyncMock(return_value=1)

        captured_update = {}
        async def mock_update(filter_q, update_q, **kwargs):
            captured_update.update(update_q["$set"])
            return {**session_doc, **update_q["$set"]}
        mock_db.doctor_sessions.find_one_and_update = mock_update

        user = {"id": "u-doc-1", "role": "doctor"}
        # Calling with delay_minutes=30 again must calculate from original_start_time (10:00 AM + 30m = 10:30 AM)
        body = DoctorTimingAdjustBody(date="2026-10-02", delay_minutes=30, reason="Running late")
        res = await adjust_doctor_timing("doc-1", body, user)
        assert captured_update["expected_start_time"] == "10:30 AM"

    @pytest.mark.asyncio
    async def test_consultation_underway_shifts_waiting_without_rewriting_active(self, mock_db, monkeypatch):
        tz_ist = timezone(timedelta(hours=5, minutes=30))
        fixed_now = datetime(2026, 10, 2, 10, 5, 0, tzinfo=tz_ist)
        monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

        mock_db.doctors.find_one = AsyncMock(return_value={
            "id": "doc-1",
            "full_name": "Dr. Sharma",
            "avg_consult_minutes": 15,
            "status": "active",
        })
        # Doctor adjusted expected availability to 11:00 AM while consultation is underway
        mock_db.doctor_sessions.find_one = AsyncMock(return_value={
            "id": "doc-1_2026-10-02",
            "doctor_id": "doc-1",
            "date": "2026-10-02",
            "original_start_time": "10:00 AM",
            "expected_start_time": "11:00 AM",
            "actual_start_time": "10:00 AM",
            "delay_reason": "Doctor in emergency surgery",
            "status": "in_consultation",
            "version": 3,
        })
        appts = [
            {"id": "a1", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 1, "status": "in_consultation", "started_at": "2026-10-02T10:00:00+05:30"},
            {"id": "a2", "doctor_id": "doc-1", "date": "2026-10-02", "token_number": 2, "status": "booked"},
        ]
        mock_db.appointments.find.return_value = MockCursor(appts)

        # Active patient #1 must remain "Now" with position 0
        eta_active = await calculate_appointment_eta(appts[0])
        assert eta_active["my_position"] == 0
        assert eta_active["expected_turn_time"] == "Now"
        assert eta_active["actual_start_time"] == "10:00 AM"

        # Subsequent waiting patient #2 gets recalculated turn time starting from 11:00 AM
        eta_waiting = await calculate_appointment_eta(appts[1])
        assert eta_waiting["patients_ahead"] == 1
        assert eta_waiting["my_position"] == 2
        assert "11:00 AM" in eta_waiting["expected_turn_time"]
        assert "Doctor in emergency surgery" in eta_waiting["delay_notice"]

