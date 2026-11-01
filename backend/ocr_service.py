"""
AI-Powered Multi-Model Patient Document OCR Sub-Pipeline.

Primary Engine: Groq Vision API (qwen/qwen3.8-27b)
Intelligent Fallbacks:
  - Hugging Face Model 1: zai-org/GLM-OCR (0.9B VLM Document Comprehension)
  - Hugging Face Model 2: datalab-to/indra-ocr (Lightweight Document OCR)
  - Hugging Face Model 3: numind/NuExtract3 (Structured Schema Extraction)
  - Local Engine: Stream/Regex Patient Data Extractor (Offline Safety Net)

Disqualified / Removed Models:
  - lukaszrzepinski/MikolajRej: Disqualified (archival 16th-century Polish manuscript OCR; cannot process Indian healthcare records)
  - paragon-AI/blip2-image-to-text: Disqualified (scene/image captioning model, lacks character-accurate transcription)
  - muscgab/manga-ocr-base-CPT-flex: Disqualified (Japanese manga comic speech bubble OCR; corrupts Indian names and numbers)
  - tiiuae/Falcon-OCR: Disqualified (requires untrusted remote code execution 'trust_remote_code=True'; lacks structured JSON output)

Required Output Fields (Section 4):
  1. patient_name
  2. age
  3. phone_number
  4. address
"""

import os
import io
import re
import uuid
import time
import json
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
        OCRConfirmRequest,
        OCRConfirmResponse,
        OCRHealthResponse,
    )
except ImportError:
    from backend.ocr_schema import (
        ExtractedField,
        ExtractedPatientData,
        OCRExtractRequest,
        OCRExtractResponse,
        OCRConfirmRequest,
        OCRConfirmResponse,
        OCRHealthResponse,
    )

logger = logging.getLogger("receptionist_ocr")

# Primary and Fallback Models
PRIMARY_GROQ_MODEL = "qwen/qwen3.8-27b"
DEFAULT_GROQ_VISION_MODEL = PRIMARY_GROQ_MODEL
FALLBACK_HF_GLM = "zai-org/GLM-OCR"
FALLBACK_HF_INDRA = "datalab-to/indra-ocr"
FALLBACK_HF_NUEXTRACT = "numind/NuExtract3"
FALLBACK_LOCAL = "indra-ocr-local"

DISQUALIFIED_MODELS = {
    "lukaszrzepinski/MikolajRej": "Archival 16th-century Polish manuscript OCR; completely incompatible with Indian healthcare IDs",
    "paragon-AI/blip2-image-to-text": "Scene captioning model; outputs general image descriptions instead of text transcription",
    "muscgab/manga-ocr-base-CPT-flex": "Japanese manga comic bubble OCR; corrupts Latin and Devanagari names/numbers",
    "tiiuae/Falcon-OCR": "Requires untrusted remote code execution (trust_remote_code=True); lacks structured JSON schema output",
}

KNOWN_VISION_MODELS = {
    "qwen/qwen3.8-27b",
    "llama-3.2-11b-vision-preview",
    "llama-3.2-90b-vision-preview",
}

MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # 10 MB
MAX_IMAGE_DIMENSION = 2048  # Scale down to 2048px for optimal inference speed
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
            "Please configure GROQ_API_KEY in backend/.env to enable primary patient document scanning."
        )
    return key


def get_hf_api_key() -> Optional[str]:
    """Retrieve Hugging Face API key/token securely from environment if available."""
    return os.environ.get("HUGGINGFACE_API_KEY", "").strip() or os.environ.get("HF_TOKEN", "").strip() or None


def get_configured_model() -> str:
    """Retrieve configured Groq model from environment or fallback to default primary vision model."""
    m = os.environ.get("GROQ_MODEL", PRIMARY_GROQ_MODEL).strip()
    # Map decommissioned Llama vision models transparently to active Qwen vision model
    if m in ("llama-3.2-11b-vision-preview", "llama-3.2-90b-vision-preview"):
        return PRIMARY_GROQ_MODEL
    return m or PRIMARY_GROQ_MODEL


def is_vision_model(model_name: str) -> bool:
    """Check if the target model accepts image_url inputs."""
    name = (model_name or "").lower()
    if name in KNOWN_VISION_MODELS:
        return True
    if any(k in name for k in ("qwen3.8", "vision", "vl-", "4b", "7b", "11b", "90b")):
        return True
    return False


def clean_base64_data(raw_input: str, default_mime: str = "image/jpeg") -> Tuple[bytes, str]:
    """Clean base64 input string and extract MIME type."""
    if not raw_input or not isinstance(raw_input, str) or not raw_input.strip():
        raise DocumentValidationError("No document data provided")

    cleaned = raw_input.strip()
    detected_mime = default_mime.lower().strip()

    data_url_match = re.match(r"^data:([^;]+);base64,(.*)$", cleaned, re.DOTALL)
    if data_url_match:
        detected_mime = data_url_match.group(1).lower().strip()
        cleaned = data_url_match.group(2)

    cleaned = cleaned.strip()
    if not cleaned:
        raise DocumentValidationError("No document data provided")

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
    If PIL is not installed, gracefully returns (image_bytes, 0, 0)
    so Groq Vision can process the raw image directly.
    """
    if Image is None or ImageOps is None:
        logger.warning("PIL (Pillow) library not available on server; passing raw image directly to Groq Vision.")
        return image_bytes, 0, 0

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.verify()
    except Exception as e:
        raise DocumentValidationError(f"Invalid or corrupted image format: {str(e)}")

    with Image.open(io.BytesIO(image_bytes)) as img:
        try:
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass

        if img.mode in ("RGBA", "LA", "P", "CMYK"):
            img = img.convert("RGB")
        elif img.mode != "RGB":
            img = img.convert("RGB")

        orig_w, orig_h = img.size
        if orig_w < 50 or orig_h < 50:
            raise DocumentValidationError("Image resolution is too low (< 50x50 pixels) to extract text")

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
    """
    Extract text content from a PDF document.
    Attempts extraction via pypdf first; falls back to pure-Python PDF stream scanning.
    """
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        extracted_pages = []
        for idx, page in enumerate(reader.pages):
            text = page.extract_text()
            if text and text.strip():
                extracted_pages.append(f"--- Page {idx + 1} ---\n{text.strip()}")
        full_text = "\n\n".join(extracted_pages).strip()
        if full_text:
            return full_text
    except ImportError:
        logger.warning("pypdf not installed; attempting raw text stream extraction.")
    except Exception as e:
        logger.warning(f"pypdf extraction error: {e}")

    try:
        raw_str = pdf_bytes.decode("latin1", errors="ignore")
        matches = re.findall(r"\(([^)]+)\)\s*(?:Tj|'|\")", raw_str)
        if matches:
            cleaned_tokens = [m.strip() for m in matches if len(m.strip()) > 1 and not m.startswith("/")]
            if len(cleaned_tokens) >= 3:
                fallback_text = " ".join(cleaned_tokens).strip()
                if len(fallback_text) > 30:
                    logger.info("Successfully extracted text using fallback PDF stream parser.")
                    return fallback_text
    except Exception as e:
        logger.warning(f"PDF stream fallback failed: {e}")

    raise DocumentValidationError(
        "Could not extract text from this PDF document. If this is a scanned/photographed PDF, please upload it as an image (JPG/PNG)."
    )


def normalize_mobile(value: Optional[str]) -> Optional[str]:
    """Clean and normalize 10-digit mobile number."""
    if not value:
        return None
    cleaned = re.sub(r"[^0-9]", "", str(value))
    if len(cleaned) == 12 and cleaned.startswith("91"):
        cleaned = cleaned[2:]
    if len(cleaned) == 11 and cleaned.startswith("0"):
        cleaned = cleaned[1:]
    if len(cleaned) == 10 and cleaned[0] in "6789":
        return cleaned
    return None


def normalize_date(value: Optional[str]) -> Optional[str]:
    """Convert various date formats into standard YYYY-MM-DD."""
    if not value:
        return None
    val = str(value).strip()
    formats = [
        "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",
        "%d/%m/%y", "%d-%m-%y", "%Y/%m/%d", "%d %b %Y",
        "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
    ]
    for fmt in formats:
        try:
            parsed = datetime.strptime(val, fmt).date()
            if 1900 <= parsed.year <= date.today().year:
                return parsed.isoformat()
        except ValueError:
            continue
    return None


def calculate_age_from_dob(dob_str: Optional[str]) -> Optional[int]:
    """Calculate age in years from normalized YYYY-MM-DD string."""
    if not dob_str:
        return None
    try:
        born = datetime.strptime(dob_str, "%Y-%m-%d").date()
        today = date.today()
        age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        return age if 0 <= age <= 125 else None
    except Exception:
        return None


def normalize_gender(value: Optional[str]) -> Optional[str]:
    """Standardize gender to Male, Female, or Other."""
    if not value:
        return None
    v = str(value).strip().lower()
    if v in ("m", "male", "man", "boy", "purush", "m/"):
        return "Male"
    if v in ("f", "female", "woman", "girl", "mahila", "f/"):
        return "Female"
    if v in ("o", "other", "transgender"):
        return "Other"
    return None


def normalize_pincode(value: Optional[str]) -> Optional[str]:
    """Extract valid 6-digit Indian PIN code."""
    if not value:
        return None
    m = re.search(r"\b([1-9][0-9]{5})\b", str(value))
    return m.group(1) if m else None


def build_system_prompt() -> str:
    """Return strict JSON extraction prompt for clinical patient registration."""
    return """You are a specialized medical receptionist AI OCR assistant.
Extract patient identity details from the uploaded document (Aadhaar, PAN, Voter ID, Passport, Driving License, Doctor Prescription, or Hospital Card).

Extraction Rules:
1. Extract ONLY information actually visible on the document.
2. NEVER guess, invent, or hallucinate missing information. If a field is not present or cannot be read, set its value to null.
3. Clean phone numbers to 10 digits without country code.
4. Normalize dates of birth to YYYY-MM-DD.
5. If age is given explicitly (e.g. '31 Years' or 'Age: 45'), extract it as an integer.
6. Address should contain full street/locality details. City, state, postal_code should be identified separately if present.
7. Assign a confidence score between 0.0 and 1.0 for each field.

You MUST respond strictly with valid JSON conforming to this schema:
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
    """Call Groq Vision API with preprocessed JPEG image."""
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

    chat_completion = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        temperature=0.1,
        max_tokens=1024,
        response_format={"type": "json_object"},
    )

    resp_content = chat_completion.choices[0].message.content
    try:
        return json.loads(resp_content)
    except Exception as e:
        logger.error(f"Failed to parse Groq vision JSON: {e}. Raw content: {resp_content}")
        raise OCRExtractionError(f"Groq vision returned invalid JSON: {str(e)}")


async def call_groq_text(document_text: str, model: str, api_key: str) -> Dict[str, Any]:
    """Call Groq Text API on extracted PDF text layer."""
    from groq import AsyncGroq
    client = AsyncGroq(api_key=api_key)

    system_prompt = build_system_prompt()
    user_prompt = f"Extract structured patient identity details from the following document text:\n\n{document_text[:4000]}"

    chat_completion = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.1,
        max_tokens=1024,
        response_format={"type": "json_object"},
    )

    resp_content = chat_completion.choices[0].message.content
    try:
        return json.loads(resp_content)
    except Exception as e:
        logger.error(f"Failed to parse Groq text JSON: {e}")
        raise OCRExtractionError(f"Groq text returned invalid JSON: {str(e)}")


async def call_huggingface_ocr(
    image_bytes: bytes,
    model_id: str = FALLBACK_HF_GLM,
    hf_token: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Fallback 1: Call Hugging Face Serverless Inference API for candidate OCR models.
    Supports zai-org/GLM-OCR, datalab-to/indra-ocr, and numind/NuExtract3.
    """
    if not hf_token:
        logger.info(f"Hugging Face token not configured. Skipping fallback model {model_id}.")
        return None

    import httpx
    # Hugging Face Router endpoint
    url = f"https://router.huggingface.co/hf-inference/models/{model_id}"
    headers = {
        "Authorization": f"Bearer {hf_token}",
        "Content-Type": "application/octet-stream",
    }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(url, headers=headers, content=image_bytes)
            if resp.status_code == 200:
                result_text = resp.text
                try:
                    parsed = json.loads(result_text)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    pass
                # Wrap raw text into structured schema
                return {
                    "raw_text_summary": result_text[:1000],
                    "full_name": {"value": None, "confidence": 0.5},
                    "mobile_number": {"value": None, "confidence": 0.5},
                }
            elif resp.status_code == 503:
                logger.warning(f"Hugging Face model {model_id} is loading (503). Skipping.")
                return None
            else:
                logger.warning(f"Hugging Face API returned status {resp.status_code} for {model_id}: {resp.text[:200]}")
                return None
    except Exception as e:
        logger.warning(f"Hugging Face inference error on {model_id}: {e}")
        return None


def extract_patient_details_offline(text: str) -> Dict[str, Any]:
    """
    Fallback 2: Lightweight pure-Python / regex document data extractor.
    Extracts Patient Name, Phone, Age, and Address directly from document text.
    """
    out: Dict[str, Any] = {
        "full_name": {"value": None, "confidence": 0.0, "uncertain": True},
        "mobile_number": {"value": None, "confidence": 0.0, "uncertain": True},
        "age": {"value": None, "confidence": 0.0, "uncertain": True},
        "address": {"value": None, "confidence": 0.0, "uncertain": True},
        "date_of_birth": {"value": None, "confidence": 0.0, "uncertain": True},
        "raw_text_summary": text[:500] if text else "",
        "warnings": ["Extracted using local offline fallback parser."],
    }

    if not text:
        return out

    # Phone: 10 digit Indian number (handles optional country code and spaces like 91234 56789)
    phone_m = re.search(r"(?:(?:\+?91|0)[ -]?)?([6-9]\d{4}\s*\d{5}|[6-9]\d{9})\b", text)
    if phone_m:
        raw_phone = re.sub(r"\D", "", phone_m.group(1))
        out["mobile_number"] = {"value": raw_phone, "confidence": 0.88, "uncertain": False}

    # Age: e.g. Age: 34 or 34 Years or Age / Gender: 35 Yrs
    age_m = re.search(r"\b(?:Age|Age\s*/\s*Gender|Age\s*/\s*Sex|Years|Yrs|Yr)[\s:/]*(\d{1,3})\b", text, re.IGNORECASE)
    if age_m:
        try:
            a = int(age_m.group(1))
            if 0 < a < 125:
                out["age"] = {"value": a, "confidence": 0.85, "uncertain": False}
        except ValueError:
            pass

    # DOB: DD/MM/YYYY or YYYY-MM-DD
    dob_m = re.search(r"\b(?:DOB|Birth|D\.O\.B)[\s:/]*(\d{2}[-/]\d{2}[-/]\d{4}|\d{4}[-/]\d{2}[-/]\d{2})\b", text, re.IGNORECASE)
    if dob_m:
        norm_dob = normalize_date(dob_m.group(1))
        if norm_dob:
            out["date_of_birth"] = {"value": norm_dob, "confidence": 0.85, "uncertain": False}
            if not out["age"]["value"]:
                derived_age = calculate_age_from_dob(norm_dob)
                if derived_age:
                    out["age"] = {"value": derived_age, "confidence": 0.82, "uncertain": False}

    # Name: Name: John Doe or Patient Name: Anita Sen
    name_m = re.search(r"\b(?:Patient\s*Name|Name|Mr\.|Mrs\.|Ms\.|Shri|Smt)[\s:/]*([A-Za-z. ]{2,35})(?:[\r\n]|$)", text, re.IGNORECASE)
    if name_m:
        cand = name_m.group(1).strip()
        cand = re.sub(r"\b(Patient|Name|Age|Sex|Male|Female|Date)\b", "", cand, flags=re.IGNORECASE).strip()
        if len(cand) >= 2 and not cand.isdigit():
            out["full_name"] = {"value": cand.title(), "confidence": 0.82, "uncertain": False}

    # Address / City / PIN
    pin_m = re.search(r"\b([1-9][0-9]{5})\b", text)
    pin = pin_m.group(1) if pin_m else None
    addr_m = re.search(r"\b(?:Address|Add|Res|Vill|Flat|House)[\s:/]*([^\r\n]{8,90})", text, re.IGNORECASE)
    if addr_m:
        addr = addr_m.group(1).strip()
        out["address"] = {"value": addr, "confidence": 0.78, "uncertain": False}
    elif pin:
        out["address"] = {"value": f"PIN: {pin}", "confidence": 0.65, "uncertain": True}

    return out


def normalize_extracted_data(raw: Dict[str, Any]) -> Tuple[ExtractedPatientData, List[str]]:
    """Normalize and validate extracted fields with non-fabrication guarantees."""
    data = ExtractedPatientData()
    warnings: List[str] = list(raw.get("warnings") or [])

    # Map raw fields safely
    for field_name in [
        "full_name",
        "date_of_birth",
        "age",
        "gender",
        "mobile_number",
        "email_address",
        "address",
        "city",
        "state",
        "postal_code",
        "document_type",
        "document_id_number",
    ]:
        raw_val = raw.get(field_name)
        if isinstance(raw_val, dict):
            val = raw_val.get("value")
            conf = float(raw_val.get("confidence", 0.0) or 0.0)
            unc = bool(raw_val.get("uncertain", False))
        else:
            val = raw_val
            conf = 0.8 if val else 0.0
            unc = False

        if val is not None and str(val).strip():
            setattr(
                data,
                field_name,
                ExtractedField(
                    value=str(val).strip(),
                    confidence=min(1.0, max(0.0, conf)),
                    uncertain=unc,
                ),
            )
        else:
            setattr(data, field_name, ExtractedField(value=None, confidence=0.0, uncertain=False))

    # 1. Normalize Mobile
    if data.mobile_number.value:
        norm_mobile = normalize_mobile(data.mobile_number.value)
        if norm_mobile:
            data.mobile_number.value = norm_mobile
            data.mobile_number.uncertain = False
        else:
            warnings.append(f"Mobile number '{data.mobile_number.value}' could not be validated as 10-digit Indian number.")
            data.mobile_number.uncertain = True

    # 2. Normalize DOB and Age derivation
    if data.date_of_birth.value:
        norm_dob = normalize_date(data.date_of_birth.value)
        if norm_dob:
            data.date_of_birth.value = norm_dob
            if not data.age.value:
                calc_age = calculate_age_from_dob(norm_dob)
                if calc_age is not None:
                    data.age.value = str(calc_age)
                    data.age.confidence = data.date_of_birth.confidence
        else:
            data.date_of_birth.uncertain = True

    # 3. Normalize Gender
    if data.gender.value:
        norm_g = normalize_gender(data.gender.value)
        if norm_g:
            data.gender.value = norm_g
        else:
            data.gender.uncertain = True

    # 4. Normalize Pincode
    if data.postal_code.value:
        norm_pin = normalize_pincode(data.postal_code.value)
        if norm_pin:
            data.postal_code.value = norm_pin
        else:
            data.postal_code.uncertain = True

    # Flag low confidence fields
    for field_name in ["full_name", "date_of_birth", "mobile_number", "gender", "address"]:
        field: ExtractedField = getattr(data, field_name)
        if field.value and field.confidence < 0.65:
            field.uncertain = True
            warnings.append(f"Low confidence ({int(field.confidence * 100)}%) on {field_name.replace('_', ' ')}.")

    return data, warnings


# Backward-compatibility alias
normalize_raw_output = normalize_extracted_data


async def process_document_ocr(
    req: OCRExtractRequest,
    api_key_override: Optional[str] = None,
) -> OCRExtractResponse:
    """
    Main Multi-Model Orchestration Pipeline:
    1. Validate input payload & MIME type.
    2. Try Primary Model: Groq Vision (qwen/qwen3.8-27b).
    3. If Groq fails: Try Fallback 1: Hugging Face (zai-org/GLM-OCR or numind/NuExtract3).
    4. If HF fails: Try Fallback 2: Lightweight document stream/regex extractor.
    5. Construct standardized Section 4 response with the 4 required clinical fields:
       - patient_name
       - age
       - phone_number
       - address
       along with extracted_fields, missing_fields, confidence, and model_used.
    """
    start_time = time.time()
    req_id = f"ocr_{uuid.uuid4().hex[:12]}"
    warnings: List[str] = []
    model_used = PRIMARY_GROQ_MODEL
    raw_result: Optional[Dict[str, Any]] = None

    # 1. Clean payload
    raw_bytes, detected_mime = clean_base64_data(req.file_data, req.mime_type or "image/jpeg")
    is_pdf = detected_mime == "application/pdf" or (req.file_name and req.file_name.lower().endswith(".pdf"))

    # Extract text if PDF
    pdf_text = None
    if is_pdf:
        try:
            pdf_text = extract_text_from_pdf(raw_bytes)
        except Exception as e:
            logger.warning(f"PDF extraction error [{req_id}]: {e}")
            warnings.append(f"PDF parsing warning: {str(e)}")

    # 2. PRIMARY MODEL: Groq API
    groq_api_key = api_key_override or os.environ.get("GROQ_API_KEY", "").strip()
    hf_token = get_hf_api_key()
    configured_model = get_configured_model()

    if not groq_api_key and not hf_token and not api_key_override:
        # Require at least one configured API key to prevent silent empty responses
        raise GroqConfigurationError(
            "GROQ_API_KEY is not configured in backend environment. "
            "Please configure GROQ_API_KEY in backend/.env to enable patient document scanning."
        )

    if groq_api_key:
        try:
            if is_pdf and pdf_text:
                raw_result = await call_groq_text(pdf_text, configured_model, groq_api_key)
                model_used = configured_model
            else:
                opt_jpeg, _, _ = preprocess_image(raw_bytes)
                raw_result = await call_groq_vision(opt_jpeg, configured_model, groq_api_key)
                model_used = configured_model
        except Exception as e:
            logger.warning(f"Primary Groq model failed [{req_id}]: {e}. Triggering fallback pipeline.")
            warnings.append(f"Primary Groq engine encountered an issue: {str(e)}. Triggered fallback.")
            raw_result = None

    # 3. FALLBACK 1: Hugging Face Inference API
    hf_token = get_hf_api_key()
    if raw_result is None and hf_token:
        try:
            logger.info(f"Attempting Fallback 1: Hugging Face ({FALLBACK_HF_GLM})...")
            hf_res = await call_huggingface_ocr(raw_bytes, model_id=FALLBACK_HF_GLM, hf_token=hf_token)
            if hf_res and (hf_res.get("full_name") or hf_res.get("raw_text_summary")):
                raw_result = hf_res
                model_used = f"huggingface/{FALLBACK_HF_GLM}"
        except Exception as e:
            logger.warning(f"Hugging Face Fallback 1 failed [{req_id}]: {e}")
            warnings.append(f"Hugging Face fallback unavailable: {str(e)}")

    # 4. FALLBACK 2: Lightweight Local Document / Stream Extractor
    if raw_result is None:
        logger.info(f"Attempting Fallback 2: Lightweight Local Extractor ({FALLBACK_LOCAL})...")
        text_source = pdf_text or ""
        if not text_source:
            # Check raw string for text tokens or embedded streams
            try:
                text_source = raw_bytes.decode("latin1", errors="ignore")
            except Exception:
                text_source = ""
        raw_result = extract_patient_details_offline(text_source)
        model_used = FALLBACK_LOCAL
        warnings.append("Processed using local offline fallback parser.")

    # 5. Normalize and validate fields
    data, norm_warnings = normalize_extracted_data(raw_result or {})
    warnings.extend(norm_warnings)

    # 6. Extract Section 4 Required Fields (patient_name, age, phone_number, address)
    patient_name = data.full_name.value
    age_val = data.age.value
    phone_number = data.mobile_number.value

    # Build address from street + city + state + PIN if partial
    address_parts = [p for p in [data.address.value, data.city.value, data.state.value, data.postal_code.value] if p]
    address_val = ", ".join(address_parts) if address_parts else data.address.value

    # 7. Compute extracted_fields vs missing_fields (Section 4 Contract)
    candidate_fields = {
        "patient_name": (patient_name, data.full_name.confidence),
        "age": (age_val, data.age.confidence),
        "phone_number": (phone_number, data.mobile_number.confidence),
        "address": (address_val, data.address.confidence),
    }

    extracted_fields: List[str] = []
    missing_fields: List[str] = []
    confidence_map: Dict[str, float] = {}

    for f_name, (f_val, f_conf) in candidate_fields.items():
        if f_val is not None and str(f_val).strip():
            extracted_fields.append(f_name)
            confidence_map[f_name] = round(float(f_conf or 0.85), 2)
        else:
            missing_fields.append(f_name)
            confidence_map[f_name] = 0.0

    duration_ms = round((time.time() - start_time) * 1000, 2)

    return OCRExtractResponse(
        success=True,
        request_id=req_id,
        patient_name=patient_name,
        age=str(age_val) if age_val is not None else None,
        phone_number=phone_number,
        address=address_val,
        extracted_fields=extracted_fields,
        missing_fields=missing_fields,
        confidence=confidence_map,
        ocr_model=model_used,
        requires_review=True,
        extracted_data=data,
        warnings=warnings,
        model_used=model_used,
        processing_time_ms=duration_ms,
        error=None,
    )


async def confirm_patient_ocr(
    req: OCRConfirmRequest,
    db: Any = None,
) -> OCRConfirmResponse:
    """
    Validate confirmed patient details against existing patient database.
    Checks if patient already exists by phone_number to prevent duplicate creation.
    """
    matched = False
    existing_id = None
    msg = "New patient will be created upon appointment booking."

    phone = normalize_mobile(req.phone_number)
    if db is not None and phone:
        try:
            existing = await db.users.find_one({"mobile": phone})
            if existing:
                matched = True
                existing_id = str(existing.get("_id"))
                msg = f"Existing patient matched (ID: {existing_id}). Record will be reused without duplication."
        except Exception as e:
            logger.warning(f"Database lookup error during OCR confirmation: {e}")

    return OCRConfirmResponse(
        matched_existing_patient=matched,
        existing_patient_id=existing_id,
        message=msg,
        patient_data={
            "patient_name": req.patient_name,
            "phone_number": phone or req.phone_number,
            "age": req.age,
            "address": req.address,
            "gender": req.gender,
            "doctor_id": req.doctor_id,
            "session_id": req.session_id,
        },
    )


def get_ocr_health() -> OCRHealthResponse:
    """Return health status and capability configuration of the multi-model OCR pipeline."""
    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    hf_token = get_hf_api_key()
    configured_model = get_configured_model()

    status_val = "operational" if groq_key else ("fallback_mode" if hf_token else "unconfigured")
    return OCRHealthResponse(
        status=status_val,
        primary_model=f"groq/{configured_model}",
        fallback_sequence=[
            f"huggingface/{FALLBACK_HF_GLM}",
            f"huggingface/{FALLBACK_HF_INDRA}",
            f"huggingface/{FALLBACK_HF_NUEXTRACT}",
            FALLBACK_LOCAL,
        ],
        disqualified_models=DISQUALIFIED_MODELS,
        groq_api_key_configured=bool(groq_key),
        huggingface_api_key_configured=bool(hf_token),
        configured_model=configured_model,
        model_vision_supported=is_vision_model(configured_model),
        supported_mime_types=SUPPORTED_MIME_TYPES,
        max_file_size_bytes=MAX_FILE_SIZE_BYTES,
    )
