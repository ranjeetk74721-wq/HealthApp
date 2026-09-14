"""
Unit tests for LiveAir HTTP SMS API integration, provider routing, error mapping,
custom appointment SMS format, security, credits check, and dev test endpoints.
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
    get_liveair_credits,
    get_liveair_delivery_status,
    validate_liveair_startup_config,
    detect_message_type,
    execute_liveair_test_sms,
    LIVEAIR_ERROR_CODES,
)
from sms_service import (
    get_sms_provider,
    format_custom_appointment_sms,
    send_appointment_sms,
    send_otp_sms,
)
import uuid
import secrets
import pymongo
from server import app, create_token, get_current_user, save_memory_otp, _otp_store, normalize_mobile
from rate_limiter import rate_limiter
from starlette.testclient import TestClient

sync_client = pymongo.MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
sync_db = sync_client[os.environ.get("DB_NAME", "clinicqueue")]


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
    assert mask_phone_for_logging("9876543210") == "******3210"
    assert mask_phone_for_logging("+919876543210") == "******3210"
    assert mask_phone_for_logging("123") == "*****"
    assert mask_phone_for_logging("") == "unknown"


# ==========================================
# 2. MESSAGE TYPE AUTO-DETECTION TESTS
# ==========================================

def test_detect_message_type():
    """Verify ASCII/Hinglish text uses type 1 and Hindi Unicode uses type 3."""
    # Plain English / Hinglish
    assert detect_message_type("Aapka appointment confirm ho gaya hai.") == "1"
    # Hindi Unicode
    assert detect_message_type("आपका नंबर कब आएगा देखने के लिए") == "3"
    # Explicit override preserved
    assert detect_message_type("Hello", configured_type="2") == "2"


# ==========================================
# 3. RESPONSE PARSING & ERROR CODE MAPPING
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
    ("101", "Invalid user"),
    ("102", "Invalid sender ID"),
    ("103", "Invalid contact(s)"),
    ("104", "Invalid SMS route"),
    ("105", "Invalid message type"),
    ("106", "Message content does not exist"),
    ("107", "Spam blocked"),
    ("108", "Low credits in specified route"),
    ("109", "No SMSC connection available"),
    ("110", "Promotional route available only 9 AM–9 PM"),
    ("111", "Connection error"),
    ("112", "All numbers are DND"),
    ("113", "Invalid DLT template ID"),
])
def test_parse_liveair_response_error_codes(code, expected_error):
    """Verify documented provider error codes (101-113) map to clear internal errors."""
    res = parse_liveair_response(200, f"{code} : Sample provider error text")
    assert res["success"] is False
    assert res["code"] == code
    assert expected_error.lower() in res["error"].lower()


def test_parse_liveair_response_json_error():
    """Verify JSON error response parsing."""
    res = parse_liveair_response(400, '{"status": "error", "code": "113", "message": "Template mismatch"}')
    assert res["success"] is False
    assert res["code"] == "113"
    assert "Template mismatch" in res["error"]


# ==========================================
# 4. LIVEAIR HTTP DISPATCH & SECURITY TESTS
# ==========================================

@pytest.mark.asyncio
async def test_send_liveair_sms_missing_token(monkeypatch):
    """Verify dispatch is blocked cleanly if LIVEAIR_API_TOKEN is missing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "")
    res = await send_liveair_sms("9876543210", "Test message")
    assert res["success"] is False
    assert res["code"] == "MISSING_TOKEN"


@pytest.mark.asyncio
async def test_send_liveair_sms_missing_template_id(monkeypatch):
    """Verify dispatch is blocked if LIVEAIR_TEMPLATE_ID is missing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "valid-test-token")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "")
    res = await send_liveair_sms("9876543210", "Test message")
    assert res["success"] is False
    assert res["code"] == "MISSING_TEMPLATE_ID"


@pytest.mark.asyncio
async def test_send_liveair_sms_invalid_phone(monkeypatch):
    """Verify invalid phone format is rejected before network dispatch."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "valid-test-token")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")
    res = await send_liveair_sms("12345", "Test message")
    assert res["success"] is False
    assert res["code"] == "INVALID_PHONE"


@pytest.mark.asyncio
async def test_send_liveair_sms_dispatches_correct_parameters(monkeypatch):
    """Verify LiveAir HTTP request includes token, sender, number, route, type, sms, templateid."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "secret-test-token-xyz")
    monkeypatch.setenv("LIVEAIR_SENDER_ID", "newsen")
    monkeypatch.setenv("LIVEAIR_ROUTE", "3")
    monkeypatch.setenv("LIVEAIR_MESSAGE_TYPE", "1")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")
    monkeypatch.setenv("LIVEAIR_BASE_URL", "http://godspeed.liveair.co.in/httpapi")

    captured_url = None
    captured_params = None

    async def mock_get(url, params=None, **kwargs):
        nonlocal captured_url, captured_params
        captured_url = url
        captured_params = params
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "MSG-554433"
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        res = await send_liveair_sms(
            phone="+919876543210",
            message="Your appointment token is 5",
            purpose="appointment_test",
        )

    assert res["success"] is True
    assert res["message_id"] == "MSG-554433"
    assert captured_url == "http://godspeed.liveair.co.in/httpapi/httpapi"
    assert captured_params["token"] == "secret-test-token-xyz"
    assert captured_params["sender"] == "newsen"
    assert captured_params["number"] == "9876543210"
    assert captured_params["route"] == "3"
    assert captured_params["type"] == "1"
    assert captured_params["sms"] == "Your appointment token is 5"
    assert captured_params["templateid"] == "1777178651407186753"


@pytest.mark.asyncio
async def test_send_liveair_sms_timeout(monkeypatch):
    """Verify timeout is safely captured and normalized."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "token")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")
    with patch("httpx.AsyncClient.get", side_effect=httpx.TimeoutException("Timeout")):
        res = await send_liveair_sms("9876543210", "Hello")
    assert res["success"] is False
    assert res["code"] == "TIMEOUT"


# ==========================================
# 5. CREDITS API TESTS
# ==========================================

@pytest.mark.asyncio
async def test_get_liveair_credits_success(monkeypatch):
    """Verify available credits API parsing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "token")
    monkeypatch.setenv("LIVEAIR_ROUTE", "3")
    monkeypatch.setenv("LIVEAIR_BASE_URL", "http://godspeed.liveair.co.in/httpapi")

    async def mock_get(url, params=None, **kwargs):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = '["Route","Sender ID","Credits","10"]'
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        res = await get_liveair_credits()

    assert res["success"] is True
    assert res["route"] == "3"
    assert res["credits"] == "10"


@pytest.mark.asyncio
async def test_get_liveair_credits_invalid_route(monkeypatch):
    """Verify credits check handles invalid route code cleanly."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "token")
    monkeypatch.setenv("LIVEAIR_ROUTE", "2")

    async def mock_get(url, params=None, **kwargs):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.text = "102 : Invalid route 123"
        return mock_resp

    with patch("httpx.AsyncClient.get", side_effect=mock_get):
        res = await get_liveair_credits()

    assert res["success"] is False
    assert res["code"] == "102"


# ==========================================
# 6. DELIVERY STATUS REPORT TESTS
# ==========================================

@pytest.mark.asyncio
async def test_get_liveair_delivery_status_delivered(monkeypatch):
    """Verify delivery report status parsing."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "test-token")
    monkeypatch.setenv("LIVEAIR_BASE_URL", "http://godspeed.liveair.co.in/httpapi")

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
# 7. STARTUP CONFIG VALIDATION
# ==========================================

def test_validate_liveair_startup_config(monkeypatch):
    """Verify backend startup configuration check."""
    monkeypatch.setenv("LIVEAIR_API_TOKEN", "valid-token")
    monkeypatch.setenv("LIVEAIR_SENDER_ID", "newsen")
    monkeypatch.setenv("LIVEAIR_ROUTE", "3")
    monkeypatch.setenv("LIVEAIR_MESSAGE_TYPE", "1")
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")

    chk = validate_liveair_startup_config()
    assert chk["valid"] is True
    assert len(chk["missing"]) == 0
    assert chk["route"] == "3"


# ==========================================
# 8. PROVIDER SWITCH & CUSTOM APPOINTMENT SMS
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
    """Verify custom appointment SMS structure matches Requirement 5."""
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
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")

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
    assert res["provider"] == "renflair"


# ==========================================
# 9. DEV TEST ENDPOINTS & ACCESS CONTROL
# ==========================================

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
    monkeypatch.setenv("LIVEAIR_TEMPLATE_ID", "1777178651407186753")

    mock_test = AsyncMock(return_value={
        "success": True,
        "phone_masked": "******3210",
        "route": "3",
        "credits": "10",
        "send_response": {
            "success": True,
            "provider": "liveair",
            "message_id": "LA-DEV-123",
        },
        "delivery_report": {"status": "DELIVERED"},
    })

    app.dependency_overrides[get_current_user] = lambda: {"id": "adm1", "role": "admin"}
    try:
        client = TestClient(app)
        with patch("liveair_sms_service.execute_liveair_test_sms", mock_test):
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


def test_dev_liveair_credits_endpoint(monkeypatch):
    """Verify /api/dev/liveair-credits returns available credits."""
    monkeypatch.setenv("DEV_TEST_SMS_ENABLED", "1")
    app.dependency_overrides[get_current_user] = lambda: {"id": "adm1", "role": "admin"}

    mock_credits = AsyncMock(return_value={
        "success": True,
        "route": "3",
        "credits": "10",
    })

    try:
        client = TestClient(app)
        with patch("liveair_sms_service.get_liveair_credits", mock_credits):
            resp = client.get("/api/dev/liveair-credits")

        assert resp.status_code == 200
        data = resp.json()
        assert data["success"] is True
        assert data["credits"] == "10"
        assert data["route"] == "3"
    finally:
        app.dependency_overrides.clear()


# ==============================================================================
# 10. FIRST-TIME LIVEAIR OTP VERIFICATION TEST SUITE (Requirement 16)
# ==============================================================================

@pytest.fixture(autouse=True)
def clean_otp_and_limits():
    """Ensure clean OTP memory store and rate limiter records per test."""
    _otp_store.clear()
    rate_limiter._records.clear()
    rate_limiter._blocks.clear()
    rate_limiter._violations.clear()
    rate_limiter._last_event.clear()
    yield
    _otp_store.clear()


def test_req16_test_1_new_number_requires_otp_and_verifies(monkeypatch):
    """TEST 1 — NEW NUMBER:
    - enter a new mobile number
    - OTP is sent via LiveAir Trans OTP route 4
    - account not fully activated before verification
    - correct OTP succeeds -> account created/verified -> access token returned
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_OTP_ENABLED", "1")
    monkeypatch.setenv("LIVEAIR_OTP_ROUTE", "4")
    monkeypatch.setenv("LIVEAIR_OTP_SENDER_ID", "newsen")
    monkeypatch.setenv("LIVEAIR_OTP_TEMPLATE_ID", "1777178651407186753")
    
    mobile = f"98711{secrets.randbelow(90000) + 10000}"
    captured_calls = []

    async def mock_send_liveair(phone, message, template_id=None, route=None, sender=None, **kwargs):
        captured_calls.append({
            "phone": phone,
            "message": message,
            "route": route,
            "sender": sender,
            "template_id": template_id,
        })
        return {
            "success": True,
            "provider": "liveair",
            "message_id": "LA-OTP-998877",
            "error": None,
        }

    with patch("sms_service.send_liveair_sms", mock_send_liveair):
        client = TestClient(app)
        
        # 1. Enter new mobile number
        r_send = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert r_send.status_code == 200
        send_data = r_send.json()
        assert send_data["ok"] is True
        assert send_data["direct_login"] is False
        assert send_data["is_registered"] is False
        assert "access_token" not in send_data
        
        # Verify LiveAir route 4 was targeted
        assert len(captured_calls) == 1
        assert captured_calls[0]["route"] == "4"
        assert captured_calls[0]["sender"] == "newsen"
        assert "Your Meribaari OTP is" in captured_calls[0]["message"]
        
        # Verify account does NOT exist yet in MongoDB before verification
        norm_mobile = f"+91{mobile}"
        assert sync_db.users.find_one({"mobile": norm_mobile}) is None
        
        # 2. Extract generated OTP and verify
        otp_rec = _otp_store.get(norm_mobile)
        assert otp_rec is not None
        
        # Inject known OTP for verification test
        save_memory_otp(mobile, "554433", 300)
        r_verify = client.post("/api/auth/verify-otp", json={
            "mobile": mobile,
            "otp": "554433",
            "full_name": "New Verified Patient",
            "age": 28,
            "gender": "Female",
            "consent_privacy": True,
        })
        assert r_verify.status_code == 200
        v_data = r_verify.json()
        assert "access_token" in v_data
        assert v_data["user"]["full_name"] == "New Verified Patient"
        assert v_data["user"]["phone_verified"] is True
        
        # Verify user is now created in MongoDB with phone_verified == True
        user_db = sync_db.users.find_one({"mobile": norm_mobile})
        assert user_db is not None
        assert user_db["phone_verified"] is True


def test_req16_test_2_existing_number_no_otp(monkeypatch):
    """TEST 2 — EXISTING NUMBER:
    - enter an already registered mobile
    - NO registration OTP sent
    - existing login flow remains unchanged
    - login succeeds directly
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    mobile = f"98722{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    patient_id = str(uuid.uuid4())
    
    # Pre-seed verified patient in database
    sync_db.users.insert_one({
        "id": patient_id,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Existing Registered Patient",
        "role": "patient",
        "phone_verified": True,
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    mock_send = AsyncMock()
    with patch("sms_service.send_liveair_sms", mock_send):
        client = TestClient(app)
        res = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res.status_code == 200
        data = res.json()
        
        # Direct login: No OTP sent
        assert data["ok"] is True
        assert data["direct_login"] is True
        assert data["is_registered"] is True
        assert "access_token" in data
        assert data["user"]["id"] == patient_id
        mock_send.assert_not_called()


def test_req16_test_3_existing_user_after_feature_deployment(monkeypatch):
    """TEST 3 — EXISTING USER AFTER FEATURE DEPLOYMENT:
    - existing users are not forced to verify again
    - no breaking migration
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    mobile = f"98733{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    user_id = str(uuid.uuid4())
    
    sync_db.users.insert_one({
        "id": user_id,
        "mobile": norm_mobile,
        "full_name": "Prior User",
        "role": "patient",
        "phone_verified": True,
    })
    
    client = TestClient(app)
    res = client.post("/api/auth/send-otp", json={"mobile": mobile})
    assert res.status_code == 200
    assert res.json()["direct_login"] is True
    assert "access_token" in res.json()


def test_req16_test_4_wrong_otp_rejected_attempts_increment():
    """TEST 4 — WRONG OTP:
    - login/register rejected (HTTP 401)
    - attempt counter increments
    """
    mobile = f"98744{secrets.randbelow(90000) + 10000}"
    save_memory_otp(mobile, "112233", 300)
    
    client = TestClient(app)
    # Attempt with wrong OTP
    res = client.post("/api/auth/verify-otp", json={"mobile": mobile, "otp": "999999"})
    assert res.status_code == 401
    assert "Invalid OTP" in res.json()["detail"]
    
    # Check attempt counter in memory
    norm_mobile = f"+91{mobile}"
    assert _otp_store[norm_mobile]["attempts"] == 1


def test_req16_test_5_expired_otp_rejected():
    """TEST 5 — EXPIRED OTP:
    - rejected when past expiry window
    """
    mobile = f"98755{secrets.randbelow(90000) + 10000}"
    # Expired 10 seconds ago
    save_memory_otp(mobile, "112233", -10)
    
    client = TestClient(app)
    res = client.post("/api/auth/verify-otp", json={"mobile": mobile, "otp": "112233"})
    assert res.status_code == 401
    assert "expired" in res.json()["detail"].lower()


def test_req16_test_6_otp_reuse_rejected():
    """TEST 6 — OTP REUSE:
    - already-used OTP cannot be used a second time
    """
    mobile = f"98766{secrets.randbelow(90000) + 10000}"
    save_memory_otp(mobile, "112233", 300)
    
    client = TestClient(app)
    # First attempt: succeeds
    res1 = client.post("/api/auth/verify-otp", json={
        "mobile": mobile,
        "otp": "112233",
        "full_name": "Single Use Patient",
    })
    assert res1.status_code == 200
    
    # Second attempt with same OTP: rejected
    res2 = client.post("/api/auth/verify-otp", json={
        "mobile": mobile,
        "otp": "112233",
        "full_name": "Single Use Patient",
    })
    assert res2.status_code == 401


def test_req16_test_7_resend_cooldown_enforced(monkeypatch):
    """TEST 7 — RESEND:
    - 60-second cooldown enforced, returning HTTP 429
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_OTP_ENABLED", "1")
    mobile = f"98777{secrets.randbelow(90000) + 10000}"
    
    mock_send = AsyncMock(return_value={"success": True, "provider": "liveair", "message_id": "123"})
    with patch("sms_service.send_liveair_sms", mock_send):
        client = TestClient(app)
        # First send: 200
        res1 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res1.status_code == 200
        
        # Second send immediately: 429 Cooldown
        res2 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res2.status_code == 429
        assert "cooldown" in res2.json()["detail"].lower() or "wait" in res2.json()["detail"].lower()


def test_req16_test_8_duplicate_registration_prevented():
    """TEST 8 — DUPLICATE REGISTRATION:
    - same phone cannot create duplicate user records in database
    """
    mobile = f"98788{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    
    # Seed user 1
    u1_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": u1_id,
        "mobile": norm_mobile,
        "full_name": "Original Patient",
        "role": "patient",
        "phone_verified": True,
    })
    
    save_memory_otp(mobile, "667788", 300)
    client = TestClient(app)
    res = client.post("/api/auth/verify-otp", json={
        "mobile": mobile,
        "otp": "667788",
        "full_name": "Duplicate Attempt",
    })
    assert res.status_code == 200
    
    # Ensure only 1 record exists in MongoDB for this mobile
    count = sync_db.users.count_documents({"mobile": norm_mobile})
    assert count == 1


def test_req16_test_9_receptionist_created_patient_linking(monkeypatch):
    """TEST 9 — RECEPTIONIST-CREATED NEW PATIENT:
    - receptionist creates walk-in patient (phone_verified == False)
    - patient later logs in via app -> receives LiveAir OTP
    - OTP verifies ownership -> phone_verified updated to True
    - NO second patient account created
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_OTP_ENABLED", "1")
    mobile = f"98799{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    patient_id = str(uuid.uuid4())
    
    # Walk-in patient created by receptionist
    sync_db.users.insert_one({
        "id": patient_id,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Clinic Walkin Patient",
        "role": "patient",
        "phone_verified": False,
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    mock_send = AsyncMock(return_value={"success": True, "provider": "liveair", "message_id": "LA-WALKIN-1"})
    with patch("sms_service.send_liveair_sms", mock_send):
        client = TestClient(app)
        
        # 1. Walk-in patient visits app: unverified, so must receive OTP
        res1 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res1.status_code == 200
        assert res1.json()["direct_login"] is False
        mock_send.assert_called_once()
        
        # 2. Patient verifies OTP
        save_memory_otp(mobile, "998811", 300)
        res_verify = client.post("/api/auth/verify-otp", json={"mobile": mobile, "otp": "998811"})
        assert res_verify.status_code == 200
        assert res_verify.json()["user"]["id"] == patient_id
        assert res_verify.json()["user"]["phone_verified"] is True
        
        # 3. Ensure no second user record was created
        assert sync_db.users.count_documents({"mobile": norm_mobile}) == 1
        
        # 4. Future login: now phone_verified == True -> direct login without OTP
        mock_send.reset_mock()
        res2 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res2.status_code == 200
        assert res2.json()["direct_login"] is True
        mock_send.assert_not_called()


def test_req16_test_10_liveair_gateway_failure_safe_handling(monkeypatch):
    """TEST 10 — LIVEAIR FAILURE:
    - error handled safely
    - no secret leaked
    - UI does not falsely claim OTP was sent (returns HTTP 502)
    """
    monkeypatch.setenv("SMS_PROVIDER", "liveair")
    monkeypatch.setenv("LIVEAIR_OTP_ENABLED", "1")
    monkeypatch.delenv("ALLOW_DEV_OTP", raising=False)
    mobile = f"98700{secrets.randbelow(90000) + 10000}"
    
    mock_send = AsyncMock(return_value={
        "success": False,
        "provider": "liveair",
        "message_id": None,
        "error": "Low credits in specified route (108)",
        "code": "108",
    })
    
    with patch("sms_service.send_liveair_sms", mock_send):
        client = TestClient(app)
        res = client.post("/api/auth/send-otp", json={"mobile": mobile})
        
        # Must return 502 Bad Gateway
        assert res.status_code == 502
        err_body = res.json()["detail"]
        assert "Unable to send verification SMS" in err_body
        assert "Low credits" in err_body
        # Ensure secret token is NEVER exposed
        assert "833ea6bad3676507b7924a35406b6d96" not in str(res.json())
        assert "token=" not in str(res.json())
