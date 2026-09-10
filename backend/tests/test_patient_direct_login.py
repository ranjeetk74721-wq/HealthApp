import sys
from pathlib import Path
import uuid
import secrets
from unittest.mock import patch, AsyncMock

_backend_dir = Path(__file__).resolve().parent.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

import os
import pymongo
import pytest
from starlette.testclient import TestClient
from server import app, save_memory_otp, _otp_store, create_token

sync_client = pymongo.MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
sync_db = sync_client[os.environ.get("DB_NAME", "clinicqueue")]


from rate_limiter import rate_limiter


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def reset_rate_limits():
    rate_limiter._records.clear()
    rate_limiter._blocks.clear()


def test_first_time_user_requires_otp_and_verification(client):
    """A new unregistered mobile number cannot direct-login; receives OTP."""
    mobile = f"98111{secrets.randbelow(90000) + 10000}"
    
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = {"ok": True, "provider": "renflair"}
        
        res = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res.status_code == 200, res.text
        data = res.json()
        assert data["ok"] is True
        assert data["direct_login"] is False
        assert data["is_registered"] is False
        assert "access_token" not in data
        mock_send.assert_called_once()


def test_first_time_otp_verification_creates_verified_patient(client):
    """Verifying OTP for the first time creates the account with phone_verified == True."""
    mobile = f"98222{secrets.randbelow(90000) + 10000}"
    
    # 1. Send OTP
    client.post("/api/auth/send-otp", json={"mobile": mobile})
    
    # 2. Inject test OTP and verify
    save_memory_otp(mobile, "654321", 300)
    res_verify = client.post("/api/auth/verify-otp", json={
        "mobile": mobile,
        "otp": "654321",
        "full_name": "Verified Test Patient",
        "age": 29,
        "gender": "Male",
        "consent_privacy": True,
    })
    assert res_verify.status_code == 200, res_verify.text
    data = res_verify.json()
    assert "access_token" in data
    assert data["user"]["full_name"] == "Verified Test Patient"
    
    # 3. Verify in database that phone_verified is True
    norm_mobile = f"+91{mobile}"
    user_in_db = sync_db.users.find_one({"mobile": norm_mobile})
    assert user_in_db is not None
    assert user_in_db.get("phone_verified") is True


def test_second_time_user_logs_in_directly_without_otp(client):
    """Second time login: Registered patient enters same number and logs in directly without OTP."""
    mobile = f"98333{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    
    # Seed an already verified patient account
    patient_id = str(uuid.uuid4())
    sync_db.users.insert_one({
        "id": patient_id,
        "email": None,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Returning Patient",
        "role": "patient",
        "phone_verified": True,
        "age": 34,
        "gender": "Female",
        "address": "45 Park Street",
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    # Second time user calls /api/auth/send-otp
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        res = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res.status_code == 200, res.text
        data = res.json()
        
        # Must return direct_login == True and grant access_token
        assert data["ok"] is True
        assert data["is_registered"] is True
        assert data["direct_login"] is True
        assert "access_token" in data
        assert isinstance(data["access_token"], str)
        assert data["user"]["id"] == patient_id
        assert data["user"]["full_name"] == "Returning Patient"
        assert data["user"]["role"] == "patient"
        assert data["user"]["phone_verified"] is True
        
        # No SMS dispatch needed for direct returning login
        mock_send.assert_not_called()


def test_second_time_direct_login_token_can_access_protected_apis(client):
    """The access_token issued by direct login is fully valid for protected patient endpoints."""
    mobile = f"98444{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    patient_id = str(uuid.uuid4())
    
    sync_db.users.insert_one({
        "id": patient_id,
        "email": None,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Direct Access Patient",
        "role": "patient",
        "phone_verified": True,
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    # Direct login
    res = client.post("/api/auth/send-otp", json={"mobile": mobile})
    assert res.status_code == 200
    token = res.json()["access_token"]
    
    # Access protected /api/auth/me endpoint
    res_me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res_me.status_code == 200, res_me.text
    me_data = res_me.json()
    assert me_data["id"] == patient_id
    assert me_data["full_name"] == "Direct Access Patient"


def test_force_otp_resends_otp_even_for_registered_user(client):
    """When force_otp is True (e.g. user on OTP screen clicked Resend OTP), sends real OTP."""
    mobile = f"98555{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    patient_id = str(uuid.uuid4())
    
    sync_db.users.insert_one({
        "id": patient_id,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Forced OTP Patient",
        "role": "patient",
        "phone_verified": True,
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = {"ok": True, "provider": "renflair"}
        
        res = client.post("/api/auth/send-otp", json={"mobile": mobile, "force_otp": True})
        assert res.status_code == 200
        data = res.json()
        assert data["direct_login"] is False
        assert "access_token" not in data
        mock_send.assert_called_once()


def test_unverified_receptionist_patient_requires_otp_first_time(client):
    """Patient created by receptionist has phone_verified == False; must verify OTP first."""
    mobile = f"98666{secrets.randbelow(90000) + 10000}"
    norm_mobile = f"+91{mobile}"
    patient_id = str(uuid.uuid4())
    
    # Receptionist created patient (unverified)
    sync_db.users.insert_one({
        "id": patient_id,
        "mobile": norm_mobile,
        "phone": norm_mobile,
        "full_name": "Clinic Walkin Patient",
        "role": "patient",
        "phone_verified": False,
        "created_at": "2026-09-01T10:00:00Z",
    })
    
    # 1. First visit by this patient requires OTP
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        mock_send.return_value = {"ok": True, "provider": "renflair"}
        res1 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res1.status_code == 200
        assert res1.json()["direct_login"] is False
        mock_send.assert_called_once()
    
    # 2. Patient verifies OTP
    save_memory_otp(mobile, "888999", 300)
    res_ver = client.post("/api/auth/verify-otp", json={"mobile": mobile, "otp": "888999"})
    assert res_ver.status_code == 200
    
    # 3. Subsequent visit: now phone_verified is True -> direct login without OTP
    with patch("server.send_otp_sms", new_callable=AsyncMock) as mock_send:
        res2 = client.post("/api/auth/send-otp", json={"mobile": mobile})
        assert res2.status_code == 200
        assert res2.json()["direct_login"] is True
        assert "access_token" in res2.json()
        mock_send.assert_not_called()
