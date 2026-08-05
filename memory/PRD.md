# ClinicQueue - Healthcare Appointment & Queue Management App (India)

## Overview
Full-stack Expo React Native mobile app that reduces patient waiting time at clinics through real-time queue management. Supports three user roles: Patient, Doctor, Receptionist.

## Tech Stack
- Frontend: Expo (React Native), expo-router file-based routing, TypeScript
- Backend: FastAPI + MongoDB (motor async driver)
- Auth: JWT (email/password for staff; Mobile+OTP for patients) with bcrypt password hashing
- Real-time updates: **WebSocket** with polling fallback (15s)
- Push notifications: Emergent-managed push (placeholder key in dev; auto-replaced at deploy)

## Features Implemented

### Patient (Mobile+OTP Auth)
- **Mobile OTP login/signup** — enter mobile, receive OTP, verify; new patients complete profile (name, age, gender, address)
- Dev OTP `123456` (universal) or actual dev_otp shown for autofill; 5-min expiry
- Doctor search by name/specialty/city (chips + text search)
- Doctor profile page with fees, timings, wait time
- Book appointment (date + time slot selection)
- Mock payment (Pay Online or Pay at Clinic)
- **Live queue via WebSocket** — instant updates when queue moves; polling fallback
- Appointment history with prescriptions modal
- Cancel appointment

### Receptionist (Long-lived session — 90 days)
- **Add Walk-in Patient** — full form (name, mobile, age, gender, symptoms, address, slot); auto creates patient user + appointment; same mobile lets patient self-login later via OTP
- Doctor selector to switch context
- Real-time queue KPIs via WebSocket + green live-dot indicator
- Actions per appointment: Mark Arrived, Start, Complete, Skip
- Emergency Patient Insert (bumps to top with token #0)
- Toast on successful add

### Doctor
- Dashboard with total/completed/pending/earnings KPIs + WebSocket live-dot
- Status modes: Active / Break / Emergency
- "Next Patient" hero card with Call Next + Complete actions
- **Per-row actions** on Today's Schedule: Arrived / Call / Done / Skip (contextual to status) + status pills + symptoms display
- Prescription entry modal per appointment

## Seeded Data
- 6 doctors across specialties/cities (see /app/memory/test_credentials.md)
- 1 receptionist account

## Key Endpoints
- POST /api/auth/signup, /api/auth/login, GET /api/auth/me
- **POST /api/auth/send-otp, /api/auth/verify-otp** (patient mobile flow)
- **POST /api/reception/add-patient** (receptionist creates patient + appointment)
- **POST /api/register-push** (Emergent push registration)
- GET /api/doctors, /api/doctors/{id}, /api/specialties
- POST /api/appointments, GET /api/appointments/me, /api/appointments/{id}/queue
- POST /api/appointments/{id}/cancel, /reschedule
- Doctor: /api/doctor/dashboard, /api/doctor/appointments, /api/doctor/status, /api/doctor/prescription
- Reception: /api/reception/queue, /api/reception/doctors, /mark_arrived, /start_consultation, /complete, /skip, /reorder, /emergency_insert
- **WebSocket: /api/ws/queue/doctor/{doctor_id}, /api/ws/queue/appt/{appointment_id}**

## Known Limitations (MOCKED)
- OTP SMS: **MOCKED** — dev_otp returned in response, universal '123456' also accepted (no real SMS)
- Payments: MOCKED (no real Stripe/UPI); UI simulates payment success
- Push notifications: EMERGENT_PUSH_KEY=placeholder in dev; auto-replaced at deploy time. Feature works only in deployed builds.

## Future Enhancements
- Twilio SMS for real OTP delivery
- Google Maps for clinic search
- Razorpay/UPI real payments
- Firebase google-services.json for Android push (deploy time)
