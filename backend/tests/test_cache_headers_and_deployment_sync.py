import os
os.environ["MONGO_URL"] = "mongodb://localhost:27017/test_meribaari"

import pytest
from unittest.mock import AsyncMock
from httpx import AsyncClient, ASGITransport
import backend.server as server
from backend.server import app, BACKEND_VERSION


@pytest.mark.asyncio
async def test_api_cache_control_headers_and_version():
    """Verify that all API responses include no-store Cache-Control and X-Backend-Version headers."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Health check includes version and no-store headers
        res = await client.get("/health")
        assert res.status_code == 200
        assert "no-store" in res.headers.get("Cache-Control", "")
        assert "no-cache" in res.headers.get("Cache-Control", "")
        assert res.headers.get("X-Content-Type-Options") == "nosniff"
        assert res.headers.get("X-Backend-Version") == BACKEND_VERSION
        data = res.json()
        assert "version" in data

        # 2. Version endpoint
        ver_res = await client.get("/api/version")
        assert ver_res.status_code == 200
        assert "no-store" in ver_res.headers.get("Cache-Control", "")
        assert ver_res.headers.get("X-Backend-Version") == BACKEND_VERSION
        ver_data = ver_res.json()
        assert ver_data["version"] == BACKEND_VERSION
        assert ver_data["service"] == "meribaari-api"


@pytest.mark.asyncio
async def test_dynamic_api_no_store_protection(monkeypatch):
    """Verify that operational API endpoints enforce no-store to protect sensitive queue/patient data."""
    mock_cursor = type("MockCursor", (), {"to_list": AsyncMock(return_value=[{"name": "Cardiology"}])})()
    mock_specialties = type("MockCol", (), {"find": lambda *args, **kwargs: mock_cursor})()
    mock_doctors = type("MockCol", (), {"distinct": AsyncMock(return_value=["Cardiology"])})()
    monkeypatch.setattr(server.db, "specialties", mock_specialties)
    monkeypatch.setattr(server.db, "doctors", mock_doctors)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/specialties")
        assert res.status_code == 200
        assert "no-store" in res.headers.get("Cache-Control", "")
        assert "private" in res.headers.get("Cache-Control", "")
