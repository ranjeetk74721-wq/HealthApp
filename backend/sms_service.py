"""
Centralized SMS Service with Multi-Provider Support (LiveAir, Brevo, Renflair).

Purposes supported:
1. Mobile number OTP verification (via existing working provider / LiveAir OTP)
2. Appointment booking confirmation SMS with dynamic appointment link

Provider Switch:
Configured via backend environment variable:
- SMS_PROVIDER=liveair -> Dispatches via LiveAir SMS Gateway HTTP API
- SMS_PROVIDER=brevo   -> Dispatches via Brevo Transactional SMS HTTP API
- SMS_PROVIDER=renflair (default/fallback) -> Dispatches via Renflair SMS Gateway

Credentials and Configuration:
- LiveAir: LIVEAIR_API_TOKEN, LIVEAIR_SENDER_ID, LIVEAIR_ROUTE, LIVEAIR_MESSAGE_TYPE, LIVEAIR_TEMPLATE_ID
- Brevo: BREVO_API_KEY (or Brevo-api), BREVO_SMS_SENDER
- Renflair: RENFLAIR_API_KEY, RENFLAIR_BASE_URL
- Common: APP_PUBLIC_URL (Frontend dynamic appointment link host)

Security Guarantees:
- Never logs API keys, tokens, OTPs, or authentication credentials.
- Never exposes API keys or provider tokens in client responses or bundles.
- Dispatches all provider HTTP requests strictly from backend.
"""

import os
import logging
import re
import httpx
from typing import Optional, Dict, Any

try:
    from liveair_sms_service import (
        send_liveair_sms,
        get_liveair_delivery_status,
        normalize_liveair_number,
    )
except ImportError:
    from backend.liveair_sms_service import (
        send_liveair_sms,
        get_liveair_delivery_status,
        normalize_liveair_number,
    )

logger = logging.getLogger("sms_service")

# Provider endpoints & timeouts
RENFLAIR_BASE_URL = os.environ.get("RENFLAIR_BASE_URL", "https://sms.renflair.in").rstrip("/")
RENFLAIR_OTP_URL = f"{RENFLAIR_BASE_URL}/V1.php"
RENFLAIR_APPT_URL = f"{RENFLAIR_BASE_URL}/V7.php"

BREVO_API_URL = "https://api.brevo.com/v3/transactionalSMS/send"

REQUEST_TIMEOUT_SECONDS = 8.0


def get_sms_provider() -> str:
    """Retrieve active SMS provider switch from environment (liveair, brevo, or renflair)."""
    val = (os.environ.get("SMS_PROVIDER") or "").strip().lower()
    if val in ("liveair", "brevo", "renflair"):
        # If LiveAir is selected but LIVEAIR_API_TOKEN is empty, fallback to renflair if available
        if val == "liveair" and not (os.environ.get("LIVEAIR_API_TOKEN") or "").strip():
            if (os.environ.get("RENFLAIR_API_KEY") or "").strip():
                return "renflair"
        return val
    # If not explicitly set, default to renflair for backward compatibility
    return "renflair"



def get_renflair_api_key() -> str:
    """Retrieve Renflair API key from environment with fallback checks."""
    key = os.environ.get("RENFLAIR_API_KEY")
    if not key or key.strip() in ("placeholder", "your_renflair_api_key"):
        key = os.environ.get("RENFLAIR_API") or os.environ.get("Renflair-api")
    return (key or "").strip()


def get_brevo_api_key() -> str:
    """Retrieve Brevo API key from environment, checking standard and fallback keys."""
    key = os.environ.get("BREVO_API_KEY")
    if not key or key.strip() in ("placeholder", "your_brevo_api_key"):
        key = os.environ.get("Brevo-api") or os.environ.get("BREVO_API")
    return (key or "").strip()


def get_brevo_sender() -> str:
    """Retrieve Brevo sender name (max 11 alphanumeric characters)."""
    raw = os.environ.get("BREVO_SMS_SENDER", "Meribaari").strip()
    clean = re.sub(r"[^a-zA-Z0-9]", "", raw)[:11]
    return clean or "Meribaari"


def get_app_public_url() -> str:
    """Retrieve public frontend URL for dynamic appointment links."""
    return os.environ.get("APP_PUBLIC_URL", "https://health-at0ltu9id-mariya12.vercel.app").rstrip("/")


def mask_phone_for_logging(phone: str) -> str:
    """Safely mask phone number for audit logs (e.g. 98765*****)."""
    if not phone:
        return "unknown"
    clean = re.sub(r"\D", "", str(phone))
    if len(clean) >= 5:
        return f"{clean[:5]}*****"
    return "*****"


def format_renflair_phone(phone: str) -> Optional[str]:
    """Validate and normalize Indian mobile number to the 10-digit format expected by SMS providers.
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


# Backward-compatible alias for existing tests/callers
format_brevo_recipient = format_renflair_phone


def format_renflair_oid(oid_val: Any) -> str:
    """Format booking/appointment identifier (OID) required by SMS templates.
    Accepts integer token numbers or alphanumeric appointment IDs.
    """
    if oid_val is None:
        return "1"
    clean = str(oid_val).strip()
    return clean if clean else "1"


def format_12hr_time(val: Any) -> str:
    """Format time string or datetime into standard 12-hour AM/PM format."""
    if val is None:
        return ""
    val_str = str(val).strip()
    if not val_str:
        return ""
    m_12 = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$", val_str, re.IGNORECASE)
    if m_12:
        hr = str(int(m_12.group(1)))
        return f"{hr}:{m_12.group(2)} {m_12.group(3).upper()}"
    m_24 = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", val_str)
    if m_24:
        hr_24 = int(m_24.group(1))
        minute = m_24.group(2)
        ampm = "PM" if hr_24 >= 12 else "AM"
        hr_12 = hr_24 % 12 or 12
        return f"{hr_12}:{minute} {ampm}"
    return val_str


def format_expected_time_range(start: Any, end: Optional[Any] = None) -> str:
    """Format start and end times into standard 12-hour AM/PM range."""
    if start is None and end is None:
        return ""
    if isinstance(start, str) and not end:
        sep = " – " if " – " in start else (" - " if " - " in start else None)
        if sep:
            parts = start.split(sep, 1)
            s_part = format_12hr_time(parts[0].strip())
            e_part = format_12hr_time(parts[1].strip())
            if not e_part or s_part == e_part:
                return s_part
            return f"{s_part} – {e_part}"
    start_str = format_12hr_time(start)
    if not end:
        return start_str
    end_str = format_12hr_time(end)
    if not start_str:
        return end_str
    if not end_str or start_str == end_str:
        return start_str
    return f"{start_str} – {end_str}"


def format_renflair_hour(hour_val: Any, default: str = "2") -> str:
    """Format hour/time value required by template.
    Preserves standard 12-hour AM/PM range or single clean hour.
    """
    if hour_val is None:
        return str(default)
    
    val_str = str(hour_val).strip()
    if not val_str:
        return str(default)

    if " – " in val_str or " - " in val_str:
        return format_expected_time_range(val_str)
    
    if val_str.isdigit():
        return val_str
    
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


# Hindi instruction line for queue tracking
HINDI_QUEUE_INSTRUCTION = "आपका नंबर कब आएगा देखने के लिए लिंक पर क्लिक करें:"


def format_custom_appointment_sms(
    hospital_name: str,
    token_number: Any,
    estimated_time: str,
    dynamic_link: str,
) -> str:
    """Format custom appointment confirmation SMS per Requirement 5:
    {HOSPITAL_NAME}

    Aapka appointment confirm ho gaya hai.

    Token: {TOKEN_NUMBER}
    Estimated Time: {ESTIMATED_TIME}

    Aapka number kab aayega dekhne ke liye:
    {DYNAMIC_LINK}
    """
    hosp = (hospital_name or "MeriBaari Clinic").strip()
    token = str(token_number or "1").strip()
    eta = str(estimated_time or "As per live queue").strip()
    link = str(dynamic_link or "").strip()

    return (
        f"{hosp}\n\n"
        f"Aapka appointment confirm ho gaya hai.\n\n"
        f"Token: {token}\n"
        f"Estimated Time: {eta}\n\n"
        f"Aapka number kab aayega dekhne ke liye:\n"
        f"{link}"
    )


def format_appointment_sms_text(
    hospital_name: str,
    doctor_name: str,
    token_number: Any,
    expected_time: str,
    live_queue_link: str,
) -> str:
    """Format appointment confirmation SMS message in plain text:
    {HOSPITAL_NAME}
    आपका नंबर कब आएगा देखने के लिए लिंक पर क्लिक करें:
    {LIVE_QUEUE_LINK}
    Dr. {DOCTOR_NAME}
    Token: {TOKEN} | Time: {EXPECTED_TIME}
    Thank you
    -MeriBaari
    """
    hosp = (hospital_name or "MeriBaari Clinic").strip()
    doc = (doctor_name or "Doctor").strip()
    clean_doc = doc if not doc.lower().startswith("dr.") else doc[3:].strip()
    clean_token = str(token_number or "1").strip()
    clean_time = str(expected_time or "As per live queue").strip()
    clean_link = str(live_queue_link or "https://health-at0ltu9id-mariya12.vercel.app/login").strip()

    return (
        f"{hosp}\n"
        f"{HINDI_QUEUE_INSTRUCTION}\n"
        f"{clean_link}\n"
        f"Dr. {clean_doc}\n"
        f"Token: {clean_token} | Time: {clean_time}\n"
        f"Thank you\n"
        f"-MeriBaari"
    )


def _parse_provider_response(resp: httpx.Response) -> Dict[str, Any]:
    """Defensively parse Renflair HTTP response (JSON or plain text).
    Never leaks sensitive details.
    """
    content_type = resp.headers.get("content-type", "").lower()
    raw_text = resp.text.strip()
    
    parsed_json = None
    try:
        parsed_json = resp.json()
    except Exception:
        pass
    
    if isinstance(parsed_json, dict):
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


# ============ BREVO INTEGRATION ============

async def send_sms_via_brevo(recipient: str, content: str) -> Dict[str, Any]:
    """Execute Brevo Transactional SMS HTTP POST request."""
    api_key = get_brevo_api_key()
    if not api_key or api_key == "placeholder":
        logger.warning(f"[SMS] Provider: Brevo | BREVO_API_KEY not configured. Simulated SMS to {recipient[:6]}****")
        return {"ok": True, "simulated": True, "message_id": "simulated_sms_id", "provider": "brevo"}

    formatted_recipient = format_renflair_phone(recipient)
    if not formatted_recipient:
        logger.warning(f"[SMS] Provider: Brevo | Invalid recipient phone format: {recipient[:4]}***")
        return {"ok": False, "provider": "brevo", "error": "Invalid recipient phone number"}

    sender = get_brevo_sender()
    payload = {
        "sender": sender,
        "recipient": f"+91{formatted_recipient}",
        "content": content,
        "type": "transactional",
    }
    headers = {
        "accept": "application/json",
        "api-key": api_key,
        "content-type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(BREVO_API_URL, json=payload, headers=headers)
            if resp.status_code in (200, 201):
                data = resp.json() if resp.content else {}
                msg_id = data.get("messageId") or data.get("reference") or "delivered"
                logger.info(f"[SMS] Provider: Brevo | Dispatched to +91{formatted_recipient[:5]}**** (id: {msg_id})")
                return {"ok": True, "provider": "brevo", "message_id": str(msg_id)}
            else:
                err_msg = resp.text
                try:
                    err_msg = resp.json().get("message", resp.text)
                except Exception:
                    pass
                logger.error(f"[SMS] Provider: Brevo error HTTP {resp.status_code}: {err_msg[:200]}")
                return {"ok": False, "provider": "brevo", "error": f"Brevo HTTP {resp.status_code}", "status_code": resp.status_code}
    except httpx.TimeoutException:
        logger.error(f"[SMS] Provider: Brevo timeout after {REQUEST_TIMEOUT_SECONDS}s")
        return {"ok": False, "provider": "brevo", "error": "Brevo SMS timeout"}
    except Exception as e:
        logger.error(f"[SMS] Provider: Brevo error: {type(e).__name__}")
        return {"ok": False, "provider": "brevo", "error": "SMS gateway connection failed"}


# ============ DISPATCH ROUTERS ============

async def send_otp_sms(phone: str, otp: str) -> Dict[str, Any]:
    """Send OTP verification code.
    Per Requirement 14:
    - Default remains on current working OTP implementation (Renflair V1).
    - If LiveAir is configured with LIVEAIR_OTP_ENABLED=1, routes through LiveAir.
    - If Brevo is configured with BREVO_OTP_ENABLED=1, routes through Brevo.
    Plaintext OTP and API keys are NEVER logged.
    """
    formatted_phone = format_renflair_phone(phone)
    if not formatted_phone:
        logger.warning("[SMS] OTP dispatch rejected: Invalid Indian phone format")
        return {
            "ok": False,
            "error": "Invalid Indian mobile number format. Must be 10 digits starting with 6-9.",
            "error_code": "INVALID_PHONE",
        }
    
    clean_otp = str(otp).strip()
    if not clean_otp:
        return {
            "ok": False,
            "error": "OTP cannot be empty.",
            "error_code": "INVALID_OTP",
        }

    provider = get_sms_provider()

    # Route to LiveAir OTP if explicitly enabled (LIVEAIR_OTP_ENABLED=1)
    if provider == "liveair" and os.environ.get("LIVEAIR_OTP_ENABLED") == "1":
        otp_sender = (os.environ.get("LIVEAIR_OTP_SENDER_ID") or os.environ.get("LIVEAIR_SENDER_ID") or "LNCHLY").strip()
        otp_route = str(os.environ.get("LIVEAIR_OTP_ROUTE", "4")).strip()
        otp_type = str(os.environ.get("LIVEAIR_OTP_MESSAGE_TYPE") or os.environ.get("LIVEAIR_MESSAGE_TYPE", "1")).strip()
        otp_template = (os.environ.get("LIVEAIR_OTP_TEMPLATE_ID") or os.environ.get("LIVEAIR_TEMPLATE_ID") or "1701177408762310294").strip()
        otp_msg = f"Your verification code is {clean_otp} Use this OTP to complete your login. Do not share this code with anyone. -Launchly"
        
        res = await send_liveair_sms(
            phone=formatted_phone,
            message=otp_msg,
            template_id=otp_template,
            route=otp_route,
            sender=otp_sender,
            message_type=otp_type,
            purpose="otp_verification",
        )
        
        masked_phone = f"******{formatted_phone[-4:]}" if len(formatted_phone) >= 4 else "******"
        logger.info(
            f"[OTP]\n"
            f"Phone: {masked_phone}\n"
            f"Existing user: NO\n"
            f"Provider: LiveAir\n"
            f"Route: {otp_route}\n"
            f"Send status: {'ACCEPTED' if res.get('success') else 'FAILED'}\n"
            f"Provider message id: {res.get('message_id') or 'NONE'}"
        )
        
        return {
            "ok": res.get("success", False),
            "provider": "liveair",
            "phone": formatted_phone,
            "message_id": res.get("message_id"),
            "error": res.get("error"),
            "error_code": res.get("code"),
        }

    # Route to Brevo OTP if explicitly enabled
    if provider == "brevo" and os.environ.get("BREVO_OTP_ENABLED") == "1":
        otp_msg = f"Meribaari: Your verification code is {clean_otp}. Valid for 5 minutes. Do not share this OTP with anyone."
        res = await send_sms_via_brevo(formatted_phone, otp_msg)
        return {
            "ok": res.get("ok", False),
            "provider": "brevo",
            "phone": formatted_phone,
            "message_id": res.get("message_id"),
            "error": res.get("error"),
        }

    # Standard Renflair V1 OTP implementation (Default)
    api_key = get_renflair_api_key()
    if not api_key:
        logger.warning("[SMS] Renflair OTP dispatch blocked: RENFLAIR_API_KEY not configured")
        return {
            "ok": False,
            "error": "Renflair API key is not configured.",
            "error_code": "MISSING_API_KEY",
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
                    logger.info(f"[SMS] Provider: Renflair | OTP SMS sent to {masked_phone}")
                    return {"ok": True, "provider": "renflair", "phone": formatted_phone}
                else:
                    logger.warning(f"[SMS] Provider: Renflair | OTP error for {masked_phone}: {parsed.get('error')}")
                    return {
                        "ok": False,
                        "provider": "renflair",
                        "error": parsed.get("error", "Renflair provider error"),
                        "error_code": "PROVIDER_ERROR",
                    }
            else:
                logger.error(f"[SMS] Provider: Renflair | OTP HTTP {resp.status_code} for {masked_phone}")
                return {
                    "ok": False,
                    "provider": "renflair",
                    "error": f"Renflair gateway HTTP {resp.status_code}",
                    "error_code": "GATEWAY_ERROR",
                    "status_code": resp.status_code,
                }
    except httpx.TimeoutException:
        logger.error(f"[SMS] Provider: Renflair | OTP request timed out for {masked_phone}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway request timed out.",
            "error_code": "TIMEOUT",
        }
    except Exception as e:
        logger.error(f"[SMS] Provider: Renflair | OTP failure for {masked_phone}: {type(e).__name__}")
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
    """Send appointment booking confirmation SMS using configured provider.

    Provider Selection:
    - SMS_PROVIDER=liveair -> LiveAir HTTP SMS API (custom appointment message & dynamic link)
    - SMS_PROVIDER=brevo   -> Brevo Transactional SMS API
    - SMS_PROVIDER=renflair (default) -> Renflair V7 API

    Accepts arguments (hospital_name, doctor_name, token_number, expected_time, live_queue_link)
    """
    # Resolve OID & HOUR
    resolved_oid = oid
    if resolved_oid is None:
        resolved_oid = kwargs.get("token_number") or kwargs.get("appointment_id") or kwargs.get("id") or "1"
    formatted_oid = format_renflair_oid(resolved_oid)
    
    resolved_hour = hour
    if resolved_hour is None:
        resolved_hour = kwargs.get("expected_time") or kwargs.get("estimated_time") or kwargs.get("slot") or "2"
    
    if isinstance(resolved_hour, str) and (" – " in resolved_hour or " - " in resolved_hour):
        formatted_hour = format_expected_time_range(resolved_hour)
    elif kwargs.get("expected_time") and (" – " in str(kwargs["expected_time"]) or " - " in str(kwargs["expected_time"])):
        formatted_hour = format_expected_time_range(kwargs["expected_time"])
    else:
        formatted_hour = format_renflair_hour(resolved_hour, default="2")

    # Resolve message fields
    hospital_name = kwargs.get("hospital_name") or kwargs.get("clinic_name") or "MeriBaari Clinic"
    doctor_name = kwargs.get("doctor_name") or "Doctor"
    token_number = kwargs.get("token_number") or formatted_oid
    expected_time = kwargs.get("expected_time") or kwargs.get("estimated_time") or "As per live queue"
    live_queue_link = kwargs.get("live_queue_link") or kwargs.get("appointment_link") or ""

    # Generate custom appointment confirmation message (Requirement 5)
    custom_sms_text = format_custom_appointment_sms(
        hospital_name=hospital_name,
        token_number=token_number,
        estimated_time=expected_time,
        dynamic_link=live_queue_link,
    )

    # Generate template-compatible message for existing tests & backward compatibility
    template_sms_text = format_appointment_sms_text(
        hospital_name=hospital_name,
        doctor_name=doctor_name,
        token_number=token_number,
        expected_time=expected_time,
        live_queue_link=live_queue_link,
    )

    formatted_phone = format_renflair_phone(phone)
    if not formatted_phone:
        logger.warning("[SMS] Appointment SMS rejected: Invalid Indian phone format")
        return {
            "ok": False,
            "error": "Invalid Indian mobile number format.",
            "error_code": "INVALID_PHONE",
            "sms_text": template_sms_text,
        }

    provider = get_sms_provider()

    # ============ LIVEAIR PROVIDER BRANCH ============
    if provider == "liveair":
        # Check if custom or template text is requested (defaults to custom formatted message)
        liveair_text = custom_sms_text if os.environ.get("LIVEAIR_USE_TEMPLATE_TEXT") != "1" else template_sms_text
        liveair_res = await send_liveair_sms(
            phone=formatted_phone,
            message=liveair_text,
            purpose="appointment_confirmation",
            appt_ref=str(formatted_oid),
        )
        return {
            "ok": liveair_res.get("success", False),
            "provider": "liveair",
            "phone": formatted_phone,
            "oid": formatted_oid,
            "hour": formatted_hour,
            "message_id": liveair_res.get("message_id"),
            "sms_text": liveair_text,
            "error": liveair_res.get("error"),
            "error_code": liveair_res.get("code"),
        }

    # ============ BREVO PROVIDER BRANCH ============
    if provider == "brevo":
        brevo_res = await send_sms_via_brevo(
            recipient=formatted_phone,
            content=custom_sms_text,
        )
        return {
            "ok": brevo_res.get("ok", False),
            "provider": "brevo",
            "phone": formatted_phone,
            "oid": formatted_oid,
            "hour": formatted_hour,
            "message_id": brevo_res.get("message_id"),
            "sms_text": custom_sms_text,
            "error": brevo_res.get("error"),
        }

    # ============ RENFLAIR PROVIDER BRANCH (DEFAULT) ============
    api_key = get_renflair_api_key()
    if not api_key:
        logger.warning("[SMS] Renflair Appointment SMS blocked: RENFLAIR_API_KEY not configured")
        return {
            "ok": False,
            "error": "Renflair API key is not configured.",
            "error_code": "MISSING_API_KEY",
            "sms_text": template_sms_text,
        }
    
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
                    logger.info(f"[SMS] Provider: Renflair | Appointment SMS sent to {masked_phone} (OID: {formatted_oid}, HOUR: {formatted_hour})")
                    return {
                        "ok": True,
                        "provider": "renflair",
                        "phone": formatted_phone,
                        "oid": formatted_oid,
                        "hour": formatted_hour,
                        "sms_text": template_sms_text,
                    }
                else:
                    logger.warning(f"[SMS] Provider: Renflair | Appointment error for {masked_phone}: {parsed.get('error')}")
                    return {
                        "ok": False,
                        "provider": "renflair",
                        "error": parsed.get("error", "Renflair provider error"),
                        "error_code": "PROVIDER_ERROR",
                        "sms_text": template_sms_text,
                    }
            else:
                logger.error(f"[SMS] Provider: Renflair | HTTP {resp.status_code} for {masked_phone}")
                return {
                    "ok": False,
                    "provider": "renflair",
                    "error": f"Renflair gateway HTTP {resp.status_code}",
                    "error_code": "GATEWAY_ERROR",
                    "status_code": resp.status_code,
                    "sms_text": template_sms_text,
                }
    except httpx.TimeoutException:
        logger.error(f"[SMS] Provider: Renflair | Appointment request timed out for {masked_phone}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway request timed out.",
            "error_code": "TIMEOUT",
            "sms_text": template_sms_text,
        }
    except Exception as e:
        logger.error(f"[SMS] Provider: Renflair | Communication failure for {masked_phone}: {type(e).__name__}")
        return {
            "ok": False,
            "provider": "renflair",
            "error": "SMS gateway connection failed.",
            "error_code": "CONNECTION_ERROR",
            "sms_text": template_sms_text,
        }
