import os

# Prevent remote MongoDB SRV DNS lookup during offline unit test execution
os.environ["MONGO_URL"] = os.environ.get("BACKEND_TEST_MONGO_URL", "mongodb://127.0.0.1:27017")
os.environ["DB_NAME"] = "clinicqueue_test"
