"""
Centralized SMS Service using Renflair SMS Gateway API.

Purposes supported:
1. Mobile number OTP verification via Renflair V1 (https://sms.renflair.in/V1.php)
2. Appointment booking confirmation SMS via Renflair V7 (https://sms.renflair.in/V7.php)

Reads credentials securely from backend environment variables:
- RENFLAIR_API_KEY: Secret Renflair API authentication key
- RENFLAIR_BASE_URL: Base URL for Renflair SMS Gateway (default: https://sms.renflair.in)
- APP_PUBLIC_URL: Public frontend URL for Meribaari appointment dashboard (default: http://localhost:8081)

Provider Limitation Note:
Renflair V7 currently does not expose a parameter for the dynamic appointment URL in the provided API specification.
Only API, PHONE, OID, and HOUR are officially accepted by V7.php.

Security Guarantee:
Never logs API keys, OTPs, or authentication credentials.
Never exposes the API key in client responses or bundles.
"""

import os
import logging
import re
import httpx
from typing import Optional, Dict, Any

logger = logging.getLogger("sms_service")

RENFLAIR_BASE_URL = os.environ.get("RENFLAIR_BASE_URL", "https://sms.renflair.in").rstrip("/")
RENFLAIR_OTP_URL = f"{RENFLAIR_BASE_URL}/V1.php"
RENFLAIR_APPT_URL = f"{RENFLAIR_BASE_URL}/V7.php"
REQUEST_TIMEOUT_SECONDS = 8.0


def get_renflair_api_key() -> str:
    """Retrieve Renflair API key from environment with fallback checks."""
    key = os.environ.get("RENFLAIR_API_KEY")
    if not key or key.strip() in ("placeholder", "your_renflair_api_key"):
        key = os.environ.get("RENFLAIR_API") or os.environ.get("Renflair-api")
    return (key or "").strip()


def get_app_public_url() -> str:
    """Retrieve public frontend URL for dynamic appointment links."""
    return os.environ.get("APP_PUBLIC_URL", "http://localhost:8081").rstrip("/")


def mask_phone_for_logging(phone: str) -> str:
    """Safely mask phone number for audit logs (e.g. 98765*****)."""
    if not phone:
        return "unknown"
    clean = re.sub(r"\D", "", str(phone))
    if len(clean) >= 5:
        return f"{clean[:5]}*****"
    return "*****"


def format_renflair_phone(phone: str) -> Optional[str]:
    """Validate and normalize Indian mobile number to the 10-digit format expected by Renflair.
    Example: +919876543210 -> 9876543210, 09876543210 -> 9876543210.
    Returns None if the phone is not a valid 10-digit Indian mobile number.
    """
    if not phone:
        return None
    # Strip all non-digit characters
    digits = "".join(ch for ch in str(phone) if ch.isdigit())
    
    # Strip leading country codes (91) or trunk prefixes (0)
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    
    # Valid Indian mobile number: exactly 10 digits starting with 6, 7, 8, or 9
    if len(digits) == 10 and digits[0] in "6789":
        return digits
    return None


def format_renflair_oid(oid_val: Any) -> str:
    """Format booking/appointment identifier (OID) required by Renflair V7 template.
    Accepts integer token numbers or alphanumeric appointment IDs.
    """
    if oid_val is None:
        return "1"
    clean = str(oid_val).strip()
    return clean if clean else "1"


def format_renflair_hour(hour_val: Any, default: str = "2") -> str:
    """Format hour/time value (HOUR) required by Renflair V7 template.
    Extracts numerical hour from formats like '10:30 AM', '14:00', 2, etc.
    """
    if hour_val is None:
        return str(default)
    
    val_str = str(hour_val).strip()
    if not val_str:
        return str(default)
    
    # If already a clean integer/number string
    if val_str.isdigit():
        return val_str
    
    # Try parsing time format (e.g. "10:30 AM", "02:15 PM", "11:00")
    match = re.match(r"^(\d{1,2})(?::\d{2})?\s*(AM|PM)?", val_str, re.IGNORECASE)
    if match:
        hr = int(match.group(1))
        meridiem = match.group(2)
        if meridiem:
            meridiem = meridiem.upper()
            if meridiem == "PM" and hr < 12:
                hr += 12
            elif meridiem == "AM" and hr == 12:
                hr = 0
        return str(hr)
    
    return str(default)


# Backward-compatible alias for existing tests/callers
format_brevo_recipient = format_renflair_phone


def _parse_provider_response(resp: httpx.Response) -> Dict[str, Any]:
    """Defensively parse Renflair HTTP response (JSON or plain text).
    Never leaks sensitive details.
    """
    content_type = resp.headers.get("content-type", "").lower()
    raw_text = resp.text.strip()
    
    # Try JSON parsing first
    parsed_json = None
    try:
        parsed_json = resp.json()
    except Exception:
        pass
    
    if isinstance(parsed_json, dict):
        # Look for error indicators in JSON
        status_field = str(parsed_json.get("status", "")).lower()
        type_field = str(parsed_json.get("type", "")).lower()
        error_field = parsed_json.get("error") or parsed_json.get("message")
        
        if status_field in ("error", "failed", "failure") or type_field in ("error", "failed"):
            return {
                "ok": False,
                "error": str(error_field or "Renflair returned error status"),
                "status_code": resp.status_code,
            }
        return {
            "ok": True,
            "data": parsed_json,
            "status_code": resp.status_code,
        }
    
    # Plain text handling
    lower_text = raw_text.lower()
    error_keywords = ("error", "invalid", "fail", "denied", "unauthorized", "missing")
    if any(k in lower_text for k in error_keywords):
        return {
            "ok": False,
            "error": raw_text[:120] or f"Renflair error (HTTP {resp.status_code})",
            "status_code": resp.status_code,
        }
    
    return {
        "ok": True,
        "raw_text": raw_text[:120],
        "status_code": resp.status_code,
    }


async def send_otp_sms(phone: str, otp: str) -> Dict[str, Any]:
    """Send OTP verification code to patient's mobile number via Renflair V1 API.

    Endpoint:
    GET https://sms.renflair.in/V1.php?API={RENFLAIR_API_KEY}&PHONE={PHONE}&OTP={OTP}

    All query parameters are automatically URL-encoded.
    Plaintext OTP and API key are NEVER logged.
    """
    formatted_phone = format_renflair_phone(phone)
    if not formatted_phone:
        logger.warning("Renflair OTP dispatch rejected: Invalid Indian phone format")
        return {
            "ok": False,
            "error": "Invalid Indian mobile number format. Must be 10 digits starting with 6-9.",
            "error_code": "INVALID_PHONE",
        }
    
    api_key = get_renflair_api_key()
    if not api_key:
        logger.warning("Renflair OTP dispatch blocked: RENFLAIR_API_KEY not configured")
        return {
            "ok": False,
            "error": "Renflair API key is not configured.",
            "error_code": "MISSING_API_KEY",
        }
    
    clean_otp = str(otp).strip()
    if not clean_otp:
        return {
            "ok": False,
            "error": "OTP cannot be empty.",
            "error_code": "INVALID_OTP",
        }
    
    params = {
        "API": api_key,
        "PHONE": formatted_phone,
        "OTP": clean_otp,
    }
    
    masked_phone = mask_phone_for_logging(formatted_phone)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(RENFLAIR_OTP_URL, params=params)
            
            if resp.status_code == 200:
                parsed = _parse_provider_response(resp)
                if parsed.get("ok"):
                    logger.info(f"Renflair OTP SMS successfully sent to {masked_phone}")
                    return {"ok": True, "provider": "renflair", "phone": formatted_phone}
                else:
                    logger.warning(f"Renflair OTP error for {masked_phone}: {parsed.get('error')}")
                    return {
                        "ok": False,
                        "provider": "renflair",
                        "error": parsed.get("error", "Renflair provider error"),
                        "error_code": "PROVIDER_ERROR",
                    }
            else:
                logger.error(f"Renflair OTP HTTP {resp.status_code} for {masked_phone}")
                return {
                    "ok": False,
                    "provider": "renflair",
                    "error": f"Renflair gateway HTTP {resp.status_code}",
                    "error_code": "GATEWAY_ERROR",
                    "status_code": resp.status_code,
                }
    except httpx.TimeoutException:
        logger.error(f"Renflair OTP request timed out after {REQUEST_TIMEOUT_SECONDS}s for {masked_phone}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway request timed out.",
            "error_code": "TIMEOUT",
        }
    except Exception as e:
        logger.error(f"Renflair OTP communication failure for {masked_phone}: {type(e).__name__}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway connection failed.",
            "error_code": "CONNECTION_ERROR",
        }


async def send_appointment_sms(
    phone: str,
    oid: Optional[Any] = None,
    hour: Optional[Any] = None,
    **kwargs,
) -> Dict[str, Any]:
    """Send appointment booking confirmation SMS via Renflair V7 API.

    Endpoint:
    GET https://sms.renflair.in/V7.php?API={RENFLAIR_API_KEY}&PHONE={PHONE}&OID={OID}&HOUR={HOUR}

    Parameter Mapping:
    - PHONE: 10-digit normalized Indian mobile number.
    - OID: Booking/order/token identifier (derived from oid or token_number or appointment id).
    - HOUR: Hour/time value (derived from hour or estimated_time or slot).

    Backward Compatibility:
    Accepts legacy arguments (patient_name, doctor_name, token_number, estimated_time, appointment_link)
    so existing callers and tests remain fully functional without regressions.

    Provider Limitation Note:
    Renflair V7 currently does not expose a parameter for the dynamic appointment URL in the provided API specification.
    Only API, PHONE, OID, and HOUR are sent.
    """
    formatted_phone = format_renflair_phone(phone)
    if not formatted_phone:
        logger.warning("Renflair Appointment SMS rejected: Invalid Indian phone format")
        return {
            "ok": False,
            "error": "Invalid Indian mobile number format.",
            "error_code": "INVALID_PHONE",
        }
    
    api_key = get_renflair_api_key()
    if not api_key:
        logger.warning("Renflair Appointment SMS blocked: RENFLAIR_API_KEY not configured")
        return {
            "ok": False,
            "error": "Renflair API key is not configured.",
            "error_code": "MISSING_API_KEY",
        }
    
    # Resolve OID
    resolved_oid = oid
    if resolved_oid is None:
        resolved_oid = kwargs.get("token_number") or kwargs.get("appointment_id") or kwargs.get("id") or "1"
    formatted_oid = format_renflair_oid(resolved_oid)
    
    # Resolve HOUR
    resolved_hour = hour
    if resolved_hour is None:
        resolved_hour = kwargs.get("estimated_time") or kwargs.get("slot") or "2"
    formatted_hour = format_renflair_hour(resolved_hour, default="2")
    
    params = {
        "API": api_key,
        "PHONE": formatted_phone,
        "OID": formatted_oid,
        "HOUR": formatted_hour,
    }
    
    masked_phone = mask_phone_for_logging(formatted_phone)
    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(RENFLAIR_APPT_URL, params=params)
            
            if resp.status_code == 200:
                parsed = _parse_provider_response(resp)
                if parsed.get("ok"):
                    logger.info(f"Renflair Appointment SMS sent to {masked_phone} (OID: {formatted_oid}, HOUR: {formatted_hour})")
                    return {
                        "ok": True,
                        "provider": "renflair",
                        "phone": formatted_phone,
                        "oid": formatted_oid,
                        "hour": formatted_hour,
                    }
                else:
                    logger.warning(f"Renflair Appointment SMS error for {masked_phone}: {parsed.get('error')}")
                    return {
                        "ok": False,
                        "provider": "renflair",
                        "error": parsed.get("error", "Renflair provider error"),
                        "error_code": "PROVIDER_ERROR",
                    }
            else:
                logger.error(f"Renflair Appointment HTTP {resp.status_code} for {masked_phone}")
                return {
                    "ok": False,
                    "provider": "renflair",
                    "error": f"Renflair gateway HTTP {resp.status_code}",
                    "error_code": "GATEWAY_ERROR",
                    "status_code": resp.status_code,
                }
    except httpx.TimeoutException:
        logger.error(f"Renflair Appointment request timed out after {REQUEST_TIMEOUT_SECONDS}s for {masked_phone}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway request timed out.",
            "error_code": "TIMEOUT",
        }
    except Exception as e:
        logger.error(f"Renflair Appointment communication failure for {masked_phone}: {type(e).__name__}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway connection failed.",
            "error_code": "CONNECTION_ERROR",
        }
