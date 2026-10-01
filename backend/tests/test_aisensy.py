"""
Unit and integration tests for AiSensy Project API WhatsApp OTP and Utility messaging.
Covers:
1. Destination phone normalization (+91 E.164 and international)
2. AiSensy Project API HTTP dispatch, headers, and JSON payload verification
3. Proper JSON validation and decode error handling
4. OTP dispatch with button parameters and cryptographic verification lifecycle
5. Appointment booking utility message formatting and parameter mapping
6. Provider failure modes (rejection, timeout, connection errors) and non-blocking guarantees
7. Credential fallback behavior (Project_api_key vs AISENSY_API_KEY)
"""

import pytest
import os
import json
import httpx
from unittest.mock import patch, MagicMock, AsyncMock
from fastapi.testclient import TestClient

from aisensy_service import (
    normalize_aisensy_destination,
    get_aisensy_api_key,
    get_aisensy_otp_campaign_name,
    get_aisensy_appt_campaign_name,
    send_aisensy_project_message,
    send_aisensy_otp,
    send_aisensy_appointment,
    format_appointment_date,
)
from sms_service import (
    get_sms_provider,
    send_otp_sms,
    send_appointment_sms,
)
from server import (
    app,
    hash_otp,
    save_memory_otp,
    normalize_mobile,
    _otp_store,
    OTP_EXP_SECONDS,
)


# ============ 1. PHONE NORMALIZATION TESTS ============

def test_normalize_aisensy_destination_indian_10_digits():
    assert normalize_aisensy_destination("9876543210") == "+919876543210"
    assert normalize_aisensy_destination(" 8765432109 ") == "+918765432109"
    assert normalize_aisensy_destination("7654321098") == "+917654321098"
    assert normalize_aisensy_destination("6543210987") == "+916543210987"


def test_normalize_aisensy_destination_with_prefixes():
    assert normalize_aisensy_destination("+919876543210") == "+919876543210"
    assert normalize_aisensy_destination("919876543210") == "+919876543210"
    assert normalize_aisensy_destination("09876543210") == "+919876543210"


def test_normalize_aisensy_destination_international():
    assert normalize_aisensy_destination("+14155552671") == "+14155552671"
    assert normalize_aisensy_destination("+447911123456") == "+447911123456"


def test_normalize_aisensy_destination_invalid():
    assert normalize_aisensy_destination("") is None
    assert normalize_aisensy_destination("abc") is None
    assert normalize_aisensy_destination("123") is None
    assert normalize_aisensy_destination("123456789012345678") is None


# ============ 2. CONFIGURATION & CREDENTIAL RESOLUTION TESTS ============

def test_get_aisensy_api_key_standard(monkeypatch):
    monkeypatch.setenv("AISENSY_API_KEY", "test_standard_key_123")
    monkeypatch.delenv("Project_api_key", raising=False)
    assert get_aisensy_api_key() == "test_standard_key_123"


def test_get_aisensy_api_key_fallback(monkeypatch):
    monkeypatch.delenv("AISENSY_API_KEY", raising=False)
    monkeypatch.setenv("Project_api_key", "4b68f3a8bcf9ef5c25fae")
    assert get_aisensy_api_key() == "4b68f3a8bcf9ef5c25fae"


def test_get_aisensy_campaign_names(monkeypatch):
    monkeypatch.setenv("Key_name", "meribaari")
    monkeypatch.delenv("AISENSY_OTP_CAMPAIGN_NAME", raising=False)
    assert get_aisensy_otp_campaign_name() == "meribaari"

    monkeypatch.setenv("AISENSY_APPT_CAMPAIGN_NAME", "custom_appt_campaign")
    assert get_aisensy_appt_campaign_name() == "custom_appt_campaign"


def test_get_sms_provider_auto_detect_aisensy(monkeypatch):
    monkeypatch.delenv("SMS_PROVIDER", raising=False)
    monkeypatch.setenv("Project_api_key", "4b68f3a8bcf9ef5c25fae")
    assert get_sms_provider() == "aisensy"


# ============ 3. AISENSY PROJECT API HTTP DISPATCH TESTS (MOCKED) ============

@pytest.mark.asyncio
async def test_send_aisensy_project_message_success(monkeypatch):
    monkeypatch.setenv("Project_api_key", "test_project_key_999")
    
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "msg_aisensy_12345"})
    mock_response.json.return_value = {"success": True, "messageId": "msg_aisensy_12345"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_project_message(
            destination="9876543210",
            campaign_name="meribaari",
            user_name="John Doe",
            template_params=["482910"],
            button_params=["482910"],
            source="MeriBaari Auth",
        )

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        assert res["message_id"] == "msg_aisensy_12345"
        assert res["phone"] == "+919876543210"

        # Verify exact payload and headers sent to AiSensy
        mock_post.assert_called_once()
        call_args, call_kwargs = mock_post.call_args
        assert call_args[0] == "https://backend.aisensy.com/campaign/t1/api/v2"
        sent_json = call_kwargs["json"]
        assert sent_json["apiKey"] == "test_project_key_999"
        assert sent_json["campaignName"] == "meribaari"
        assert sent_json["destination"] == "+919876543210"
        assert sent_json["userName"] == "John Doe"
        assert sent_json["templateParams"] == ["482910"]
        assert sent_json["buttons"][0]["parameters"][0]["text"] == "482910"
        assert sent_json["source"] == "MeriBaari Auth"

        sent_headers = call_kwargs["headers"]
        assert sent_headers["Content-Type"] == "application/json"
        assert "Bearer test_project_key_999" in sent_headers["Authorization"]


@pytest.mark.asyncio
async def test_send_aisensy_project_message_rejection(monkeypatch):
    monkeypatch.setenv("Project_api_key", "invalid_key")
    
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 401
    mock_response.text = json.dumps({"status": "failed", "message": "Unauthorized", "code": "AUTH_FAILED"})
    mock_response.json.return_value = {"status": "failed", "message": "Unauthorized", "code": "AUTH_FAILED"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_project_message(
            destination="9876543210",
            campaign_name="meribaari",
            user_name="John Doe",
        )

        assert res["ok"] is False
        assert res["provider"] == "aisensy"
        assert "Unauthorized" in res["error"]
        assert res["status_code"] == 401


@pytest.mark.asyncio
async def test_send_aisensy_project_message_timeout(monkeypatch):
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.TimeoutException("Connection timed out")

        res = await send_aisensy_project_message(
            destination="9876543210",
            campaign_name="meribaari",
            user_name="John Doe",
        )

        assert res["ok"] is False
        assert res["error_code"] == "TIMEOUT"
        assert "timed out" in res["error"]


# ============ 4. OTP DISPATCH & VERIFICATION TESTS ============

@pytest.mark.asyncio
async def test_send_aisensy_otp_payload(monkeypatch):
    monkeypatch.setenv("Project_api_key", "test_key")
    monkeypatch.setenv("AISENSY_OTP_CAMPAIGN_NAME", "meribaari")
    monkeypatch.setenv("Key_name", "meribaari")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "otp_msg_999"})
    mock_response.json.return_value = {"success": True, "messageId": "otp_msg_999"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_otp("9876543210", "654321", "Alice")

        assert res["ok"] is True
        assert res["message_id"] == "otp_msg_999"

        sent_json = mock_post.call_args[1]["json"]
        assert sent_json["templateParams"] == ["654321"]
        assert sent_json["buttons"][0]["parameters"][0]["text"] == "654321"
        assert sent_json["campaignName"] == "meribaari"
        assert sent_json["destination"] == "+919876543210"


@pytest.mark.asyncio
async def test_send_otp_sms_routes_to_aisensy(monkeypatch):
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("sms_service.send_aisensy_otp", new_callable=AsyncMock) as mock_otp:
        mock_otp.return_value = {
            "ok": True,
            "provider": "aisensy",
            "message_id": "test_msg_id",
        }

        res = await send_otp_sms("9876543210", "123456")

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        mock_otp.assert_called_once()


def test_in_memory_otp_hash_and_single_use():
    mobile = "9876543210"
    norm_mobile = normalize_mobile(mobile)
    otp = "543210"
    
    # Save OTP hash in memory
    save_memory_otp(mobile, otp, expires_in_sec=300)
    assert norm_mobile in _otp_store
    rec = _otp_store[norm_mobile]

    # Verify hash is present and not plaintext
    assert "otp_hash" in rec
    assert rec["otp_hash"] == hash_otp(otp, norm_mobile)
    assert rec.get("otp") is None  # Never store plaintext OTP

    # Invalidate on resend
    save_memory_otp(mobile, "999888", expires_in_sec=300)
    assert _otp_store[norm_mobile]["otp_hash"] == hash_otp("999888", norm_mobile)


# ============ 5. APPOINTMENT UTILITY MESSAGING TESTS ============

def test_format_appointment_date_valid_and_invalid():
    """Verify DD/MM/YYYY formatting, future dates preservation, and non-substitution of today."""
    # YYYY-MM-DD
    assert format_appointment_date("2026-10-15") == "15/10/2026"
    assert format_appointment_date("2026-05-03") == "03/05/2026"
    # Future dates must remain their booked date without shifting
    assert format_appointment_date("2027-12-31") == "31/12/2027"
    # ISO strings - extracts date part directly without timezone shifting
    assert format_appointment_date("2026-10-15T00:00:00Z") == "15/10/2026"
    assert format_appointment_date("2026-10-15T23:59:59+05:30") == "15/10/2026"
    # Already DD/MM/YYYY
    assert format_appointment_date("15/10/2026") == "15/10/2026"
    assert format_appointment_date("5/3/2026") == "05/03/2026"
    # DD-MM-YYYY
    assert format_appointment_date("15-10-2026") == "15/10/2026"
    # YYYY/MM/DD
    assert format_appointment_date("2026/10/15") == "15/10/2026"

    # Missing or invalid - must NEVER substitute today's date
    assert format_appointment_date(None) is None
    assert format_appointment_date("") is None
    assert format_appointment_date("   ") is None
    assert format_appointment_date("null") is None
    assert format_appointment_date("undefined") is None
    assert format_appointment_date("today") is None
    assert format_appointment_date("tomorrow") is None
    assert format_appointment_date("2026-13-45") is None


def test_aisensy_campaign_name_config(monkeypatch):
    """Verify campaign name prioritizes AISENSY_APPT_CAMPAIGN_NAME and defaults to Meribaari_appointment_api."""
    monkeypatch.delenv("AISENSY_APPT_CAMPAIGN_NAME", raising=False)
    monkeypatch.delenv("AISENSY_UTILITY_CAMPAIGN_NAME", raising=False)
    monkeypatch.delenv("Key_name", raising=False)
    monkeypatch.delenv("KEY_NAME", raising=False)
    monkeypatch.delenv("AISENSY_CAMPAIGN_NAME", raising=False)
    assert get_aisensy_appt_campaign_name() == "Meribaari_appointment_api"

    monkeypatch.setenv("AISENSY_APPT_CAMPAIGN_NAME", "Meribaari_appointment_api")
    assert get_aisensy_appt_campaign_name() == "Meribaari_appointment_api"


@pytest.mark.asyncio
async def test_send_aisensy_appointment_payload_6_params(monkeypatch):
    """Verify outgoing appointment payload has exactly 6 string parameters in required order."""
    monkeypatch.setenv("Project_api_key", "test_key")
    monkeypatch.setenv("AISENSY_APPT_CAMPAIGN_NAME", "Meribaari_appointment_api")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "appt_msg_888"})
    mock_response.json.return_value = {"success": True, "messageId": "appt_msg_888"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number=7,
            expected_time="2:30 PM",
            live_queue_link="https://app.meribaari.com/appointment/sec_token_123",
            patient_name="Rahul Sharma",
            appointment_date="2026-10-15",
        )

        assert res["ok"] is True
        assert res["message_id"] == "appt_msg_888"

        sent_json = mock_post.call_args[1]["json"]
        assert sent_json["campaignName"] == "Meribaari_appointment_api"
        assert sent_json["destination"] == "+919876543210"
        assert sent_json["userName"] == "Rahul Sharma"

        params = sent_json["templateParams"]
        # Must have exactly 6 parameters
        assert len(params) == 6
        # All 6 must be strings
        assert all(isinstance(p, str) for p in params)
        # Required order:
        # 1. Hospital name
        # 2. Patient-specific live queue URL
        # 3. Doctor name
        # 4. Actual appointment date (DD/MM/YYYY)
        # 5. Token number
        # 6. Expected time / estimated time range
        assert params == [
            "City Heart Clinic",
            "https://app.meribaari.com/appointment/sec_token_123",
            "Dr. Mariya",
            "15/10/2026",
            "7",
            "2:30 PM",
        ]


@pytest.mark.asyncio
async def test_send_aisensy_appointment_future_date_not_today(monkeypatch):
    """Verify a future appointment strictly uses its booked date, never today's date."""
    monkeypatch.setenv("Project_api_key", "test_key")

    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "appt_future_1"})
    mock_response.json.return_value = {"success": True, "messageId": "appt_future_1"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number=14,
            expected_time="10:00 AM",
            live_queue_link="https://app.meribaari.com/appointment/sec_future",
            patient_name="Future Patient",
            appointment_date="2027-01-25",
        )

        assert res["ok"] is True
        sent_json = mock_post.call_args[1]["json"]
        # Date param (index 3) must be the booked future date
        assert sent_json["templateParams"][3] == "25/01/2027"


@pytest.mark.asyncio
async def test_send_aisensy_appointment_validation_missing_date(monkeypatch):
    """Verify missing appointment date returns clear error without HTTP dispatch."""
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number=7,
            expected_time="2:30 PM",
            live_queue_link="https://app.meribaari.com/appointment/sec_token_123",
            patient_name="Rahul Sharma",
            appointment_date=None,
        )

        assert res["ok"] is False
        assert res["error_code"] == "MISSING_APPOINTMENT_DATE"
        mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_send_aisensy_appointment_validation_missing_link(monkeypatch):
    """Verify missing live queue link returns clear error without HTTP dispatch."""
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number=7,
            expected_time="2:30 PM",
            live_queue_link="",
            appointment_date="2026-10-15",
        )

        assert res["ok"] is False
        assert res["error_code"] == "MISSING_QUEUE_LINK"
        mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_send_aisensy_appointment_validation_missing_token(monkeypatch):
    """Verify missing token number returns clear error without HTTP dispatch."""
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number="",
            expected_time="2:30 PM",
            live_queue_link="https://app.meribaari.com/appointment/sec_123",
            appointment_date="2026-10-15",
        )

        assert res["ok"] is False
        assert res["error_code"] == "MISSING_TOKEN_NUMBER"
        mock_post.assert_not_called()


@pytest.mark.asyncio
async def test_send_appointment_sms_routes_to_aisensy(monkeypatch):
    """Verify send_appointment_sms forwards appointment_date to send_aisensy_appointment."""
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("Project_api_key", "test_key")

    with patch("sms_service.send_aisensy_appointment", new_callable=AsyncMock) as mock_appt:
        mock_appt.return_value = {
            "ok": True,
            "provider": "aisensy",
            "message_id": "appt_msg_999",
        }

        res = await send_appointment_sms(
            phone="9876543210",
            token_number=5,
            hospital_name="Apex Care",
            doctor_name="Dr. Sharma",
            expected_time="11:00 AM",
            live_queue_link="https://app.meribaari.com/appointment/xyz",
            appointment_date="2026-10-20",
        )

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        mock_appt.assert_called_once()
        call_kwargs = mock_appt.call_args[1]
        assert call_kwargs["appointment_date"] == "2026-10-20"


@pytest.mark.asyncio
async def test_notification_failure_does_not_crash_or_rollback():
    """Verify that an HTTP 400 or provider rejection returns a clean error dict without throwing."""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 400
    mock_response.text = json.dumps({"message": "Template params does not match the campaign", "code": "INVALID_PARAMS"})
    mock_response.json.return_value = {"message": "Template params does not match the campaign", "code": "INVALID_PARAMS"}

    with patch("aisensy_service.get_aisensy_api_key", return_value="dummy_key"), \
         patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_appointment(
            phone="9876543210",
            hospital_name="City Heart Clinic",
            doctor_name="Dr. Mariya",
            token_number=7,
            expected_time="2:30 PM",
            live_queue_link="https://app.meribaari.com/appointment/sec_token_123",
            patient_name="Rahul Sharma",
            appointment_date="2026-10-15",
        )

        # Provider failed with 400, but function handles gracefully without raising
        assert res["ok"] is False
        assert res["status_code"] == 400
        assert "Template params does not match the campaign" in res["error"]



# ============ 6. FASTAPI JSON VALIDATION ERROR HANDLER TEST ============

def test_fastapi_json_validation_error_handling():
    client = TestClient(app, raise_server_exceptions=False)
    # Send malformed JSON payload
    response = client.post(
        "/api/auth/send-otp",
        content="invalid json payload { missing",
        headers={"Content-Type": "application/json"}
    )
    assert response.status_code == 400
    assert response.json()["ok"] is False
    assert "Invalid or empty JSON body" in response.json()["detail"]
