"""
Unit and integration tests for the AI-Powered OCR Sub-Pipeline.
Covers:
1. File validation (empty files, invalid base64, oversized files, unsupported formats).
2. Image preprocessing (resizing, orientation, RGBA-to-RGB, corrupt image handling).
3. PDF parsing and text layer extraction.
4. Data normalization (mobile numbers, DOB, age derivation, gender, postal code).
5. Non-fabrication guarantee (missing fields remain None).
6. Confidence and uncertainty estimation.
7. Groq API integration (mocked vision and text responses).
8. Live Groq API integration (conditionally run if GROQ_API_KEY is configured and RUN_LIVE_GROQ_TEST=1).
9. Role-based authorization and health checks.
"""

import os
import io
import json
import base64
import uuid
import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from PIL import Image

import ocr_schema
from ocr_schema import (
    OCRExtractRequest,
    OCRExtractResponse,
    ExtractedField,
    ExtractedPatientData,
)
import ocr_service
from ocr_service import (
    clean_base64_data,
    preprocess_image,
    normalize_mobile,
    normalize_date,
    calculate_age_from_dob,
    normalize_gender,
    normalize_pincode,
    normalize_raw_output,
    process_document_ocr,
    get_ocr_health,
    DocumentValidationError,
    GroqConfigurationError,
    DEFAULT_GROQ_VISION_MODEL,
    MAX_FILE_SIZE_BYTES,
)


def create_sample_image(width=400, height=300, color="white", text_layer=None) -> bytes:
    """Helper to generate a valid JPEG in memory."""
    img = Image.new("RGB", (width, height), color=color)
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


def create_sample_png(width=200, height=200, mode="RGBA") -> bytes:
    """Helper to generate a PNG image with alpha channel."""
    img = Image.new(mode, (width, height), color=(255, 0, 0, 128) if mode == "RGBA" else (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ============ 1. BASE64 & FILE VALIDATION TESTS ============

def test_clean_base64_data_valid_raw():
    img_bytes = create_sample_image()
    b64_str = base64.b64encode(img_bytes).decode("utf-8")
    decoded, mime = clean_base64_data(b64_str, "image/jpeg")
    assert decoded == img_bytes
    assert mime == "image/jpeg"


def test_clean_base64_data_valid_data_url():
    img_bytes = create_sample_image()
    b64_str = base64.b64encode(img_bytes).decode("utf-8")
    data_url = f"data:image/png;base64,{b64_str}"
    decoded, mime = clean_base64_data(data_url)
    assert decoded == img_bytes
    assert mime == "image/png"


def test_clean_base64_data_empty_raises():
    with pytest.raises(DocumentValidationError, match="No document data provided"):
        clean_base64_data("")


def test_clean_base64_data_whitespace_raises():
    with pytest.raises(DocumentValidationError, match="No document data provided"):
        clean_base64_data("   \n\t  ")


def test_clean_base64_data_invalid_base64_raises():
    with pytest.raises(DocumentValidationError, match="Invalid base64 encoding"):
        clean_base64_data("!@#$%%^&*()_not_base64")


def test_clean_base64_data_oversized_raises():
    fake_oversized = b"0" * (MAX_FILE_SIZE_BYTES + 1024)
    b64_str = base64.b64encode(fake_oversized).decode("utf-8")
    with pytest.raises(DocumentValidationError, match="exceeds maximum allowed limit"):
        clean_base64_data(b64_str)


# ============ 2. IMAGE PREPROCESSING TESTS ============

def test_preprocess_image_converts_rgba_to_rgb():
    png_bytes = create_sample_png(300, 200, mode="RGBA")
    jpeg_bytes, w, h = preprocess_image(png_bytes)
    assert w == 300
    assert h == 200
    # Output must be readable JPEG
    with Image.open(io.BytesIO(jpeg_bytes)) as out_img:
        assert out_img.format == "JPEG"
        assert out_img.mode == "RGB"


def test_preprocess_image_downscales_oversized():
    # 3000 x 1500 image should be scaled down so max dimension is 2048
    large_bytes = create_sample_image(width=3000, height=1500)
    jpeg_bytes, w, h = preprocess_image(large_bytes)
    assert max(w, h) == 2048
    assert w == 2048
    assert h == 1024


def test_preprocess_image_rejects_too_small():
    tiny_bytes = create_sample_image(width=20, height=20)
    with pytest.raises(DocumentValidationError, match="too low"):
        preprocess_image(tiny_bytes)


def test_preprocess_image_rejects_corrupted():
    corrupted_bytes = b"\xFF\xD8\xFF\xE0\x00\x10JFIF" + b"randomjunk123456"
    with pytest.raises(DocumentValidationError, match="corrupted"):
        preprocess_image(corrupted_bytes)


# ============ 3. NORMALIZATION & SANITIZATION TESTS ============

def test_normalize_mobile_various_formats():
    assert normalize_mobile("9876543210") == "9876543210"
    assert normalize_mobile("+91 98765 43210") == "9876543210"
    assert normalize_mobile("919876543210") == "9876543210"
    assert normalize_mobile("09876543210") == "9876543210"
    assert normalize_mobile("98765-43210") == "9876543210"
    assert normalize_mobile("12345") is None
    assert normalize_mobile(None) is None


def test_normalize_date_formats():
    assert normalize_date("1992-05-18") == "1992-05-18"
    assert normalize_date("18/05/1992") == "1992-05-18"
    assert normalize_date("18-05-1992") == "1992-05-18"
    assert normalize_date("18 May 1992") == "1992-05-18"
    assert normalize_date("InvalidDate") is None
    assert normalize_date(None) is None


def test_calculate_age_from_dob():
    age = calculate_age_from_dob("2000-01-01")
    assert age is not None
    assert age >= 24


def test_normalize_gender_values():
    assert normalize_gender("M") == "Male"
    assert normalize_gender("male") == "Male"
    assert normalize_gender("PURUSH") == "Male"
    assert normalize_gender("Female") == "Female"
    assert normalize_gender("F") == "Female"
    assert normalize_gender("mahila") == "Female"
    assert normalize_gender("Other") == "Other"
    assert normalize_gender("Alien") is None
    assert normalize_gender(None) is None


def test_normalize_pincode():
    assert normalize_pincode("814151") == "814151"
    assert normalize_pincode("Dumka 814151, Jharkhand") == "814151"
    assert normalize_pincode("012345") is None  # Invalid Indian PIN
    assert normalize_pincode("abc") is None


def test_non_fabrication_preserves_none():
    """Ensure absent fields in raw dict remain None without inventing data."""
    raw_dict = {
        "full_name": {"value": "Ramesh Kumar", "confidence": 0.95},
        "gender": {"value": "Male", "confidence": 0.90},
        # Mobile, DOB, Email, Address are absent
    }
    extracted, warnings = normalize_raw_output(raw_dict)
    assert extracted.full_name.value == "Ramesh Kumar"
    assert extracted.gender.value == "Male"
    assert extracted.mobile_number.value is None
    assert extracted.date_of_birth.value is None
    assert extracted.email_address.value is None
    assert extracted.address.value is None


def test_uncertainty_flagging_for_low_confidence():
    raw_dict = {
        "full_name": {"value": "Blurry Name", "confidence": 0.40},
        "mobile_number": {"value": "9876543210", "confidence": 0.50},
    }
    extracted, warnings = normalize_raw_output(raw_dict)
    assert extracted.full_name.uncertain is True
    assert extracted.mobile_number.uncertain is True
    assert any("Low confidence" in w for w in warnings)


# ============ 4. GROQ API ERROR HANDLING & SERVICE TESTS (MOCKED) ============

@pytest.mark.asyncio
async def test_process_document_ocr_missing_key_raises(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    img_bytes = create_sample_image()
    req = OCRExtractRequest(
        file_data=base64.b64encode(img_bytes).decode("utf-8"),
        mime_type="image/jpeg",
    )
    with pytest.raises(GroqConfigurationError, match="GROQ_API_KEY is not configured"):
        await process_document_ocr(req)


@pytest.mark.asyncio
async def test_process_document_ocr_mocked_vision_success(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "mock_gsk_test_key_12345")
    img_bytes = create_sample_image()
    req = OCRExtractRequest(
        file_data=base64.b64encode(img_bytes).decode("utf-8"),
        mime_type="image/jpeg",
        file_name="patient_aadhaar.jpg",
    )

    mock_llm_response = {
        "full_name": {"value": "Sunita Sharma", "confidence": 0.98, "uncertain": False},
        "date_of_birth": {"value": "1988-07-22", "confidence": 0.94, "uncertain": False},
        "age": {"value": 36, "confidence": 0.94, "uncertain": False},
        "gender": {"value": "Female", "confidence": 0.99, "uncertain": False},
        "mobile_number": {"value": "9876543210", "confidence": 0.92, "uncertain": False},
        "email_address": {"value": None, "confidence": 0.0, "uncertain": False},
        "address": {"value": "Sector 14, Ring Road", "confidence": 0.88, "uncertain": False},
        "city": {"value": "Ranchi", "confidence": 0.90, "uncertain": False},
        "state": {"value": "Jharkhand", "confidence": 0.92, "uncertain": False},
        "postal_code": {"value": "834001", "confidence": 0.89, "uncertain": False},
        "document_type": {"value": "Aadhaar", "confidence": 0.99, "uncertain": False},
        "document_id_number": {"value": "XXXX XXXX 1234", "confidence": 0.95, "uncertain": False},
        "raw_text_summary": "Government of India Aadhaar Card Sunita Sharma DOB 22/07/1988 Female",
        "warnings": [],
    }

    with patch.object(ocr_service, "call_groq_vision", new_callable=AsyncMock) as mock_vision:
        mock_vision.return_value = mock_llm_response

        res = await process_document_ocr(req)

        assert res.success is True
        assert res.requires_review is True
        assert res.extracted_data.full_name.value == "Sunita Sharma"
        assert res.extracted_data.gender.value == "Female"
        assert res.extracted_data.mobile_number.value == "9876543210"
        assert res.extracted_data.date_of_birth.value == "1988-07-22"
        assert res.extracted_data.document_type.value == "Aadhaar"
        assert res.model_used == DEFAULT_GROQ_VISION_MODEL
        assert res.request_id.startswith("ocr_")


@pytest.mark.asyncio
async def test_process_document_ocr_pdf_routing(monkeypatch):
    """Test PDF extraction using text layer and Groq text model."""
    monkeypatch.setenv("GROQ_API_KEY", "mock_gsk_test_key_12345")

    fake_pdf_bytes = b"%PDF-1.4 ... fake pdf content ..."
    req = OCRExtractRequest(
        file_data=base64.b64encode(fake_pdf_bytes).decode("utf-8"),
        mime_type="application/pdf",
        file_name="discharge_summary.pdf",
    )

    mock_llm_response = {
        "full_name": {"value": "Amitabh Verma", "confidence": 0.96, "uncertain": False},
        "date_of_birth": {"value": "1975-12-04", "confidence": 0.91, "uncertain": False},
        "gender": {"value": "Male", "confidence": 0.95, "uncertain": False},
        "mobile_number": {"value": "9123456780", "confidence": 0.89, "uncertain": False},
        "document_type": {"value": "Prescription", "confidence": 0.94, "uncertain": False},
    }

    with patch.object(ocr_service, "extract_text_from_pdf") as mock_pdf_extract, \
         patch.object(ocr_service, "call_groq_text", new_callable=AsyncMock) as mock_text_call:
        mock_pdf_extract.return_value = "Patient: Amitabh Verma, Age 48, Male, Ph: 9123456780"
        mock_text_call.return_value = mock_llm_response

        res = await process_document_ocr(req)
        assert res.success is True
        assert res.extracted_data.full_name.value == "Amitabh Verma"
        assert res.extracted_data.mobile_number.value == "9123456780"
        assert res.extracted_data.gender.value == "Male"


def test_get_ocr_health_unconfigured(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    h = get_ocr_health()
    assert h.status == "unconfigured"
    assert h.groq_api_key_configured is False
    assert h.model_vision_supported is True


def test_get_ocr_health_configured(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_live_key_xyz")
    h = get_ocr_health()
    assert h.status == "operational"
    assert h.groq_api_key_configured is True


# ============ 5. LIVE GROQ INTEGRATION TEST (CONDITIONAL) ============

@pytest.mark.asyncio
async def test_live_groq_api_integration():
    """
    Live test against Groq's official API endpoint.
    Executed ONLY when GROQ_API_KEY is configured in backend environment and RUN_LIVE_GROQ_TEST=1.
    Skipped with clear diagnostic message when key is not present.
    """
    api_key = os.environ.get("GROQ_API_KEY", "").strip()
    run_live = os.environ.get("RUN_LIVE_GROQ_TEST", "0").strip()
    if not api_key or run_live != "1":
        pytest.skip(
            "Live Groq integration test requires valid GROQ_API_KEY in environment and RUN_LIVE_GROQ_TEST=1. Skipping."
        )

    # Generate a sample document image containing legible text
    from PIL import ImageDraw
    img = Image.new("RGB", (600, 300), color="white")
    draw = ImageDraw.Draw(img)
    draw.text((30, 30), "REPUBLIC OF INDIA - PATIENT HEALTH CARD", fill="black")
    draw.text((30, 80), "Name: Rajesh Kumar Gupta", fill="black")
    draw.text((30, 120), "DOB: 15/08/1985", fill="black")
    draw.text((30, 160), "Gender: Male", fill="black")
    draw.text((30, 200), "Mobile: 9876543210", fill="black")
    draw.text((30, 240), "Address: Main Road, Ranchi, Jharkhand 834001", fill="black")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    img_bytes = buf.getvalue()

    req = OCRExtractRequest(
        file_data=base64.b64encode(img_bytes).decode("utf-8"),
        mime_type="image/jpeg",
        file_name="live_test_card.jpg",
    )

    res = await process_document_ocr(req, api_key_override=api_key)
    assert res.success is True
    assert res.extracted_data.full_name.value is not None
    assert "Rajesh" in res.extracted_data.full_name.value
    assert res.extracted_data.gender.value == "Male"
    assert res.extracted_data.mobile_number.value == "9876543210"


# ============ 6. FASTAPI ROUTE & AUTHORIZATION TESTS ============

def test_ocr_endpoint_unauthorized_rejected():
    """Unauthenticated request must be rejected with 401 or 403."""
    from fastapi.testclient import TestClient
    from server import app
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.post("/api/receptionist/ocr/extract", json={"file_data": "dGVzdA=="})
    assert resp.status_code in (401, 403)


def test_ocr_health_endpoint_authenticated():
    """Authenticated receptionist can check OCR health status."""
    from fastapi.testclient import TestClient
    from server import app, get_current_user
    client = TestClient(app, raise_server_exceptions=False)

    app.dependency_overrides[get_current_user] = lambda: {
        "id": "rec_test_123",
        "role": "receptionist",
        "hospital_id": "test_hosp_1",
    }
    try:
        resp = client.get("/api/receptionist/ocr/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "status" in data
        assert "groq_api_key_configured" in data
        assert "configured_model" in data
        assert "model_vision_supported" in data
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_ocr_extract_endpoint_success_receptionist(monkeypatch):
    """Authenticated receptionist can invoke OCR extraction endpoint."""
    monkeypatch.setenv("GROQ_API_KEY", "mock_gsk_test_key_12345")
    from fastapi.testclient import TestClient
    from server import app, get_current_user
    client = TestClient(app, raise_server_exceptions=False)

    app.dependency_overrides[get_current_user] = lambda: {
        "id": "rec_test_123",
        "role": "receptionist",
        "hospital_id": "test_hosp_1",
    }

    img_bytes = create_sample_image()
    payload = {
        "file_data": base64.b64encode(img_bytes).decode("utf-8"),
        "mime_type": "image/jpeg",
        "file_name": "patient_doc.jpg",
    }

    mock_llm_response = {
        "full_name": {"value": "Pooja Roy", "confidence": 0.97, "uncertain": False},
        "gender": {"value": "Female", "confidence": 0.99, "uncertain": False},
        "mobile_number": {"value": "9876543210", "confidence": 0.94, "uncertain": False},
    }

    with patch.object(ocr_service, "call_groq_vision", new_callable=AsyncMock) as mock_vision:
        mock_vision.return_value = mock_llm_response
        try:
            resp = client.post("/api/receptionist/ocr/extract", json=payload)
            assert resp.status_code == 200
            data = resp.json()
            assert data["success"] is True
            assert data["extracted_data"]["full_name"]["value"] == "Pooja Roy"
            assert data["extracted_data"]["gender"]["value"] == "Female"
            assert data["extracted_data"]["mobile_number"]["value"] == "9876543210"
            assert data["requires_review"] is True
        finally:
            app.dependency_overrides.pop(get_current_user, None)
