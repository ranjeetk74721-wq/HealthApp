"""
LiveAir SMS Gateway HTTP API Integration.

Implements LiveAir HTTP SMS API and Delivery Report API for MeriBaari:
- Parameter mapping: token, sender, number, route, type, sms, templateid
- Secure credential retrieval from backend environment only
- Sanitized logging (never logs API tokens or full authenticated query URLs)
- Normalized response structure and error code translation (101-113)
- Delivery report status tracking
"""

import os
import re
import logging
from typing import Optional, Dict, Any
import httpx

logger = logging.getLogger("liveair_sms_service")

# Error code mapping according to LiveAir documentation
LIVEAIR_ERROR_CODES: Dict[str, str] = {
    "101": "Invalid user / API token",
    "102": "Invalid sender ID",
    "103": "Invalid contact(s) / recipient number",
    "104": "Invalid SMS route",
    "105": "Invalid message type",
    "106": "Message content does not exist / empty message",
    "109": "No SMSC connection available",
    "110": "Promotional route timing restriction (9 AM - 9 PM)",
    "111": "Provider connection error",
    "112": "All numbers are DND / blocked",
    "113": "Invalid DLT template ID",
}

REQUEST_TIMEOUT_SECONDS = 8.0


def get_liveair_config() -> Dict[str, str]:
    """Retrieve LiveAir environment configuration securely from backend environment."""
    base_url = (os.environ.get("LIVEAIR_BASE_URL") or "https://liveair.co.in").rstrip("/")
    sms_url = os.environ.get("LIVEAIR_SMS_URL") or f"{base_url}/sendsms"
    dlr_url = os.environ.get("LIVEAIR_DLR_URL") or f"{base_url}/deliveryreport"
    
    return {
        "token": (os.environ.get("LIVEAIR_API_TOKEN") or "").strip(),
        "sender": (os.environ.get("LIVEAIR_SENDER_ID") or "MRBARI").strip(),
        "route": (os.environ.get("LIVEAIR_ROUTE") or "2").strip(),
        "type": (os.environ.get("LIVEAIR_MESSAGE_TYPE") or "1").strip(),
        "template_id": (os.environ.get("LIVEAIR_TEMPLATE_ID") or "").strip(),
        "otp_route": (os.environ.get("LIVEAIR_OTP_ROUTE") or "4").strip(),
        "otp_template_id": (os.environ.get("LIVEAIR_OTP_TEMPLATE_ID") or "").strip(),
        "sms_url": sms_url,
        "dlr_url": dlr_url,
    }


def normalize_liveair_number(phone: str) -> Optional[str]:
    """Normalize destination mobile number to 10-digit Indian mobile format.
    Accepts +91XXXXXXXXXX, 91XXXXXXXXXX, 0XXXXXXXXXX, or XXXXXXXXXX.
    Returns 10-digit string starting with 6, 7, 8, or 9, or None if invalid.
    """
    if not phone:
        return None
    digits = "".join(ch for ch in str(phone) if ch.isdigit())
    if digits.startswith("91") and len(digits) == 12:
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) == 11:
        digits = digits[1:]
    
    if len(digits) == 10 and digits[0] in "6789":
        return digits
    return None


def mask_phone_for_logging(phone: str) -> str:
    """Safely mask recipient phone number for logs (e.g. 98765*****)."""
    if not phone:
        return "unknown"
    clean = re.sub(r"\D", "", str(phone))
    if len(clean) >= 5:
        return f"{clean[:5]}*****"
    return "*****"


def parse_liveair_response(status_code: int, response_text: str) -> Dict[str, Any]:
    """Parse raw response from LiveAir HTTP API.
    Provider returns either numeric error codes (e.g. '101', '113') or a message/batch ID on success.
    JSON responses like {"status": "success", "msgid": "..."} or {"status": "error", "code": "..."}
    are also defensively handled.
    """
    raw = (response_text or "").strip()
    
    # Try parsing as JSON first
    import json
    parsed_json = None
    try:
        parsed_json = json.loads(raw)
    except Exception:
        pass

    if isinstance(parsed_json, dict):
        status_val = str(parsed_json.get("status") or "").lower()
        if status_val in ("error", "failed", "failure"):
            code = str(parsed_json.get("code") or parsed_json.get("error_code") or "")
            err_msg = parsed_json.get("message") or parsed_json.get("error") or LIVEAIR_ERROR_CODES.get(code, "LiveAir error")
            return {
                "success": False,
                "provider": "liveair",
                "message_id": None,
                "error": err_msg,
                "code": code or None,
            }
        # JSON success
        msg_id = str(parsed_json.get("msgid") or parsed_json.get("message_id") or parsed_json.get("id") or "liveair_sent")
        return {
            "success": True,
            "provider": "liveair",
            "message_id": msg_id,
            "error": None,
            "code": None,
        }

    # Plain text parsing
    # Check if raw response matches an exact error code
    clean_code = raw.strip().split()[0] if raw else ""
    if clean_code in LIVEAIR_ERROR_CODES:
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": LIVEAIR_ERROR_CODES[clean_code],
            "code": clean_code,
        }

    # Check for keywords indicating failure
    lower_raw = raw.lower()
    if any(k in lower_raw for k in ("invalid", "error", "failed", "denied", "reject", "unauthorized")):
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": raw[:150] or f"HTTP {status_code} error",
            "code": clean_code if clean_code.isdigit() else None,
        }

    if status_code in (200, 201):
        # Treat raw output as message/request ID (or fallback to 'liveair_sent')
        message_id = raw if raw else "liveair_sent"
        return {
            "success": True,
            "provider": "liveair",
            "message_id": message_id,
            "error": None,
            "code": None,
        }

    return {
        "success": False,
        "provider": "liveair",
        "message_id": None,
        "error": f"LiveAir gateway returned HTTP {status_code}",
        "code": str(status_code),
    }


async def send_liveair_sms(
    phone: str,
    message: str,
    template_id: Optional[str] = None,
    route: Optional[str] = None,
    message_type: Optional[str] = None,
    sender: Optional[str] = None,
    purpose: str = "appointment_notification",
    appt_ref: Optional[str] = None,
) -> Dict[str, Any]:
    """Dispatch SMS via LiveAir HTTP SMS API.

    Parameters sent to LiveAir:
    - token: LiveAir API Token (NEVER logged)
    - sender: Sender ID / Header
    - number: Normalized 10-digit Indian recipient mobile number
    - route: Configured route (e.g. 2 for Transactional, 4 for OTP)
    - type: Message type (e.g. 1 for Text, 2 for Unicode)
    - sms: URL-encoded message content
    - templateid: Approved DLT template ID

    Returns normalized response:
    {
       "success": bool,
       "provider": "liveair",
       "message_id": str or None,
       "error": str or None,
       "code": str or None
    }
    """
    config = get_liveair_config()
    token = config["token"]
    if not token or token == "placeholder":
        logger.warning("[SMS] Provider: LiveAir | Configuration Error: LIVEAIR_API_TOKEN is not set.")
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": "LiveAir API token not configured.",
            "code": "MISSING_TOKEN",
        }

    normalized_phone = normalize_liveair_number(phone)
    if not normalized_phone:
        logger.warning(f"[SMS] Provider: LiveAir | Rejected: Invalid recipient phone format {phone[:4] if phone else 'empty'}")
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": "Invalid Indian mobile number format. Must be 10 digits starting with 6-9.",
            "code": "INVALID_PHONE",
        }

    if not message or not str(message).strip():
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": "Message content cannot be empty.",
            "code": "EMPTY_MESSAGE",
        }

    resolved_template_id = template_id or config["template_id"]
    resolved_route = route or config["route"]
    resolved_type = message_type or config["type"]
    resolved_sender = sender or config["sender"]

    # Parameters per LiveAir HTTP API specification
    params = {
        "token": token,
        "sender": resolved_sender,
        "number": normalized_phone,
        "route": resolved_route,
        "type": resolved_type,
        "sms": message.strip(),
    }
    if resolved_template_id:
        params["templateid"] = resolved_template_id

    masked_phone = mask_phone_for_logging(normalized_phone)
    safe_ref = appt_ref or "none"

    try:
        # Request is dispatched from backend only with strict timeout
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            # LiveAir HTTP API accepts GET / POST parameters
            resp = await client.post(config["sms_url"], data=params)
            
            result = parse_liveair_response(resp.status_code, resp.text)
            
            if result.get("success"):
                logger.info(
                    f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
                    f"Appointment: {safe_ref} | Status: SENT | Provider Message ID: {result.get('message_id')}"
                )
            else:
                logger.warning(
                    f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
                    f"Appointment: {safe_ref} | Status: FAILED | Code: {result.get('code')} | Error: {result.get('error')}"
                )
            return result

    except httpx.TimeoutException:
        logger.error(
            f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
            f"Appointment: {safe_ref} | Status: FAILED | Error: Request timed out after {REQUEST_TIMEOUT_SECONDS}s"
        )
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": f"LiveAir gateway request timed out ({REQUEST_TIMEOUT_SECONDS}s).",
            "code": "TIMEOUT",
        }
    except Exception as e:
        logger.error(
            f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
            f"Appointment: {safe_ref} | Status: FAILED | Error: {type(e).__name__}"
        )
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": "SMS gateway connection failed.",
            "code": "CONNECTION_ERROR",
        }


async def get_liveair_delivery_status(message_id: str) -> Dict[str, Any]:
    """Check SMS delivery report via LiveAir Delivery Report API.
    Parameters:
    - token: LiveAir API token
    - messageid: LiveAir message ID
    """
    if not message_id or not str(message_id).strip():
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "status": "INVALID_MESSAGE_ID",
            "error": "message_id is required",
        }

    config = get_liveair_config()
    token = config["token"]
    if not token or token == "placeholder":
        return {
            "success": False,
            "provider": "liveair",
            "message_id": message_id,
            "status": "CONFIG_ERROR",
            "error": "LiveAir API token is not configured.",
        }

    params = {
        "token": token,
        "messageid": str(message_id).strip(),
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(config["dlr_url"], params=params)
            raw = (resp.text or "").strip()
            
            # Defensive JSON check
            import json
            parsed = None
            try:
                parsed = json.loads(raw)
            except Exception:
                pass

            raw_status = ""
            if isinstance(parsed, dict):
                raw_status = str(parsed.get("status") or parsed.get("delivery_status") or "").upper()
            else:
                raw_status = raw.upper()

            # Map to standard statuses: SENT, DELIVERED, FAILED, PENDING
            normalized_status = "PENDING"
            if any(k in raw_status for k in ("DELIV", "DELIVERED", "SUCCESS")):
                normalized_status = "DELIVERED"
            elif any(k in raw_status for k in ("FAIL", "REJECT", "UNDELIV", "EXPIRED", "DND")):
                normalized_status = "FAILED"
            elif any(k in raw_status for k in ("SENT", "SUBMIT", "PROCESS", "DISPATCH")):
                normalized_status = "SENT"
            elif any(k in raw_status for k in ("PEND", "WAIT", "QUEUE")):
                normalized_status = "PENDING"

            return {
                "success": resp.status_code == 200,
                "provider": "liveair",
                "message_id": message_id,
                "status": normalized_status,
                "raw_response": raw[:200] if not any(k in raw.lower() for k in ("token", "key")) else "hidden",
                "error": None if resp.status_code == 200 else f"HTTP {resp.status_code}",
            }
    except httpx.TimeoutException:
        return {
            "success": False,
            "provider": "liveair",
            "message_id": message_id,
            "status": "TIMEOUT",
            "error": "Delivery report query timed out.",
        }
    except Exception as e:
        return {
            "success": False,
            "provider": "liveair",
            "message_id": message_id,
            "status": "ERROR",
            "error": f"Delivery report query failed: {type(e).__name__}",
        }
