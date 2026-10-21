import pytest
from fastapi.testclient import TestClient
from server import app

client = TestClient(app)

def test_no_double_api_prefix_registered():
    """Verify that zero routes in the entire FastAPI application have an /api/api prefix."""
    double_api_routes = [
        route.path for route in app.routes if getattr(route, "path", "").startswith("/api/api")
    ]
    assert double_api_routes == [], f"Found routes with double /api/api prefix: {double_api_routes}"

def test_version_manifest_endpoints():
    """Verify release manifest is accessible with and without /api prefix."""
    for path in ["/version", "/api/version"]:
        res = client.get(path)
        assert res.status_code == 200, f"Failed at {path}: {res.status_code}"
        data = res.json()
        assert data.get("service") == "meribaari-api"
        assert "version" in data
        assert "api_contract_version" in data
        assert "compatible_frontend_range" in data

def test_health_endpoints():
    """Verify health endpoints return ok at both paths."""
    for path in ["/health", "/api/health"]:
        res = client.get(path)
        assert res.status_code == 200
        assert res.json().get("status") in ("ok", "degraded")

def test_critical_endpoints_registered_at_both_prefixes():
    """Verify that critical endpoints exist at both /api and root prefixes and do not 404."""
    # Test POST /reception/add-patient and /api/reception/add-patient
    for path in ["/reception/add-patient", "/api/reception/add-patient"]:
        res = client.post(path, json={})
        # Should return 401 (Unauthorized) or 400 (Validation), NEVER 404!
        assert res.status_code in (401, 400, 422), f"{path} returned unexpected {res.status_code} (wanted not 404)"

    # Test GET /reception/queue and /api/reception/queue
    for path in ["/reception/queue", "/api/reception/queue"]:
        res = client.get(path)
        assert res.status_code in (401, 400, 422), f"{path} returned unexpected {res.status_code} (wanted not 404)"

    # Test POST /hospital/validate-id and /api/hospital/validate-id
    for path in ["/hospital/validate-id", "/api/hospital/validate-id"]:
        res = client.post(path, json={})
        assert res.status_code in (400, 422), f"{path} returned unexpected {res.status_code} (wanted not 404)"
