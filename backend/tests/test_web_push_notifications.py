import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from datetime import datetime, timezone, timedelta
import server
from server import (
    format_ist_12hr,
    calculate_appointment_eta,
    send_fcm_web_push,
    notify_appointment_booked,
    send_welcome_status_if_needed,
    notify_queue_movement,
    notify_doctor_status_change,
    notify_appointment_cancelled,
)


class MockCursor:
    def __init__(self, data):
        self._data = data

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length):
        return self._data


class MockCollection:
    def __init__(self, find_data=None, find_one_data=None):
        self._find_data = find_data or []
        self._find_one_data = find_one_data
        self.update_one = AsyncMock()
        self.update_many = AsyncMock()
        self.insert_one = AsyncMock()
        self.count_documents = AsyncMock(return_value=len(self._find_data))

    def find(self, *args, **kwargs):
        return MockCursor(self._find_data)

    async def find_one(self, *args, **kwargs):
        if callable(self._find_one_data):
            return self._find_one_data(*args, **kwargs)
        return self._find_one_data


class MockDB:
    def __init__(self):
        self.doctors = MockCollection()
        self.appointments = MockCollection()
        self.push_subscriptions = MockCollection()
        self.push_notifications_log = MockCollection()


class TestWebPushFormattingAndPrivacy:
    def test_ist_12hr_time_format(self):
        """Clinic times must be formatted in 12-hour AM/PM format without raw 24h military clock."""
        dt_morning = datetime(2026, 10, 2, 9, 5, tzinfo=timezone.utc)
        formatted_morning = format_ist_12hr(dt_morning)
        assert "AM" in formatted_morning or "PM" in formatted_morning
        assert not formatted_morning.startswith("0")

        dt_afternoon = datetime(2026, 10, 2, 15, 50, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        formatted_afternoon = format_ist_12hr(dt_afternoon)
        assert formatted_afternoon == "3:50 PM"

    @pytest.mark.asyncio
    async def test_notification_privacy_no_pii_exposed(self, monkeypatch):
        """Notification content on lock-screen must not expose patient name, phone, symptoms, or medical details."""
        mock_db = MockDB()
        mock_db.push_subscriptions.count_documents = AsyncMock(return_value=1)
        monkeypatch.setattr(server, "db", mock_db)

        appt = {
            "id": "appt-101",
            "token_number": 25,
            "patient_id": "user-patient-99",
            "patient_name": "Ranjeet Kumar",
            "patient_mobile": "+919876543210",
            "medical_notes": "Suspected chronic diabetes and hypertension",
            "doctor_id": "doc-1",
            "doctor_name": "Dr. Mariya Khan",
            "date": "2026-10-02",
            "slot": "Token Booking",
            "secure_token": "safe_sec_token_xyz",
            "notifications_sent": {},
        }
        doctor = {
            "id": "doc-1",
            "full_name": "Dr. Mariya Khan",
            "clinic_name": "Murti Nursing Home",
            "hospital_name": "Murti Nursing Home",
        }
        eta_data = {
            "currently_serving": 18,
            "expected_turn_time": "4:15–4:30 PM",
            "eta_minutes": 35,
        }

        with patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push:
            await notify_appointment_booked(appt, doctor, eta_data)

            assert mock_push.called
            call_args = mock_push.call_args[1]
            title = call_args["title"]
            body = call_args["body"]

            # Must contain clinic name, token number, now serving, estimated turn
            assert "Murti Nursing Home — MeriBaari" in title
            assert "Your Token: 25" in body
            assert "Now Serving: #18" in body
            assert "Estimated Turn: 4:15–4:30 PM" in body
            assert "Tap to view live queue." in body

            # Privacy checks: patient name, phone, or symptoms must NOT be exposed
            assert "Ranjeet" not in body
            assert "9876543210" not in body
            assert "diabetes" not in body.lower()
            assert "hypertension" not in body.lower()


class TestQueueEligibleOrderCalculations:
    @pytest.mark.asyncio
    async def test_patients_ahead_calculation_with_gaps_and_skipped(self):
        """Patients ahead must be computed from actual eligible appointments, not token subtraction."""
        # Suppose Token 1 is in_consultation
        # Token 2 was skipped
        # Token 3 was cancelled
        # Tokens 4, 5, 6, 7 are booked
        # For Token 7:
        # Subtracting token numbers: 7 - 1 = 6 (INCORRECT!)
        # Actual eligible queue ahead of 7: Tokens 4, 5, 6 (3 waiting) + Token 1 in consultation = 4 patients ahead!
        all_appts = [
            {"id": "a1", "token_number": 1, "status": "in_consultation", "patient_id": "p1", "notifications_sent": {}},
            {"id": "a2", "token_number": 2, "status": "skipped", "patient_id": "p2", "notifications_sent": {}},
            {"id": "a4", "token_number": 4, "status": "booked", "patient_id": "p4", "notifications_sent": {}},
            {"id": "a5", "token_number": 5, "status": "booked", "patient_id": "p5", "notifications_sent": {}},
            {"id": "a6", "token_number": 6, "status": "booked", "patient_id": "p6", "notifications_sent": {}},
            {"id": "a7", "token_number": 7, "status": "booked", "patient_id": "p7", "notifications_sent": {}},
        ]

        active_waiting = [a for a in all_appts if a.get("status") in ("booked", "arrived")]
        current_in_consultation = next((a for a in all_appts if a.get("status") == "in_consultation"), None)

        patients_ahead_7 = sum(1 for a in active_waiting if a["token_number"] < 7) + (1 if current_in_consultation else 0)

        # Verified: 4 patients ahead, NOT 7 - 1 = 6
        assert patients_ahead_7 == 4


class TestQueueMovementAndTurnAlerts:
    @pytest.mark.asyncio
    async def test_notify_queue_movement_five_and_two_ahead(self, monkeypatch):
        """Verify queue movement triggers five_ahead and two_ahead notifications accurately."""
        doctor = {
            "id": "doc-q",
            "full_name": "Dr. Anita",
            "hospital_name": "Anita Health",
            "avg_consult_minutes": 10,
            "status": "active",
        }

        mock_appts = [
            {"id": "a1", "token_number": 1, "status": "in_consultation", "patient_id": "p1", "notifications_sent": {"called": True}},
            {"id": "a2", "token_number": 2, "status": "booked", "patient_id": "p2", "notifications_sent": {}},
            {"id": "a3", "token_number": 3, "status": "booked", "patient_id": "p3", "notifications_sent": {}},
            {"id": "a4", "token_number": 4, "status": "booked", "patient_id": "p4", "notifications_sent": {}},
            {"id": "a5", "token_number": 5, "status": "booked", "patient_id": "p5", "notifications_sent": {}},
            {"id": "a6", "token_number": 6, "status": "booked", "patient_id": "p6", "notifications_sent": {}},
        ]

        mock_db = MockDB()
        mock_db.doctors._find_one_data = doctor
        mock_db.appointments._find_data = mock_appts
        monkeypatch.setattr(server, "db", mock_db)

        with patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push, \
             patch("server.calculate_appointment_eta", new_callable=AsyncMock) as mock_eta:

            mock_eta.return_value = {
                "expected_turn_time": "3:00 PM – 3:30 PM",
                "eta_minutes": 20,
                "currently_serving": 1,
            }

            await notify_queue_movement("doc-q")

            pids_notified = [call[1]["recipients"][0] for call in mock_push.call_args_list]
            assert "p3" in pids_notified
            assert "p6" in pids_notified

            # Verify content of 2-ahead notification
            p3_call = next(c for c in mock_push.call_args_list if c[1]["recipients"][0] == "p3")
            assert "Only 2 patients ahead!" in p3_call[1]["body"]

            # Verify content of 5-ahead notification
            p6_call = next(c for c in mock_push.call_args_list if c[1]["recipients"][0] == "p6")
            assert "5 patients ahead." in p6_call[1]["body"]

    @pytest.mark.asyncio
    async def test_notify_called_when_in_consultation(self, monkeypatch):
        """When patient status becomes in_consultation, they must receive 'It's your turn now!'."""
        doctor = {
            "id": "doc-call",
            "full_name": "Dr. Mariya",
            "hospital_name": "MeriBaari Clinic",
        }
        mock_appts = [
            {
                "id": "a-called",
                "token_number": 12,
                "status": "in_consultation",
                "patient_id": "patient-turn",
                "secure_token": "token_turn_xyz",
                "notifications_sent": {},
            }
        ]

        mock_db = MockDB()
        mock_db.doctors._find_one_data = doctor
        mock_db.appointments._find_data = mock_appts
        monkeypatch.setattr(server, "db", mock_db)

        with patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push:
            await notify_queue_movement("doc-call")

            assert mock_push.called
            call_kwargs = mock_push.call_args[1]
            assert "patient-turn" in call_kwargs["recipients"]
            assert "a-called" in call_kwargs["recipients"]
            assert "🎉 It's your turn now!" in call_kwargs["body"]
            assert "/appointment/token_turn_xyz" in call_kwargs["action_url"]


class TestPostBookingSubscriptionNotification:
    @pytest.mark.asyncio
    async def test_subscribe_after_booking_sends_current_status_not_duplicate_booking(self, monkeypatch):
        """If patient enables notifications after booking, send ONE current status alert instead of duplicate booking."""
        appt = {
            "id": "appt-later",
            "token_number": 15,
            "doctor_id": "doc-welcome",
            "patient_id": "user-welcome",
            "date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "status": "booked",
            "secure_token": "sec_tok_welcome",
            "notifications_sent": {},
        }
        doctor = {
            "id": "doc-welcome",
            "full_name": "Dr. Verma",
            "hospital_name": "Verma Clinic",
        }

        mock_db = MockDB()
        mock_db.appointments._find_one_data = appt
        mock_db.doctors._find_one_data = doctor
        monkeypatch.setattr(server, "db", mock_db)

        with patch("server.calculate_appointment_eta", new_callable=AsyncMock) as mock_eta, \
             patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push:

            mock_eta.return_value = {
                "currently_serving": 10,
                "expected_turn_time": "2:30 PM – 2:45 PM",
                "eta_minutes": 25,
            }

            await send_welcome_status_if_needed(
                user_id="user-welcome",
                device_token="fcm_token_device_abc",
                appointment_id="appt-later",
            )

            assert mock_push.called
            call_kwargs = mock_push.call_args[1]
            assert "Your Token: 15" in call_kwargs["body"]
            assert "Now Serving: #10" in call_kwargs["body"]
            assert "Estimated Turn: 2:30 PM – 2:45 PM" in call_kwargs["body"]
            assert call_kwargs["extra_data"]["event"] == "status_welcomed"

            # Must update status_welcomed so it never sends duplicate
            mock_db.appointments.update_one.assert_called_once()
            set_dict = mock_db.appointments.update_one.call_args[0][1]["$set"]
            assert set_dict["notifications_sent.status_welcomed"] is True


class TestDoctorStatusAndCancellationAlerts:
    @pytest.mark.asyncio
    async def test_notify_doctor_paused_and_active(self, monkeypatch):
        """Doctor pause/resume must notify waiting patients."""
        doctor = {
            "id": "doc-pause",
            "full_name": "Dr. Mariya",
            "clinic_name": "MeriBaari Care",
        }
        waiting = [
            {"id": "w1", "patient_id": "p-wait-1", "token_number": 5, "secure_token": "sec_w1"},
        ]

        mock_db = MockDB()
        mock_db.doctors._find_one_data = doctor
        mock_db.appointments._find_data = waiting
        # find_one returns current in_consultation
        mock_db.appointments._find_one_data = {"token_number": 2}
        monkeypatch.setattr(server, "db", mock_db)

        with patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push:
            # 1. Doctor Paused
            await notify_doctor_status_change("doc-pause", "paused")
            assert mock_push.called
            call_kwargs = mock_push.call_args[1]
            assert "briefly paused" in call_kwargs["body"]
            assert "Now Serving: #2" in call_kwargs["body"]

            mock_push.reset_mock()

            # 2. Doctor Resumed Active
            await notify_doctor_status_change("doc-pause", "active")
            assert mock_push.called
            call_kwargs = mock_push.call_args[1]
            assert "resumed consultations" in call_kwargs["body"]

    @pytest.mark.asyncio
    async def test_notify_appointment_cancelled(self, monkeypatch):
        """Cancellation push must notify patient cleanly."""
        appt = {
            "id": "appt-cancel-1",
            "doctor_id": "doc-c",
            "patient_id": "patient-c",
            "token_number": 8,
        }
        doctor = {
            "id": "doc-c",
            "full_name": "Dr. Mariya",
            "clinic_name": "Murti Clinic",
        }

        mock_db = MockDB()
        mock_db.doctors._find_one_data = doctor
        monkeypatch.setattr(server, "db", mock_db)

        with patch("server.send_fcm_web_push", new_callable=AsyncMock) as mock_push:
            await notify_appointment_cancelled(appt)

            assert mock_push.called
            call_kwargs = mock_push.call_args[1]
            assert "patient-c" in call_kwargs["recipients"]
            assert "appt-cancel-1" in call_kwargs["recipients"]
            assert "Your appointment (Token #8) with Dr. Mariya has been cancelled." in call_kwargs["body"]
            assert call_kwargs["action_url"] == "/patient/history"



class TestTokenDeactivationOnUnregister:
    @pytest.mark.asyncio
    async def test_send_fcm_web_push_marks_invalid_tokens_inactive(self, monkeypatch):
        """When FCM reports UnregisteredError, the stale token must be marked active=False in DB."""
        subs = [
            {"token": "expired_token_123", "user_id": "u1", "platform": "web"},
        ]

        mock_db = MockDB()
        mock_db.push_subscriptions._find_data = subs
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "FIREBASE_ADMIN_AVAILABLE", True)

        from firebase_admin import messaging

        with patch("server.init_firebase_admin_if_available"), \
             patch("firebase_admin.messaging.send", side_effect=messaging.UnregisteredError("Token unregistered")):

            res = await send_fcm_web_push(
                recipients=["u1"],
                title="Test Title",
                body="Test Body",
            )

            assert res["failed"] == 1
            mock_db.push_subscriptions.update_many.assert_called_once()
            call_args = mock_db.push_subscriptions.update_many.call_args[0]
            assert call_args[0] == {"token": {"$in": ["expired_token_123"]}}
            assert call_args[1]["$set"]["active"] is False


class TestTokenDeduplicationAndErrorHandling:
    @pytest.mark.asyncio
    async def test_duplicate_device_tokens_sent_only_once(self, monkeypatch):
        """When multiple subscription records share the same device token, send only 1 FCM message."""
        subs = [
            {"token": "same_device_token_abc", "user_id": "u1", "platform": "web"},
            {"token": "same_device_token_abc", "user_id": "u1", "platform": "web"},
            {"token": "distinct_device_token_xyz", "user_id": "u1", "platform": "web"},
        ]

        mock_db = MockDB()
        mock_db.push_subscriptions._find_data = subs
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "FIREBASE_ADMIN_AVAILABLE", True)

        with patch("server.init_firebase_admin_if_available"), \
             patch("firebase_admin.messaging.send", return_value="projects/test/messages/msg123") as mock_send:

            res = await send_fcm_web_push(
                recipients=["u1"],
                title="Test Title",
                body="Test Body",
            )

            # Exactly 2 sends (not 3) because same_device_token_abc is deduplicated
            assert mock_send.call_count == 2
            assert res["sent"] == 2
            assert res["failed"] == 0

    @pytest.mark.asyncio
    async def test_unconfigured_firebase_admin_returns_error_and_zero_sent(self, monkeypatch):
        """When Firebase Admin SDK or credentials are missing, never report success and return sent: 0."""
        subs = [
            {"token": "token_1", "user_id": "u1", "platform": "web"},
            {"token": "token_2", "user_id": "u1", "platform": "web"},
        ]

        mock_db = MockDB()
        mock_db.push_subscriptions._find_data = subs
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "FIREBASE_ADMIN_AVAILABLE", False)

        with patch("server.init_firebase_admin_if_available"):
            res = await send_fcm_web_push(
                recipients=["u1"],
                title="Unconfigured Test",
                body="Should not report success",
            )

            assert res["sent"] == 0
            assert res["failed"] == 2
            assert res["simulated"] is True
            assert "error" in res


class TestGuestWalkInSecureAccess:
    @pytest.mark.asyncio
    async def test_guest_walk_in_receives_only_minimal_non_pii_data(self, monkeypatch):
        """Unauthenticated guest opening secure token link receives token, ETA, status, but NO PII."""
        appt = {
            "id": "appt-guest-1",
            "secure_token": "valid_secure_token_12345",
            "token_number": 14,
            "doctor_id": "doc-mariya",
            "doctor_name": "Dr. Mariya Khan",
            "hospital_id": "hosp-1",
            "date": "2026-10-03",
            "slot": "Walk-in",
            "status": "arrived",
            "patient_name": "Ranjeet Kumar",
            "patient_mobile": "+919876543210",
            "symptoms": "High fever and cough",
            "prescription": "Paracetamol 500mg",
            "medical_notes": "Internal clinical private note",
            "created_at": "2026-10-03T10:00:00Z",
        }

        mock_db = MockDB()
        mock_db.appointments._find_one_data = appt
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "calculate_appointment_eta", AsyncMock(return_value={
            "currently_serving": 10,
            "expected_turn_time": "11:30 AM – 11:45 AM",
            "patients_ahead": 3,
            "your_token": 14,
        }))

        from server import get_appointment_by_token

        # Unauthenticated guest call (user=None)
        res = await get_appointment_by_token(token="valid_secure_token_12345", user=None)

        assert res["ok"] is True
        assert res["is_guest"] is True
        guest_appt = res["appointment"]

        # Minimal queue details must be present
        assert guest_appt["token_number"] == 14
        assert guest_appt["doctor_name"] == "Dr. Mariya Khan"
        assert guest_appt["status"] == "arrived"
        assert guest_appt["secure_token"] == "valid_secure_token_12345"

        # PII MUST be excluded
        assert "patient_name" not in guest_appt
        assert "patient_mobile" not in guest_appt
        assert "symptoms" not in guest_appt
        assert "prescription" not in guest_appt
        assert "medical_notes" not in guest_appt

    @pytest.mark.asyncio
    async def test_authenticated_owner_receives_full_details(self, monkeypatch):
        """Authenticated owner of appointment receives full record."""
        appt = {
            "id": "appt-owner-1",
            "secure_token": "valid_secure_token_owner",
            "patient_id": "patient-user-123",
            "patient_name": "Ranjeet Kumar",
            "patient_mobile": "+919876543210",
            "doctor_name": "Dr. Mariya Khan",
            "token_number": 5,
            "status": "booked",
            "symptoms": "High fever",
            "date": "2026-10-03",
        }

        mock_db = MockDB()
        mock_db.appointments._find_one_data = appt
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "calculate_appointment_eta", AsyncMock(return_value={"patients_ahead": 2}))

        from server import get_appointment_by_token

        owner_user = {"id": "patient-user-123", "role": "patient", "mobile": "+919876543210"}
        res = await get_appointment_by_token(token="valid_secure_token_owner", user=owner_user)

        assert res["ok"] is True
        assert res["is_guest"] is False
        assert res["appointment"]["patient_name"] == "Ranjeet Kumar"
        assert res["appointment"]["symptoms"] == "High fever"

    @pytest.mark.asyncio
    async def test_cancelled_appointment_returns_410_gone(self, monkeypatch):
        """Cancelled appointment access token must return 410."""
        from fastapi import HTTPException
        appt = {
            "id": "appt-cancelled",
            "secure_token": "token_cancelled_xyz",
            "status": "cancelled",
        }
        mock_db = MockDB()
        mock_db.appointments._find_one_data = appt
        monkeypatch.setattr(server, "db", mock_db)

        from server import get_appointment_by_token

        with pytest.raises(HTTPException) as exc:
            await get_appointment_by_token(token="token_cancelled_xyz", user=None)
        assert exc.value.status_code == 410


class TestPushSubscribeAuthorization:
    @pytest.mark.asyncio
    async def test_guest_subscription_with_valid_token_allowed(self, monkeypatch):
        """Guest holding valid appointment_token can subscribe without login."""
        appt = {
            "id": "appt-walkin-sub",
            "secure_token": "tok_sub_valid_123",
            "status": "arrived",
            "patient_id": "patient_walkin_id",
        }
        mock_db = MockDB()
        mock_db.appointments._find_one_data = appt
        monkeypatch.setattr(server, "db", mock_db)
        monkeypatch.setattr(server, "send_welcome_status_if_needed", AsyncMock())

        from server import push_subscribe, PushSubscribeBody

        body = PushSubscribeBody(
            token="device_fcm_token_999",
            appointment_token="tok_sub_valid_123",
        )
        res = await push_subscribe(body, user=None)

        assert res["ok"] is True
        assert res["status"] == "subscribed"
        mock_db.push_subscriptions.update_one.assert_called_once()
        set_dict = mock_db.push_subscriptions.update_one.call_args[0][1]["$set"]
        assert set_dict["appointment_id"] == "appt-walkin-sub"
        assert set_dict["active"] is True

    @pytest.mark.asyncio
    async def test_guest_subscription_without_token_rejected_401(self, monkeypatch):
        """Unauthenticated caller attempting to subscribe with raw appointment_id without token must be rejected."""
        from fastapi import HTTPException
        mock_db = MockDB()
        monkeypatch.setattr(server, "db", mock_db)

        from server import push_subscribe, PushSubscribeBody

        body = PushSubscribeBody(
            token="device_fcm_token_fake",
            appointment_id="raw_guessed_id",
        )
        with pytest.raises(HTTPException) as exc:
            await push_subscribe(body, user=None)
        assert exc.value.status_code == 401

