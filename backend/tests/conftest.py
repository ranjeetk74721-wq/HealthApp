import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from backend directory if present so tests have access to configured DB if available
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(env_path)

if "BACKEND_TEST_MONGO_URL" in os.environ:
    os.environ["MONGO_URL"] = os.environ["BACKEND_TEST_MONGO_URL"]
else:
    os.environ["MONGO_URL"] = "mongodb://127.0.0.1:27017"

os.environ["DB_NAME"] = "clinicqueue_test"
