# ClinicQueue - Healthcare Appointment & Queue Management App (India)

## Overview
Full-stack Expo React Native mobile app that reduces patient waiting time at clinics through real-time queue management. Supports three user roles: Patient, Doctor, Receptionist.

## Tech Stack
- Frontend: Expo (React Native), expo-router file-based routing, TypeScript
- Backend: FastAPI + MongoDB (motor async driver)
- Auth: JWT (email/password) with bcrypt password hashing
- Real-time updates: 5s polling on queue screens

## Features Implemented

### Patient
- Signup/Login with JWT auth
- Doctor search by name/specialty/city (chips + text search)
- Doctor profile page with fees, timings, wait time
- Book appointment (date + time slot selection)
- Mock payment (Pay Online or Pay at Clinic)
- Live queue position screen (huge "#N" display, auto-refreshes every 5s)
- Appointment history with prescriptions modal
- Cancel appointment

### Receptionist
- Doctor selector to switch context
- Real-time queue KPIs (total/arrived/completed/pending)
- Actions per appointment: Mark Arrived, Start, Complete, Skip
- Emergency Patient Insert (bumps to top with token #0)
- Auto-refreshes every 5s

### Doctor
- Dashboard with total/completed/pending/earnings KPIs
- Status modes: Active / Break / Emergency
- "Next Patient" hero card with Call Next + Complete actions
- Today's schedule list with prescription entry modal
- Auto-refreshes every 5s

## Seeded Data
- 6 doctors across specialties/cities (see /app/memory/test_credentials.md)
- 1 receptionist account

## Key Endpoints
- POST /api/auth/signup, /api/auth/login, GET /api/auth/me
- GET /api/doctors, /api/doctors/{id}, /api/specialties
- POST /api/appointments, GET /api/appointments/me, /api/appointments/{id}/queue
- POST /api/appointments/{id}/cancel, /reschedule
- Doctor: /api/doctor/dashboard, /api/doctor/appointments, /api/doctor/status, /api/doctor/prescription
- Reception: /api/reception/queue, /api/reception/doctors, /api/reception/mark_arrived, /start_consultation, /complete, /skip, /reorder, /emergency_insert

## Known Limitations (MOCKED)
- Payments: MOCKED (no real Stripe/UPI); UI simulates payment success
- Push notifications: In-app / polling only (no FCM/APNs)
- Real-time: 5s polling (no WebSockets)

## Future Enhancements
- Add Stripe/Razorpay integration for real payments
- Add SMS/WhatsApp reminders via Twilio (revenue: premium reminder feature)
- Multi-clinic tenancy and clinic admin dashboard
