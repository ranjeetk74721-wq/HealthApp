"""
Centralized SMS Service using Brevo Transactional SMS API.

Reads credentials securely from backend environment variables:
- BREVO_API_KEY
- BREVO_SMS_SENDER (default: "Meribaari", max 11 alphanumeric chars)
- APP_PUBLIC_URL (default: "http://localhost:8081")

Never logs API keys, OTPs, or authentication credentials.
"""

import os
import logging
import re
import httpx
from typing import Optional, Dict, Any

logger = logging.getLogger("sms_service")

BREVO_API_URL = "https://api.brevo.com/v3/transactionalSMS/send"
REQUEST_TIMEOUT_SECONDS = 8.0


def get_brevo_api_key() -> str:
    """Retrieve Brevo API key from environment, checking standard and fallback keys."""
    key = os.environ.get("BREVO_API_KEY")
    if not key or key.strip() == "placeholder":
        # Fallback check
        key = os.environ.get("Brevo-api") or os.environ.get("BREVO_API")
    return (key or "").strip()


def get_brevo_sender() -> str:
    """Retrieve sender name (max 11 alphanumeric characters)."""
    raw = os.environ.get("BREVO_SMS_SENDER", "Meribaari").strip()
    # Sanitize to alphanumeric max 11 chars
    clean = re.sub(r"[^a-zA-Z0-9]", "", raw)[:11]
    return clean or "Meribaari"


def get_app_public_url() -> str:
    """Retrieve public frontend URL for dynamic appointment links."""
    return os.environ.get("APP_PUBLIC_URL", "http://localhost:8081").rstrip("/")


def format_brevo_recipient(phone: str) -> str:
    """Format phone number for Brevo (e.g. 919876543210 or +919876543210).
    Removes whitespace, hyphens, and formats Indian 10-digit numbers with +91.
    """
    if not phone:
        return ""
    digits = "".join(ch for ch in phone if ch.isdigit())
    if len(digits) == 10:
        return f"+91{digits}"
    if digits.startswith("91") and len(digits) == 12:
        return f"+{digits}"
    if phone.startswith("+"):
        return f"+{digits}"
    return f"+{digits}" if digits else ""


async def send_sms_via_brevo(recipient: str, content: str) -> Dict[str, Any]:
    """Execute low-level Brevo Transactional SMS HTTP POST request."""
    api_key = get_brevo_api_key()
    if not api_key or api_key == "placeholder":
        logger.warning(f"BREVO_API_KEY not configured. Simulated SMS to {recipient[:6]}****: {content[:30]}...")
        return {"ok": True, "simulated": True, "message_id": "simulated_sms_id"}

    formatted_recipient = format_brevo_recipient(recipient)
    if not formatted_recipient or len(formatted_recipient) < 10:
        logger.warning(f"Invalid recipient phone format: {recipient[:4]}***")
        return {"ok": False, "error": "Invalid recipient phone number"}

    sender = get_brevo_sender()
    payload = {
        "sender": sender,
        "recipient": formatted_recipient,
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
                logger.info(f"SMS successfully dispatched via Brevo to {formatted_recipient[:5]}**** (id: {msg_id})")
                return {"ok": True, "message_id": str(msg_id)}
            else:
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("message", resp.text)
                except Exception:
                    err_msg = resp.text
                logger.error(f"Brevo SMS API returned status {resp.status_code}: {err_msg[:200]}")
                return {"ok": False, "error": f"Brevo HTTP {resp.status_code}", "status_code": resp.status_code}
    except httpx.TimeoutException:
        logger.error(f"Brevo SMS request timed out after {REQUEST_TIMEOUT_SECONDS}s")
        return {"ok": False, "error": "Brevo SMS timeout"}
    except Exception as e:
        logger.error(f"Unexpected error communicating with Brevo: {type(e).__name__}")
        return {"ok": False, "error": "SMS gateway connection failed"}


async def send_appointment_sms(
    phone: str,
    patient_name: str,
    doctor_name: str,
    token_number: int,
    estimated_time: str,
    appointment_link: str,
) -> Dict[str, Any]:
    """Send appointment confirmation SMS with dynamic appointment link.
    Format:
    Meribaari: Hello {patientName}, your appointment with Dr. {doctorName} is confirmed. Token: {tokenNumber}. Estimated time: {estimatedTime}. Apna updated appointment aur live queue dekhne ke liye: {dynamicLink}
    """
    safe_name = (patient_name or "Patient").strip()
    safe_doc = (doctor_name or "Doctor").strip()
    clean_doc = safe_doc if not safe_doc.lower().startswith("dr.") else safe_doc[3:].strip()
    safe_eta = (estimated_time or "As per live queue").strip()
    
    content = (
        f"Meribaari: Hello {safe_name}, your appointment with Dr. {clean_doc} is confirmed. "
        f"Token: {token_number}. Estimated time: {safe_eta}. "
        f"Apna updated appointment aur live queue dekhne ke liye: {appointment_link}"
    )

    return await send_sms_via_brevo(phone, content)


async def send_otp_sms(phone: str, otp: str) -> Dict[str, Any]:
    """Send 6-digit OTP verification code via Brevo transactional SMS.
    OTP value is NOT logged.
    """
    content = f"Meribaari: Your verification code is {otp}. Valid for 5 minutes. Do not share this OTP with anyone."
    return await send_sms_via_brevo(phone, content)
