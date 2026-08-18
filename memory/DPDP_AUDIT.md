# Meribaari — DPDP Act 2023 Technical Compliance Audit

**Audit date:** 2026-02-XX (dev/preview build)
**Auditor:** Automated code review by main agent (NOT a legal audit)
**Version:** Post-owner-dashboard build

> ⚠️ **LEGAL DISCLAIMER**
> This document is a **technical implementation review** against DPDP Act 2023 principles. It is **NOT** legal advice or a certification of legal compliance. Actual DPDP compliance requires:
> - Engagement of a qualified data-protection lawyer
> - Appointment of a Data Protection Officer (DPO) if significant-data-fiduciary
> - Registration with a Consent Manager (where applicable)
> - Signed Data Processing Agreements (DPAs) with all vendors
> - Board-approved policies, risk assessments and audits by an independent auditor once DPDP Rules 2025 are notified
>
> The application, in its current state, **cannot** be declared legally DPDP-compliant. What follows is a good-faith technical review to reduce risk and identify remediations.

---

## 1. Data Inventory (Personal Data Collected)

| # | Data Category | Fields | Source | Storage | Consent basis |
|---|---|---|---|---|---|
| 1 | Patient Identity | full_name, mobile (+91), age, gender, address | User via OTP flow / Receptionist adds | MongoDB `users` collection | Explicit at signup (to be implemented) |
| 2 | Patient Health | symptoms, prescription, appointment history | Receptionist / Doctor | MongoDB `appointments` | Sensitive per DPDP — explicit consent required |
| 3 | Doctor PII + Professional | full_name, email, phone, address, degree, experience_years, bio | Owner adds | MongoDB `users` + `doctors` | Employment / service-provider basis |
| 4 | Doctor Documents | id_proof_photo (base64), degree_photo (base64), profile photo | Owner uploads | MongoDB `doctors` | Verification purpose |
| 5 | Receptionist / Owner | email, password_hash, phone | Seed / signup | MongoDB `users` | Employment / operator basis |
| 6 | Authentication | password_hash (bcrypt), JWT token | System | MongoDB `users` + client `AsyncStorage` | Necessary for service |
| 7 | OTP | mobile → 6-digit OTP + expiry | System | MongoDB `otps` | Necessary for auth; 5-min expiry ✅ |
| 8 | Device / Push Token | device_token, platform | User at signup | Relayed to Emergent Push (SuprSend) | Notification consent required |
| 9 | Operational | appointment status, token number, timestamps, revenue calculations | System | MongoDB `appointments` | Legitimate business need |

**Data NOT collected (good):** No IP logging, no analytics/tracking, no location, no biometrics, no payment card data.

---

## 2. Per-Category Analysis

### Patient Identity + Health (categories 1 & 2)
1. **Purpose**: Appointment booking, queue tracking, medical record continuity.
2. **Necessity**: Necessary for core service.
3. **Consent**: **NOT explicitly captured today** — implicit via OTP verification. ❌ FAIL — DPDP requires explicit, specific, informed consent for sensitive personal data (health data).
4. **Storage**: Local MongoDB (`test_database`). Not encrypted at rest at DB level.
5. **Access**: Patient (own only), doctor (all patients — no scoping), receptionist (all doctors' patients — no scoping), owner (all).
6. **3rd-party sharing**: Only push notification metadata to Emergent Push relay (title/message contain patient identifiers indirectly).
7. **Retention**: Indefinite — no auto-cleanup.
8. **Deletion**: **No user-facing mechanism** ❌ FAIL.

### Doctor Documents (category 4)
- Very sensitive (govt-issued ID). Currently stored as base64 in MongoDB, transmitted via HTTPS.
- No access controls beyond "owner role".
- **Recommendation**: Move to encrypted object store (S3 with SSE) with signed URLs; log every access.

---

## 3. DPDP Section-by-Section Findings

### A. Privacy Notice — ❌ NOT PRESENT
- No privacy notice at signup or in-app.
- **Action being implemented**: `/privacy` screen with sections for data collected, purpose, rights, grievance officer contact.

### B. Consent — ❌ IMPLICIT ONLY
- Patient OTP flow does not present a consent screen.
- No consent record (who consented, when, purpose, version).
- No withdrawal mechanism.
- **Action being implemented**: consent checkbox on OTP verify → new patient profile step; consent snapshot stored in DB with version + timestamp; withdraw endpoint.

### C. User Data Controls — ❌ MISSING
- No access / export / delete UI.
- **Action being implemented**:
  - `GET /api/user/data-export` → returns full personal-data JSON for the requester
  - `POST /api/user/delete-me` → soft-delete flow (30-day grace, then hard delete via a scheduled task in production; MVP does immediate soft-delete)
  - `POST /api/user/withdraw-consent` → sets consent=false, blocks further processing

### D. Security — ⚠️ PARTIAL
| Item | State | Note |
|---|---|---|
| TLS in transit | ✅ | Kubernetes ingress terminates TLS |
| Encryption at rest | ❌ | MongoDB default; needs Atlas encryption or field-level encryption for health data |
| Password storage | ✅ | bcrypt with salt |
| JWT auth | ✅ | HS256, expiry set |
| Role-based access | ⚠️ | Roles exist but per-doctor/per-clinic scoping missing |
| Least privilege | ❌ | Doctors see ALL appointments today; receptionists see ALL doctors |
| Session mgmt | ⚠️ | Client-side JWT only; no server-side revocation list |
| Rate limiting | ❌ | No rate limits anywhere — OTP endpoint is enumerable |
| CORS | ❌ | `allow_origins=["*"]` — must be tightened for production |
| SQL/NoSQL injection | ✅ | Motor uses parameterized queries; low risk |
| Audit logs | ❌ | No structured audit log for sensitive access |
| Secrets management | ⚠️ | `.env` in repo; EMERGENT keys marked "placeholder" in dev |
| Backup security | ❌ | No documented backup / retention encryption |

**Action being implemented**: audit_logs collection + OTP rate limit + JWT-blocklist on password change.

### E. Healthcare Privacy — ❌ CRITICAL GAPS
- **Doctor visibility**: The `GET /api/doctor/appointments` endpoint returns all today's appointments for that doctor — this is fine. But the **doctor list is global** — every receptionist sees every doctor. **This is the "1 doctor ↔ 1 receptionist" issue you already flagged.**
- **Multi-clinic isolation**: No `clinic_id` on any document. Different clinics' data is mixed in one DB.
- **Owner access**: One owner sees ALL doctors, ALL patients, ALL revenue. In multi-clinic deployment this is a boundary violation.
- **Prescription privacy**: Prescription visible to patient (correct), doctor (correct), and receptionist (⚠️ questionable — receptionist should not see clinical notes).

### F. Data Retention — ❌ NOT DEFINED
- No retention policy in code, config, or docs.
- OTP has 5-min expiry ✅
- Appointments: kept forever ❌
- Deleted users: hard-deleted (via owner delete) — no soft-delete audit trail

### G. Third-Party Processors
| Provider | Data shared | Purpose | DPA needed |
|---|---|---|---|
| Emergent Push (SuprSend relay) | user_id, device_token, notification title+body | Push delivery | YES — subject to Emergent's own DPA |
| Emergent LLM key (Gemini image gen) | Only prompt text (not patient data) | Logo generation only | Low-risk |
| MongoDB (local in dev; unknown in prod) | All personal data | Primary storage | YES in production |
| Firebase / APNs (via push) | Device token + notification payload | Push transport | Indirect (via Emergent relay) |

**No DPAs are currently in place**. This must be resolved before production launch.

### H. Breach Response — ❌ NOT DEFINED
- No incident-response runbook.
- **Action being implemented**: `docs/BREACH_RESPONSE.md` with steps.

### I. Children — ⚠️ UNADDRESSED
- The app collects patient age. Patients under 18 can register.
- DPDP requires **verifiable parental consent** for children (below 18) and prohibits behavioural tracking / targeted ads on children.
- **Action being implemented**: age check at OTP profile step — if age < 18, block registration and show "guardian must register on your behalf" message.

### J. Data Flow Diagram

```
┌─────────┐    HTTPS/TLS    ┌─────────────┐    Motor async    ┌──────────┐
│ Patient │◄──────────────►│ FastAPI     │◄─────────────────►│ MongoDB  │
│ (mobile │                 │ /api/*      │                    │ (users,  │
│  app)   │                 │             │                    │  doctors,│
└─────────┘                 │             │                    │  appts,  │
                             │             │                    │  otps,   │
┌─────────┐    HTTPS/TLS    │             │                    │  audit)  │
│ Doctor  │◄──────────────►│             │                    └──────────┘
└─────────┘                 │             │
                             │             │    HTTPS   ┌────────────────┐
┌───────────┐   HTTPS      │             │◄──────────►│ Emergent Push  │
│Reception  │◄────────────►│             │            │ (SuprSend →    │
└───────────┘               │             │            │  FCM / APNs)   │
                             │             │            └────────────────┘
┌────────┐    HTTPS         │             │
│ Owner  │◄────────────────►│             │    WSS     ┌─────────────┐
└────────┘                  │             │◄─────────►│ WebSocket   │
                             └─────────────┘            │ clients     │
                                                        │ (all roles) │
                                                        └─────────────┘
```

---

## 4. Compliance Report

### ✅ PASS
- HTTPS/TLS in transit
- Password hashing (bcrypt)
- JWT expiry set
- OTP 5-min expiry
- Parameterised DB queries (motor)
- No PII in URLs
- No unnecessary tracking / analytics / IP logging

### ⚠️ PARTIALLY IMPLEMENTED (fixes in this session)
- Privacy notice — being added as `/privacy` screen
- Consent — checkbox at OTP profile step + record in DB
- Data access & deletion endpoints — `/api/user/*`
- Audit log — `audit_logs` collection for sensitive actions
- OTP rate limiting — max 5 requests / mobile / 10 min
- Grievance officer contact — placeholder email in privacy screen

### ❌ FAIL (needs product + legal decisions, cannot be fixed by code alone)
- **Multi-tenancy / clinic isolation** — needs data-model refactor (`clinic_id` on doctors + scoping)
- **1 doctor ↔ 1 receptionist** binding — needs product decision (asked user, awaiting reply)
- **Encryption at rest** for health data — needs infra decision (Atlas or field-level encryption)
- **Data Processing Agreements** with all third parties — needs legal work
- **DPO appointment** if crossing significant-data-fiduciary threshold — legal / HR
- **Consent Manager registration** — regulatory
- **Prescription visibility to receptionist** — product decision
- **Retention policy** finalised numbers — business decision (e.g., appointments retained 3 years?)
- **Children (< 18) flow** — needs verifiable parental consent mechanism; currently only blocked
- **CORS tightening** — deployment concern (must set exact frontend origin post-deploy)
- **Secrets rotation policy** — ops process
- **Third-party push payload contents** — do not send patient names / phone numbers to third parties (SuprSend); use user_id references only ✅ current implementation does this
- **Audit / independent security assessment** — external firm

### 🐞 Security Issues Found (fixed / to fix)
1. **OTP endpoint has no rate limit** — enumeration + SMS abuse risk → **FIXED** in this session (in-memory rate limiter).
2. **CORS `*`** — flagged; production deploy must override.
3. **`dev_otp` in API response** — MUST be disabled in production; current code uses a `MOCK_OTP_MODE` gate to strip it before returning outside of dev.
4. **Receptionist sees all doctors** — flagged (product decision pending).
5. **Doctor `avg_consult_minutes` and `fees` are self-editable without owner approval** — flagged as a business risk (not privacy).

---

## 5. Recommended Fixes — Priority Ordered

| Priority | Fix | Type | Status in this session |
|---|---|---|---|
| P0 | Privacy notice + grievance contact | UI + doc | **Done** |
| P0 | Consent checkbox + record | UI + backend | **Done** |
| P0 | User data export + delete | Backend + UI | **Done** |
| P0 | OTP rate limiting | Backend | **Done** |
| P0 | Basic audit log (sensitive endpoints) | Backend | **Done** |
| P0 | Children age check (< 18 blocked) | Backend | **Done** |
| P0 | Strip `dev_otp` from response outside dev | Backend | **Done** |
| P1 | Clinic scoping / receptionist ↔ doctor binding | Data model | **Pending user decision** |
| P1 | Encryption at rest for health fields | Infra | **Pending deployment** |
| P1 | Data Processing Agreements | Legal | **Out of scope** |
| P1 | Move ID/degree images to S3 with signed URLs | Infra | **Pending deployment** |
| P2 | Retention scheduler (auto-purge old data) | Backend cron | **Config field added; scheduler pending** |
| P2 | JWT server-side revocation on password change | Backend | **Pending** |
| P2 | Tighten CORS at deploy time | Config | **Pending deployment** |

---

## 6. Grievance Officer / DPO Contact

Currently a **placeholder** in `/privacy` screen: `grievance@meribaari.example`.
**Owner MUST replace this** with a valid, staffed contact channel before production launch. DPDP requires a published grievance mechanism with reasonable turnaround.

---

## 7. Files Changed in This Session for DPDP Alignment

- `backend/server.py` — added `/api/user/data-export`, `/api/user/delete-me`, `/api/user/withdraw-consent`, OTP rate limit, audit log, age gate, prod OTP strip, consent capture.
- `frontend/app/privacy.tsx` — new privacy notice screen.
- `frontend/app/otp.tsx` — added explicit consent checkbox on new-user profile step.
- `frontend/app/patient/settings.tsx` — new "My Data & Privacy" screen with export / delete / withdraw.
- `memory/DPDP_AUDIT.md` — this document.

---

## FINAL STATEMENT

The application, after this session's changes, has **improved DPDP alignment** but **is not, and does not claim to be, legally DPDP-compliant.** Legal compliance requires the business owner to:
1. Engage a data-protection lawyer.
2. Sign DPAs with Emergent, MongoDB host, push relay, and any future vendors.
3. Appoint / designate a grievance officer and (if applicable) a DPO.
4. Formally publish a legally-reviewed privacy notice replacing the placeholder in-app version.
5. Complete an independent security assessment before production launch.
6. Wait for DPDP Rules 2025 final notification and align to any prescriptive obligations added therein.

**Nothing in this file should be construed as legal advice or DPDP certification.**
