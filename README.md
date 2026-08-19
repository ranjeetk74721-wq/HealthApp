# ClinicQueue

ClinicQueue is a React Native Expo frontend backed by a FastAPI and MongoDB API.

## Prerequisites

- Windows PowerShell
- Python 3.11 or newer
- Node.js 20 or newer and npm
- MongoDB running locally on `mongodb://localhost:27017`, or a reachable MongoDB URI

## First-time setup

From the repository root, run:

```powershell
.\setup.ps1
```

The script creates `backend/.venv`, installs the core API/test dependencies from `backend/requirements-core.txt`, copies local environment templates, and runs `npm ci` in `frontend`. The broader pinned dependency inventory is kept in `backend/requirements.txt` for optional integrations.

The optional `backend/requirements-optional.txt` file is only needed when running `gen_logo.py`; it is kept separate because that private package is not needed by the API or tests.

For a remote MongoDB instance, edit `backend/.env` after setup. Set `MONGO_URL`, `DB_NAME`, and a strong `JWT_SECRET` before using the app.

## Development

Start the API:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn server:app --reload --app-dir backend --host 0.0.0.0 --port 8000
```

Start Expo in a second terminal:

```powershell
npm --prefix frontend run start
```

For Expo Go on a phone connected to the same Wi-Fi network, use LAN mode and scan the QR code shown by Expo:

```powershell
npm --prefix frontend run start:lan
```

When `EXPO_PUBLIC_BACKEND_URL` is left as `http://localhost:8000`, native Expo clients automatically use the computer's LAN address for the API. Keep the backend running on port `8000` and allow Python through Windows Firewall when prompted.

Use `npm --prefix frontend run web` for the browser build. The frontend defaults to `http://localhost:8000` when `EXPO_PUBLIC_BACKEND_URL` is not set.

## Validation and tests

Backend tests target `EXPO_PUBLIC_BACKEND_URL` and default to the existing preview API. To test a local API, set the variable first:

```powershell
$env:EXPO_PUBLIC_BACKEND_URL = "http://localhost:8000"
& .\backend\.venv\Scripts\python.exe -m pytest backend\tests
```

Frontend static checks:

```powershell
npm --prefix frontend run test
npm --prefix frontend run doctor
```

`npm run test` currently runs Expo ESLint and TypeScript checks. The backend suite is the end-to-end API test suite and requires seeded users and MongoDB data when run locally.
