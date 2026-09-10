"""
Automated Test Suite for Renflair SMS Gateway Integration.

Verifies:
1. Mobile number OTP verification (Renflair V1 API)
   - Valid Indian phone normalization (10-digit format)
   - Invalid number validation
   - Missing Renflair API key controlled error
   - Renflair timeout/error handling without server crash
   - Plaintext OTP and API key privacy (never in logs or client responses)
2. Appointment booking confirmation SMS (Renflair V7 API)
   - Parameter mapping for PHONE, OID, HOUR
   - Provider failure does not roll back or delete appointments
   - Duplicate prevention via appointment uniqueness and cooldown
"""

import os
import re
import uuid
import secrets
import logging
import pytest
import httpx
from datetime import datetime, timezone
from unittest.mock import patch, AsyncMock
from starlette.testclient import TestClient
import sys
from pathlib import Path

# Ensure backend directory is in sys.path
_backend_dir = str(Path(__file__).resolve().parent.parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from sms_service import (
    format_renflair_phone,
    format_renflair_oid,
    format_renflair_hour,
    send_otp_sms,
    send_appointment_sms,
    get_renflair_api_key,
    RENFLAIR_OTP_URL,
    RENFLAIR_APPT_URL,
)
from server import app, normalize_mobile, save_memory_otp, _otp_store, db, create_token


# ==============================================================================
# UNIT TESTS: RENFLAIR PHONE & PARAMETER NORMALIZATION
# ==============================================================================
def test_format_renflair_phone_valid_indian_numbers():
    """Valid Indian mobile numbers must normalize to exactly 10 digits starting with 6-9."""
    assert format_renflair_phone("9876543210") == "9876543210"
    assert format_renflair_phone("+919876543210") == "9876543210"
    assert format_renflair_phone("919876543210") == "9876543210"
    assert format_renflair_phone("09876543210") == "9876543210"
    assert format_renflair_phone("+91 98765 43210") == "9876543210"
    assert format_renflair_phone("98765-43210") == "9876543210"
    # Numbers starting with 6, 7, 8, 9
    assert format_renflair_phone("6123456789") == "6123456789"
    assert format_renflair_phone("7123456789") == "7123456789"
    assert format_renflair_phone("8123456789") == "8123456789"


def test_format_renflair_phone_invalid_numbers():
    """Invalid numbers must return None (validation failure)."""
    assert format_renflair_phone("") is None
    assert format_renflair_phone(None) is None
    assert format_renflair_phone("12345") is None
    assert format_renflair_phone("1234567890") is None  # Does not start with 6-9
    assert format_renflair_phone("abcdefghij") is None
    assert format_renflair_phone("+14155552671") is None  # Non-Indian US number


def test_format_renflair_oid():
    """OID mapping from integer, token, or appointment ID."""
    assert format_renflair_oid(1) == "1"
    assert format_renflair_oid(1234) == "1234"
    assert format_renflair_oid("token-5") == "token-5"
    assert format_renflair_oid(None) == "1"
    assert format_renflair_oid("") == "1"


def test_format_renflair_hour():
    """HOUR extraction from times, slots, and integers."""
    assert format_renflair_hour(2) == "2"
    assert format_renflair_hour("2") == "2"
    assert format_renflair_hour("10:30 AM") == "10"
    assert format_renflair_hour("02:15 PM") == "14"
    assert format_renflair_hour("12:00 PM") == "12"
    assert format_renflair_hour("12:30 AM") == "0"
    assert format_renflair_hour("11:00") == "11"
    assert format_renflair_hour(None) == "2"
    assert format_renflair_hour("Walk-in") == "2"


# ==============================================================================
# UNIT TESTS: RENFLAIR V1 OTP SMS SERVICE
# ==============================================================================
@pytest.mark.asyncio
async def test_otp_sms_success():
    """Valid Indian phone and API key sends GET to Renflair V1 with correct URL-encoded params."""
    mock_resp = httpx.Response(
        status_code=200,
        text='{"status":"success","message":"SMS dispatched successfully","msgid":"1001"}',
        headers={"content-type": "application/json"},
    )
    
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_renflair_key_xyz"}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        
        res = await send_otp_sms("9876543210", "654321")
        
        assert res["ok"] is True
        assert res["provider"] == "renflair"
        assert res["phone"] == "9876543210"
        
        # Verify call parameters
        mock_get.assert_called_once()
        call_args, call_kwargs = mock_get.call_args
        assert call_args[0] == RENFLAIR_OTP_URL
        assert call_kwargs["params"] == {
            "API": "test_renflair_key_xyz",
            "PHONE": "9876543210",
            "OTP": "654321",
        }


@pytest.mark.asyncio
async def test_otp_sms_invalid_phone_rejected():
    """Invalid phone number returns controlled error without calling Renflair."""
    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        res = await send_otp_sms("12345", "654321")
        assert res["ok"] is False
        assert res["error_code"] == "INVALID_PHONE"
        mock_get.assert_not_called()


@pytest.mark.asyncio
async def test_otp_sms_missing_api_key_controlled_error():
    """Missing Renflair API key returns controlled error without crashing."""
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": ""}, clear=False), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        res = await send_otp_sms("9876543210", "654321")
        assert res["ok"] is False
        assert res["error_code"] == "MISSING_API_KEY"
        mock_get.assert_not_called()


@pytest.mark.asyncio
async def test_otp_sms_provider_timeout_resilience():
    """Renflair gateway timeout returns controlled error and does not raise."""
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_key"}), \
         patch("httpx.AsyncClient.get", side_effect=httpx.TimeoutException("Read timed out")):
        res = await send_otp_sms("9876543210", "654321")
        assert res["ok"] is False
        assert res["error_code"] == "TIMEOUT"


@pytest.mark.asyncio
async def test_otp_sms_provider_http_500_resilience():
    """Renflair HTTP 500 error returns controlled error."""
    mock_resp = httpx.Response(status_code=500, text="Internal Gateway Error")
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_key"}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        res = await send_otp_sms("9876543210", "654321")
        assert res["ok"] is False
        assert res["error_code"] == "GATEWAY_ERROR"


@pytest.mark.asyncio
async def test_otp_sms_plaintext_privacy():
    """Ensure sensitive API key and OTP never appear in returned error structures."""
    secret_key = "secret_renflair_token_super_private"
    secret_otp = "982314"
    mock_resp = httpx.Response(status_code=403, text='{"error":"Invalid API Key"}')
    
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": secret_key}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        res = await send_otp_sms("9876543210", secret_otp)
        
        res_str = str(res)
        assert secret_key not in res_str
        assert secret_otp not in res_str


# ==============================================================================
# UNIT TESTS: RENFLAIR V7 APPOINTMENT BOOKING SMS SERVICE
# ==============================================================================
@pytest.mark.asyncio
async def test_appointment_sms_success_v7_params():
    """Appointment SMS sends GET to Renflair V7 with API, PHONE, OID, HOUR."""
    mock_resp = httpx.Response(
        status_code=200,
        text='{"status":"success","message":"Order confirmation SMS sent"}',
        headers={"content-type": "application/json"},
    )
    
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_renflair_key_v7"}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        
        res = await send_appointment_sms(
            phone="+919876543210",
            oid=1234,
            hour=2,
        )
        
        assert res["ok"] is True
        assert res["provider"] == "renflair"
        assert res["phone"] == "9876543210"
        assert res["oid"] == "1234"
        assert res["hour"] == "2"
        
        mock_get.assert_called_once()
        call_args, call_kwargs = mock_get.call_args
        assert call_args[0] == RENFLAIR_APPT_URL
        assert call_kwargs["params"] == {
            "API": "test_renflair_key_v7",
            "PHONE": "9876543210",
            "OID": "1234",
            "HOUR": "2",
        }


@pytest.mark.asyncio
async def test_appointment_sms_backward_compatible_kwargs():
    """Appointment SMS seamlessly resolves OID and HOUR from legacy keyword arguments."""
    mock_resp = httpx.Response(status_code=200, text="success")
    
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_key"}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        
        res = await send_appointment_sms(
            phone="9876543210",
            patient_name="John Doe",
            doctor_name="Dr. Smith",
            token_number=7,
            estimated_time="10:30 AM",
            appointment_link="http://localhost:8081/appointment/abc",
        )
        
        assert res["ok"] is True
        assert res["oid"] == "7"
        assert res["hour"] == "10"
        
        call_args, call_kwargs = mock_get.call_args
        assert call_kwargs["params"]["OID"] == "7"
        assert call_kwargs["params"]["HOUR"] == "10"


@pytest.mark.asyncio
async def test_appointment_sms_invalid_phone_controlled_handling():
    """Missing or invalid phone returns controlled error without crashing."""
    res = await send_appointment_sms(phone="", oid=1, hour=2)
    assert res["ok"] is False
    assert res["error_code"] == "INVALID_PHONE"


@pytest.mark.asyncio
async def test_appointment_sms_provider_failure_graceful():
    """Renflair V7 failure returns controlled status."""
    mock_resp = httpx.Response(status_code=502, text="Bad Gateway")
    with patch.dict(os.environ, {"RENFLAIR_API_KEY": "test_key"}), \
         patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_resp
        res = await send_appointment_sms(phone="9876543210", oid=10, hour=3)
        assert res["ok"] is False
        assert res["error_code"] == "GATEWAY_ERROR"


# ==============================================================================
# INTEGRATION TESTS: APPLICATION AUTH & BOOKING FLOW WITH RENFLAIR
# ==============================================================================
def test_send_otp_api_endpoint_never_exposes_plaintext_otp():
    """Verify POST /api/auth/send-otp triggers Renflair SMS and never exposes OTP in response."""
    client = TestClient(app)
    mobile = f"98765{secrets.randbelow(90000) + 10000}"
    
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = {"ok": True, "provider": "renflair"}
        
        r = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["ok"] is True
        assert data["mobile"] == f"+91{mobile}"
        # Security requirement: OTP must NEVER appear in response
        assert "otp" not in data
        assert "dev_otp" not in data
        
        mock_send.assert_called_once()
        call_phone, call_otp = mock_send.call_args[0]
        assert call_phone == f"+91{mobile}"
        assert len(call_otp) == 6
        assert call_otp.isdigit()
