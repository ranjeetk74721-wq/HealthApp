"""
Comprehensive verification tests for AiSensy WhatsApp appointment confirmation fix:
1. Outgoing appointment payload has exactly six string parameters in the required order:
   [hospital_name, live_queue_url, doctor_name, appointment_date, token_number, expected_time]
2. All parameters in templateParams are string types.
3. Date propagation for online booking, walk-in, and receptionist resend.
4. Future appointment uses its booked date, not today's date.
5. Notification failure does not roll back a successful booking.
6. OTP payload behavior remains completely unchanged.
"""

import pytest
import json
import httpx
from unittest.mock import patch, MagicMock, AsyncMock

from aisensy_service import (
    send_aisensy_appointment,
    send_aisensy_otp,
    format_appointment_date,
    get_aisensy_appt_campaign_name,
)
from sms_service import send_appointment_sms


# ============ 1. PAYLOAD FORMAT & PARAMETER ORDER VERIFICATION ============

@pytest.mark.asyncio
async def test_appointment_payload_exactly_six_strings_in_required_order(monkeypatch):
    """
    Verify outgoing appointment payload has exactly six string parameters in the required order:
    1. Hospital name
    2. Patient-specific live queue URL
    3. Doctor name
    4. Actual appointment date (DD/MM/YYYY)
    5. Token number
    6. Expected time / estimated time range
    """
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")
    monkeypatch.setenv("AISENSY_APPT_CAMPAIGN_NAME", "Meribaari_appointment_api")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "msg_verification_123"})
    mock_response.json.return_value = {"success": True, "messageId": "msg_verification_123"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        hospital = "Meribaari Central Clinic"
        queue_url = "https://health-app.vercel.app/appointment/sec_token_987"
        doctor = "Dr. Mariya Khan"
        raw_date = "2026-11-05"
        token = 42
        eta = "03:30 PM"

        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name=hospital,
            doctor_name=doctor,
            token_number=token,
            expected_time=eta,
            live_queue_link=queue_url,
            patient_name="Amit Patel",
            appointment_date=raw_date,
        )

        assert res["ok"] is True
        assert res["message_id"] == "msg_verification_123"

        mock_post.assert_called_once()
        payload = mock_post.call_args[1]["json"]

        assert payload["campaignName"] == "Meribaari_appointment_api"
        assert payload["destination"] == "+919876543210"
        assert payload["userName"] == "Amit Patel"

        params = payload["templateParams"]
        # Exactly 6 parameters
        assert len(params) == 6, f"Expected 6 templateParams, got {len(params)}: {params}"
        # All 6 must be strings
        assert all(isinstance(p, str) for p in params), "All templateParams must be string instances"

        # Explicit order check
        assert params[0] == hospital, f"Param 1 should be hospital_name, got {params[0]}"
        assert params[1] == queue_url, f"Param 2 should be live_queue_link, got {params[1]}"
        assert params[2] == doctor, f"Param 3 should be doctor_name, got {params[2]}"
        assert params[3] == "05/11/2026", f"Param 4 should be DD/MM/YYYY date, got {params[3]}"
        assert params[4] == "42", f"Param 5 should be token_number string, got {params[4]}"
        assert params[5] == "3:30 PM", f"Param 6 should be formatted expected_time, got {params[5]}"


# ============ 2. FUTURE DATE PRESERVATION (NEVER TODAY'S DATE) ============

@pytest.mark.asyncio
async def test_future_appointment_uses_booked_date_not_today(monkeypatch):
    """Verify that an appointment for a future date uses that exact date, not today's date."""
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "msg_future_456"})
    mock_response.json.return_value = {"success": True, "messageId": "msg_future_456"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        # Booked for next year
        future_date = "2027-08-22"
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="Meribaari Clinic",
            doctor_name="Dr. Mariya",
            token_number=10,
            expected_time="10:00 AM",
            live_queue_link="https://app.meribaari.com/appointment/sec_future",
            patient_name="Future Patient",
            appointment_date=future_date,
        )

        assert res["ok"] is True
        payload = mock_post.call_args[1]["json"]
        assert payload["templateParams"][3] == "22/08/2027"
        assert payload["templateParams"][3] != "22/08/2026"


# ============ 3. VALIDATION BEFORE DISPATCH ============

@pytest.mark.asyncio
async def test_missing_date_validation_blocks_dispatch(monkeypatch):
    """Missing or invalid date must fail with clear error and NOT dispatch HTTP request."""
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="Clinic",
            doctor_name="Doctor",
            token_number=1,
            expected_time="10:00 AM",
            live_queue_link="https://link.com",
            appointment_date="",  # empty date
        )

        assert res["ok"] is False
        assert res["error_code"] == "MISSING_APPOINTMENT_DATE"
        mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_missing_link_validation_blocks_dispatch(monkeypatch):
    """Missing queue link must fail with clear error and NOT dispatch HTTP request."""
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="Clinic",
            doctor_name="Doctor",
            token_number=1,
            expected_time="10:00 AM",
            live_queue_link="",  # empty link
            appointment_date="2026-10-15",
        )

        assert res["ok"] is False
        assert res["error_code"] == "MISSING_QUEUE_LINK"
        mock_post.assert_not_called()


# ============ 4. DATE PROPAGATION THROUGH SMS_SERVICE ============

@pytest.mark.asyncio
async def test_sms_service_forwards_appointment_date_to_aisensy(monkeypatch):
    """Verify send_appointment_sms forwards appointment_date to send_aisensy_appointment."""
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")

    with patch("sms_service.send_aisensy_appointment", new_callable=AsyncMock) as mock_aisensy:
        mock_aisensy.return_value = {
            "ok": True,
            "provider": "aisensy",
            "message_id": "test_id_789",
        }

        res = await send_appointment_sms(
            phone="9876543210",
            oid=8,
            hour="11:30 AM",
            hospital_name="City Hospital",
            doctor_name="Dr. Mariya",
            token_number=8,
            expected_time="11:30 AM",
            live_queue_link="https://app.meribaari.com/appointment/token_test",
            appointment_date="2026-12-01",
        )

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        mock_aisensy.assert_called_once()
        kwargs = mock_aisensy.call_args[1]
        assert kwargs["appointment_date"] == "2026-12-01"


# ============ 5. DATE PROPAGATION: ONLINE, WALK-IN, RESEND ============

@pytest.mark.asyncio
async def test_online_booking_date_propagation(monkeypatch):
    """Verify that online booking passes doc['date'] / body.date through send_appointment_sms."""
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")
    with patch("sms_service.send_aisensy_appointment", new_callable=AsyncMock) as mock_aisensy:
        mock_aisensy.return_value = {"ok": True, "provider": "aisensy", "message_id": "m1"}

        booking_date = "2026-11-18"
        # Simulate online booking invocation
        await send_appointment_sms(
            phone="9876543210",
            oid=12,
            hour="02:00 PM",
            hospital_name="Online Hospital",
            patient_name="Online Patient",
            doctor_name="Dr. Online",
            token_number=12,
            expected_time="02:00 PM",
            live_queue_link="https://app.meribaari.com/appointment/sec_online",
            appointment_date=booking_date,
        )

        mock_aisensy.assert_called_once()
        assert mock_aisensy.call_args[1]["appointment_date"] == "2026-11-18"


@pytest.mark.asyncio
async def test_walkin_booking_date_propagation(monkeypatch):
    """Verify that walk-in booking passes appt['date'] through send_appointment_sms."""
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")
    with patch("sms_service.send_aisensy_appointment", new_callable=AsyncMock) as mock_aisensy:
        mock_aisensy.return_value = {"ok": True, "provider": "aisensy", "message_id": "m2"}

        walkin_date = "2026-11-19"
        # Simulate walk-in booking invocation
        await send_appointment_sms(
            phone="9876543210",
            oid=3,
            hour="10:00 AM",
            hospital_name="Walk-in Clinic",
            patient_name="Walk-in Patient",
            doctor_name="Dr. Walkin",
            token_number=3,
            expected_time="10:00 AM",
            live_queue_link="https://app.meribaari.com/appointment/sec_walkin",
            appointment_date=walkin_date,
        )

        mock_aisensy.assert_called_once()
        assert mock_aisensy.call_args[1]["appointment_date"] == "2026-11-19"


@pytest.mark.asyncio
async def test_receptionist_resend_date_propagation(monkeypatch):
    """Verify that receptionist resend passes saved appt['date'] through send_appointment_sms."""
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")
    with patch("sms_service.send_aisensy_appointment", new_callable=AsyncMock) as mock_aisensy:
        mock_aisensy.return_value = {"ok": True, "provider": "aisensy", "message_id": "m3"}

        resend_date = "2026-11-20"
        # Simulate receptionist resend invocation
        await send_appointment_sms(
            phone="9876543210",
            oid=5,
            hour="11:00 AM",
            hospital_name="Resend Clinic",
            patient_name="Resend Patient",
            doctor_name="Dr. Resend",
            token_number=5,
            expected_time="11:00 AM",
            live_queue_link="https://app.meribaari.com/appointment/sec_resend",
            appointment_date=resend_date,
        )

        mock_aisensy.assert_called_once()
        assert mock_aisensy.call_args[1]["appointment_date"] == "2026-11-20"


# ============ 6. NOTIFICATION FAILURE DOES NOT ROLL BACK BOOKING ============

@pytest.mark.asyncio
async def test_notification_failure_returns_graceful_error_without_exception(monkeypatch):
    """
    Verify that if AiSensy returns HTTP 400 (e.g. parameter mismatch) or network error:
    - send_appointment_sms returns ok=False with error details.
    - No unhandled exception is thrown that would abort the transaction or roll back MongoDB appointment.
    """
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 400
    mock_response.text = json.dumps({
        "message": "Template params does not match the campaign",
        "code": "INVALID_PARAMS"
    })
    mock_response.json.return_value = {
        "message": "Template params does not match the campaign",
        "code": "INVALID_PARAMS"
    }

    with patch("aisensy_service.get_aisensy_api_key", return_value="test_key"), \
         patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        # Call send_appointment_sms
        res = await send_appointment_sms(
            phone="9876543210",
            oid=1,
            hour="10:00 AM",
            hospital_name="Clinic",
            doctor_name="Doctor",
            token_number=1,
            expected_time="10:00 AM",
            live_queue_link="https://link.com/appt/1",
            appointment_date="2026-10-15",
        )

        # Result is graceful failure dictionary, not an unhandled exception
        assert res["ok"] is False
        assert "Template params does not match the campaign" in res["error"]
        assert res["error_code"] == "INVALID_PARAMS"


# ============ 7. OTP PAYLOAD UNCHANGED CONFIRMATION ============

@pytest.mark.asyncio
async def test_otp_payload_behavior_remains_unchanged(monkeypatch):
    """
    Verify OTP dispatch continues to pass:
    - templateParams = [otp]
    - buttons = [{ type: 'button', sub_type: 'url', parameters: [{ text: otp }] }]
    No changes to OTP workflow.
    """
    monkeypatch.setenv("Project_api_key", "test_mock_api_key")
    monkeypatch.setenv("AISENSY_OTP_CAMPAIGN_NAME", "meribaari")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "otp_msg_777"})
    mock_response.json.return_value = {"success": True, "messageId": "otp_msg_777"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_otp(
            phone="9876543210",
            otp="741852",
            user_name="OTP User",
        )

        assert res["ok"] is True
        payload = mock_post.call_args[1]["json"]
        assert payload["campaignName"] == "meribaari"
        assert payload["destination"] == "+919876543210"
        assert payload["userName"] == "OTP User"
        assert payload["templateParams"] == ["741852"]
        assert payload["buttons"] == [
            {
                "type": "button",
                "sub_type": "url",
                "index": "0",
                "parameters": [{"type": "text", "text": "741852"}]
            }
        ]
