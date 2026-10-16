import os
import sys
import uuid
import json
import gzip
import time
import pytest
from pathlib import Path
from starlette.testclient import TestClient

# Ensure backend root is in sys.path
backend_root = str(Path(__file__).resolve().parent.parent)
if backend_root not in sys.path:
    sys.path.insert(0, backend_root)

mongomock_motor = pytest.importorskip("mongomock_motor")
import server
from server import app, create_token, get_ist_now, now_iso

# Setup an isolated in-memory Mongo database
mock_client = mongomock_motor.AsyncMongoMockClient()
mock_db = mock_client["clinicqueue_test_isolated"]

# Patch database proxy to return mock_db
server.get_database = lambda: mock_db


@pytest.fixture(autouse=True)
def setup_mock_data():
    """Seed base doctor, hospital, receptionist, and patient accounts."""
    import asyncio
    async def _seed():
        # Clear mock collections
        await mock_db.users.drop()
        await mock_db.doctors.drop()
        await mock_db.hospitals.drop()
        await mock_db.appointments.drop()
        await mock_db.token_sequences.drop()
        await mock_db.doctor_schedule_configs.drop()

        # Seed hospital
        hosp_id = "hosp-1"
        await mock_db.hospitals.insert_one({
            "id": hosp_id,
            "name": "Apollo Clinic",
            "city": "Mumbai",
            "is_active": True
        })

        # Seed doctor user & profile
        doc_user_id = "user-doc-1"
        doc_id = "doc-1"
        await mock_db.users.insert_one({
            "id": doc_user_id,
            "full_name": "Dr. Sarah Patel",
            "role": "doctor",
            "mobile": "9876543210",
            "is_active": True,
            "hospital_id": hosp_id,
        })
        await mock_db.doctors.insert_one({
            "id": doc_id,
            "user_id": doc_user_id,
            "hospital_id": hosp_id,
            "full_name": "Dr. Sarah Patel",
            "specialty": "Cardiology",
            "fees": 600,
            "status": "active",
            "timings": "10:00 AM - 02:00 PM",
            "avg_consult_minutes": 15,
        })

        # Seed receptionist user
        rec_id = "rec-1"
        await mock_db.users.insert_one({
            "id": rec_id,
            "full_name": "Rita Reception",
            "role": "receptionist",
            "mobile": "9876500000",
            "hospital_id": hosp_id,
            "is_active": True,
        })

        # Seed patient user
        pat_id = "pat-1"
        await mock_db.users.insert_one({
            "id": pat_id,
            "full_name": "John Doe",
            "role": "patient",
            "mobile": "9123456780",
            "address": "Bandra West, Mumbai",
            "is_active": True,
        })

    asyncio.run(_seed())


def test_1_receptionist_adds_walkin_patient():
    """Verify adding a walk-in patient allocates token number, sets arrived status, and enriches patient."""
    today = get_ist_now().strftime("%Y-%m-%d")
    rec_token = create_token("rec-1", "receptionist")

    with TestClient(app) as client:
        payload = {
            "doctor_id": "doc-1",
            "full_name": "Walkin Patient A",
            "mobile": "9888877771",
            "age": 32,
            "gender": "male",
            "address": "Linking Rd, Mumbai",
            "payment_method": "pay_at_clinic",
            "date": today,
            "fee": 600,
        }
        res = client.post(
            "/api/reception/add-patient",
            json=payload,
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data.get("ok") is True
        appt = data.get("appointment")
        assert appt["patient_name"] == "Walkin Patient A"
        assert appt["status"] == "arrived"
        assert appt["token_number"] == 1


def test_2_patient_online_appointment_booking():
    """Verify patient can book an appointment and gets next token number."""
    today = get_ist_now().strftime("%Y-%m-%d")
    pat_token = create_token("pat-1", "patient")

    with TestClient(app) as client:
        payload = {
            "doctor_id": "doc-1",
            "patient_name": "John Doe",
            "patient_phone": "9123456780",
            "date": today,
            "slot": "10:30 AM",
        }
        res = client.post(
            "/api/appointments",
            json=payload,
            headers={"Authorization": f"Bearer {pat_token}"}
        )
        assert res.status_code == 200, res.text
        data = res.json()
        assert data.get("doctor_id") == "doc-1"
        assert data.get("patient_name") == "John Doe"
        assert data.get("token_number") == 1


def test_3_queue_counts_and_consultation_completion():
    """Verify doctor appointments endpoint returns complete list, token sorting, and consultation completion."""
    today = get_ist_now().strftime("%Y-%m-%d")
    rec_token = create_token("rec-1", "receptionist")
    doc_token = create_token("user-doc-1", "doctor")

    with TestClient(app) as client:
        # Add 2 patients
        p1 = {
            "doctor_id": "doc-1",
            "full_name": "Queue Patient 1",
            "mobile": "9111111111",
            "age": 28,
            "gender": "female",
            "address": "Andheri, Mumbai",
            "payment_method": "pay_at_clinic",
            "date": today,
        }
        p2 = {
            "doctor_id": "doc-1",
            "full_name": "Queue Patient 2",
            "mobile": "9222222222",
            "age": 45,
            "gender": "male",
            "address": "Juhu, Mumbai",
            "payment_method": "pay_at_clinic",
            "date": today,
        }
        r1 = client.post("/api/reception/add-patient", json=p1, headers={"Authorization": f"Bearer {rec_token}"})
        r2 = client.post("/api/reception/add-patient", json=p2, headers={"Authorization": f"Bearer {rec_token}"})
        assert r1.status_code == 200
        assert r2.status_code == 200
        appt1_id = r1.json()["appointment"]["id"]
        appt2_id = r2.json()["appointment"]["id"]

        # Doctor appointments query
        doc_appts = client.get(
            f"/api/doctor/appointments?date={today}",
            headers={"Authorization": f"Bearer {doc_token}"}
        )
        assert doc_appts.status_code == 200
        appts_list = doc_appts.json()
        assert len(appts_list) >= 2
        # Verify token sorting and enrichment
        tokens = [a["token_number"] for a in appts_list]
        assert tokens == sorted(tokens), "Appointments must be sorted by token number"
        assert appts_list[0].get("patient_address") is not None, "Patient address must be enriched"

        # Complete consultation for appt 1
        comp_res = client.post(
            "/api/reception/complete",
            json={"appointment_id": appt1_id},
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert comp_res.status_code == 200
        assert comp_res.json().get("ok") is True

        # Fetch appointments again and verify status changed
        refreshed = client.get(
            f"/api/doctor/appointments?date={today}",
            headers={"Authorization": f"Bearer {doc_token}"}
        )
        updated_list = refreshed.json()
        item1 = next(a for a in updated_list if a["id"] == appt1_id)
        assert item1["status"] == "completed"
        assert item1["payment_status"] == "paid"


def test_4_gzip_compression_performance():
    """Verify GZipMiddleware compresses response payloads > 500 bytes and measures bandwidth reduction."""
    today = get_ist_now().strftime("%Y-%m-%d")
    rec_token = create_token("rec-1", "receptionist")
    doc_token = create_token("user-doc-1", "doctor")

    with TestClient(app) as client:
        # Create 10 patients to produce a realistic response payload (>1KB)
        for i in range(10):
            client.post(
                "/api/reception/add-patient",
                json={
                    "doctor_id": "doc-1",
                    "full_name": f"Gzip Test Patient {i+1}",
                    "mobile": f"90000000{i:02d}",
                    "address": f"Apartment {i+1}, Marine Drive, Mumbai",
                    "payment_method": "pay_at_clinic",
                    "date": today,
                },
                headers={"Authorization": f"Bearer {rec_token}"}
            )

        # 1. Request WITHOUT gzip (explicit identity encoding)
        res_raw = client.get(
            f"/api/doctor/appointments?date={today}",
            headers={"Authorization": f"Bearer {doc_token}", "Accept-Encoding": "identity"}
        )
        raw_size = len(res_raw.content)
        assert res_raw.status_code == 200
        assert "gzip" not in res_raw.headers.get("content-encoding", "")

        # 2. Request WITH gzip
        res_gzip = client.get(
            f"/api/doctor/appointments?date={today}",
            headers={
                "Authorization": f"Bearer {doc_token}",
                "Accept-Encoding": "gzip"
            }
        )
        assert res_gzip.status_code == 200
        assert res_gzip.headers.get("content-encoding") == "gzip"
        gzip_size = int(res_gzip.headers.get("content-length", len(gzip.compress(res_raw.content))))

        # Verify compression ratio
        assert gzip_size < raw_size, f"Gzip ({gzip_size} bytes) should be smaller than raw ({raw_size} bytes)"
        reduction_pct = ((raw_size - gzip_size) / raw_size) * 100
        print(f"\n[PERFORMANCE] Raw payload: {raw_size} bytes | GZip wire payload: {gzip_size} bytes | Bandwidth reduction: {reduction_pct:.1f}%")
        assert reduction_pct > 50.0, "GZip should achieve > 50% bandwidth reduction on JSON"


def test_5_websocket_connection_and_heartbeat_ping():
    """Verify WebSocket connects and handles ping/pong heartbeat properly."""
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws/queue/doctor/doc-1") as ws:
            # First message is connection confirmation
            welcome = ws.receive_json()
            assert welcome["type"] == "connected"
            assert welcome["channel"] == "doctor:doc-1"

            # Client sends ping, server responds with pong
            ws.send_text("ping")
            pong = ws.receive_json()
            assert pong["type"] == "pong"
            assert "ts" in pong


def test_6_frontend_heartbeat_filtering_logic():
    """Unit test the exact frontend heartbeat filtering condition to guarantee heartbeat messages are ignored."""
    def should_trigger_reload(event_data):
        try:
            msg = json.loads(event_data) if isinstance(event_data, str) else event_data
            if msg.get("type") in ("ping", "pong", "connected"):
                return False
        except Exception:
            pass
        return True

    # Heartbeat and connection messages MUST NOT trigger reload
    assert should_trigger_reload('{"type": "ping"}') is False
    assert should_trigger_reload('{"type": "pong", "ts": "2026-10-14T07:00:00Z"}') is False
    assert should_trigger_reload('{"type": "connected", "channel": "doctor:doc-1"}') is False

    # Actual queue events MUST trigger reload
    assert should_trigger_reload('{"type": "booked", "doctor_id": "doc-1"}') is True
    assert should_trigger_reload('{"type": "completed", "doctor_id": "doc-1"}') is True
    assert should_trigger_reload('{"type": "arrived", "doctor_id": "doc-1"}') is True
    assert should_trigger_reload('{"type": "queue_update", "doctor_id": "doc-1"}') is True
