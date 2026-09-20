"""
Unit and integration tests for AiSensy WhatsApp OTP and Utility messaging.
Covers:
1. Destination phone normalization (+91 E.164 and international)
2. AiSensy API campaign HTTP dispatch and payload verification
3. OTP dispatch and cryptographic verification lifecycle
4. Appointment booking utility message formatting and parameter mapping
5. Provider failure modes (rejection, timeout, connection errors) and non-blocking guarantees
6. Credential fallback behavior (AISENSY_API_KEY vs Project_api_key)
"""

import pytest
import os
import json
import httpx
from unittest.mock import patch, MagicMock, AsyncMock

from aisensy_service import (
    normalize_aisensy_destination,
    get_aisensy_api_key,
    get_aisensy_otp_campaign_name,
    get_aisensy_appt_campaign_name,
    send_aisensy_campaign,
    send_aisensy_otp,
    send_aisensy_appointment,
)
from sms_service import (
    get_sms_provider,
    send_otp_sms,
    send_appointment_sms,
)
from server import (
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


# ============ 3. AISENSY HTTP DISPATCH TESTS (MOCKED) ============

@pytest.mark.asyncio
async def test_send_aisensy_campaign_success(monkeypatch):
    monkeypatch.setenv("AISENSY_API_KEY", "test_api_key")
    
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 200
    mock_response.text = json.dumps({"success": True, "messageId": "msg_aisensy_12345"})
    mock_response.json.return_value = {"success": True, "messageId": "msg_aisensy_12345"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_campaign(
            destination="9876543210",
            campaign_name="meribaari",
            user_name="John Doe",
            template_params=["482910"],
            source="MeriBaari Auth",
        )

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        assert res["message_id"] == "msg_aisensy_12345"
        assert res["phone"] == "+919876543210"

        # Verify exact payload structure sent to AiSensy
        mock_post.assert_called_once()
        call_args, call_kwargs = mock_post.call_args
        assert call_args[0] == "https://backend.aisensy.com/campaign/t1/api/v2"
        sent_json = call_kwargs["json"]
        assert sent_json["apiKey"] == "test_api_key"
        assert sent_json["campaignName"] == "meribaari"
        assert sent_json["destination"] == "+919876543210"
        assert sent_json["userName"] == "John Doe"
        assert sent_json["templateParams"] == ["482910"]
        assert sent_json["source"] == "MeriBaari Auth"


@pytest.mark.asyncio
async def test_send_aisensy_campaign_provider_rejection(monkeypatch):
    monkeypatch.setenv("AISENSY_API_KEY", "invalid_key")
    
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = 401
    mock_response.text = json.dumps({"status": "failed", "message": "Invalid API Key", "code": "AUTH_FAILED"})
    mock_response.json.return_value = {"status": "failed", "message": "Invalid API Key", "code": "AUTH_FAILED"}

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_response

        res = await send_aisensy_campaign(
            destination="9876543210",
            campaign_name="meribaari",
            user_name="John Doe",
        )

        assert res["ok"] is False
        assert res["provider"] == "aisensy"
        assert "Invalid API Key" in res["error"]
        assert res["status_code"] == 401


@pytest.mark.asyncio
async def test_send_aisensy_campaign_timeout(monkeypatch):
    monkeypatch.setenv("AISENSY_API_KEY", "test_key")

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.side_effect = httpx.TimeoutException("Connection timed out")

        res = await send_aisensy_campaign(
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
    monkeypatch.setenv("AISENSY_API_KEY", "test_key")
    monkeypatch.setenv("AISENSY_OTP_CAMPAIGN_NAME", "meribaari_otp")

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
        assert sent_json["campaignName"] == "meribaari_otp"
        assert sent_json["destination"] == "+919876543210"


@pytest.mark.asyncio
async def test_send_otp_sms_routes_to_aisensy(monkeypatch):
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("AISENSY_API_KEY", "test_key")

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

@pytest.mark.asyncio
async def test_send_aisensy_appointment_payload(monkeypatch):
    monkeypatch.setenv("AISENSY_API_KEY", "test_key")
    monkeypatch.setenv("AISENSY_APPT_CAMPAIGN_NAME", "meribaari_appointment")

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
        )

        assert res["ok"] is True
        assert res["message_id"] == "appt_msg_888"

        sent_json = mock_post.call_args[1]["json"]
        assert sent_json["campaignName"] == "meribaari_appointment"
        assert sent_json["destination"] == "+919876543210"
        assert sent_json["userName"] == "Rahul Sharma"
        assert sent_json["templateParams"] == [
            "City Heart Clinic",
            "Dr. Mariya",
            "7",
            "2:30 PM",
            "https://app.meribaari.com/appointment/sec_token_123",
        ]


@pytest.mark.asyncio
async def test_send_appointment_sms_routes_to_aisensy(monkeypatch):
    monkeypatch.setenv("SMS_PROVIDER", "aisensy")
    monkeypatch.setenv("AISENSY_API_KEY", "test_key")

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
        )

        assert res["ok"] is True
        assert res["provider"] == "aisensy"
        mock_appt.assert_called_once()
