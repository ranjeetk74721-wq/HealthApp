"""
Focused regression and verification test suite for:
- Feature 1: Patient Status Correction & Accidental Skip Recovery (Doctor & Receptionist)
- Feature 2: Doctor Self-Profile Update (Strict ownership, validation, password security)
- Feature 3: Doctor-Only Receptionist Account Management (Hospital scope, view, update, status)
- Feature 4: Role-Based Access Control
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from fastapi import HTTPException
import server
from server import (
    correct_appointment_status,
    CorrectStatusBody,
    doctor_update_profile,
    DoctorSelfUpdateBody,
    doctor_get_receptionist,
    doctor_update_receptionist,
    DoctorUpdateReceptionistBody,
    hash_password,
    verify_password,
)


class MockCollection:
    def __init__(self, items=None):
        self.items = list(items or [])

    async def find_one(self, filter_dict, projection=None, sort=None):
        def matches(doc, flt):
            for k, v in flt.items():
                if k == "$or":
                    if not any(matches(doc, cond) for cond in v):
                        return False
                elif isinstance(v, dict):
                    if "$in" in v:
                        if doc.get(k) not in v["$in"]:
                            return False
                    elif "$ne" in v:
                        if doc.get(k) == v["$ne"]:
                            return False
                    elif "$regex" in v:
                        import re
                        pattern = v["$regex"]
                        flags = re.IGNORECASE if v.get("$options") == "i" else 0
                        val = str(doc.get(k) or "")
                        if not re.search(pattern, val, flags):
                            return False
                else:
                    if doc.get(k) != v:
                        return False
            return True

        matching = [item for item in self.items if matches(item, filter_dict)]
        if not matching:
            return None
        res = dict(matching[0])
        if projection:
            if projection.get("_id") == 0:
                res.pop("_id", None)
            if projection.get("password_hash") == 0:
                res.pop("password_hash", None)
        return res

    async def insert_one(self, doc):
        d = dict(doc)
        self.items.append(d)
        return MagicMock(inserted_id="mock_id")

    async def update_one(self, filter_dict, update_dict, upsert=False):
        for item in self.items:
            matches_all = True
            for k, v in filter_dict.items():
                if k == "$or":
                    pass
                elif item.get(k) != v:
                    matches_all = False
                    break
            if matches_all:
                if "$set" in update_dict:
                    item.update(update_dict["$set"])
                if "$push" in update_dict:
                    for pk, pv in update_dict["$push"].items():
                        if pk not in item:
                            item[pk] = []
                        item[pk].append(pv)
                return MagicMock(modified_count=1)
        if upsert:
            new_item = {}
            if "$set" in update_dict:
                new_item.update(update_dict["$set"])
            self.items.append(new_item)
            return MagicMock(modified_count=1)
        return MagicMock(modified_count=0)

    async def find(self, filter_dict=None, projection=None):
        flt = filter_dict or {}
        results = [dict(item) for item in self.items]
        mock_cursor = MagicMock()
        mock_cursor.sort = MagicMock(return_value=mock_cursor)
        async def to_list(limit=None):
            return results
        mock_cursor.to_list = to_list
        return mock_cursor


# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 1: PATIENT STATUS CORRECTION & SKIP RECOVERY TESTS
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_receptionist_restores_accidentally_skipped_patient():
    """Receptionist corrects status of skipped patient back to waiting/arrived."""
    mock_appt = {
        "id": "appt_skip_1",
        "doctor_id": "doc_101",
        "patient_name": "Rohan Gupta",
        "patient_mobile": "9876543210",
        "token_number": 15,
        "date": "2026-10-20",
        "slot": "Evening OPD",
        "session_id": "sess_evening",
        "payment_status": "pending",
        "status": "skipped",
    }
    mock_doctor = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "hospital_id": "HOSP_A",
        "full_name": "Dr. Mariya",
    }
    rec_user = {
        "id": "u_rec_1",
        "role": "receptionist",
        "hospital_id": "HOSP_A",
        "full_name": "Pooja Sharma",
    }

    mock_db = MagicMock()
    mock_db.appointments = MockCollection([mock_appt])
    mock_db.doctors = MockCollection([mock_doctor])
    mock_db.audit_logs = MockCollection([])

    with patch.object(server, "db", mock_db), \
         patch("server.broadcast_doctor_update", new_callable=AsyncMock), \
         patch("server.notify_queue_movement", new_callable=AsyncMock):

        body = CorrectStatusBody(
            appointment_id="appt_skip_1",
            new_status="waiting",
            reason="Accidentally skipped, patient was in waiting room"
        )
        res = await correct_appointment_status(body=body, user=rec_user)

        assert res["ok"] is True
        updated = res["appointment"]
        # Canonical status is arrived (Waiting)
        assert updated["status"] == "arrived"
        # Token number, appointment ID, slot, session are preserved!
        assert updated["token_number"] == 15
        assert updated["id"] == "appt_skip_1"
        assert updated["slot"] == "Evening OPD"
        assert updated["session_id"] == "sess_evening"
        assert updated["patient_mobile"] == "9876543210"
        # Status history appended
        assert "status_history" in updated
        assert len(updated["status_history"]) == 1
        assert updated["status_history"][0]["from_status"] == "skipped"
        assert updated["status_history"][0]["to_status"] == "arrived"
        assert updated["status_history"][0]["changed_by"] == "u_rec_1"


@pytest.mark.asyncio
async def test_doctor_restores_skipped_patient():
    """Doctor directly restores an accidentally skipped patient."""
    mock_appt = {
        "id": "appt_skip_2",
        "doctor_id": "doc_101",
        "patient_name": "Anita Verma",
        "token_number": 8,
        "date": "2026-10-20",
        "status": "skipped",
    }
    mock_doctor = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "hospital_id": "HOSP_A",
    }
    doc_user = {
        "id": "u_doc_101",
        "role": "doctor",
        "hospital_id": "HOSP_A",
        "full_name": "Dr. Mariya",
    }

    mock_db = MagicMock()
    mock_db.appointments = MockCollection([mock_appt])
    mock_db.doctors = MockCollection([mock_doctor])
    mock_db.audit_logs = MockCollection([])

    with patch.object(server, "db", mock_db), \
         patch("server.broadcast_doctor_update", new_callable=AsyncMock), \
         patch("server.notify_queue_movement", new_callable=AsyncMock):

        body = CorrectStatusBody(
            appointment_id="appt_skip_2",
            new_status="arrived",
            reason="Patient arrived after call"
        )
        res = await correct_appointment_status(body=body, user=doc_user)
        assert res["ok"] is True
        assert res["appointment"]["status"] == "arrived"
        assert res["appointment"]["token_number"] == 8


@pytest.mark.asyncio
async def test_status_correction_rejects_unauthorized_cross_hospital():
    """Receptionist or Doctor from hospital B cannot modify patient from hospital A."""
    mock_appt = {
        "id": "appt_1",
        "doctor_id": "doc_101",
        "status": "skipped",
    }
    mock_doctor = {
        "id": "doc_101",
        "hospital_id": "HOSP_A",
    }
    unauth_rec = {
        "id": "u_rec_other",
        "role": "receptionist",
        "hospital_id": "HOSP_B",
    }

    mock_db = MagicMock()
    mock_db.appointments = MockCollection([mock_appt])
    mock_db.doctors = MockCollection([mock_doctor])

    with patch.object(server, "db", mock_db):
        body = CorrectStatusBody(appointment_id="appt_1", new_status="arrived")
        with pytest.raises(HTTPException) as exc_info:
            await correct_appointment_status(body=body, user=unauth_rec)
        assert exc_info.value.status_code == 403


@pytest.mark.asyncio
async def test_status_correction_prevents_completing_while_another_in_consultation():
    """Rule 8: Cannot mark a patient completed if another consultation is actively ongoing."""
    mock_appt_1 = {
        "id": "appt_consulting",
        "doctor_id": "doc_101",
        "date": "2026-10-20",
        "token_number": 5,
        "status": "in_consultation",
    }
    mock_appt_2 = {
        "id": "appt_waiting",
        "doctor_id": "doc_101",
        "date": "2026-10-20",
        "token_number": 6,
        "status": "arrived",
    }
    mock_doctor = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "hospital_id": "HOSP_A",
    }
    user = {"id": "u_doc_101", "role": "doctor", "hospital_id": "HOSP_A"}

    mock_db = MagicMock()
    mock_db.appointments = MockCollection([mock_appt_1, mock_appt_2])
    mock_db.doctors = MockCollection([mock_doctor])

    with patch.object(server, "db", mock_db):
        body = CorrectStatusBody(appointment_id="appt_waiting", new_status="completed")
        with pytest.raises(HTTPException) as exc_info:
            await correct_appointment_status(body=body, user=user)
        assert exc_info.value.status_code == 400
        assert "is actively in consultation" in exc_info.value.detail


@pytest.mark.asyncio
async def test_status_correction_invalid_status_rejected():
    """Invalid status name raises 400."""
    mock_appt = {"id": "appt_1", "doctor_id": "doc_101", "status": "arrived"}
    mock_doctor = {"id": "doc_101", "user_id": "u_doc_101", "hospital_id": "HOSP_A"}
    user = {"id": "u_doc_101", "role": "doctor", "hospital_id": "HOSP_A"}

    mock_db = MagicMock()
    mock_db.appointments = MockCollection([mock_appt])
    mock_db.doctors = MockCollection([mock_doctor])

    with patch.object(server, "db", mock_db):
        body = CorrectStatusBody(appointment_id="appt_1", new_status="non_existent_status")
        with pytest.raises(HTTPException) as exc_info:
            await correct_appointment_status(body=body, user=user)
        assert exc_info.value.status_code == 400


# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 2: DOCTOR PROFILE MANAGEMENT TESTS
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_doctor_update_profile_success():
    """Doctor successfully updates own name, email, specialization, and clinic."""
    mock_user = {
        "id": "u_doc_101",
        "full_name": "Dr. Mariya Khan",
        "email": "mariya@meribaari.com",
        "mobile": "9876543210",
        "role": "doctor",
        "password_hash": hash_password("OldPassword123"),
    }
    mock_doctor = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "full_name": "Dr. Mariya Khan",
        "email": "mariya@meribaari.com",
        "mobile": "9876543210",
        "specialization": "General Physician",
        "clinic_name": "MeriBaari Clinic",
        "fees": 500,
    }

    mock_db = MagicMock()
    mock_db.users = MockCollection([mock_user])
    mock_db.doctors = MockCollection([mock_doctor])
    mock_db.audit_logs = MockCollection([])

    with patch.object(server, "db", mock_db), \
         patch("server.broadcast_doctor_update", new_callable=AsyncMock):

        body = DoctorSelfUpdateBody(
            full_name="Dr. Mariya K. Ahmed",
            email="mariya.ahmed@meribaari.com",
            mobile="9876543211",
            specialization="Senior Consultant Physician",
            clinic_name="Ahmed Medicare Clinic",
            fees=600,
            bio="Experienced family physician with 10+ years experience"
        )
        res = await doctor_update_profile(body=body, user={"id": "u_doc_101", "role": "doctor"})
        assert res["ok"] is True
        doc_updated = res["doctor"]
        assert doc_updated["full_name"] == "Dr. Mariya K. Ahmed"
        assert doc_updated["email"] == "mariya.ahmed@meribaari.com"
        assert doc_updated["specialization"] == "Senior Consultant Physician"
        assert doc_updated["clinic_name"] == "Ahmed Medicare Clinic"
        assert doc_updated["fees"] == 600

        # Also verified in db.users
        u_updated = await mock_db.users.find_one({"id": "u_doc_101"})
        assert u_updated["full_name"] == "Dr. Mariya K. Ahmed"
        assert u_updated["email"] == "mariya.ahmed@meribaari.com"
        assert u_updated["mobile"] == "9876543211"


@pytest.mark.asyncio
async def test_doctor_update_profile_duplicate_email_rejected():
    """Duplicate email registration is rejected with 400."""
    user1 = {"id": "u_doc_1", "email": "doc1@hospital.com", "role": "doctor"}
    user2 = {"id": "u_doc_2", "email": "doc2@hospital.com", "role": "doctor"}
    doc1 = {"id": "d_1", "user_id": "u_doc_1", "email": "doc1@hospital.com"}

    mock_db = MagicMock()
    mock_db.users = MockCollection([user1, user2])
    mock_db.doctors = MockCollection([doc1])

    with patch.object(server, "db", mock_db):
        body = DoctorSelfUpdateBody(email="doc2@hospital.com")
        with pytest.raises(HTTPException) as exc_info:
            await doctor_update_profile(body=body, user={"id": "u_doc_1", "role": "doctor"})
        assert exc_info.value.status_code == 400
        assert "already registered" in exc_info.value.detail


@pytest.mark.asyncio
async def test_doctor_change_password_with_verification():
    """Doctor securely changes password with current password verification."""
    old_hash = hash_password("CurrentSecret123")
    user = {"id": "u_doc_1", "email": "doc1@hospital.com", "password_hash": old_hash, "role": "doctor"}
    doc = {"id": "d_1", "user_id": "u_doc_1"}

    mock_db = MagicMock()
    mock_db.users = MockCollection([user])
    mock_db.doctors = MockCollection([doc])
    mock_db.audit_logs = MockCollection([])

    with patch.object(server, "db", mock_db):
        # 1. Incorrect current password rejected
        body_fail = DoctorSelfUpdateBody(
            current_password="WrongPassword!",
            new_password="NewSecurePassword123"
        )
        with pytest.raises(HTTPException) as exc_info:
            await doctor_update_profile(body=body_fail, user={"id": "u_doc_1", "role": "doctor"})
        assert exc_info.value.status_code == 400
        assert "Current password is incorrect" in exc_info.value.detail

        # 2. Correct current password succeeds
        body_success = DoctorSelfUpdateBody(
            current_password="CurrentSecret123",
            new_password="NewSecurePassword123"
        )
        res = await doctor_update_profile(body=body_success, user={"id": "u_doc_1", "role": "doctor"})
        assert res["ok"] is True
        updated_u = await mock_db.users.find_one({"id": "u_doc_1"})
        assert verify_password("NewSecurePassword123", updated_u["password_hash"])
        assert not verify_password("CurrentSecret123", updated_u["password_hash"])


# ─────────────────────────────────────────────────────────────────────────────
# FEATURE 3: RECEPTIONIST MANAGEMENT TESTS
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_doctor_view_and_update_receptionist():
    """Doctor views and updates assigned receptionist's name, email, mobile, and status."""
    rec = {
        "id": "rec_001",
        "full_name": "Priya Sharma",
        "email": "priya@hospa.com",
        "mobile": "9876543200",
        "hospital_id": "HOSP_A",
        "doctor_id": "u_doc_101",
        "role": "receptionist",
        "status": "active",
        "login_disabled": False,
        "password_hash": hash_password("Secret123"),
    }
    doctor = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "hospital_id": "HOSP_A",
    }
    doc_user = {"id": "u_doc_101", "role": "doctor", "hospital_id": "HOSP_A"}

    mock_db = MagicMock()
    mock_db.users = MockCollection([rec])
    mock_db.doctors = MockCollection([doctor])
    mock_db.audit_logs = MockCollection([])

    with patch.object(server, "db", mock_db):
        # View
        view_res = await doctor_get_receptionist(receptionist_id="rec_001", user=doc_user)
        assert view_res["full_name"] == "Priya Sharma"
        assert "password_hash" not in view_res

        # Update
        update_body = DoctorUpdateReceptionistBody(
            full_name="Priya S. Verma",
            email="priya.verma@hospa.com",
            mobile="9876543299",
            status="inactive"
        )
        update_res = await doctor_update_receptionist(receptionist_id="rec_001", body=update_body, user=doc_user)
        assert update_res["ok"] is True
        updated_rec = update_res["receptionist"]
        assert updated_rec["full_name"] == "Priya S. Verma"
        assert updated_rec["email"] == "priya.verma@hospa.com"
        assert updated_rec["mobile"] == "9876543299"
        assert updated_rec["status"] == "inactive"
        assert updated_rec["login_disabled"] is True
        assert "password_hash" not in updated_rec


@pytest.mark.asyncio
async def test_doctor_cannot_edit_receptionist_from_another_hospital():
    """Doctor from HOSPITAL_A cannot edit receptionist belonging to HOSPITAL_B."""
    rec_other = {
        "id": "rec_other_hosp",
        "full_name": "Rahul Kumar",
        "email": "rahul@hospb.com",
        "hospital_id": "HOSP_B",
        "doctor_id": "u_doc_other",
        "role": "receptionist",
    }
    doctor_a = {
        "id": "doc_101",
        "user_id": "u_doc_101",
        "hospital_id": "HOSP_A",
    }
    doc_user_a = {"id": "u_doc_101", "role": "doctor", "hospital_id": "HOSP_A"}

    mock_db = MagicMock()
    mock_db.users = MockCollection([rec_other])
    mock_db.doctors = MockCollection([doctor_a])

    with patch.object(server, "db", mock_db):
        update_body = DoctorUpdateReceptionistBody(full_name="Hacked Name")
        with pytest.raises(HTTPException) as exc_info:
            await doctor_update_receptionist(receptionist_id="rec_other_hosp", body=update_body, user=doc_user_a)
        assert exc_info.value.status_code == 403
        assert "another hospital" in exc_info.value.detail
