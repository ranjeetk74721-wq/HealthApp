"""
AI-Powered Patient Document OCR Sub-Pipeline using Groq API.

Modular, isolated service for document preprocessing, vision/text extraction via Groq,
data normalization, validation, and structured output formatting.
"""

import os
import io
import re
import uuid
import time
import base64
import logging
from typing import Optional, Dict, Any, Tuple, List
from datetime import datetime, date
from pathlib import Path
from dotenv import load_dotenv

# Ensure backend/.env is loaded
_env_path = Path(__file__).resolve().parent / ".env"
if _env_path.exists():
    load_dotenv(_env_path)

try:
    from PIL import Image, ImageOps
except ImportError:
    Image = None
    ImageOps = None

try:
    from ocr_schema import (
        ExtractedField,
        ExtractedPatientData,
        OCRExtractRequest,
        OCRExtractResponse,
        OCRHealthResponse,
    )
except ImportError:
    from backend.ocr_schema import (
        ExtractedField,
        ExtractedPatientData,
        OCRExtractRequest,
        OCRExtractResponse,
        OCRHealthResponse,
    )

logger = logging.getLogger("receptionist_ocr")

# Supported models
DEFAULT_GROQ_VISION_MODEL = "qwen/qwen3.8-27b"
FALLBACK_GROQ_VISION_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_TEXT_MODEL = "qwen/qwen3.8-27b"

KNOWN_VISION_MODELS = {
    "qwen/qwen3.8-27b",
    "llama-3.2-11b-vision-preview",
    "llama-3.2-90b-vision-preview",
}

MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_IMAGE_DIMENSION = 2048  # Downscale to max 2048px on longest side for optimal Groq latency
SUPPORTED_MIME_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "application/pdf",
]


class GroqConfigurationError(Exception):
    """Raised when GROQ_API_KEY is not configured or invalid."""
    pass


class DocumentValidationError(Exception):
    """Raised when an uploaded document fails validation."""
    pass


class OCRExtractionError(Exception):
    """Raised when OCR processing or parsing fails."""
    pass


def get_groq_api_key() -> str:
    """Retrieve GROQ_API_KEY securely from environment."""
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise GroqConfigurationError(
            "GROQ_API_KEY is not configured in backend environment. "
            "Please configure GROQ_API_KEY in backend/.env to enable patient document scanning."
        )
    return key


def get_configured_model() -> str:
    """Retrieve configured Groq model from environment or fallback to default vision model."""
    m = os.environ.get("GROQ_MODEL", DEFAULT_GROQ_VISION_MODEL).strip()
    # Gracefully upgrade decommissioned Groq preview models
    if m in ("llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"):
        return DEFAULT_GROQ_VISION_MODEL
    return m


def is_vision_model(model_name: str) -> bool:
    """Check if model name supports multimodal image input."""
    name = model_name.lower()
    return "vision" in name or name in KNOWN_VISION_MODELS


def clean_base64_data(raw_data: str, fallback_mime: str = "image/jpeg") -> Tuple[bytes, str]:
    """
    Decodes base64 string or data URL.
    Returns (raw_bytes, detected_mime_type).
    """
    if not raw_data or not isinstance(raw_data, str) or not raw_data.strip():
        raise DocumentValidationError("No document data provided")

    detected_mime = fallback_mime
    cleaned = raw_data.strip()

    # Handle data:mime/type;base64,header
    data_url_match = re.match(r"^data:([^;]+);base64,(.*)$", cleaned, re.DOTALL)
    if data_url_match:
        detected_mime = data_url_match.group(1).lower().strip()
        cleaned = data_url_match.group(2)

    cleaned = cleaned.strip()
    if not cleaned:
        raise DocumentValidationError("Uploaded document is empty (0 bytes)")

    try:
        raw_bytes = base64.b64decode(cleaned, validate=True)
    except Exception as e:
        raise DocumentValidationError(f"Invalid base64 encoding: {str(e)}")

    if len(raw_bytes) == 0:
        raise DocumentValidationError("Uploaded document is empty (0 bytes)")

    if len(raw_bytes) > MAX_FILE_SIZE_BYTES:
        raise DocumentValidationError(
            f"File size exceeds maximum allowed limit of {MAX_FILE_SIZE_BYTES // (1024 * 1024)}MB"
        )

    return raw_bytes, detected_mime


def preprocess_image(image_bytes: bytes) -> Tuple[bytes, int, int]:
    """
    Preprocess image with PIL:
    - Verifies format and integrity
    - Corrects EXIF rotation
    - Converts RGBA/P/CMYK to RGB
    - Downscales if oversized (> 2048px)
    - Re-encodes as optimized JPEG
    Returns (optimized_jpeg_bytes, width, height).
    """
    if Image is None or ImageOps is None:
        raise DocumentValidationError("Pillow (PIL) image processing library is not installed on this server.")

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.verify()
    except Exception as e:
        raise DocumentValidationError(f"Invalid or corrupted image format: {str(e)}")

    # Re-open after verify()
    with Image.open(io.BytesIO(image_bytes)) as img:
        # Correct orientation based on EXIF tag
        try:
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass

        # Convert to RGB if needed
        if img.mode in ("RGBA", "LA", "P", "CMYK"):
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        orig_w, orig_h = img.size
        if orig_w < 50 or orig_h < 50:
            raise DocumentValidationError("Image resolution is too low (< 50x50 pixels) to extract text")

        # Downscale if larger than MAX_IMAGE_DIMENSION
        w, h = orig_w, orig_h
        if max(w, h) > MAX_IMAGE_DIMENSION:
            scale = MAX_IMAGE_DIMENSION / float(max(w, h))
            w = max(1, int(orig_w * scale))
            h = max(1, int(orig_h * scale))
            img = img.resize((w, h), Image.Resampling.LANCZOS)

        out_buf = io.BytesIO()
        img.save(out_buf, format="JPEG", quality=88, optimize=True)
        return out_buf.getvalue(), w, h


def extract_text_from_pdf(pdf_bytes: bytes) -> str:
    """Extract text content from a PDF document using pypdf."""
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        extracted_pages = []
        for idx, page in enumerate(reader.pages):
            text = page.extract_text()
            if text and text.strip():
                extracted_pages.append(f"--- Page {idx + 1} ---\n{text.strip()}")
        full_text = "\n\n".join(extracted_pages).strip()
        if not full_text:
            raise DocumentValidationError(
                "PDF contains no extractable text layer. If this is a scanned PDF image, please export/upload as an image."
            )
        return full_text
    except DocumentValidationError:
        raise
    except Exception as e:
        raise DocumentValidationError(f"Failed to parse PDF document: {str(e)}")


def normalize_mobile(value: Optional[str]) -> Optional[str]:
    """Clean and normalize 10-digit mobile number."""
    if not value:
        return None
    cleaned = re.sub(r"[^0-9]", "", str(value))
    # Remove leading country code +91 or 91 if 12 digits
    if len(cleaned) == 12 and cleaned.startswith("91"):
        cleaned = cleaned[2:]
    # Remove leading 0 if 11 digits
    elif len(cleaned) == 11 and cleaned.startswith("0"):
        cleaned = cleaned[1:]

    if len(cleaned) == 10 and cleaned[0] in "6789":
        return cleaned
    return cleaned if len(cleaned) == 10 else None


def normalize_date(value: Optional[str]) -> Optional[str]:
    """Attempt to parse and normalize date to YYYY-MM-DD."""
    if not value:
        return None
    cleaned = str(value).strip()
    formats = [
        "%Y-%m-%d",
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%d.%m.%Y",
        "%d %b %Y",
        "%d %B %Y",
        "%Y/%m/%d",
        "%m/%d/%Y",
    ]
    for fmt in formats:
        try:
            parsed = datetime.strptime(cleaned, fmt)
            # Basic sanity check (between 1900 and today)
            if 1900 <= parsed.year <= datetime.now().year:
                return parsed.strftime("%Y-%m-%d")
        except ValueError:
            continue
    # If already matches YYYY-MM-DD
    if re.match(r"^\d{4}-\d{2}-\d{2}$", cleaned):
        return cleaned
    return None


def calculate_age_from_dob(dob_str: Optional[str]) -> Optional[int]:
    """Calculate age in years from normalized YYYY-MM-DD date."""
    if not dob_str:
        return None
    try:
        born = datetime.strptime(dob_str, "%Y-%m-%d").date()
        today = date.today()
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        if 0 <= age <= 125:
            return age
    except Exception:
        pass
    return None


def normalize_gender(value: Optional[str]) -> Optional[str]:
    """Normalize gender to 'Male', 'Female', or 'Other'."""
    if not value:
        return None
    v = str(value).strip().lower()
    if v in ("m", "male", "man", "boy", "purush"):
        return "Male"
    if v in ("f", "female", "woman", "girl", "mahila", "stri"):
        return "Female"
    if v in ("o", "other", "others", "transgender"):
        return "Other"
    return None


def normalize_pincode(value: Optional[str]) -> Optional[str]:
    """Normalize 6-digit Indian PIN code."""
    if not value:
        return None
    match = re.search(r"\b[1-9][0-9]{5}\b", str(value))
    if match:
        return match.group(0)
    return None


def build_system_prompt() -> str:
    return """You are a highly precise clinical OCR and document understanding engine for an outpatient healthcare clinic.
Your task is to analyze patient documents (Aadhaar cards, PAN cards, Voter ID, Driving License, Patient ID cards, Doctor Prescriptions, Medical Bills, Discharge Summaries, Lab Reports, etc.) and extract structured patient demographic details.

CRITICAL RULES:
1. NEVER fabricate, hallucinate, or guess missing information.
2. If a field is not clearly visible, absent, or unreadable, its "value" MUST be null.
3. For each field, provide a "confidence" score between 0.0 and 1.0 based on text clarity and legibility.
4. If a field is partially visible or ambiguous, set "uncertain": true.
5. Extract address parts if present (street address, city, state, postal_code).
6. Distinguish the PATIENT from doctors, technicians, or family members.
7. Return ONLY a single valid JSON object with the exact keys specified below:

{
  "full_name": {"value": string or null, "confidence": float, "uncertain": bool},
  "date_of_birth": {"value": string "YYYY-MM-DD" or null, "confidence": float, "uncertain": bool},
  "age": {"value": integer or null, "confidence": float, "uncertain": bool},
  "gender": {"value": "Male"|"Female"|"Other" or null, "confidence": float, "uncertain": bool},
  "mobile_number": {"value": "10-digit string" or null, "confidence": float, "uncertain": bool},
  "email_address": {"value": string or null, "confidence": float, "uncertain": bool},
  "address": {"value": string or null, "confidence": float, "uncertain": bool},
  "city": {"value": string or null, "confidence": float, "uncertain": bool},
  "state": {"value": string or null, "confidence": float, "uncertain": bool},
  "postal_code": {"value": "6-digit string" or null, "confidence": float, "uncertain": bool},
  "document_type": {"value": "Aadhaar"|"PAN"|"Voter ID"|"Driving License"|"Passport"|"Prescription"|"Hospital Card"|"Insurance"|"Other" or null, "confidence": float, "uncertain": bool},
  "document_id_number": {"value": string or null, "confidence": float, "uncertain": bool},
  "raw_text_summary": string,
  "warnings": [string]
}
"""


async def call_groq_vision(image_bytes: bytes, model: str, api_key: str) -> Dict[str, Any]:
    """
    Call Groq Vision API with preprocessed JPEG image.
    Uses AsyncGroq or OpenAI-compatible async client.
    """
    from groq import AsyncGroq
    client = AsyncGroq(api_key=api_key)

    b64_img = base64.b64encode(image_bytes).decode("utf-8")
    data_url = f"data:image/jpeg;base64,{b64_img}"

    system_prompt = build_system_prompt()
    user_content = [
        {
            "type": "text",
            "text": "Extract all patient demographic and identification details from this document image according to the required JSON schema."
        },
        {
            "type": "image_url",
            "image_url": {
                "url": data_url
            }
        }
    ]

    completion = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        response_format={"type": "json_object"},
        temperature=0.1,
        max_tokens=1500,
        timeout=30.0,
    )

    content = completion.choices[0].message.content
    import json
    return json.loads(content)


async def call_groq_text(document_text: str, model: str, api_key: str) -> Dict[str, Any]:
    """
    Call Groq text model for PDF text or text-only model fallback.
    """
    from groq import AsyncGroq
    client = AsyncGroq(api_key=api_key)

    system_prompt = build_system_prompt()
    user_prompt = f"Extract all patient demographic details from the following document text into the required JSON schema:\n\n{document_text[:8000]}"

    completion = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
        temperature=0.1,
        max_tokens=1500,
        timeout=30.0,
    )

    content = completion.choices[0].message.content
    import json
    return json.loads(content)


def normalize_raw_output(raw_dict: Dict[str, Any], raw_text: Optional[str] = None) -> Tuple[ExtractedPatientData, List[str]]:
    """
    Normalizes parsed LLM output into ExtractedPatientData.
    Applies deterministic phone, date, gender, age, and address sanitization.
    """
    warnings: List[str] = []
    if "warnings" in raw_dict and isinstance(raw_dict["warnings"], list):
        warnings.extend(str(w) for w in raw_dict["warnings"] if w)

    def parse_field(name: str) -> ExtractedField:
        item = raw_dict.get(name)
        if isinstance(item, dict):
            val = item.get("value")
            conf = float(item.get("confidence", 0.0) or 0.0)
            conf = max(0.0, min(1.0, conf))
            unc = bool(item.get("uncertain", False))
            s_val = str(val).strip() if val is not None else None
            return ExtractedField(value=s_val if s_val else None, confidence=conf, uncertain=unc)
        elif item is not None and not isinstance(item, (dict, list)):
            s_val = str(item).strip()
            return ExtractedField(value=s_val if s_val else None, confidence=0.75, uncertain=False)
        return ExtractedField(value=None, confidence=0.0, uncertain=False)

    data = ExtractedPatientData(
        full_name=parse_field("full_name"),
        date_of_birth=parse_field("date_of_birth"),
        age=parse_field("age"),
        gender=parse_field("gender"),
        mobile_number=parse_field("mobile_number"),
        email_address=parse_field("email_address"),
        address=parse_field("address"),
        city=parse_field("city"),
        state=parse_field("state"),
        postal_code=parse_field("postal_code"),
        document_type=parse_field("document_type"),
        document_id_number=parse_field("document_id_number"),
        raw_text=raw_text or raw_dict.get("raw_text_summary"),
    )

    # 1. Normalize Mobile
    if data.mobile_number.value:
        norm_mob = normalize_mobile(data.mobile_number.value)
        if norm_mob:
            data.mobile_number.value = norm_mob
        else:
            warnings.append(f"Mobile number '{data.mobile_number.value}' is not a valid 10-digit number.")
            data.mobile_number.uncertain = True

    # 2. Normalize DOB and Age
    if data.date_of_birth.value:
        norm_dob = normalize_date(data.date_of_birth.value)
        if norm_dob:
            data.date_of_birth.value = norm_dob
            calc_age = calculate_age_from_dob(norm_dob)
            if calc_age is not None and not data.age.value:
                data.age.value = str(calc_age)
                data.age.confidence = data.date_of_birth.confidence
        else:
            data.date_of_birth.uncertain = True

    if data.age.value:
        try:
            age_int = int(re.sub(r"[^0-9]", "", data.age.value))
            if 0 <= age_int <= 125:
                data.age.value = str(age_int)
            else:
                data.age.value = None
                warnings.append("Extracted age is outside clinical range (0-125).")
        except Exception:
            data.age.value = None

    # 3. Normalize Gender
    if data.gender.value:
        norm_gen = normalize_gender(data.gender.value)
        if norm_gen:
            data.gender.value = norm_gen
        else:
            warnings.append(f"Unrecognized gender '{data.gender.value}'.")
            data.gender.uncertain = True

    # 4. Normalize Pincode
    if data.postal_code.value:
        norm_pin = normalize_pincode(data.postal_code.value)
        if norm_pin:
            data.postal_code.value = norm_pin
        else:
            data.postal_code.uncertain = True

    # 5. Flag low-confidence fields
    for field_name in [
        "full_name",
        "date_of_birth",
        "mobile_number",
        "gender",
        "address",
    ]:
        field: ExtractedField = getattr(data, field_name)
        if field.value and field.confidence < 0.65:
            field.uncertain = True
            warnings.append(f"Low confidence ({int(field.confidence * 100)}%) on {field_name.replace('_', ' ')}.")

    return data, warnings


async def process_document_ocr(
    req: OCRExtractRequest,
    api_key_override: Optional[str] = None,
) -> OCRExtractResponse:
    """
    Main entry point for OCR extraction pipeline:
    1. Decodes and validates file payload
    2. Image preprocessing / PDF text extraction
    3. Calls Groq Vision (or Groq Text model)
    4. Normalizes and validates extracted patient data
    5. Returns structured OCRExtractResponse
    """
    start_time = time.time()
    req_id = f"ocr_{uuid.uuid4().hex[:12]}"
    warnings: List[str] = []

    # Verify API key
    api_key = api_key_override or get_groq_api_key()
    configured_model = get_configured_model()

    # Decode and validate file bytes
    raw_bytes, detected_mime = clean_base64_data(req.file_data, req.mime_type or "image/jpeg")

    is_pdf = detected_mime == "application/pdf" or (req.file_name and req.file_name.lower().endswith(".pdf"))
    raw_text_summary = None

    try:
        if is_pdf:
            # Extract PDF text
            pdf_text = extract_text_from_pdf(raw_bytes)
            raw_text_summary = pdf_text[:1000]
            # Use Groq text model (or configured model if it can handle text)
            model_to_use = configured_model if not is_vision_model(configured_model) else DEFAULT_GROQ_TEXT_MODEL
            raw_result = await call_groq_text(pdf_text, model_to_use, api_key)
        else:
            # Preprocess image
            opt_jpeg, w, h = preprocess_image(raw_bytes)

            # Choose model based on vision capability
            if is_vision_model(configured_model):
                model_to_use = configured_model
                raw_result = await call_groq_vision(opt_jpeg, model_to_use, api_key)
            else:
                # If configured model is text-only, log warning and use fallback vision model or reject
                warnings.append(
                    f"Configured model '{configured_model}' is text-only. Routing image to vision model '{DEFAULT_GROQ_VISION_MODEL}'."
                )
                model_to_use = DEFAULT_GROQ_VISION_MODEL
                raw_result = await call_groq_vision(opt_jpeg, model_to_use, api_key)

        # Normalize and sanitize
        extracted_data, norm_warnings = normalize_raw_output(raw_result, raw_text_summary)
        warnings.extend(norm_warnings)

        duration_ms = round((time.time() - start_time) * 1000, 2)

        return OCRExtractResponse(
            success=True,
            request_id=req_id,
            extracted_data=extracted_data,
            warnings=warnings,
            requires_review=True,
            model_used=model_to_use,
            processing_time_ms=duration_ms,
            error=None,
        )

    except (DocumentValidationError, GroqConfigurationError) as e:
        logger.warning(f"OCR validation error [{req_id}]: {str(e)}")
        raise
    except Exception as e:
        logger.error(f"OCR processing failed [{req_id}]: {str(e)}", exc_info=True)
        duration_ms = round((time.time() - start_time) * 1000, 2)
        return OCRExtractResponse(
            success=False,
            request_id=req_id,
            extracted_data=ExtractedPatientData(),
            warnings=[f"OCR extraction encountered an error: {str(e)}"],
            requires_review=True,
            model_used=configured_model,
            processing_time_ms=duration_ms,
            error=str(e),
        )


def get_ocr_health() -> OCRHealthResponse:
    """Return health status and capability configuration of OCR pipeline."""
    key = os.environ.get("GROQ_API_KEY", "").strip()
    model = get_configured_model()
    return OCRHealthResponse(
        status="operational" if key else "unconfigured",
        groq_api_key_configured=bool(key),
        configured_model=model,
        model_vision_supported=is_vision_model(model),
        supported_mime_types=SUPPORTED_MIME_TYPES,
        max_file_size_bytes=MAX_FILE_SIZE_BYTES,
    )
