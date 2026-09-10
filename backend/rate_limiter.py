"""
Safe Sliding-Window Rate Limiter and Temporary Abuse Blocker.

Configurable via environment variables:
- RATE_LIMIT_GENERAL_IP_PER_MIN (default: 60)
- RATE_LIMIT_BOOK_IP_PER_10MIN (default: 5)
- RATE_LIMIT_BOOK_PHONE_PER_10MIN (default: 3)
- RATE_LIMIT_OTP_SEND_PHONE_PER_10MIN (default: 3)
- RATE_LIMIT_OTP_SEND_IP_PER_10MIN (default: 5)
- RATE_LIMIT_OTP_COOLDOWN_SECONDS (default: 60)
- RATE_LIMIT_OTP_VERIFY_PHONE_PER_10MIN (default: 5)
- RATE_LIMIT_SMS_COOLDOWN_SECONDS (default: 45)

Supports:
- Separate IP and Phone rate limiting & abuse tracking
- Temporary progressive blocking (15 min, 1 hour, 24 hours for extreme abuse)
- Framework client IP extraction with trusted reverse proxy support
- Never permanent bans on 2 requests
- HTTP 429 with Retry-After header
"""

import os
import time
import hashlib
import logging
from collections import defaultdict
from typing import Optional, Tuple
from fastapi import Request, HTTPException, status

logger = logging.getLogger("rate_limiter")


def _get_int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (ValueError, TypeError):
        return default


# Limits & windows
GENERAL_IP_PER_MIN = _get_int_env("RATE_LIMIT_GENERAL_IP_PER_MIN", 60)
BOOK_IP_PER_10MIN = _get_int_env("RATE_LIMIT_BOOK_IP_PER_10MIN", 5)
BOOK_PHONE_PER_10MIN = _get_int_env("RATE_LIMIT_BOOK_PHONE_PER_10MIN", 3)
OTP_SEND_PHONE_PER_10MIN = _get_int_env("RATE_LIMIT_OTP_SEND_PHONE_PER_10MIN", 3)
OTP_SEND_IP_PER_10MIN = _get_int_env("RATE_LIMIT_OTP_SEND_IP_PER_10MIN", 5)
OTP_COOLDOWN_SECONDS = _get_int_env("RATE_LIMIT_OTP_COOLDOWN_SECONDS", 60)
OTP_VERIFY_PHONE_PER_10MIN = _get_int_env("RATE_LIMIT_OTP_VERIFY_PHONE_PER_10MIN", 5)
SMS_COOLDOWN_SECONDS = _get_int_env("RATE_LIMIT_SMS_COOLDOWN_SECONDS", 45)

# Temporary Abuse Block thresholds (separate for IP and Phone)
ABUSE_BLOCK_15MIN_VIOLATIONS = 8
ABUSE_BLOCK_1HR_VIOLATIONS = 15
ABUSE_BLOCK_24HR_VIOLATIONS = 50


def hash_ip_for_logs(ip: str) -> str:
    """Anonymize/minimize IP in persistent logs."""
    return hashlib.sha256(ip.encode()).hexdigest()[:10]


def get_client_ip(request: Request) -> str:
    """Extract real client IP safely behind reverse proxies (Render, Vercel, Nginx)."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # Take the leftmost public IP
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if parts:
            return parts[0]
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


class RateLimiter:
    """In-memory sliding window rate limiter with separate IP and Phone tracking."""

    def __init__(self):
        # Key: str -> list of float timestamps
        self._records = defaultdict(list)
        # Key: str -> float timestamp when unblocked
        self._blocks = {}
        # Key: str -> violation count
        self._violations = defaultdict(int)
        # Last request timestamps for cooldowns: key -> float timestamp
        self._last_event = {}

    def _cleanup_old(self, key: str, window_seconds: int, now: float):
        cutoff = now - window_seconds
        self._records[key] = [t for t in self._records[key] if t > cutoff]

    def _check_blocked(self, key: str, now: float) -> Optional[int]:
        """Returns remaining seconds if key is temporarily blocked, or None."""
        blocked_until = self._blocks.get(key)
        if blocked_until:
            if now < blocked_until:
                return max(1, int(blocked_until - now))
            else:
                del self._blocks[key]
        return None

    def _record_violation(self, key: str, now: float) -> int:
        """Track violation and apply temporary abuse blocking if thresholds exceeded."""
        self._violations[key] += 1
        v = self._violations[key]
        block_duration = 0
        if v >= ABUSE_BLOCK_24HR_VIOLATIONS:
            block_duration = 86400  # 24 hours
        elif v >= ABUSE_BLOCK_1HR_VIOLATIONS:
            block_duration = 3600   # 1 hour
        elif v >= ABUSE_BLOCK_15MIN_VIOLATIONS:
            block_duration = 900    # 15 minutes

        if block_duration > 0:
            self._blocks[key] = now + block_duration
            return block_duration
        return 0

    def check_rate_limit(
        self,
        key: str,
        max_requests: int,
        window_seconds: int,
        cooldown_seconds: Optional[int] = None,
        key_type: str = "ip",
    ) -> Tuple[bool, int, str]:
        """Check sliding window limit and optional cooldown.
        Returns: (allowed: bool, retry_after_seconds: int, reason: str)
        """
        now = time.time()

        # Check temporary abuse block
        remaining_block = self._check_blocked(key, now)
        if remaining_block:
            return False, remaining_block, "Temporary block due to high request volume. Please wait."

        # Check cooldown if required
        if cooldown_seconds:
            last_time = self._last_event.get(key)
            if last_time and (now - last_time < cooldown_seconds):
                retry = max(1, int(cooldown_seconds - (now - last_time)))
                return False, retry, f"Please wait {retry}s before trying again."

        # Check sliding window
        self._cleanup_old(key, window_seconds, now)
        current_count = len(self._records[key])
        if current_count >= max_requests:
            block_sec = self._record_violation(key, now)
            oldest_ts = self._records[key][0]
            retry = max(1, int(window_seconds - (now - oldest_ts)))
            if block_sec > retry:
                retry = block_sec
            return False, retry, "Too many requests. Please try again later."

        # Record event
        self._records[key].append(now)
        if cooldown_seconds:
            self._last_event[key] = now
        return True, 0, ""

    def reset_key(self, key: str):
        """Clear records for a key upon successful verification."""
        self._records.pop(key, None)
        self._last_event.pop(key, None)
        self._violations.pop(key, None)
        self._blocks.pop(key, None)


# Singleton instance
rate_limiter = RateLimiter()


def enforce_general_ip_rate_limit(request: Request):
    """General API rate limit (default 60 req/min per IP)."""
    ip = get_client_ip(request)
    allowed, retry, msg = rate_limiter.check_rate_limit(
        key=f"gen:ip:{ip}",
        max_requests=GENERAL_IP_PER_MIN,
        window_seconds=60,
        key_type="ip",
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=msg,
            headers={"Retry-After": str(retry)},
        )


def enforce_booking_rate_limit(request: Request, mobile: Optional[str] = None):
    """Enforce book appointment rate limits (per IP + per phone)."""
    now = time.time()
    ip = get_client_ip(request)

    # IP limit (5 per 10 min)
    allowed_ip, retry_ip, msg_ip = rate_limiter.check_rate_limit(
        key=f"book:ip:{ip}",
        max_requests=BOOK_IP_PER_10MIN,
        window_seconds=600,
        key_type="ip",
    )
    if not allowed_ip:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=msg_ip,
            headers={"Retry-After": str(retry_ip)},
        )

    # Phone limit (3 per 10 min)
    if mobile:
        norm_mobile = "".join(ch for ch in mobile if ch.isdigit())
        allowed_ph, retry_ph, msg_ph = rate_limiter.check_rate_limit(
            key=f"book:ph:{norm_mobile}",
            max_requests=BOOK_PHONE_PER_10MIN,
            window_seconds=600,
            key_type="phone",
        )
        if not allowed_ph:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=msg_ph,
                headers={"Retry-After": str(retry_ph)},
            )


def enforce_send_otp_rate_limit(request: Request, mobile: str):
    """Enforce OTP sending limits:
    - 3 sends/10 min per phone
    - 5 sends/10 min per IP
    - 60s cooldown per phone
    """
    ip = get_client_ip(request)
    norm_mobile = "".join(ch for ch in mobile if ch.isdigit())

    # Per IP check (5 / 10min)
    allowed_ip, retry_ip, msg_ip = rate_limiter.check_rate_limit(
        key=f"otp_send:ip:{ip}",
        max_requests=OTP_SEND_IP_PER_10MIN,
        window_seconds=600,
        key_type="ip",
    )
    if not allowed_ip:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=msg_ip,
            headers={"Retry-After": str(retry_ip)},
        )

    # Per Phone check (3 / 10min, with 60s cooldown)
    allowed_ph, retry_ph, msg_ph = rate_limiter.check_rate_limit(
        key=f"otp_send:ph:{norm_mobile}",
        max_requests=OTP_SEND_PHONE_PER_10MIN,
        window_seconds=600,
        cooldown_seconds=OTP_COOLDOWN_SECONDS,
        key_type="phone",
    )
    if not allowed_ph:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=msg_ph,
            headers={"Retry-After": str(retry_ph)},
        )


def enforce_verify_otp_rate_limit(mobile: str):
    """Enforce OTP verification limits (5 attempts/10min per phone)."""
    norm_mobile = "".join(ch for ch in mobile if ch.isdigit())
    allowed, retry, msg = rate_limiter.check_rate_limit(
        key=f"otp_verify:ph:{norm_mobile}",
        max_requests=OTP_VERIFY_PHONE_PER_10MIN,
        window_seconds=600,
        key_type="phone",
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=msg,
            headers={"Retry-After": str(retry)},
        )


def enforce_send_sms_cooldown(appt_id: str):
    """Enforce 30-60s cooldown for sending appointment link SMS for the same appointment."""
    allowed, retry, msg = rate_limiter.check_rate_limit(
        key=f"sms_link:{appt_id}",
        max_requests=1,
        window_seconds=SMS_COOLDOWN_SECONDS,
        cooldown_seconds=SMS_COOLDOWN_SECONDS,
        key_type="appointment",
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Please wait {retry}s before resending the appointment link.",
            headers={"Retry-After": str(retry)},
        )
