"""
Schema definitions for the AI-Powered OCR Sub-Pipeline.
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
    success: bool
    request_id: str
    extracted_data: ExtractedPatientData
    warnings: List[str] = Field(default_factory=list)
    requires_review: bool = True
    model_used: Optional[str] = None
    processing_time_ms: Optional[float] = None
    error: Optional[str] = None


class OCRHealthResponse(BaseModel):
    status: str
    groq_api_key_configured: bool
    configured_model: str
    model_vision_supported: bool
    supported_mime_types: List[str]
    max_file_size_bytes: int

