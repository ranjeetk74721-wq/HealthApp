"""
Schema definitions for the Multi-Model AI-Powered OCR Sub-Pipeline.
Supports primary Groq vision models, Hugging Face candidate fallbacks,
and lightweight offline extraction with the required 4-field clinical output:
(patient_name, age, phone_number, address).
"""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class ExtractedField(BaseModel):
    value: Optional[str] = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    uncertain: bool = False


class ExtractedPatientData(BaseModel):
    full_name: ExtractedField = Field(default_factory=ExtractedField)
    date_of_birth: ExtractedField = Field(default_factory=ExtractedField)
    age: ExtractedField = Field(default_factory=ExtractedField)
    gender: ExtractedField = Field(default_factory=ExtractedField)
    mobile_number: ExtractedField = Field(default_factory=ExtractedField)
    email_address: ExtractedField = Field(default_factory=ExtractedField)
    address: ExtractedField = Field(default_factory=ExtractedField)
    city: ExtractedField = Field(default_factory=ExtractedField)
    state: ExtractedField = Field(default_factory=ExtractedField)
    postal_code: ExtractedField = Field(default_factory=ExtractedField)
    document_type: ExtractedField = Field(default_factory=ExtractedField)
    document_id_number: ExtractedField = Field(default_factory=ExtractedField)
    raw_text: Optional[str] = None


class OCRExtractRequest(BaseModel):
    """
    Accepts base64 encoded document image or PDF.
    file_data can be raw base64 or a data URL (e.g. 'data:image/jpeg;base64,...').
    """
    file_data: str = Field(..., description="Base64 encoded file content or data URL")
    mime_type: Optional[str] = Field(default="image/jpeg", description="MIME type of uploaded document")
    file_name: Optional[str] = Field(default="document.jpg", description="Original filename")


class OCRExtractResponse(BaseModel):
    """
    Standardized Multi-Model OCR response schema conforming to Section 4.
    Includes top-level required clinical fields:
      - patient_name
      - age
      - phone_number
      - address
    along with confidence mappings, extracted/missing lists, and backward-compatible fields.
    """
    success: bool
    request_id: str
    patient_name: Optional[str] = None
    age: Optional[str] = None
    phone_number: Optional[str] = None
    address: Optional[str] = None
    extracted_fields: List[str] = Field(default_factory=list)
    missing_fields: List[str] = Field(default_factory=list)
    confidence: Dict[str, float] = Field(default_factory=dict)
    ocr_model: Optional[str] = None
    requires_review: bool = True
    # Backward compatibility with detailed sub-objects
    extracted_data: ExtractedPatientData = Field(default_factory=ExtractedPatientData)
    warnings: List[str] = Field(default_factory=list)
    model_used: Optional[str] = None
    processing_time_ms: Optional[float] = None
    error: Optional[str] = None


class OCRConfirmRequest(BaseModel):
    """
    Receptionist confirmed patient data from review screen.
    Checks existing patient database before creating appointment.
    """
    patient_name: str = Field(..., min_length=1, description="Confirmed patient name")
    phone_number: Optional[str] = Field(default=None, description="Confirmed 10-digit phone number")
    age: Optional[str] = Field(default=None, description="Confirmed patient age")
    address: Optional[str] = Field(default=None, description="Confirmed patient address")
    gender: Optional[str] = Field(default=None, description="Confirmed patient gender")
    doctor_id: Optional[str] = Field(default=None, description="Selected doctor ID")
    session_id: Optional[str] = Field(default=None, description="Selected doctor session ID")


class OCRConfirmResponse(BaseModel):
    matched_existing_patient: bool
    existing_patient_id: Optional[str] = None
    message: str
    patient_data: Dict[str, Any]


class OCRHealthResponse(BaseModel):
    status: str
    primary_model: str
    fallback_sequence: List[str]
    disqualified_models: Dict[str, str]
    groq_api_key_configured: bool
    huggingface_api_key_configured: bool
    configured_model: str
    model_vision_supported: bool
    supported_mime_types: List[str]
    max_file_size_bytes: int
