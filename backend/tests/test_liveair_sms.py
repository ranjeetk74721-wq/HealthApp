"""
Unit tests for LiveAir HTTP SMS API integration, provider routing, error mapping,
custom appointment SMS format, security, and dev test endpoints.
"""

import os
import sys
from pathlib import Path
import pytest
from unittest.mock import patch, AsyncMock, MagicMock
import httpx

# Ensure backend directory is in sys.path
_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from liveair_sms_service import (
    normalize_liveair_number,
    mask_phone_for_logging,
    parse_liveair_response,
    send_liveair_sms,
    get_liveair_delivery_status,
    LIVEAIR_ERROR_CODES,
)
from sms_service import (
    get_sms_provider,
    format_custom_appointment_sms,
    send_appointment_sms,
    send_otp_sms,
)
from server import app, create_token


# ==========================================
# 1. PHONE NORMALIZATION & MASKING TESTS
# ==========================================

def test_normalize_liveair_number():
    """Verify phone normalization for 10-digit Indian numbers."""
    assert normalize_liveair_number("9876543210") == "9876543210"
    assert normalize_liveair_number("+919876543210") == "9876543210"
    assert normalize_liveair_number("919876543210") == "9876543210"
    assert normalize_liveair_number("09876543210") == "9876543210"
    assert normalize_liveair_number("98765-43210") == "9876543210"
    assert normalize_liveair_number("+91 98765 43210") == "9876543210"
    # Invalid numbers
    assert normalize_liveair_number("1234567890") is None  # Doesn't start with 6-9
    assert normalize_liveair_number("98765") is None  # Too short
    assert normalize_liveair_number("") is None


def test_mask_phone_for_logging():
    """Verify recipient numbers are safely masked in logs."""
    assert mask_phone_for_logging("9876543210") == "98765*****"
    assert mask_phone_for_logging("+919876543210") == "91987*****"
    assert mask_phone_for_logging("123") == "*****"
    assert mask_phone_for_logging("") == "unknown"


# ==========================================
# 2. RESPONSE PARSING & ERROR CODE MAPPING
# ==========================================

def test_parse_liveair_response_success_numeric():
    """Verify numeric message ID response is parsed as success."""
    res = parse_liveair_response(200, "1709823412345")
    assert res["success"] is True
    assert res["provider"] == "liveair"
    assert res["message_id"] == "1709823412345"
    assert res["error"] is None


def test_parse_liveair_response_success_json():
    """Verify JSON success response is parsed correctly."""
    res = parse_liveair_response(200, '{"status": "success", "msgid": "MSG-9988"}')
    assert res["success"] is True
    assert res["message_id"] == "MSG-9988"
    assert res["error"] is None


@pytest.mark.parametrize("code,expected_error", [
    ("101", "Invalid user / API token"),
    ("102", "Invalid sender ID"),
    ("103", "Invalid contact(s) / recipient number"),
    ("104", "Invalid SMS route"),
    ("105", "Invalid message type"),
    ("106", "Message content does not exist / empty message"),
    ("109", "No SMSC connection available"),
    ("110", "Promotional route timing restriction (9 AM - 9 PM)"),
    ("111", "Provider connection error"),
    ("112", "All numbers are DND / blocked"),
    ("113", "Invalid DLT template ID"),
])
def test_parse_liveair_response_error_codes(code, expected_error):
    """Verify documented provider error codes (101-113) map to clear internal errors."""
    res = parse_liveair_response(200, code)
    assert res["success"] is False
    assert res["code"] == code
    assert expected_error in res["error"]


def test_parse_liveair_response_json_error():
    """Verify JSON error response parsing."""
    res = parse_liveair_response(400, '{"status": "error", "code": "113", "message": "Template mismatch"}')
    assert res["success"] is False
    assert res["code"] == "113"
    assert "Template mismatch" in res["error"]


# ==========================================
# 3. LIVEAIR HTTP DISPATCH & SECURITY TESTS
# ==========================================

@pytest.mark.asyncio
async def test_send_liveair_sms_missing_token(monkeypatch):
    """Verify dispatch is blocked cleanly if LIVEAIR_API_TOKEN is missing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "")
    res = await send_liveair_sms("9876543210", "Test message")
    assert res["success"] is False
    assert res["code"] == "MISSING_TOKEN"


@pytest.mark.asyncio
async def test_send_liveair_sms_invalid_phone(monkeypatch):
    """Verify invalid phone format is rejected before network dispatch."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "valid-test-token")
    res = await send_liveair_sms("12345", "Test message")
    assert res["success"] is False
    assert res["code"] == "INVALID_PHONE"


@pytest.mark.asyncio
async def test_send_liveair_sms_dispatches_correct_parameters(monkeypatch):
    """Verify LiveAir HTTP request includes token, sender, number, route, type, sms, templateid."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "secret-test-token-xyz")
    monkeypatch.setenv("LIVEAIR_SENDER_ID", "MRBARI")
    monkeypatch.setenv("LIVEAIR_ROUTE", "2")
    monkeypatch.setenv("LIVEAIR_MESSAGE_TYPE", "1")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1007123456789012")
    monkeypatch.setenv("LIVEAIR_BASE_URL", "https://mock.liveair.co.in")

    captured_url = None
    captured_data = None

    async def mock_post(url, data=None, **kwargs):
        nonlocal captured_url, captured_data
        captured_url = url
        captured_data = data
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "MSG-554433"
        return mock_resp

    with patch("httpx.AsyncClient.post", side_effect=mock_post):
        res = await send_liveair_sms(
            phone="+919876543210",
            message="Your appointment token is 5",
            purpose="appointment_test",
        )

    assert res["success"] is True
    assert res["message_id"] == "MSG-554433"
    assert captured_url == "https://mock.liveair.co.in/sendsms"
    assert captured_data["token"] == "secret-test-token-xyz"
    assert captured_data["sender"] == "MRBARI"
    assert captured_data["number"] == "9876543210"
    assert captured_data["route"] == "2"
    assert captured_data["type"] == "1"
    assert captured_data["sms"] == "Your appointment token is 5"
    assert captured_data["templateid"] == "1007123456789012"


@pytest.mark.asyncio
async def test_send_liveair_sms_timeout(monkeypatch):
    """Verify timeout is safely captured and normalized."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "token")
    with patch("httpx.AsyncClient.post", side_effect=httpx.TimeoutException("Timeout")):
        res = await send_liveair_sms("9876543210", "Hello")
    assert res["success"] is False
    assert res["code"] == "TIMEOUT"


# ==========================================
# 4. DELIVERY STATUS REPORT TESTS
# ==========================================

@pytest.mark.asyncio
async def test_get_liveair_delivery_status_delivered(monkeypatch):
    """Verify delivery report status parsing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "test-token")
    monkeypatch.setenv("LIVEAIR_BASE_URL", "https://mock.liveair.co.in")

    async def mock_get(url, params=None, **kwargs):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "DELIVERED"
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        report = await get_liveair_delivery_status("MSG-554433")

    assert report["success"] is True
    assert report["status"] == "DELIVERED"
    assert report["message_id"] == "MSG-554433"


@pytest.mark.asyncio
async def test_get_liveair_delivery_status_pending(monkeypatch):
    """Verify pending status parsing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "test-token")

    async def mock_get(url, params=None, **kwargs):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "QUEUE_PENDING"
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        report = await get_liveair_delivery_status("MSG-1122")

    assert report["status"] == "PENDING"


# ==========================================
# 5. PROVIDER SWITCH & CUSTOM APPOINTMENT SMS
# ==========================================

def test_get_sms_provider_switching(monkeypatch):
    """Verify SMS_PROVIDER environment switch."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "mock-liveair-token")
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    assert get_sms_provider() == "liveair"

    monkeypatch.setenv("SMS_PROVIDER", "brevo")
    assert get_sms_provider() == "brevo"

    monkeypatch.setenv("SMS_PROVIDER", "renflair")
    assert get_sms_provider() == "renflair"

    monkeypatch.delenv("SMS_PROVIDER", raising=False)
    assert get_sms_provider() == "renflair"



def test_format_custom_appointment_sms():
    """Verify custom appointment SMS structure matches Requirement 5:
    {HOSPITAL_NAME}

    Aapka appointment confirm ho gaya hai.

    Token: {TOKEN_NUMBER}
    Estimated Time: {ESTIMATED_TIME}

    Aapka number kab aayega dekhne ke liye:
    {DYNAMIC_LINK}
    """
    msg = format_custom_appointment_sms(
        hospital_name="City Hospital",
        token_number=7,
        estimated_time="11:30 AM",
        dynamic_link="https://app.meribaari.com/appointment/sec-token-123",
    )
    assert "City Hospital" in msg
    assert "Aapka appointment confirm ho gaya hai." in msg
    assert "Token: 7" in msg
    assert "Estimated Time: 11:30 AM" in msg
    assert "Aapka number kab aayega dekhne ke liye:" in msg
    assert "https://app.meribaari.com/appointment/sec-token-123" in msg


@pytest.mark.asyncio
async def test_send_appointment_sms_routes_to_liveair(monkeypatch):
    """Verify appointment SMS uses LiveAir when SMS_PROVIDER=liveair."""
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "liveair-token")

    mock_send = AsyncMock(return_value={
        "success": True,
        "provider": "liveair",
        "message_id": "LA-991122",
        "error": None,
        "code": None,
    })

    with patch("sms_service.send_liveair_sms", mock_send):
        res = await send_appointment_sms(
            phone="9876543210",
            oid=14,
            hour="3:00 PM",
            hospital_name="Apex Clinic",
            doctor_name="Dr. Sharma",
            token_number=14,
            expected_time="3:00 PM",
            live_queue_link="http://localhost:8081/appointment/token-apex",
        )

    assert res["ok"] is True
    assert res["provider"] == "liveair"
    assert res["message_id"] == "LA-991122"
    assert "Token: 14" in res["sms_text"]
    assert "Apex Clinic" in res["sms_text"]
    assert "http://localhost:8081/appointment/token-apex" in res["sms_text"]


@pytest.mark.asyncio
async def test_send_appointment_sms_routes_to_brevo(monkeypatch):
    """Verify appointment SMS uses Brevo when SMS_PROVIDER=brevo."""
    monkeypatch.setenv("SMS_PROVIDER", "brevo")
    monkeypatch.setenv("BREVO_API_KEY", "brevo-key")

    mock_brevo = AsyncMock(return_value={
        "ok": True,
        "provider": "brevo",
        "message_id": "BREVO-1002",
    })

    with patch("sms_service.send_sms_via_brevo", mock_brevo):
        res = await send_appointment_sms(
            phone="9876543210",
            oid=3,
            hour="10:00 AM",
            hospital_name="Metro Clinic",
            doctor_name="Dr. Ali",
            token_number=3,
            expected_time="10:00 AM",
            live_queue_link="http://localhost:8081/appointment/token-metro",
        )

    assert res["ok"] is True
    assert res["provider"] == "brevo"
    assert res["message_id"] == "BREVO-1002"


@pytest.mark.asyncio
async def test_otp_remains_on_existing_provider(monkeypatch):
    """Verify OTP does NOT switch to LiveAir unless LIVEAIR_OTP_ENABLED=1 (Requirement 14)."""
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.delenv("LIVEAIR_OTP_ENABLED", raising=False)
    monkeypatch.setenv("RENFLAIR_API_KEY", "renflair-key")

    mock_renflair = MagicMock()
    mock_renflair.status_code = 200
    mock_renflair.headers = {"content-type": "application/json"}
    mock_renflair.json.return_value = {"status": "success"}

    with patch("httpx.AsyncClient.get", AsyncMock(return_value=mock_renflair)):
        res = await send_otp_sms("9876543210", "123456")

    assert res["ok"] is True
    assert res["provider"] == "renflair"  # Verified preserved


# ==========================================
# 6. DEV TEST ENDPOINTS & ACCESS CONTROL
# ==========================================

from starlette.testclient import TestClient
from server import get_current_user

def test_dev_test_sms_disabled_by_default(monkeypatch):
    """Verify /api/dev/test-sms is blocked when DEV_TEST_SMS_ENABLED=0."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "0")
    monkeypatch.setenv("ENVIRONMENT", "production")
    app.dependency_overrides[get_current_user] = lambda: {"id": "adm1", "role": "admin"}
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/dev/test-sms",
            json={"phone": "9876543210"},
        )
        assert resp.status_code == 403
        assert "disabled" in resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_dev_test_sms_requires_auth(monkeypatch):
    """Verify /api/dev/test-sms rejects unauthenticated calls."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "1")
    app.dependency_overrides.clear()
    client = TestClient(app)

    resp = client.post("/api/dev/test-sms", json={"phone": "9876543210"})
    assert resp.status_code in (401, 403)


def test_dev_test_sms_patient_role_forbidden(monkeypatch):
    """Verify /api/dev/test-sms rejects regular patient role."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "1")
    app.dependency_overrides[get_current_user] = lambda: {"id": "pat1", "role": "patient"}
    try:
        client = TestClient(app)
        resp = client.post(
            "/api/dev/test-sms",
            json={"phone": "9876543210"},
        )
        assert resp.status_code == 403
        assert "Admin or developer privileges required" in resp.json()["detail"]
    finally:
        app.dependency_overrides.clear()


def test_dev_test_sms_admin_success(monkeypatch):
    """Verify /api/dev/test-sms sends fixed server-controlled message via configured provider."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "1")
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "liveair-token")

    mock_send = AsyncMock(return_value={
        "success": True,
        "provider": "liveair",
        "message_id": "LA-DEV-123",
        "error": None,
        "code": None,
    })

    app.dependency_overrides[get_current_user] = lambda: {"id": "adm1", "role": "admin"}
    try:
        client = TestClient(app)
        with patch("liveair_sms_service.send_liveair_sms", mock_send):
            resp = client.post(
                "/api/dev/test-sms",
                json={"phone": "9876543210"},
            )

        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert data["provider"] == "liveair"
        assert data["message_id"] == "LA-DEV-123"
        assert data["status"] == "sent"
        # Verify API token is NEVER leaked
        assert "token" not in str(data)
        assert "liveair-token" not in str(data)
    finally:
        app.dependency_overrides.clear()


def test_dev_delivery_report_endpoint(monkeypatch):
    """Verify /api/dev/sms-delivery/{message_id} returns sanitized delivery status."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "1")
    app.dependency_overrides[get_current_user] = lambda: {"id": "adm1", "role": "admin"}

    mock_status = AsyncMock(return_value={
        "success": True,
        "provider": "liveair",
        "message_id": "LA-DEV-123",
        "status": "DELIVERED",
        "error": None,
    })

    try:
        client = TestClient(app)
        with patch("liveair_sms_service.get_liveair_delivery_status", mock_status):
            resp = client.get("/api/dev/sms-delivery/LA-DEV-123")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["status"] == "DELIVERED"
        assert data["message_id"] == "LA-DEV-123"
    finally:
        app.dependency_overrides.clear()

