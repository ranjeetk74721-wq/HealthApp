import sys
from pathlib import Path
from datetime import datetime

_backend_dir = Path(__file__).resolve().parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

import pytest
import httpx
from server import format_12hr_time, format_expected_time_range, calculate_appointment_eta
from sms_service import format_appointment_sms_text, send_appointment_sms, HINDI_QUEUE_INSTRUCTION


class Test12HourTimeFormat:
    """Tests 12-hour AM/PM conversion and formatting."""

    def test_24hr_to_12hr_afternoon(self):
        assert format_12hr_time("14:00") == "2:00 PM"
        assert format_12hr_time("14:30") == "2:30 PM"
        assert format_12hr_time("16:45") == "4:45 PM"

    def test_24hr_to_12hr_morning(self):
        assert format_12hr_time("09:00") == "9:00 AM"
        assert format_12hr_time("09:15") == "9:15 AM"
        assert format_12hr_time("11:30") == "11:30 AM"

    def test_midnight_and_noon(self):
        assert format_12hr_time("00:00") == "12:00 AM"
        assert format_12hr_time("00:30") == "12:30 AM"
        assert format_12hr_time("12:00") == "12:00 PM"
        assert format_12hr_time("12:45") == "12:45 PM"

    def test_already_formatted_12hr(self):
        assert format_12hr_time("2:00 PM") == "2:00 PM"
        assert format_12hr_time("02:30 PM") == "2:30 PM"
        assert format_12hr_time("9:15 AM") == "9:15 AM"

    def test_datetime_object(self):
        dt = datetime(2026, 9, 11, 14, 30)
        assert format_12hr_time(dt) == "2:30 PM"
        dt_morning = datetime(2026, 9, 11, 8, 5)
        assert format_12hr_time(dt_morning) == "8:05 AM"

    def test_empty_or_none(self):
        assert format_12hr_time(None) == ""
        assert format_12hr_time("") == ""


class TestTimeRangeAndUncertainty:
    """Tests expected time range formatting and edge cases like duplicate times."""

    def test_distinct_range(self):
        res = format_expected_time_range("14:00", "14:30")
        assert res == "2:00 PM – 2:30 PM"

    def test_duplicate_range_prevention(self):
        # Must NOT show "2:00 PM – 2:00 PM"
        res = format_expected_time_range("14:00", "14:00")
        assert res == "2:00 PM"

    def test_duplicate_range_prevention_same_12hr(self):
        res = format_expected_time_range("2:00 PM", "2:00 PM")
        assert res == "2:00 PM"

    def test_hyphen_delimited_string_range(self):
        res = format_expected_time_range("14:00 - 14:30")
        assert res == "2:00 PM – 2:30 PM"

    def test_en_dash_delimited_string_range(self):
        res = format_expected_time_range("10:00 – 10:45")
        assert res == "10:00 AM – 10:45 AM"

    def test_hyphen_string_with_equal_times(self):
        res = format_expected_time_range("14:00 - 14:00")
        assert res == "2:00 PM"

    def test_single_start_time(self):
        res = format_expected_time_range("15:15")
        assert res == "3:15 PM"


class TestAppointmentSmsTemplate:
    """Tests the exact Hindi + English appointment confirmation template."""

    def test_sms_structure_and_hindi_instruction(self):
        sms = format_appointment_sms_text(
            hospital_name="City Care Clinic",
            doctor_name="Rajesh Kumar",
            token_number=12,
            expected_time="2:00 PM – 2:30 PM",
            live_queue_link="https://meribaari.com/appointment/xyz789",
        )
        lines = sms.strip().split("\n")
        assert len(lines) == 7

        assert lines[0] == "City Care Clinic"
        assert lines[1] == "आपका नंबर कब आएगा देखने के लिए लिंक पर क्लिक करें:"
        assert lines[2] == "https://meribaari.com/appointment/xyz789"
        assert lines[3] == "Dr. Rajesh Kumar"
        assert lines[4] == "Token: 12 | Time: 2:00 PM – 2:30 PM"
        assert lines[5] == "Thank you"
        assert lines[6] == "-MeriBaari"

    def test_sms_with_single_time(self):
        sms = format_appointment_sms_text(
            hospital_name="Apollo Clinic",
            doctor_name="Priya Sharma",
            token_number=5,
            expected_time="11:00 AM",
            live_queue_link="https://meribaari.com/appointment/tok5",
        )
        assert "Time: 11:00 AM" in sms
        assert "Token: 5" in sms
        assert HINDI_QUEUE_INSTRUCTION in sms

    @pytest.mark.asyncio
    async def test_send_appointment_sms_returns_formatted_text(self, monkeypatch):
        monkeypatch.setenv("RENFLAIR_API_KEY", "mock_key")
        monkeypatch.setenv("RENFLAIR_BASE_URL", "https://sms.renflair.in")

        async def mock_get(self, url, params=None, timeout=None, **kwargs):
            return httpx.Response(200, json={"status": "success", "message": "SMS sent successfully"})

        monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

        res = await send_appointment_sms(
            phone="9876543210",
            doctor_name="Rajesh Kumar",
            token_number=8,
            slot="14:00 - 14:30",
            hospital_name="Metro Hospital",
            expected_time="2:00 PM – 2:30 PM",
            live_queue_link="https://meribaari.com/appointment/token-8",
        )
        assert res["ok"] is True
        assert res["sms_text"] is not None
        assert "Metro Hospital" in res["sms_text"]
        assert "Token: 8" in res["sms_text"]
        assert "Time: 2:00 PM – 2:30 PM" in res["sms_text"]
        assert HINDI_QUEUE_INSTRUCTION in res["sms_text"]


class TestInternalQueueLogicPreservation:
    """Verifies that calculate_appointment_eta preserves internal eta_minutes and formats expected_turn_time."""

    @pytest.mark.asyncio
    async def test_eta_calculation_preserves_minutes_and_formats_12hr(self, monkeypatch):
        import server

        appt = {
            "doctor_id": "doc123",
            "date": "2026-09-11",
            "token_number": 5,
            "status": "booked",
            "slot": "14:00 - 14:30",
        }
        all_appts = [
            {"token_number": 1, "status": "completed", "doctor_id": "doc123", "date": "2026-09-11"},
            {"token_number": 2, "status": "in_consultation", "doctor_id": "doc123", "date": "2026-09-11"},
            {"token_number": 3, "status": "booked", "doctor_id": "doc123", "date": "2026-09-11"},
            {"token_number": 4, "status": "booked", "doctor_id": "doc123", "date": "2026-09-11"},
            appt,
        ]

        class MockCursor:
            def __init__(self, data):
                self._data = data
            def sort(self, *args, **kwargs):
                return self
            async def to_list(self, length):
                return self._data

        class MockAppointments:
            def find(self, *args, **kwargs):
                return MockCursor(all_appts)

        class MockDoctors:
            async def find_one(self, *args, **kwargs):
                return {"id": "doc123", "avg_consult_minutes": 15, "status": "active", "full_name": "Dr. Test"}

        class MockDB:
            appointments = MockAppointments()
            doctors = MockDoctors()

        monkeypatch.setattr(server, "db", MockDB())

        result = await calculate_appointment_eta(appt)

        # Internal queue calculations preserved
        assert "eta_minutes" in result
        assert isinstance(result["eta_minutes"], int)
        assert result["eta_minutes"] > 0
        assert result["my_position"] == 4
        assert result["currently_serving"] == 2

        # Formatted 12-hour presentation
        assert "expected_turn_time" in result
        turn_time = result["expected_turn_time"]
        assert ("AM" in turn_time or "PM" in turn_time)
        # Should NOT contain 24-hr or "min"
        assert "min" not in turn_time
        # Range should not be duplicate
        if "–" in turn_time:
            parts = turn_time.split("–")
            assert parts[0].strip() != parts[1].strip()
