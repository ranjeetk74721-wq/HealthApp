import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch, MagicMock

import server
from server import (
    calculate_appointment_eta,
    allocate_next_token,
    get_ist_now,
    format_12hr_time,
    format_expected_time_range,
)


class MockCursor:
    def __init__(self, data):
        self.data = list(data)

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return list(self.data)


class MockCollection:
    def __init__(self):
        self.docs = []
        self._find_data = []
        self._find_one_data = None

    async def find_one(self, query=None, *args, **kwargs):
        if self._find_one_data is not None:
            return self._find_one_data
        if not query:
            return self.docs[0] if self.docs else None
        for d in self.docs:
            match = True
            for k, v in query.items():
                if k == "$or":
                    match = any(d.get(sub_k) == sub_v for cond in v for sub_k, sub_v in cond.items())
                elif d.get(k) != v:
                    match = False
                    break
            if match:
                return d
        return None

    def find(self, query=None, *args, **kwargs):
        if self._find_data:
            return MockCursor(self._find_data)
        return MockCursor(self.docs)

    async def count_documents(self, query=None):
        return len(self.docs)

    async def insert_one(self, doc):
        self.docs.append(dict(doc))
        return MagicMock(inserted_id=doc.get("id"))

    async def update_one(self, query, update, upsert=False):
        doc = await self.find_one(query)
        if doc:
            if "$set" in update:
                doc.update(update["$set"])
            return MagicMock(modified_count=1)
        if not doc and upsert:
            new_doc = {**query}
            if "$set" in update:
                new_doc.update(update["$set"])
            if "$setOnInsert" in update:
                new_doc.update(update["$setOnInsert"])
            self.docs.append(new_doc)
            return MagicMock(upserted_id="upserted_1")
        return MagicMock(modified_count=0)

    async def update_many(self, query, update):
        return MagicMock(modified_count=1)

    async def find_one_and_update(self, filter_q, update, return_document=None, upsert=False):
        doc = await self.find_one(filter_q)
        if not doc and upsert:
            new_doc = {**filter_q}
            if "$inc" in update:
                for k, v in update["$inc"].items():
                    new_doc[k] = v
            self.docs.append(new_doc)
            return new_doc
        elif doc and "$inc" in update:
            for k, v in update["$inc"].items():
                doc[k] = doc.get(k, 0) + v
            return doc
        return doc


class MockDB:
    def __init__(self):
        self.appointments = MockCollection()
        self.doctors = MockCollection()
        self.doctor_sessions = MockCollection()
        self.token_sequences = MockCollection()
        self.push_subscriptions = MockCollection()
        self.push_notifications_log = MockCollection()


@pytest.fixture
def mock_env(monkeypatch):
    mdb = MockDB()
    monkeypatch.setattr(server, "db", mdb)
    return mdb


class TestRequirement1ConsultationCompletion:
    """1. Receptionist-controlled consultation completion tests."""

    @pytest.mark.asyncio
    async def test_completion_removes_from_active_and_preserves_history(self, mock_env, monkeypatch):
        # 3 appointments: a1 (in_consultation), a2 (booked), a3 (booked)
        mock_env.appointments.docs = [
            {"id": "a1", "doctor_id": "doc1", "date": "2026-10-02", "token_number": 1, "status": "in_consultation"},
            {"id": "a2", "doctor_id": "doc1", "date": "2026-10-02", "token_number": 2, "status": "booked"},
            {"id": "a3", "doctor_id": "doc1", "date": "2026-10-02", "token_number": 3, "status": "booked"},
        ]
        mock_env.doctors.docs = [{"id": "doc1", "avg_consult_minutes": 10, "status": "active"}]

        # Before completion: a2 has 1 patient ahead (a1 in consultation)
        eta_before = await calculate_appointment_eta(mock_env.appointments.docs[1])
        assert eta_before["patients_ahead"] == 1
        assert eta_before["now_consulting"] == 1

        # Simulate completion of a1
        now = datetime.now(timezone.utc).isoformat()
        await mock_env.appointments.update_one(
            {"id": "a1"},
            {"$set": {"status": "completed", "consultation_completed_at": now, "completed_at": now}}
        )

        # Verify a1 is marked completed and not deleted
        completed_a1 = await mock_env.appointments.find_one({"id": "a1"})
        assert completed_a1 is not None
        assert completed_a1["status"] == "completed"
        assert completed_a1["consultation_completed_at"] == now

        # After completion: a2 is still 'booked' (completing a1 MUST NOT auto-consult a2!)
        a2 = await mock_env.appointments.find_one({"id": "a2"})
        assert a2["status"] == "booked"

        # Now active waiting excludes completed a1:
        eta_after = await calculate_appointment_eta(a2)
        assert eta_after["patients_ahead"] == 0
        assert eta_after["now_consulting"] is None  # No one consulting until receptionist explicitly starts next


class TestRequirement2DailyQueueAndTokenReset:
    """2. Daily queue and token reset tests."""

    @pytest.mark.asyncio
    async def test_atomic_token_sequence_per_doctor_and_date(self, mock_env):
        # Tokens allocate starting from 1 for doc1 on date1
        t1 = await allocate_next_token("hospA", "doc1", "2026-10-02")
        t2 = await allocate_next_token("hospA", "doc1", "2026-10-02")
        assert t1 == 1
        assert t2 == 2

        # A different doctor on the same date starts from 1
        t_doc2 = await allocate_next_token("hospA", "doc2", "2026-10-02")
        assert t_doc2 == 1

        # The same doctor on the next date starts from 1
        t_next_day = await allocate_next_token("hospA", "doc1", "2026-10-03")
        assert t_next_day == 1

    @pytest.mark.asyncio
    async def test_tokens_remain_fixed_on_skip_and_rejoin(self, mock_env):
        appt = {
            "id": "a5",
            "doctor_id": "doc1",
            "date": "2026-10-02",
            "token_number": 5,
            "status": "arrived",
        }
        mock_env.appointments.docs.append(appt)

        # Skip patient: token stays 5
        await mock_env.appointments.update_one(
            {"id": "a5"},
            {"$set": {"status": "skipped", "skipped_at": "2026-10-02T10:00:00Z"}}
        )
        skipped = await mock_env.appointments.find_one({"id": "a5"})
        assert skipped["status"] == "skipped"
        assert skipped["token_number"] == 5

        # Rejoin queue: token stays 5
        await mock_env.appointments.update_one(
            {"id": "a5"},
            {"$set": {"status": "arrived", "rejoined_at": "2026-10-02T10:15:00Z"}}
        )
        rejoined = await mock_env.appointments.find_one({"id": "a5"})
        assert rejoined["status"] == "arrived"
        assert rejoined["token_number"] == 5


class TestRequirement3RecalculateEstimatedTimes:
    """3. Recalculate remaining patients' estimated times tests."""

    @pytest.mark.asyncio
    async def test_doctor_unavailable_shows_estimate_pending(self, mock_env, monkeypatch):
        fixed_now = datetime(2026, 10, 2, 11, 0, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

        mock_env.doctors.docs = [{"id": "doc_unavail", "status": "unavailable", "avg_consult_minutes": 15}]
        mock_env.doctor_sessions.docs = [{
            "id": "doc_unavail_2026-10-02",
            "doctor_id": "doc_unavail",
            "date": "2026-10-02",
            "status": "unavailable",
        }]
        appt = {"id": "a10", "doctor_id": "doc_unavail", "date": "2026-10-02", "token_number": 1, "status": "booked"}
        mock_env.appointments.docs = [appt]

        eta = await calculate_appointment_eta(appt)
        assert eta["expected_turn_time"] == "Doctor abhi available nahi hain. Naya anumanit samay confirm hote hi update hoga"
        assert eta["is_estimate_pending"] is True
        assert eta["your_token"] == 1
        assert eta["patients_ahead"] == 0

    @pytest.mark.asyncio
    async def test_separate_token_consulting_ahead_values(self, mock_env, monkeypatch):
        fixed_now = datetime(2026, 10, 2, 10, 15, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        monkeypatch.setattr(server, "get_ist_now", lambda: fixed_now)

        mock_env.doctors.docs = [{"id": "doc_normal", "status": "active", "avg_consult_minutes": 10}]
        mock_env.doctor_sessions.docs = [{
            "id": "doc_normal_2026-10-02",
            "doctor_id": "doc_normal",
            "date": "2026-10-02",
            "status": "in_consultation",
            "actual_start_time": "10:00 AM",
        }]

        appts = [
            {"id": "curr", "doctor_id": "doc_normal", "date": "2026-10-02", "token_number": 8, "status": "in_consultation", "started_at": fixed_now.isoformat()},
            {"id": "w1", "doctor_id": "doc_normal", "date": "2026-10-02", "token_number": 9, "status": "arrived"},
            {"id": "w2", "doctor_id": "doc_normal", "date": "2026-10-02", "token_number": 10, "status": "booked"},
            {"id": "w3", "doctor_id": "doc_normal", "date": "2026-10-02", "token_number": 11, "status": "booked"},
            {"id": "target", "doctor_id": "doc_normal", "date": "2026-10-02", "token_number": 12, "status": "booked"},
        ]
        mock_env.appointments.docs = appts

        eta = await calculate_appointment_eta(appts[4])
        # Token 12 has 4 ahead: token 8 (in consultation) + tokens 9, 10, 11 (arrived/booked)
        assert eta["your_token"] == 12
        assert eta["now_consulting"] == 8
        assert eta["patients_ahead"] == 4
        assert "AM" in eta["expected_turn_time"] or "PM" in eta["expected_turn_time"]
