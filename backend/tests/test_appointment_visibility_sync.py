import re
import pytest
from unittest.mock import AsyncMock, patch
from fastapi import HTTPException
from server import reception_queue, calendar_summary, doctor_appointments, reception_doctors


class MockCollection:
    def __init__(self, data=None):
        self._data = list(data or [])

    async def to_list(self, length=None):
        if length is not None:
            return self._data[:length]
        return list(self._data)

    def sort(self, *args, **kwargs):
        return self

    async def find_one(self, query=None, projection=None):
        query = query or {}
        for item in self._data:
            match = True
            if "$or" in query:
                or_matches = False
                for clause in query["$or"]:
                    clause_match = all(item.get(k) == v for k, v in clause.items())
                    if clause_match:
                        or_matches = True
                        break
                if not or_matches:
                    match = False
            else:
                for k, v in query.items():
                    if k.startswith("$"):
                        continue
                    if isinstance(v, dict) and "$in" in v:
                        if item.get(k) not in v["$in"]:
                            match = False
                            break
                    elif item.get(k) != v:
                        match = False
                        break
            if match:
                res = dict(item)
                if projection and "_id" in projection and projection["_id"] == 0:
                    res.pop("_id", None)
                return res
        return None

    def find(self, query=None, projection=None):
        query = query or {}
        results = []
        for item in self._data:
            match = True
            if "$or" in query:
                or_matches = any(item.get(k) == v for clause in query["$or"] for k, v in clause.items())
                if not or_matches:
                    match = False
            if "$and" in query:
                and_matches = True
                for clause in query["$and"]:
                    if "$or" in clause:
                        clause_match = any(
                            (item.get(k) == v or (isinstance(v, dict) and "$regex" in v and bool(re.search(v["$regex"], str(item.get(k, ""))))))
                            for c in clause["$or"] for k, v in c.items()
                        )
                        if not clause_match:
                            and_matches = False
                            break
                if not and_matches:
                    match = False
            for k, v in query.items():
                if k in ("$or", "$and"):
                    continue
                if isinstance(v, dict):
                    if "$in" in v and item.get(k) not in v["$in"]:
                        match = False
                    elif "$ne" in v and item.get(k) == v["$ne"]:
                        match = False
                    elif "$regex" in v and not bool(re.search(v["$regex"], str(item.get(k, "")))):
                        match = False
                elif item.get(k) != v:
                    match = False
            if match:
                res = dict(item)
                if projection and "_id" in projection and projection["_id"] == 0:
                    res.pop("_id", None)
                results.append(res)
        return MockCollection(results)

    async def update_many(self, *args, **kwargs):
        return None

    async def update_one(self, *args, **kwargs):
        return None


class MockDatabase:
    def __init__(self, collections):
        self._collections = collections

    def __getattr__(self, name):
        if name in self._collections:
            return self._collections[name]
        return MockCollection([])


@pytest.mark.asyncio
async def test_reception_queue_and_calendar_summary_dual_id_consistency():
    """Verify that appointments stored with doctor user_id or doc_id are visible
    consistently across both calendar_summary and reception_queue.
    """
    doc_id = "doc_alpha_1"
    doc_user_id = "user_alpha_1"
    hosp_id = "HOSP_METRO"
    target_date = "2026-10-20"

    doctor_record = {
        "id": doc_id,
        "user_id": doc_user_id,
        "hospital_id": hosp_id,
        "full_name": "Dr. Alpha",
        "fees": 500
    }

    # 10 appointments stored with doctor_id = doc_id, 12 stored with doctor_id = doc_user_id
    appointments = []
    for i in range(1, 11):
        appointments.append({
            "id": f"appt_{i}",
            "doctor_id": doc_id,
            "patient_id": f"pat_{i}",
            "patient_name": f"Patient {i}",
            "date": target_date,
            "token_number": i,
            "status": "booked",
            "queue_order": i
        })
    for i in range(11, 23):
        appointments.append({
            "id": f"appt_{i}",
            "doctor_id": doc_user_id,
            "patient_id": f"pat_{i}",
            "patient_name": f"Patient {i}",
            "date": f"{target_date}T00:00:00",  # ISO timestamp variant
            "token_number": i,
            "status": "arrived",
            "queue_order": i
        })

    mock_db = MockDatabase({
        "doctors": MockCollection([doctor_record]),
        "appointments": MockCollection(appointments),
        "users": MockCollection([]),
        "doctor_sessions": MockCollection([]),
    })

    receptionist_user = {
        "id": "rec_001",
        "role": "receptionist",
        "hospital_id": hosp_id,
        "full_name": "Receptionist Rita"
    }

    with patch("server.db", mock_db), \
         patch("server.calculate_appointment_eta", new_callable=AsyncMock) as mock_eta:
        mock_eta.return_value = {
            "expected_turn_time": "11:00 AM",
            "eta_minutes": 15,
            "patients_ahead": 0
        }

        # Query calendar summary for doc_id
        sum_res = await calendar_summary(doctor_id=doc_id, user=receptionist_user)
        assert len(sum_res) == 1
        assert sum_res[0]["date"] == target_date
        assert sum_res[0]["patient_count"] == 22, "Calendar summary must count all 22 appointments across dual IDs"

        # Query reception queue for doc_id
        q_res = await reception_queue(doctor_id=doc_id, date=target_date, user=receptionist_user)
        assert len(q_res) == 22, "Reception queue must return all 22 appointments regardless of whether doctor_id or user_id was stored"


@pytest.mark.asyncio
async def test_reception_queue_unauthorized_doctor_returns_empty():
    """Verify that requesting queue for an unauthorized doctor returns empty list (strict hospital isolation)."""
    mock_db = MockDatabase({
        "doctors": MockCollection([
            {"id": "doc_allowed", "hospital_id": "HOSP_A", "full_name": "Dr. A"},
            {"id": "doc_forbidden", "hospital_id": "HOSP_B", "full_name": "Dr. B"}
        ]),
        "appointments": MockCollection([
            {"id": "appt_b", "doctor_id": "doc_forbidden", "date": "2026-10-20", "status": "booked"}
        ])
    })

    receptionist_user = {
        "id": "rec_001",
        "role": "receptionist",
        "hospital_id": "HOSP_A",
        "full_name": "Receptionist Rita"
    }

    with patch("server.db", mock_db):
        res = await reception_queue(doctor_id="doc_forbidden", date="2026-10-20", user=receptionist_user)
        assert len(res) == 0


@pytest.mark.asyncio
async def test_reception_doctors_matches_hospital_code():
    """Verify that reception_doctors matches doctors by hospital_code if hospital_id is absent."""
    mock_db = MockDatabase({
        "doctors": MockCollection([
            {"id": "doc_code_1", "hospital_code": "CLINIC_XYZ", "full_name": "Dr. XYZ"}
        ]),
        "appointments": MockCollection([])
    })

    receptionist_user = {
        "id": "rec_002",
        "role": "receptionist",
        "hospital_code": "CLINIC_XYZ",
        "full_name": "Receptionist John"
    }

    with patch("server.db", mock_db):
        docs = await reception_doctors(user=receptionist_user)
        assert len(docs) == 1
        assert docs[0]["id"] == "doc_code_1"
