"""
LiveAir SMS Gateway HTTP API Integration.

Direct Integration with LiveAir HTTP API:
- Base Send SMS API: http://godspeed.liveair.co.in/httpapi/httpapi
- Available Credits API: http://godspeed.liveair.co.in/httpapi/credits
- Delivery Report API: http://godspeed.liveair.co.in/httpapi/httpdlr

Parameters required by LiveAir:
- token: Authentication token (kept strictly on backend, never logged)
- sender: Approved Sender ID / Header
- number: Normalized 10-digit Indian mobile number (e.g. 98XXXXXXXX, NOT +91)
- route: Configured route (Promotional=1, Transactional=2, Sender ID=3, Trans OTP=4, International=9, Trans2=10)
- type: Message type (Text=1, Flash=2, Unicode=3)
- sms: URL-encoded SMS message content
- templateid: DLT-approved Template ID
"""

import os
import re
import logging
from typing import Optional, Dict, Any
import httpx

logger = logging.getLogger("liveair_sms_service")

# Complete LiveAir Error Codes according to documentation
LIVEAIR_ERROR_CODES: Dict[str, str] = {
    "101": "Invalid user / API token (or route unauthorized for this user)",
    "102": "Invalid sender ID (Check approved DLT sender/header mapping)",
    "103": "Invalid contact(s) / recipient mobile number",
    "104": "Invalid SMS route",
    "105": "Invalid message type",
    "106": "Message content does not exist / empty message",
    "107": "Spam blocked",
    "108": "Low credits in specified route (No SMS credits available)",
    "109": "No SMSC connection available",
    "110": "Promotional route available only 9 AM–9 PM",
    "111": "Connection error",
    "112": "All numbers are DND",
    "113": "Invalid DLT template ID or template mapping mismatch",
}

REQUEST_TIMEOUT_SECONDS = 8.0

DEFAULT_BASE_URL = "http://godspeed.liveair.co.in/httpapi"
DEFAULT_SMS_URL = f"{DEFAULT_BASE_URL}/httpapi"
DEFAULT_CREDITS_URL = f"{DEFAULT_BASE_URL}/credits"
DEFAULT_DLR_URL = f"{DEFAULT_BASE_URL}/httpdlr"


def get_liveair_config() -> Dict[str, str]:
    """Retrieve LiveAir environment configuration securely from backend environment."""
    base_url = (os.environ.get("LIVEAIR_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    sms_url = os.environ.get("LIVEAIR_SMS_URL") or (f"{base_url}/httpapi" if "godspeed" in base_url else f"{base_url}/sendsms")
    credits_url = os.environ.get("LIVEAIR_CREDITS_URL") or f"{base_url}/credits"
    dlr_url = os.environ.get("LIVEAIR_DLR_URL") or (f"{base_url}/httpdlr" if "godspeed" in base_url else f"{base_url}/deliveryreport")
    
    return {
        "token": (os.environ.get("LIVEAIR_API_TOKEN") or "").strip(),
        "sender": (os.environ.get("LIVEAIR_SENDER_ID") or "newsen").strip(),
        "route": (os.environ.get("LIVEAIR_ROUTE") or "3").strip(),
        "type": (os.environ.get("LIVEAIR_MESSAGE_TYPE") or "1").strip(),
        "template_id": (os.environ.get("LIVEAIR_TEMPLATE_ID") or "").strip(),
        "otp_route": (os.environ.get("LIVEAIR_OTP_ROUTE") or "4").strip(),
        "otp_template_id": (os.environ.get("LIVEAIR_OTP_TEMPLATE_ID") or "").strip(),
        "sms_url": sms_url,
        "credits_url": credits_url,
        "dlr_url": dlr_url,
    }


def validate_liveair_startup_config() -> Dict[str, Any]:
    """At backend startup, validate that required LiveAir settings exist.
    Never prints secrets in logs.
    """
    config = get_liveair_config()
    token_present = bool(config["token"] and config["token"] != "placeholder")
    sender_present = bool(config["sender"])
    route_val = config["route"]
    type_val = config["type"]
    template_present = bool(config["template_id"])

    logger.info(
        "LiveAir config:\n"
        f"API token: {'PRESENT' if token_present else 'MISSING'}\n"
        f"Sender ID: {'configured (' + config['sender'] + ')' if sender_present else 'MISSING'}\n"
        f"Route: {route_val}\n"
        f"Message type: {type_val}\n"
        f"Template ID: {'configured' if template_present else 'MISSING'}"
    )

    is_valid = token_present and sender_present and bool(route_val) and bool(type_val) and template_present
    missing_keys = []
    if not token_present: missing_keys.append("LIVEAIR_API_TOKEN")
    if not sender_present: missing_keys.append("LIVEAIR_SENDER_ID")
    if not route_val: missing_keys.append("LIVEAIR_ROUTE")
    if not type_val: missing_keys.append("LIVEAIR_MESSAGE_TYPE")
    if not template_present: missing_keys.append("LIVEAIR_TEMPLATE_ID")

    return {
        "valid": is_valid,
        "missing": missing_keys,
        "route": route_val,
        "type": type_val,
        "sender": config["sender"] if sender_present else "MISSING",
    }


def normalize_liveair_number(phone: str) -> Optional[str]:
    """Normalize destination mobile number to 10-digit Indian mobile format (e.g. 98XXXXXXXX).
    Removes spaces, hyphens, and leading +91 / 91 / 0.
    Does NOT prepend +91 because LiveAir expects 10-digit numbers for domestic routes.
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
    """Safely mask recipient phone number for logs (e.g. ******1234 or 98765*****)."""
    if not phone:
        return "unknown"
    clean = re.sub(r"\D", "", str(phone))
    if len(clean) >= 6:
        return f"******{clean[-4:]}"
    return "*****"


def detect_message_type(message: str, configured_type: Optional[str] = None) -> str:
    """Determine message type (1 for Text/Hinglish, 3 for Unicode/Hindi).
    If message contains non-ASCII characters (e.g. Devanagari Hindi), uses 3.
    Otherwise uses configured_type or 1.
    """
    if configured_type and configured_type in ("1", "2", "3"):
        # If explicitly set to Unicode or Flash, preserve
        if configured_type != "1":
            return configured_type
    
    # Auto-detect if message contains Unicode characters (e.g. Hindi)
    if any(ord(c) > 127 for c in message):
        return "3"
    return configured_type or "1"


def parse_liveair_response(status_code: int, response_text: str) -> Dict[str, Any]:
    """Parse raw response from LiveAir HTTP API.
    Provider returns:
    - 101 to 113 for errors (e.g. '101 : Invalid user' or '112 : All numbers are DND')
    - Any numeric value (e.g. '1709823412345') or JSON is treated as the provider MESSAGE ID.
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
                "raw": raw,
            }
        msg_id = str(parsed_json.get("msgid") or parsed_json.get("message_id") or parsed_json.get("id") or "liveair_sent")
        return {
            "success": True,
            "provider": "liveair",
            "message_id": msg_id,
            "error": None,
            "code": None,
            "raw": raw,
        }

    # Extract leading code token if formatted like "102 : Invalid sender ID" or "101"
    code_candidate = ""
    if ":" in raw:
        code_candidate = raw.split(":")[0].strip()
    else:
        code_candidate = raw.split()[0].strip() if raw else ""

    if code_candidate in LIVEAIR_ERROR_CODES:
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": LIVEAIR_ERROR_CODES[code_candidate],
            "code": code_candidate,
            "raw": raw,
        }

    # Check for failure keywords
    lower_raw = raw.lower()
    if any(k in lower_raw for k in ("invalid", "error", "failed", "denied", "reject", "unauthorized", "spam")):
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": raw[:150] or f"HTTP {status_code} error",
            "code": code_candidate if code_candidate.isdigit() else None,
            "raw": raw,
        }

    # Any other numeric value or non-error response is the LiveAir Message ID
    clean_id = raw.strip()
    if clean_id:
        return {
            "success": True,
            "provider": "liveair",
            "message_id": clean_id,
            "error": None,
            "code": None,
            "raw": raw,
        }

    return {
        "success": False,
        "provider": "liveair",
        "message_id": None,
        "error": f"LiveAir gateway returned empty response (HTTP {status_code})",
        "code": str(status_code),
        "raw": raw,
    }


async def get_liveair_credits(route: Optional[str] = None) -> Dict[str, Any]:
    """Query Available Credits API from LiveAir:
    Endpoint: http://godspeed.liveair.co.in/httpapi/credits
    Parameters: token, route
    """
    config = get_liveair_config()
    token = config["token"]
    if not token or token == "placeholder":
        return {
            "success": False,
            "route": route or config["route"],
            "credits": 0,
            "error": "LIVEAIR_API_TOKEN is not configured.",
            "code": "MISSING_TOKEN",
        }

    resolved_route = str(route or config["route"]).strip()
    params = {
        "token": token,
        "route": resolved_route,
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.get(config["credits_url"], params=params)
            raw = (resp.text or "").strip()

            # Parse credits response: e.g. ["Route","Sender ID","Credits","10"] or raw integer
            if "Credits" in raw or raw.isdigit():
                # Extract number if present
                import json
                parsed_credits = raw
                try:
                    p = json.loads(raw)
                    if isinstance(p, list) and len(p) >= 4:
                        parsed_credits = p[3]
                except Exception:
                    pass

                return {
                    "success": True,
                    "route": resolved_route,
                    "credits": parsed_credits,
                    "raw": raw,
                }
            
            # Check error code
            code_candidate = raw.split(":")[0].strip().split()[0] if raw else ""
            err_msg = LIVEAIR_ERROR_CODES.get(code_candidate, raw)
            return {
                "success": False,
                "route": resolved_route,
                "credits": 0,
                "error": err_msg,
                "code": code_candidate or None,
                "raw": raw,
            }
    except Exception as e:
        return {
            "success": False,
            "route": resolved_route,
            "credits": 0,
            "error": f"Credits query failed: {type(e).__name__}",
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

    Endpoint:
    http://godspeed.liveair.co.in/httpapi/httpapi

    Required query parameters:
    - token: LiveAir API Token (NEVER logged)
    - sender: Sender ID / Header (e.g. newsen)
    - number: Normalized 10-digit Indian recipient mobile number
    - route: Configured route (e.g. 3 for Sender ID route)
    - type: Message type (1 for Text, 3 for Unicode)
    - sms: URL-encoded message content
    - templateid: Approved DLT template ID
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
        logger.warning(f"[SMS] Provider: LiveAir | Rejected: Invalid recipient phone format: {phone[:4] if phone else 'empty'}")
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

    resolved_template_id = (template_id or config["template_id"]).strip()
    if not resolved_template_id:
        logger.warning("[SMS] Provider: LiveAir | LIVEAIR_TEMPLATE_ID is missing.")
        return {
            "success": False,
            "provider": "liveair",
            "message_id": None,
            "error": "LiveAir DLT template ID not configured (LIVEAIR_TEMPLATE_ID).",
            "code": "MISSING_TEMPLATE_ID",
        }

    resolved_sender = (sender or config["sender"]).strip()
    resolved_route = str(route or config["route"]).strip()
    resolved_type = detect_message_type(message, message_type or config["type"])

    # Query parameters per LiveAir HTTP API specification
    params = {
        "token": token,
        "sender": resolved_sender,
        "number": normalized_phone,
        "route": resolved_route,
        "type": resolved_type,
        "sms": message.strip(),
        "templateid": resolved_template_id,
    }

    masked_phone = mask_phone_for_logging(normalized_phone)
    safe_ref = appt_ref or "none"

    try:
        # Request is dispatched from backend only with strict timeout
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            # Send HTTP GET with query parameters (httpx automatically URL-encodes parameters)
            resp = await client.get(config["sms_url"], params=params)
            
            result = parse_liveair_response(resp.status_code, resp.text)
            
            if result.get("success"):
                logger.info(
                    f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
                    f"Appointment: {safe_ref} | Route: {resolved_route} | Status: SENT | Provider Message ID: {result.get('message_id')}"
                )
            else:
                logger.warning(
                    f"[SMS] Provider: LiveAir | Purpose: {purpose} | Recipient: {masked_phone} | "
                    f"Appointment: {safe_ref} | Route: {resolved_route} | Status: FAILED | Code: {result.get('code')} | Error: {result.get('error')}"
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
    """Check SMS delivery report via LiveAir Delivery Report API:
    Endpoint: http://godspeed.liveair.co.in/httpapi/httpdlr
    Parameters: token, messageid
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
            
            # Check for error responses like "102 : Invalid message id"
            if raw.startswith("102") or "invalid" in raw.lower():
                return {
                    "success": False,
                    "provider": "liveair",
                    "message_id": message_id,
                    "status": "UNKNOWN",
                    "error": raw,
                }

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

            normalized_status = "PENDING"
            if any(k in raw_status for k in ("DELIV", "DELIVERED", "SUCCESS")):
                normalized_status = "DELIVERED"
            elif any(k in raw_status for k in ("FAIL", "REJECT", "UNDELIV", "EXPIRED", "DND")):
                normalized_status = "FAILED"
            elif any(k in raw_status for k in ("SENT", "SUBMIT", "PROCESS", "DISPATCH")):
                normalized_status = "SENT_TO_PROVIDER"
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


async def execute_liveair_test_sms(phone: str) -> Dict[str, Any]:
    """Safe development-only test function (Requirement 11).
    1. Validates config
    2. Checks route credits
    3. Normalizes phone
    4. Constructs approved SMS
    5. Calls LiveAir
    6. Returns classified result and delivery check
    """
    config_check = validate_liveair_startup_config()
    if not config_check["valid"]:
        return {
            "success": False,
            "step": "CONFIG_CHECK",
            "error": f"Missing configuration: {', '.join(config_check['missing'])}",
        }

    credits_check = await get_liveair_credits()
    if not credits_check.get("success"):
        return {
            "success": False,
            "step": "CREDITS_CHECK",
            "error": credits_check.get("error", "Failed checking credits"),
            "code": credits_check.get("code"),
        }

    # Fixed harmless test message
    test_message = "Meribaari SMS integration test successful."
    send_res = await send_liveair_sms(
        phone=phone,
        message=test_message,
        purpose="development_test",
    )

    result = {
        "success": send_res.get("success", False),
        "phone_masked": mask_phone_for_logging(phone),
        "route": config_check["route"],
        "credits": credits_check.get("credits"),
        "send_response": send_res,
        "delivery_report": None,
    }

    if send_res.get("success") and send_res.get("message_id"):
        dlr = await get_liveair_delivery_status(send_res["message_id"])
        result["delivery_report"] = dlr

    return result
