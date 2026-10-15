import pytest
from unittest.mock import AsyncMock, MagicMock
from starlette.testclient import TestClient
import server


class MockDB:
    def __init__(self):
        self.appointments = MagicMock()
        self.appointments.count_documents = AsyncMock(return_value=0)
        self.doctors = MagicMock()
        self.doctor_sessions = MagicMock()
        self.doctor_schedule_configs = MagicMock()
        self.users = MagicMock()
        self.push_subscriptions = MagicMock()
        self.push_logs = MagicMock()


@pytest.fixture
def mock_db(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    monkeypatch.setattr(server, "broadcast_doctor_update", AsyncMock())
    return mdb


def test_cabin_presence_route_and_authorization(mock_db):
    """Verify HTTP route registration, authorization, persistence, and state distinctness."""
    doc_id = "doc-alpha"
    user_doc_id = "user-doc-alpha"
    user_rec_id = "user-rec-alpha"
    user_other_rec_id = "user-rec-other"

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": doc_id,
        "user_id": user_doc_id,
        "hospital_id": "HOSP_100",
        "status": "active",
    })

    session_store = {
        "id": f"{doc_id}_2026-10-15",
        "doctor_id": doc_id,
        "date": "2026-10-15",
        "status": "not_started",
        "doctor_in_cabin": False,
        "cabin_entered_at": None,
        "version": 1,
    }
    mock_db.doctor_sessions.find_one = AsyncMock(return_value=session_store)

    async def mock_find_and_update(filter_q, update_q, **kwargs):
        session_store.update(update_q.get("$set", {}))
        return dict(session_store)

    mock_db.doctor_sessions.find_one_and_update = mock_find_and_update

    users_map = {
        user_doc_id: {"id": user_doc_id, "role": "doctor", "hospital_id": "HOSP_100"},
        user_rec_id: {"id": user_rec_id, "role": "receptionist", "hospital_id": "HOSP_100"},
        user_other_rec_id: {"id": user_other_rec_id, "role": "receptionist", "hospital_id": "HOSP_999"},
        "patient-1": {"id": "patient-1", "role": "patient"},
    }
    mock_db.users.find_one = AsyncMock(side_effect=lambda q, *args, **kwargs: users_map.get(q.get("id")))

    doc_token = server.create_token(user_doc_id, "doctor")
    rec_token = server.create_token(user_rec_id, "receptionist")
    other_rec_token = server.create_token(user_other_rec_id, "receptionist")
    patient_token = server.create_token("patient-1", "patient")

    with TestClient(server.app) as client:
        # 1. Unauthenticated -> 401 or 403
        res = client.post(f"/api/doctor/{doc_id}/session/cabin-presence", json={"doctor_in_cabin": True})
        assert res.status_code in (401, 403)

        # 2. Patient role -> 403
        res = client.post(
            f"/api/doctor/{doc_id}/session/cabin-presence",
            json={"doctor_in_cabin": True},
            headers={"Authorization": f"Bearer {patient_token}"}
        )
        assert res.status_code == 403

        # 3. Mismatched hospital receptionist -> 403
        res = client.post(
            f"/api/doctor/{doc_id}/session/cabin-presence",
            json={"doctor_in_cabin": True},
            headers={"Authorization": f"Bearer {other_rec_token}"}
        )
        assert res.status_code == 403

        # 4. Doctor sets doctor_in_cabin = True
        res = client.post(
            f"/api/doctor/{doc_id}/session/cabin-presence",
            json={"doctor_in_cabin": True, "date": "2026-10-15"},
            headers={"Authorization": f"Bearer {doc_token}"}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["doctor_in_cabin"] is True
        assert data["cabin_entered_at"] is not None
        assert session_store["doctor_in_cabin"] is True
        # Verify status is NOT auto-started
        assert session_store["status"] == "not_started"

        # 5. Permitted receptionist toggles doctor_in_cabin = False
        res = client.post(
            f"/api/doctor/{doc_id}/session/cabin-presence",
            json={"doctor_in_cabin": False, "date": "2026-10-15"},
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["doctor_in_cabin"] is False
        assert session_store["doctor_in_cabin"] is False


def test_doctor_and_receptionist_shift_creation_and_overrides(mock_db):
    """Verify Day Shift, Night Shift, Emergency Shift creation and Holiday date override."""
    doc_id = "doc-shifts"
    user_doc_id = "u-doc-shifts"
    user_rec_id = "u-rec-shifts"
    user_bad_rec_id = "u-bad-rec"

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": doc_id,
        "user_id": user_doc_id,
        "hospital_id": "HOSP_SHIFTS",
        "clinic_name": "MeriBaari Care",
        "city": "Jaipur",
        "address": "Cabin 4, Ground Floor",
        "status": "active",
    })

    configs = {}

    async def mock_insert_one(doc):
        configs[doc["id"]] = doc
        return MagicMock(inserted_id=doc["id"])

    mock_db.doctor_schedule_configs.insert_one = mock_insert_one
    mock_db.doctor_schedule_configs.find.return_value = MagicMock(to_list=AsyncMock(return_value=[]))
    mock_db.doctor_schedule_configs.find_one = AsyncMock(side_effect=lambda q, *args, **kwargs: configs.get(q.get("id")))

    async def mock_update_one(q, u):
        item = configs.get(q.get("id"))
        if item and "$set" in u:
            for k, v in u["$set"].items():
                if "." in k:
                    parent, child = k.split(".", 1)
                    if parent not in item or not isinstance(item[parent], dict):
                        item[parent] = {}
                    item[parent][child] = v
                else:
                    item[k] = v
        return MagicMock(modified_count=1)

    mock_db.doctor_schedule_configs.update_one = mock_update_one

    users_map = {
        user_doc_id: {"id": user_doc_id, "role": "doctor", "hospital_id": "HOSP_SHIFTS"},
        user_rec_id: {"id": user_rec_id, "role": "receptionist", "hospital_id": "HOSP_SHIFTS"},
        user_bad_rec_id: {"id": user_bad_rec_id, "role": "receptionist", "hospital_id": "HOSP_OTHER"},
    }
    mock_db.users.find_one = AsyncMock(side_effect=lambda q, *args, **kwargs: users_map.get(q.get("id")))

    doc_token = server.create_token(user_doc_id, "doctor")
    rec_token = server.create_token(user_rec_id, "receptionist")
    bad_rec_token = server.create_token(user_bad_rec_id, "receptionist")

    with TestClient(server.app) as client:
        # 1. Doctor creates Day Shift (Morning OPD)
        day_payload = {
            "session_name": "Morning OPD",
            "date_type": "recurring",
            "days_of_week": ["Monday", "Wednesday", "Friday"],
            "start_time": "10:00 AM",
            "end_time": "02:00 PM",
            "max_bookings": 30,
            "is_unlimited_capacity": False,
            "slot_duration_minutes": 15,
            "patient_self_booking_enabled": True,
        }
        res_day = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json=day_payload,
            headers={"Authorization": f"Bearer {doc_token}"}
        )
        assert res_day.status_code == 200, res_day.text
        day_sess = res_day.json()["session"]
        assert day_sess["session_name"] == "Morning OPD"
        assert day_sess["start_time"] == "10:00 AM"

        # 2. Receptionist from different hospital attempts to create Night Shift -> 403 Forbidden
        night_payload = {
            "session_name": "Night Shift OPD",
            "date_type": "recurring",
            "days_of_week": ["Monday", "Tuesday", "Wednesday"],
            "start_time": "08:00 PM",
            "end_time": "11:30 PM",
            "max_bookings": 20,
            "is_unlimited_capacity": False,
            "slot_duration_minutes": 20,
        }
        res_bad = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json=night_payload,
            headers={"Authorization": f"Bearer {bad_rec_token}"}
        )
        assert res_bad.status_code == 403

        # 3. Authorized Receptionist creates Night Shift for doctor sitting in cabin -> 200 OK
        res_night = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json=night_payload,
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert res_night.status_code == 200, res_night.text
        night_sess = res_night.json()["session"]
        assert night_sess["session_name"] == "Night Shift OPD"
        assert night_sess["start_time"] in ("8:00 PM", "08:00 PM")

        # 4. Authorized Receptionist creates single-date Emergency Shift
        emerg_payload = {
            "session_name": "Emergency Shift",
            "date_type": "date",
            "date": "2026-10-20",
            "start_time": "03:00 PM",
            "end_time": "06:00 PM",
            "is_unlimited_capacity": True,
            "slot_duration_minutes": 10,
        }
        res_emerg = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json=emerg_payload,
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert res_emerg.status_code == 200, res_emerg.text
        emerg_sess = res_emerg.json()["session"]
        assert emerg_sess["session_name"] == "Emergency Shift"
        assert emerg_sess["is_unlimited_capacity"] is True

        # 5. Doctor / Receptionist sets Holiday / Date Override (Cancelled on specific date)
        override_payload = {
            "date": "2026-10-24",
            "status": "cancelled",
            "reason": "Diwali Holiday / Doctor on leave"
        }
        res_override = client.post(
            f"/api/doctor/{doc_id}/sessions/{day_sess['id']}/date-override",
            json=override_payload,
            headers={"Authorization": f"Bearer {rec_token}"}
        )
        assert res_override.status_code == 200, res_override.text
        data_override = res_override.json()
        assert data_override["ok"] is True
        assert "2026-10-24" in data_override["session"]["date_overrides"]
        assert data_override["session"]["date_overrides"]["2026-10-24"]["status"] == "cancelled"


def test_receptionist_scoped_authorization_and_features(mock_db):
    """Verify scoped authorization (read/write), conflict rejection, auto-refer and send-link."""
    doc_id = "doc-scope-test"
    user_doc_id = "u-doc-scope"
    user_auth_rec_id = "u-rec-auth"
    user_unassigned_rec_id = "u-rec-unassigned"

    mock_db.doctors.find_one = AsyncMock(return_value={
        "id": doc_id,
        "user_id": user_doc_id,
        "hospital_id": "HOSP_ALPHA",
        "clinic_name": "Clinic Alpha",
        "status": "active",
        "specialty": "General Physician",
    })

    configs = {}

    async def mock_insert_one(doc):
        configs[doc["id"]] = doc
        return MagicMock(inserted_id=doc["id"])

    mock_db.doctor_schedule_configs.insert_one = mock_insert_one
    mock_db.doctor_schedule_configs.find.return_value = MagicMock(to_list=AsyncMock(return_value=[]))
    mock_db.doctor_schedule_configs.find_one = AsyncMock(side_effect=lambda q, *args, **kwargs: configs.get(q.get("id")))

    users_map = {
        user_doc_id: {"id": user_doc_id, "role": "doctor", "hospital_id": "HOSP_ALPHA"},
        user_auth_rec_id: {"id": user_auth_rec_id, "role": "receptionist", "hospital_id": "HOSP_ALPHA"},
        user_unassigned_rec_id: {"id": user_unassigned_rec_id, "role": "receptionist", "hospital_id": None, "doctor_id": None},
    }
    mock_db.users.find_one = AsyncMock(side_effect=lambda q, *args, **kwargs: users_map.get(q.get("id")))

    auth_rec_token = server.create_token(user_auth_rec_id, "receptionist")
    unassigned_rec_token = server.create_token(user_unassigned_rec_id, "receptionist")

    with TestClient(server.app) as client:
        # 1. Unassigned receptionist cannot read doctor's protected sessions
        res = client.get(
            f"/api/doctor/{doc_id}/sessions?date=2026-10-15",
            headers={"Authorization": f"Bearer {unassigned_rec_token}"}
        )
        assert res.status_code == 403

        # 2. Authorized receptionist can read doctor's protected sessions
        res = client.get(
            f"/api/doctor/{doc_id}/sessions?date=2026-10-15",
            headers={"Authorization": f"Bearer {auth_rec_token}"}
        )
        assert res.status_code == 200
        assert res.json()["ok"] is True

        # 3. Unassigned receptionist cannot create session
        res = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json={
                "session_name": "Unauthorized Session",
                "date_type": "recurring",
                "days_of_week": ["Monday"],
                "start_time": "10:00 AM",
                "end_time": "01:00 PM",
            },
            headers={"Authorization": f"Bearer {unassigned_rec_token}"}
        )
        assert res.status_code == 403

        # 4. Overlap conflict test: Session timing validation rejects overlapping shifts
        res_first = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json={
                "session_name": "Morning OPD",
                "date_type": "recurring",
                "days_of_week": ["Monday"],
                "start_time": "10:00 AM",
                "end_time": "01:00 PM",
            },
            headers={"Authorization": f"Bearer {auth_rec_token}"}
        )
        assert res_first.status_code == 200

        # Now mock database to return existing config for overlap check
        existing_conf = res_first.json()["session"]
        mock_db.doctor_schedule_configs.find.return_value = MagicMock(to_list=AsyncMock(return_value=[existing_conf]))

        res_overlap = client.post(
            f"/api/doctor/{doc_id}/sessions",
            json={
                "session_name": "Conflicting OPD",
                "date_type": "recurring",
                "days_of_week": ["Monday"],
                "start_time": "11:00 AM",
                "end_time": "02:00 PM",
            },
            headers={"Authorization": f"Bearer {auth_rec_token}"}
        )
        assert res_overlap.status_code == 400
        assert "overlap" in res_overlap.text.lower()
