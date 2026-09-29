"""
AiSensy WhatsApp Messaging Adapter for Meribaari / EASE Application.

Supports:
1. AiSensy Project API (POST https://backend.aisensy.com/campaign/t1/api/v2 or https://api.aisensy.io/v1/messages)
2. WhatsApp Authentication / OTP messages with dynamic parameters and optional interactive buttons
3. WhatsApp Appointment Booking Confirmation (Utility) messages with live queue tracking links

Security Guarantees:
- API keys, OTPs, and sensitive user data are NEVER logged in plaintext.
- Recipient phone numbers are masked in audit logs.
- Dispatches HTTP requests strictly from backend with strict timeouts.
"""

import os
import re
import logging
import httpx
from typing import Optional, Dict, Any, List

logger = logging.getLogger("aisensy_service")

# Default AiSensy endpoint
DEFAULT_AISENSY_BASE_URL = "https://backend.aisensy.com/campaign/t1/api/v2"
REQUEST_TIMEOUT_SECONDS = 8.0


def get_aisensy_api_key() -> str:
    """
    Retrieve AiSensy Project API key from backend environment variables.
    Checks Project_api_key / PROJECT_API_KEY, AISENSY_API_KEY, and AISENSY_PROJECT_API_KEY.
    """
    key = (
        os.environ.get("Project_api_key")
        or os.environ.get("PROJECT_API_KEY")
        or os.environ.get("AISENSY_API_KEY")
        or os.environ.get("AISENSY_PROJECT_API_KEY")
        or os.environ.get("AISENSY_KEY")
    )
    if key and key.strip() not in ("placeholder", "your_aisensy_api_key", "your_aisensy_project_api_key"):
        return key.strip()
    return ""


def get_aisensy_otp_campaign_name() -> str:
    """
    Retrieve live API campaign / template name for OTP / Authentication messages.
    Fallback priority:
    1. AISENSY_OTP_CAMPAIGN_NAME
    2. Key_name / KEY_NAME
    3. AISENSY_CAMPAIGN_NAME
    4. Default "meribaari"
    """
    name = (
        os.environ.get("AISENSY_OTP_CAMPAIGN_NAME")
        or os.environ.get("Key_name")
        or os.environ.get("KEY_NAME")
        or os.environ.get("AISENSY_CAMPAIGN_NAME")
        or "meribaari"
    )
    return name.strip()


def get_aisensy_appt_campaign_name() -> str:
    """
    Retrieve live API campaign / template name for Appointment Confirmation / Utility messages.
    Fallback priority:
    1. AISENSY_APPT_CAMPAIGN_NAME
    2. AISENSY_UTILITY_CAMPAIGN_NAME
    3. Key_name / KEY_NAME
    4. AISENSY_CAMPAIGN_NAME
    5. Default "meribaari_appointment"
    """
    name = (
        os.environ.get("AISENSY_APPT_CAMPAIGN_NAME")
        or os.environ.get("AISENSY_UTILITY_CAMPAIGN_NAME")
        or os.environ.get("Key_name")
        or os.environ.get("KEY_NAME")
        or os.environ.get("AISENSY_CAMPAIGN_NAME")
        or "meribaari_appointment"
    )
    return name.strip()


def get_aisensy_endpoint() -> str:
    """Retrieve AiSensy API endpoint URL."""
    return (
        os.environ.get("AISENSY_PROJECT_API_URL")
        or os.environ.get("AISENSY_BASE_URL")
        or DEFAULT_AISENSY_BASE_URL
    ).strip()


def mask_phone_for_logging(phone: str) -> str:
    """Safely mask phone number for audit logging (e.g. +9198765*****)."""
    if not phone:
        return "unknown"
    clean = str(phone).strip()
    if len(clean) >= 7:
        return f"{clean[:6]}*****"
    return "*****"


def normalize_aisensy_destination(phone: str) -> Optional[str]:
    """
    Normalize phone number to international E.164 format (+91XXXXXXXXXX for India).
    """
    if not phone:
        return None
    raw = str(phone).strip()
    cleaned = re.sub(r"[^\d+]", "", raw)
    if not cleaned:
        return None

    if cleaned.startswith("+"):
        digits = cleaned[1:]
        if digits.startswith("91") and len(digits) == 12:
            sub = digits[2:]
            if sub[0] in "56789":
                return f"+91{sub}"
        if 7 <= len(digits) <= 15:
            return f"+{digits}"
        return None

    digits = cleaned
    if digits.startswith("91") and len(digits) == 12:
        sub = digits[2:]
        if sub[0] in "56789":
            return f"+91{sub}"
        return f"+{digits}"
    elif digits.startswith("0") and len(digits) == 11:
        sub = digits[1:]
        if sub[0] in "56789":
            return f"+91{sub}"
        return f"+91{sub}"
    elif len(digits) == 10:
        if digits[0] in "56789":
            return f"+91{digits}"
        return f"+91{digits}"

    return None


async def send_aisensy_project_message(
    destination: str,
    campaign_name: str,
    user_name: str,
    template_params: Optional[List[str]] = None,
    button_params: Optional[List[str]] = None,
    media: Optional[Dict[str, str]] = None,
    source: str = "MeriBaari App",
    tags: Optional[List[str]] = None,
    attributes: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Dispatch an HTTP POST request to AiSensy Project API.
    Uses proper JSON serialization via httpx without string concatenation.
    """
    api_key = get_aisensy_api_key()
    if not api_key:
        logger.warning("[AiSensy] Dispatch blocked: Project_api_key / AISENSY_API_KEY is not configured")
        return {
            "ok": False,
            "provider": "aisensy",
            "error": "AiSensy Project API key is not configured.",
            "error_code": "MISSING_API_KEY",
        }

    norm_destination = normalize_aisensy_destination(destination)
    if not norm_destination:
        logger.warning("[AiSensy] Dispatch rejected: Invalid destination phone format")
        return {
            "ok": False,
            "provider": "aisensy",
            "error": "Invalid destination phone number format. Must include valid country code & subscriber digits.",
            "error_code": "INVALID_PHONE",
        }

    clean_campaign = (campaign_name or "").strip()
    if not clean_campaign:
        return {
            "ok": False,
            "provider": "aisensy",
            "error": "Campaign / Template identifier cannot be empty.",
            "error_code": "INVALID_CAMPAIGN",
        }

    clean_user_name = (user_name or "Patient").strip()
    params = [str(p) for p in (template_params or [])]

    payload: Dict[str, Any] = {
        "apiKey": api_key,
        "campaignName": clean_campaign,
        "destination": norm_destination,
        "userName": clean_user_name,
        "source": source,
    }

    if params:
        payload["templateParams"] = params
    if button_params:
        payload["buttons"] = [
            {
                "type": "button",
                "sub_type": "url",
                "index": "0",
                "parameters": [{"type": "text", "text": str(bp)} for bp in button_params]
            }
        ]
    if media and isinstance(media, dict) and media.get("url"):
        payload["media"] = media
    if tags and isinstance(tags, list):
        payload["tags"] = tags
    if attributes and isinstance(attributes, dict):
        payload["attributes"] = attributes

    endpoint = get_aisensy_endpoint()
    masked_phone = mask_phone_for_logging(norm_destination)

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "x-api-key": api_key,
    }

    try:
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
            resp = await client.post(
                endpoint,
                json=payload,
                headers=headers,
            )

        resp_text = resp.text
        logger.info(
            f"[AiSensy] HTTP {resp.status_code} response for {masked_phone} "
            f"(template/campaign: '{clean_campaign}')"
        )

        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp_text}

        if resp.status_code in (200, 201, 202):
            is_success = True
            if isinstance(data, dict):
                if data.get("success") is False or data.get("status") in ("failed", "error"):
                    is_success = False

            return {
                "ok": is_success,
                "provider": "aisensy",
                "phone": norm_destination,
                "campaign_name": clean_campaign,
                "status_code": resp.status_code,
                "message_id": data.get("messageId") or data.get("message_id") or data.get("id"),
                "response": data,
                "error": None if is_success else (data.get("message") or data.get("error") or "Provider returned error"),
                "error_code": None if is_success else (data.get("code") or data.get("errorCode") or "API_ERROR"),
            }
        else:
            err_msg = ""
            err_code = "HTTP_ERROR"
            if isinstance(data, dict):
                err_msg = data.get("message") or data.get("error") or data.get("details") or ""
                err_code = data.get("code") or data.get("errorCode") or f"HTTP_{resp.status_code}"

            if not err_msg:
                err_msg = f"AiSensy Project API returned status {resp.status_code}: {resp_text[:120]}"

            logger.warning(
                f"[AiSensy] Request failed for {masked_phone}: HTTP {resp.status_code} - {err_msg}"
            )
            return {
                "ok": False,
                "provider": "aisensy",
                "phone": norm_destination,
                "campaign_name": clean_campaign,
                "status_code": resp.status_code,
                "error": err_msg,
                "error_code": err_code,
                "response": data,
            }

    except httpx.TimeoutException:
        logger.error(f"[AiSensy] Request timed out after {REQUEST_TIMEOUT_SECONDS}s for {masked_phone}")
        return {
            "ok": False,
            "provider": "aisensy",
            "phone": norm_destination,
            "campaign_name": clean_campaign,
            "error": "AiSensy gateway request timed out.",
            "error_code": "TIMEOUT",
        }
    except Exception as e:
        logger.error(f"[AiSensy] Connection error for {masked_phone}: {type(e).__name__} - {str(e)}")
        return {
            "ok": False,
            "provider": "aisensy",
            "phone": norm_destination,
            "campaign_name": clean_campaign,
            "error": f"Failed to connect to AiSensy gateway: {type(e).__name__}",
            "error_code": "CONNECTION_ERROR",
        }


# Alias for backward compatibility
send_aisensy_campaign = send_aisensy_project_message


async def send_aisensy_otp(
    phone: str,
    otp: str,
    user_name: str = "Patient",
) -> Dict[str, Any]:
    """
    Send OTP verification challenge via AiSensy Project API.
    Populates template parameters and button code parameter without logging plaintext OTP.
    """
    clean_otp = str(otp).strip()
    if not clean_otp:
        return {
            "ok": False,
            "provider": "aisensy",
            "error": "OTP cannot be empty.",
            "error_code": "INVALID_OTP",
        }

    campaign_name = get_aisensy_otp_campaign_name()
    template_params = [clean_otp]
    button_params = [clean_otp]

    res = await send_aisensy_project_message(
        destination=phone,
        campaign_name=campaign_name,
        user_name=user_name,
        template_params=template_params,
        button_params=button_params,
        source="MeriBaari Auth",
    )

    masked_phone = mask_phone_for_logging(phone)
    logger.info(
        f"[AiSensy OTP]\n"
        f"Phone: {masked_phone}\n"
        f"Identifier: {campaign_name}\n"
        f"Send Status: {'ACCEPTED' if res.get('ok') else 'FAILED'}\n"
        f"Message ID: {res.get('message_id') or 'NONE'}"
    )

    return res


async def send_aisensy_appointment(
    phone: str,
    hospital_name: str,
    doctor_name: str,
    token_number: Any,
    expected_time: str,
    live_queue_link: str,
    patient_name: str = "Patient",
) -> Dict[str, Any]:
    """
    Send appointment booking confirmation Utility message via AiSensy Project API.
    
    Template parameters:
    1. Hospital / Clinic Name
    2. Doctor Name
    3. Token Number
    4. Expected / Estimated Turn Time
    5. Live Queue Tracking Link
    """
    campaign_name = get_aisensy_appt_campaign_name()
    clean_hosp = (hospital_name or "MeriBaari Clinic").strip()
    clean_doc = (doctor_name or "Doctor").strip()
    clean_token = str(token_number or "1").strip()
    clean_time = str(expected_time or "As per live queue").strip()
    clean_link = str(live_queue_link or "").strip()

    template_params = [
        clean_hosp,
        clean_doc,
        clean_token,
        clean_time,
        clean_link,
    ]

    res = await send_aisensy_project_message(
        destination=phone,
        campaign_name=campaign_name,
        user_name=patient_name or "Patient",
        template_params=template_params,
        source="MeriBaari Booking",
    )

    masked_phone = mask_phone_for_logging(phone)
    logger.info(
        f"[AiSensy APPT]\n"
        f"Phone: {masked_phone}\n"
        f"Identifier: {campaign_name}\n"
        f"Token: {clean_token}\n"
        f"Send Status: {'ACCEPTED' if res.get('ok') else 'FAILED'}\n"
        f"Message ID: {res.get('message_id') or 'NONE'}"
    )

    return res
