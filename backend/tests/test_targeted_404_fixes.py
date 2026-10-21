import pytest
import uuid
from unittest.mock import AsyncMock, patch, MagicMock
from starlette.testclient import TestClient
import server
from server import app, now_iso, AddPatientBody, reception_add_patient


@pytest.fixture(scope="module")
def client():
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(scope="module")
def auth_headers():
    """Create a valid receptionist JWT token header."""
    rec_id = str(uuid.uuid4())
    import jwt, os
    jwt_secret = os.environ.get("JWT_SECRET", "iuewbfjndweojweihbwefiwehfbwefniufweuf_2324sbfubfnu_2324_990")
    token = jwt.encode(
        {"user_id": rec_id, "id": rec_id, "role": "receptionist", "hospital_id": "test-hosp-404"},
        jwt_secret,
        algorithm="HS256"
    )
    return {"Authorization": f"Bearer {token}"}


class MockCollection:
    def __init__(self, items=None):
        self.items = list(items or [])

    async def find_one(self, filter_dict, projection=None, sort=None):
        for item in self.items:
            match = True
            for k, v in filter_dict.items():
                if k == "$or":
                    if not any(all(item.get(k2) == v2 for k2, v2 in cond.items()) for cond in v):
                        match = False
                        break
                elif item.get(k) != v:
                    match = False
                    break
            if match:
                res = dict(item)
                if projection and projection.get("_id") == 0:
                    res.pop("_id", None)
                return res
        return None

    async def insert_one(self, doc):
        d = dict(doc)
        if "_id" not in d:
            d["_id"] = str(uuid.uuid4())
        self.items.append(d)
        mock_res = MagicMock()
        mock_res.inserted_id = d["_id"]
        return mock_res

    async def update_one(self, filter_dict, update_dict, upsert=False):
        doc = await self.find_one(filter_dict)
        if doc:
            if "$set" in update_dict:
                doc.update(update_dict["$set"])
            if "$inc" in update_dict:
                for k, v in update_dict["$inc"].items():
                    doc[k] = doc.get(k, 0) + v
            return MagicMock(modified_count=1)
        elif upsert:
            new_doc = dict(filter_dict)
            if "$set" in update_dict:
                new_doc.update(update_dict["$set"])
            if "$inc" in update_dict:
                for k, v in update_dict["$inc"].items():
                    new_doc[k] = v
            await self.insert_one(new_doc)
            return MagicMock(upserted_id="mock_id")
        return MagicMock(modified_count=0)

    async def find_one_and_update(self, filter_dict, update_dict, **kwargs):
        doc = await self.find_one(filter_dict)
        if not doc:
            new_doc = dict(filter_dict)
            if "$setOnInsert" in update_dict:
                new_doc.update(update_dict["$setOnInsert"])
            if "$inc" in update_dict:
                for k, v in update_dict["$inc"].items():
                    new_doc[k] = v
            await self.insert_one(new_doc)
            return new_doc
        else:
            if "$inc" in update_dict:
                for k, v in update_dict["$inc"].items():
                    doc[k] = doc.get(k, 0) + v
            if "$set" in update_dict:
                doc.update(update_dict["$set"])
            return doc

    def find(self, filter_dict=None, projection=None):
        flt = filter_dict or {}
        matched = []
        for item in self.items:
            m = True
            for k, v in flt.items():
                if item.get(k) != v:
                    m = False
                    break
            if m:
                d = dict(item)
                if projection and projection.get("_id") == 0:
                    d.pop("_id", None)
                matched.append(d)
        mock_cursor = MagicMock()
        mock_cursor.to_list = AsyncMock(return_value=matched)
        mock_cursor.sort = MagicMock(return_value=mock_cursor)
        return mock_cursor


class MockDatabase:
    def __init__(self, collections):
        self.collections = collections

    def __getattr__(self, name):
        return self.collections.setdefault(name, MockCollection([]))

    def __getitem__(self, name):
        return self.collections.setdefault(name, MockCollection([]))


class TestDoctorWebSocketEndpoint:
    """Tests for Doctor Live Queue WebSocket Handshake and Route Resolution."""

    def test_ws_doctor_queue_api_prefix(self, client):
        """Verify handshake at /api/ws/queue/doctor/{doctor_id} connects successfully."""
        doc_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/ws/queue/doctor/{doc_id}") as ws:
            connected_msg = ws.receive_json()
            assert connected_msg["type"] == "connected"
            assert connected_msg["channel"] == f"doctor:{doc_id}"

            # Verify ping-pong heartbeat
            ws.send_text("ping")
            pong = ws.receive_json()
            assert pong["type"] == "pong"
            assert "ts" in pong

    def test_ws_doctor_queue_no_prefix(self, client):
        """Verify handshake at /ws/queue/doctor/{doctor_id} connects successfully."""
        doc_id = str(uuid.uuid4())
        with client.websocket_connect(f"/ws/queue/doctor/{doc_id}") as ws:
            connected_msg = ws.receive_json()
            assert connected_msg["type"] == "connected"
            assert connected_msg["channel"] == f"doctor:{doc_id}"

    def test_ws_appt_queue_api_prefix(self, client):
        """Verify handshake at /api/ws/queue/appt/{appt_id} connects successfully."""
        appt_id = str(uuid.uuid4())
        with client.websocket_connect(f"/api/ws/queue/appt/{appt_id}") as ws:
            connected_msg = ws.receive_json()
            assert connected_msg["type"] == "connected"
            assert connected_msg["channel"] == f"appt:{appt_id}"

    def test_ws_doctor_http_get_returns_426_upgrade_required(self, client):
        """Verify that an HTTP GET request to the WebSocket route returns RFC-compliant 426 Upgrade Required."""
        doc_id = str(uuid.uuid4())
        res1 = client.get(f"/api/ws/queue/doctor/{doc_id}")
        assert res1.status_code == 426
        assert res1.json()["detail"] == "WebSocket Upgrade Required"
        assert res1.headers.get("Upgrade") == "websocket"

        res2 = client.get(f"/ws/queue/doctor/{doc_id}")
        assert res2.status_code == 426
        assert res2.json()["detail"] == "WebSocket Upgrade Required"


class TestReceptionAddPatientEndpoint:
    """Tests for Receptionist Add Patient API route resolution and execution."""

    def test_add_patient_route_resolution_both_prefixes(self, client):
        """Verify that both /api/reception/add-patient and /reception/add-patient return 401 on missing auth, NOT 404."""
        res_api = client.post("/api/reception/add-patient", json={})
        assert res_api.status_code == 401

        res_no_api = client.post("/reception/add-patient", json={})
        assert res_no_api.status_code == 401

    @pytest.mark.asyncio
    async def test_add_patient_success_with_mobile(self):
        """Verify adding a patient with mobile number succeeds and allocates token."""
        doc_id = "doc-test-123"
        sess_id = "sess-test-123"
        
        mock_doctors = MockCollection([{
            "id": doc_id,
            "full_name": "Dr. Test Doctor",
            "name": "Dr. Test Doctor",
            "hospital_id": "test-hosp-404",
            "status": "active"
        }])
        mock_schedules = MockCollection([{
            "id": sess_id,
            "doctor_id": doc_id,
            "session_name": "Morning Session",
            "date_type": "all_days",
            "active": True
        }])
        mock_users = MockCollection([])
        mock_appts = MockCollection([])
        mock_tokens = MockCollection([])

        receptionist_user = {
            "id": "rec-001",
            "role": "receptionist",
            "hospital_id": "test-hosp-404",
            "hospital_code": "test-hosp-404",
            "full_name": "Test Receptionist"
        }

        body = AddPatientBody(
            full_name="Rajesh Sharma",
            mobile="9876543210",
            age=35,
            gender="male",
            doctor_id=doc_id,
            session_id=sess_id,
            consultation_mode="walk_in",
            date="2026-10-20"
        )

        mock_db = MockDatabase({
            "doctors": mock_doctors,
            "doctor_schedule_configs": mock_schedules,
            "clinic_sessions": mock_schedules,
            "users": mock_users,
            "appointments": mock_appts,
            "token_sequences": mock_tokens,
        })

        with patch("server.db", mock_db), \
             patch("server.get_database", return_value=mock_db), \
             patch("server.broadcast_doctor_update", new_callable=AsyncMock), \
             patch("server.notify_queue_movement", new_callable=AsyncMock):
            
            res = await reception_add_patient(body, user=receptionist_user)
            assert res["ok"] is True
            assert res["patient"]["full_name"] == "Rajesh Sharma"
            assert res["patient"]["mobile"] in ("9876543210", "+919876543210")
            assert res["appointment"]["token_number"] == 1
            assert res["appointment"]["status"] == "arrived"

    @pytest.mark.asyncio
    async def test_add_patient_success_without_mobile(self):
        """Verify walk-in consultation without mobile number succeeds with assigned token."""
        doc_id = "doc-test-123"
        sess_id = "sess-test-123"

        mock_doctors = MockCollection([{
            "id": doc_id,
            "full_name": "Dr. Test Doctor",
            "name": "Dr. Test Doctor",
            "hospital_id": "test-hosp-404",
            "status": "active"
        }])
        mock_schedules = MockCollection([{
            "id": sess_id,
            "doctor_id": doc_id,
            "session_name": "Morning Session",
            "date_type": "all_days",
            "active": True
        }])
        mock_users = MockCollection([])
        mock_appts = MockCollection([])
        mock_tokens = MockCollection([])

        receptionist_user = {
            "id": "rec-001",
            "role": "receptionist",
            "hospital_id": "test-hosp-404",
            "hospital_code": "test-hosp-404",
            "full_name": "Test Receptionist"
        }

        body = AddPatientBody(
            full_name="Pooja Verma",
            age=28,
            gender="female",
            doctor_id=doc_id,
            session_id=sess_id,
            consultation_mode="no_mobile",
            date="2026-10-20"
        )

        mock_db = MockDatabase({
            "doctors": mock_doctors,
            "doctor_schedule_configs": mock_schedules,
            "clinic_sessions": mock_schedules,
            "users": mock_users,
            "appointments": mock_appts,
            "token_sequences": mock_tokens,
        })

        with patch("server.db", mock_db), \
             patch("server.get_database", return_value=mock_db), \
             patch("server.broadcast_doctor_update", new_callable=AsyncMock), \
             patch("server.notify_queue_movement", new_callable=AsyncMock):

            res = await reception_add_patient(body, user=receptionist_user)
            assert res["ok"] is True
            assert res["patient"]["full_name"] == "Pooja Verma"
            assert res["patient"]["mobile"] is None
            assert res["appointment"]["token_number"] == 1
            assert res["appointment"]["consultation_mode"] == "no_mobile"
