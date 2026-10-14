import os
import sys
import uuid
import json
import time
import secrets
import hashlib
from datetime import datetime, timezone, timedelta
from pathlib import Path
import pytest
import jwt
import bcrypt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.backends import default_backend

# Add backend directory to sys.path
backend_dir = str(Path(__file__).resolve().parent.parent)
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

import server
from server import (
    hash_password,
    verify_password,
    create_token,
    normalize_mobile,
    hash_otp,
    JWT_SECRET,
    JWT_ALGORITHM,
    JWT_EXP_SECONDS,
    JWT_EXP_SECONDS_RECEPTION,
)


class TestCryptographicIntegrity:
    """Comprehensive test suite for password hashing, JWT security, OTP hashing, and random tokens."""

    def test_1_bcrypt_password_hashing_and_salting(self):
        """Verify bcrypt password hashing generates unique salts and verifies correctly."""
        pw = "ClinicPass@2026!"
        h1 = hash_password(pw)
        h2 = hash_password(pw)

        # Unique salts guarantee different hashes for the same password
        assert h1 != h2, "Each bcrypt hash must have a unique salt"
        assert h1.startswith("$2b$") or h1.startswith("$2a$")

        # Verification correctness
        assert verify_password(pw, h1) is True
        assert verify_password(pw, h2) is True
        assert verify_password("WrongPassword123", h1) is False
        assert verify_password("", h1) is False

    def test_2_bcrypt_unicode_and_special_characters(self):
        """Verify bcrypt handles non-ASCII and Unicode characters safely."""
        unicode_pw = "डॉक्टरपासवर्ड@123_Special_🏥"
        h = hash_password(unicode_pw)
        assert verify_password(unicode_pw, h) is True
        assert verify_password("डॉक्टरपासवर्ड@123_Special", h) is False

    def test_3_jwt_token_signature_and_tampering(self):
        """Verify JWT signature validation fails if token payload or header is tampered."""
        token = create_token("user-rec-1", "receptionist", expires_in=3600)
        parts = token.split(".")
        assert len(parts) == 3, "JWT must have header, payload, and signature"

        # Valid decoding
        decoded = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        assert decoded["sub"] == "user-rec-1"
        assert decoded["role"] == "receptionist"

        # Tampered payload (e.g. privilege escalation to admin)
        import base64
        payload_data = json.loads(base64.urlsafe_b64decode(parts[1] + "==").decode())
        payload_data["role"] = "admin"
        tampered_payload_b64 = base64.urlsafe_b64encode(json.dumps(payload_data).encode()).decode().rstrip("=")
        tampered_token = f"{parts[0]}.{tampered_payload_b64}.{parts[2]}"

        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(tampered_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

    def test_4_jwt_expired_token_rejection(self):
        """Verify expired tokens are rejected with ExpiredSignatureError."""
        # Create token that expired 10 seconds ago
        expired_token = create_token("user-rec-1", "receptionist", expires_in=-10)
        with pytest.raises(jwt.ExpiredSignatureError):
            jwt.decode(expired_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

    def test_5_jwt_algorithm_confusion_none_attack(self):
        """Verify tokens with alg 'none' are rejected."""
        header = base64_url_encode(json.dumps({"typ": "JWT", "alg": "none"}).encode())
        payload = base64_url_encode(json.dumps({"sub": "attacker", "role": "admin", "exp": int(time.time()) + 3600}).encode())
        none_token = f"{header}.{payload}."

        with pytest.raises(jwt.PyJWTError):
            jwt.decode(none_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

    def test_6_jwt_wrong_secret_rejection(self):
        """Verify tokens signed with a different key are rejected."""
        foreign_token = jwt.encode({"sub": "user-1", "role": "doctor"}, "attacker-secret-key", algorithm=JWT_ALGORITHM)
        with pytest.raises(jwt.InvalidSignatureError):
            jwt.decode(foreign_token, JWT_SECRET, algorithms=[JWT_ALGORITHM])

    def test_7_otp_cryptographic_hash_and_salt(self):
        """Verify OTP hash is deterministic with secret salt and immune to whitespace/formatting bugs."""
        mobile = "9876543210"
        otp = "482910"
        h1 = hash_otp(otp, mobile)
        h2 = hash_otp(f"  {otp}  ", f"  {mobile}  ")
        assert h1 == h2, "Whitespace must be trimmed before hashing"
        assert len(h1) == 64, "SHA-256 hash must be 64 hexadecimal characters"

        # Changing one digit must change the hash completely (avalanche effect)
        h3 = hash_otp("482911", mobile)
        assert h1 != h3

        # Salt verification: mobile number acts as per-user salt
        h_different_mobile = hash_otp(otp, "9876543211")
        assert h1 != h_different_mobile, "Different phone number must yield different hash"

    def test_8_mobile_normalization_entropy(self):
        """Verify mobile normalization ensures consistent +91 representation."""
        assert normalize_mobile("+91 98765 43210") == "+919876543210"
        assert normalize_mobile("09876543210") == "+919876543210"
        assert normalize_mobile("919876543210") == "+919876543210"
        assert normalize_mobile("9876543210") == "+919876543210"

    def test_9_secure_token_randomness_and_uniqueness(self):
        """Verify secrets.token_urlsafe generates high-entropy unique tokens."""
        tokens = {secrets.token_urlsafe(16) for _ in range(1000)}
        assert len(tokens) == 1000, "1000 generated tokens must have zero collisions"
        sample = next(iter(tokens))
        assert len(sample) >= 21, "16-byte base64url token must be at least 21 characters"


def base64_url_encode(data: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(data).decode().rstrip("=")
