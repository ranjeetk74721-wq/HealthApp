import os
os.environ["MONGO_URL"] = "mongodb://localhost:27017/test_meribaari"

import pytest
import jwt
from unittest.mock import AsyncMock, MagicMock
from fastapi import HTTPException
import server
from server import (
    login,
    UserLogin,
    reception_doctors,
    verify_doctor_session_access,
    create_token,
    JWT_SECRET,
    JWT_ALGORITHM,
)

class MockCursor:
    def __init__(self, data):
        self._data = data

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length):
        return self._data


class MockDB:
    def __init__(self):
        self.users = MagicMock()
        self.doctors = MagicMock()
        self.doctor_sessions = MagicMock()
        self.hospitals = MagicMock()


@pytest.fixture
def mock_db(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    return mdb


@pytest.mark.asyncio
async def test_receptionist_login_contract_and_hospital_assignment(mock_db, monkeypatch):
    """Verifies that receptionist login succeeds with proper hospital validation,
    preserves API contracts, and returns the access_token and user object.
    """
    monkeypatch.setattr(server, "verify_password", lambda plain, hashed: True)

    mock_db.users.find_one = AsyncMock(return_value={
        "id": "rec-101",
        "email": "reception@meribaari.com",
        "full_name": "Priya Sharma",
        "role": "receptionist",
        "password_hash": "hashed_pass",
        "hospital_id": "H00001",
        "phone": "9876543210",
    })

    body = UserLogin(
        email="reception@meribaari.com",
        password="ValidPassword123",
        hospital_id="H00001",
        role="receptionist",
    )

    result = await login(body)
    assert "access_token" in result
    assert result["user"]["id"] == "rec-101"
    assert result["user"]["role"] == "receptionist"
    assert result["user"]["hospital_id"] == "H00001"

    # Verify token claims
    token_claims = jwt.decode(result["access_token"], JWT_SECRET, algorithms=[JWT_ALGORITHM])
    assert token_claims["sub"] == "rec-101"
    assert token_claims["role"] == "receptionist"


@pytest.mark.asyncio
async def test_receptionist_login_wrong_hospital_rejected(mock_db, monkeypatch):
    """Verifies that a receptionist attempting to log into a mismatched hospital is rejected with 401."""
    monkeypatch.setattr(server, "verify_password", lambda plain, hashed: True)

    mock_db.users.find_one = AsyncMock(return_value={
        "id": "rec-102",
        "email": "reception2@meribaari.com",
        "full_name": "Priya Sharma",
        "role": "receptionist",
        "password_hash": "hashed_pass",
        "hospital_id": "H00001",
    })

    body = UserLogin(
        email="reception2@meribaari.com",
        password="ValidPassword123",
        hospital_id="H99999",
        role="receptionist",
    )

    with pytest.raises(HTTPException) as exc:
        await login(body)
    assert exc.value.status_code == 401
    assert "Account is not assigned to Hospital ID" in exc.value.detail


@pytest.mark.asyncio
async def test_doctor_session_access_permission_isolation(mock_db):
    """Verifies that a feature-level 403 on doctor session verification occurs when
    hospitals mismatch, which must be isolated from the receptionist's global session.
    """
    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": "doc-diff-hosp",
        "hospital_id": "OTHER_HOSP",
    })

    user = {
        "id": "rec-101",
        "role": "receptionist",
        "hospital_id": "H00001",
    }

    # Should raise 403 Forbidden for that doctor's session, NOT 401 Unauthorized
    with pytest.raises(HTTPException) as exc:
        await verify_doctor_session_access("doc-diff-hosp", user)
    assert exc.value.status_code == 403
    assert "Forbidden" in exc.value.detail or "permission" in exc.value.detail.lower()


@pytest.mark.asyncio
async def test_reception_doctors_discovery_retains_contract(mock_db):
    """Verifies that /reception/doctors returns authorized doctor list matching receptionist's hospital."""
    mock_db.doctors.find = MagicMock(return_value=MockCursor([
        {"id": "doc-1", "full_name": "Dr. Mariya", "hospital_id": "H00001"},
        {"id": "doc-2", "full_name": "Dr. Khan", "hospital_id": "H00001"},
    ]))

    user = {
        "id": "rec-101",
        "role": "receptionist",
        "hospital_id": "H00001",
    }

    docs = await reception_doctors(user)
    assert len(docs) == 2
    assert docs[0]["id"] == "doc-1"
    assert docs[1]["id"] == "doc-2"
