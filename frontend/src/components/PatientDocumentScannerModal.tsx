import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Image,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

export interface OCRConfirmedPatientData {
  fullName: string;
  mobile?: string;
  age?: string;
  gender?: string | null;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  dateOfBirth?: string;
  documentType?: string;
  documentIdNumber?: string;
}

interface PatientDocumentScannerModalProps {
  visible: boolean;
  onClose: () => void;
  onConfirmFill: (data: OCRConfirmedPatientData) => void;
}

interface ExtractedFieldState {
  value: string;
  confidence: number;
  uncertain: boolean;
}

export default function PatientDocumentScannerModal({
  visible,
  onClose,
  onConfirmFill,
}: PatientDocumentScannerModalProps) {
  // Flow steps: 'select' -> 'camera_active' -> 'preview' -> 'processing' -> 'review'
  const [step, setStep] = useState<"select" | "camera_active" | "preview" | "processing" | "review">("select");

  // File data
  const [fileDataUrl, setFileDataUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("document.jpg");
  const [mimeType, setMimeType] = useState<string>("image/jpeg");
  const [isPdf, setIsPdf] = useState<boolean>(false);

  // Camera stream for Web
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [cameraFacing, setCameraFacing] = useState<"environment" | "user">("environment");
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Processing state & error
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [processingStatus, setProcessingStatus] = useState<string>("Analyzing document with Groq AI...");

  // Review editable fields
  const [fullName, setFullName] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [mobileNumber, setMobileNumber] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [dateOfBirth, setDateOfBirth] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [age, setAge] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [gender, setGender] = useState<string | null>(null);
  const [address, setAddress] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [city, setCity] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [state, setState] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [postalCode, setPostalCode] = useState<ExtractedFieldState>({ value: "", confidence: 1.0, uncertain: false });
  const [docType, setDocType] = useState<string>("Document");
  const [docIdNumber, setDocIdNumber] = useState<string>("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ocrModel, setOcrModel] = useState<string>("groq/qwen3.8-27b");
  const [extractedFieldsList, setExtractedFieldsList] = useState<string[]>([]);
  const [missingFieldsList, setMissingFieldsList] = useState<string[]>([]);

  // Stop camera tracks helper
  const stopCameraStream = useCallback(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore cleanup errors
        }
      });
      mediaStreamRef.current = null;
    }
  }, []);

  // Cleanup on unmount or close
  useEffect(() => {
    if (!visible) {
      stopCameraStream();
      setStep("select");
      setFileDataUrl(null);
      setProcessingError(null);
      setCameraError(null);
    }
  }, [visible, stopCameraStream]);

  // Start Live Camera
  const startCamera = async (facing: "environment" | "user" = "environment") => {
    setCameraError(null);
    if (Platform.OS === "web") {
      try {
        stopCameraStream();
        setStep("camera_active");
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setCameraError("Camera access is not supported in this browser. Please upload an image instead.");
          setStep("select");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: facing,
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        mediaStreamRef.current = stream;
        setCameraFacing(facing);

        // Attach stream to video element once rendered
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            videoRef.current.play().catch(() => {});
          }
        }, 150);
      } catch (err: any) {
        stopCameraStream();
        const msg =
          err.name === "NotAllowedError" || err.name === "PermissionDeniedError"
            ? "Camera permission was denied. Please allow camera access in your browser settings or choose 'Upload Image'."
            : err.name === "NotFoundError" || err.name === "DevicesNotFoundError"
            ? "No camera device was found on this system. Please upload an image instead."
            : `Unable to access camera: ${err.message || "Unknown error"}`;
        setCameraError(msg);
        setStep("select");
      }
    } else {
      // Native (iOS/Android) Camera via expo-image-picker
      try {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("Permission Required", "Camera permission is required to capture patient documents.");
          return;
        }
        const result = await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.88,
          base64: true,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          const dataUrl = asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri;
          setFileDataUrl(dataUrl);
          setFileName(asset.fileName || "camera_capture.jpg");
          setMimeType("image/jpeg");
          setIsPdf(false);
          setStep("preview");
        }
      } catch (err: any) {
        Alert.alert("Camera Error", err.message || "Could not launch camera.");
      }
    }
  };

  // Capture Photo from Web Camera Video
  const captureWebPhoto = () => {
    if (!videoRef.current) return;
    try {
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.90);
      stopCameraStream();
      setFileDataUrl(dataUrl);
      setFileName("live_capture.jpg");
      setMimeType("image/jpeg");
      setIsPdf(false);
      setStep("preview");
    } catch (err: any) {
      setCameraError(`Failed to capture photo: ${err.message}`);
    }
  };

  // Switch Web Camera
  const toggleCameraFacing = () => {
    const nextFacing = cameraFacing === "environment" ? "user" : "environment";
    startCamera(nextFacing);
  };

  // Upload Image File
  const handleUploadImage = async () => {
    setProcessingError(null);
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/jpeg,image/png,image/webp";
      input.onchange = (e: any) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          setProcessingError("File size exceeds 10MB limit. Please choose a smaller image.");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setFileDataUrl(reader.result as string);
          setFileName(file.name || "uploaded_image.jpg");
          setMimeType(file.type || "image/jpeg");
          setIsPdf(false);
          setStep("preview");
        };
        reader.readAsDataURL(file);
      };
      input.click();
    } else {
      try {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert("Permission Required", "Gallery permission is required to upload images.");
          return;
        }
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 0.88,
          base64: true,
        });
        if (!result.canceled && result.assets && result.assets.length > 0) {
          const asset = result.assets[0];
          const dataUrl = asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri;
          setFileDataUrl(dataUrl);
          setFileName(asset.fileName || "uploaded_image.jpg");
          setMimeType("image/jpeg");
          setIsPdf(false);
          setStep("preview");
        }
      } catch (err: any) {
        Alert.alert("Upload Error", err.message || "Could not select image.");
      }
    }
  };

  // Upload PDF Document
  const handleUploadPdf = () => {
    setProcessingError(null);
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = (e: any) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          setProcessingError("PDF size exceeds 10MB limit. Please select a smaller PDF.");
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          setFileDataUrl(reader.result as string);
          setFileName(file.name || "patient_document.pdf");
          setMimeType("application/pdf");
          setIsPdf(true);
          setStep("preview");
        };
        reader.readAsDataURL(file);
      };
      input.click();
    } else {
      Alert.alert("PDF Upload", "PDF upload is currently supported via web browser. Please upload a photo/image on mobile.");
    }
  };

  // Send to Backend OCR API
  const processDocument = async () => {
    if (!fileDataUrl) return;
    setStep("processing");
    setProcessingError(null);
    setProcessingStatus("Sending document to Groq AI extraction pipeline...");

    try {
      const payload = {
        file_data: fileDataUrl,
        mime_type: mimeType,
        file_name: fileName,
      };

      const res = await api.post("/receptionist/ocr/extract", payload, {
        timeoutMs: 35000,
      });

      if (!res || !res.success) {
        throw new Error(res?.error || "Document processing failed. Please check legibility and retry.");
      }

      const ext = res.extracted_data || {};
      const model = res.ocr_model || res.model_used || "groq/qwen3.8-27b";
      setOcrModel(model);
      setExtractedFieldsList(res.extracted_fields || []);
      setMissingFieldsList(res.missing_fields || []);

      const nameVal = res.patient_name || ext.full_name?.value || "";
      const phoneVal = res.phone_number || ext.mobile_number?.value || "";
      const ageVal = res.age || (ext.age?.value ? String(ext.age.value) : "");
      const addrVal = res.address || ext.address?.value || "";

      // Populate review form state
      setFullName({
        value: nameVal,
        confidence: res.confidence?.patient_name ?? ext.full_name?.confidence ?? 0.8,
        uncertain: ext.full_name?.uncertain ?? false,
      });

      setMobileNumber({
        value: phoneVal,
        confidence: res.confidence?.phone_number ?? ext.mobile_number?.confidence ?? 0.8,
        uncertain: ext.mobile_number?.uncertain ?? false,
      });

      setDateOfBirth({
        value: ext.date_of_birth?.value || "",
        confidence: ext.date_of_birth?.confidence ?? 0.8,
        uncertain: ext.date_of_birth?.uncertain ?? false,
      });

      setAge({
        value: ageVal,
        confidence: res.confidence?.age ?? ext.age?.confidence ?? 0.8,
        uncertain: ext.age?.uncertain ?? false,
      });

      setGender(ext.gender?.value || null);

      setAddress({
        value: addrVal,
        confidence: res.confidence?.address ?? ext.address?.confidence ?? 0.8,
        uncertain: ext.address?.uncertain ?? false,
      });

      setCity({
        value: ext.city?.value || "",
        confidence: ext.city?.confidence ?? 0.8,
        uncertain: ext.city?.uncertain ?? false,
      });

      setState({
        value: ext.state?.value || "",
        confidence: ext.state?.confidence ?? 0.8,
        uncertain: ext.state?.uncertain ?? false,
      });

      setPostalCode({
        value: ext.postal_code?.value || "",
        confidence: ext.postal_code?.confidence ?? 0.8,
        uncertain: ext.postal_code?.uncertain ?? false,
      });

      setDocType(ext.document_type?.value || "Document");
      setDocIdNumber(ext.document_id_number?.value || "");
      setWarnings(res.warnings || []);

      setStep("review");
    } catch (err: any) {
      const msg = err.message || "Failed to extract information from document. Please retry or fill manually.";
      setProcessingError(msg);
      setStep("preview");
    }
  };

  // Confirm and Fill Parent Form
  const handleConfirmAndFill = () => {
    // Combine street, city, state, postal code if address is partial
    let fullAddr = address.value.trim();
    const parts = [city.value.trim(), state.value.trim(), postalCode.value.trim()].filter(Boolean);
    if (parts.length > 0 && !fullAddr.includes(parts[0])) {
      fullAddr = fullAddr ? `${fullAddr}, ${parts.join(", ")}` : parts.join(", ");
    }

    onConfirmFill({
      fullName: fullName.value.trim(),
      mobile: mobileNumber.value.trim(),
      age: age.value.trim(),
      gender: gender,
      address: fullAddr,
      city: city.value.trim(),
      state: state.value.trim(),
      postalCode: postalCode.value.trim(),
      dateOfBirth: dateOfBirth.value.trim(),
      documentType: docType,
      documentIdNumber: docIdNumber,
    });

    onClose();
  };

  const getConfidenceBadge = (confidence: number, uncertain: boolean) => {
    if (uncertain || confidence < 0.65) {
      return (
        <View style={[styles.badge, { backgroundColor: "#FEF3C7" }]}>
          <Ionicons name="alert-circle" size={12} color="#D97706" />
          <Text style={[styles.badgeText, { color: "#B45309" }]}>Review</Text>
        </View>
      );
    }
    if (confidence >= 0.85) {
      return (
        <View style={[styles.badge, { backgroundColor: "#ECFDF5" }]}>
          <Ionicons name="checkmark-circle" size={12} color="#059669" />
          <Text style={[styles.badgeText, { color: "#047857" }]}>{Math.round(confidence * 100)}%</Text>
        </View>
      );
    }
    return (
      <View style={[styles.badge, { backgroundColor: "#EFF6FF" }]}>
        <Ionicons name="information-circle" size={12} color="#2563EB" />
        <Text style={[styles.badgeText, { color: "#1D4ED8" }]}>{Math.round(confidence * 100)}%</Text>
      </View>
    );
  };

  return (
    <Modal
      transparent
      visible={visible}
      animationType="slide"
      onRequestClose={() => {
        stopCameraStream();
        onClose();
      }}
    >
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalSheet, { maxHeight: "94%" }]}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={styles.headerIconWrap}>
                <Ionicons name="scan-circle" size={24} color={colors.brandPrimary} />
              </View>
              <View>
                <Text style={styles.headerTitle}>Scan Patient Document</Text>
                <Text style={styles.headerSub}>AI-Powered Demographic Extraction (Groq)</Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                stopCameraStream();
                onClose();
              }}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          {/* Body Content by Step */}
          {step === "select" && (
            <ScrollView contentContainerStyle={styles.contentWrap}>
              {cameraError && (
                <View style={styles.alertBox}>
                  <Ionicons name="alert-circle" size={18} color={colors.error} />
                  <Text style={styles.alertText}>{cameraError}</Text>
                </View>
              )}

              <Text style={styles.sectionHeading}>Choose Document Capture Method</Text>
              <Text style={styles.bodySub}>
                Capture an Aadhaar card, PAN card, Voter ID, Doctor Prescription, or Patient Registration card to automatically extract patient details.
              </Text>

              <View style={styles.actionGrid}>
                {/* 1. Live Camera */}
                <Pressable
                  style={({ pressed }) => [styles.optionCard, pressed && { opacity: 0.8 }]}
                  onPress={() => startCamera("environment")}
                >
                  <View style={[styles.optionIconCircle, { backgroundColor: "#E0F2FE" }]}>
                    <Ionicons name="camera" size={28} color={colors.brandPrimary} />
                  </View>
                  <Text style={styles.optionTitle}>Live Camera</Text>
                  <Text style={styles.optionDesc}>Open live camera to scan document with device camera</Text>
                  <View style={styles.actionPill}>
                    <Text style={styles.actionPillText}>Open Camera</Text>
                  </View>
                </Pressable>

                {/* 2. Upload Image */}
                <Pressable
                  style={({ pressed }) => [styles.optionCard, pressed && { opacity: 0.8 }]}
                  onPress={handleUploadImage}
                >
                  <View style={[styles.optionIconCircle, { backgroundColor: "#DCFCE7" }]}>
                    <Ionicons name="image" size={28} color="#15803D" />
                  </View>
                  <Text style={styles.optionTitle}>Upload Image</Text>
                  <Text style={styles.optionDesc}>Select a photo from disk (JPG, PNG, WebP up to 10MB)</Text>
                  <View style={[styles.actionPill, { backgroundColor: "#15803D" }]}>
                    <Text style={styles.actionPillText}>Browse Photo</Text>
                  </View>
                </Pressable>

                {/* 3. Upload PDF */}
                <Pressable
                  style={({ pressed }) => [styles.optionCard, pressed && { opacity: 0.8 }]}
                  onPress={handleUploadPdf}
                >
                  <View style={[styles.optionIconCircle, { backgroundColor: "#FEE2E2" }]}>
                    <Ionicons name="document-text" size={28} color="#DC2626" />
                  </View>
                  <Text style={styles.optionTitle}>Upload PDF</Text>
                  <Text style={styles.optionDesc}>Select a clinical report, ID, or prescription PDF</Text>
                  <View style={[styles.actionPill, { backgroundColor: "#DC2626" }]}>
                    <Text style={styles.actionPillText}>Browse PDF</Text>
                  </View>
                </Pressable>
              </View>

              <View style={styles.securityNotice}>
                <Ionicons name="shield-checkmark" size={16} color={colors.success} />
                <Text style={styles.securityText}>
                  DPDP & HIPAA Conscious: Documents are processed in-memory for extraction only. Receptionist must verify details before saving.
                </Text>
              </View>
            </ScrollView>
          )}

          {/* Web Live Camera Active */}
          {step === "camera_active" && Platform.OS === "web" && (
            <View style={styles.cameraContainer}>
              <View style={styles.videoWrapper}>
                {/* Embedded HTML5 video tag for Web */}
                <video
                  ref={videoRef as any}
                  style={{
                    width: "100%",
                    height: 380,
                    objectFit: "cover",
                    borderRadius: radius.md,
                    backgroundColor: "#000",
                  }}
                  autoPlay
                  playsInline
                  muted
                />
                <View style={styles.cameraOverlay}>
                  <View style={styles.viewfinderGuide} />
                  <Text style={styles.overlayHint}>Position document inside the frame and capture</Text>
                </View>
              </View>

              <View style={styles.cameraControlsRow}>
                <Pressable
                  onPress={() => {
                    stopCameraStream();
                    setStep("select");
                  }}
                  style={styles.cancelCameraBtn}
                >
                  <Ionicons name="close" size={20} color="#334155" />
                  <Text style={styles.cancelCameraText}>Cancel</Text>
                </Pressable>

                <Pressable onPress={captureWebPhoto} style={styles.captureBtn}>
                  <View style={styles.captureBtnInner} />
                </Pressable>

                <Pressable onPress={toggleCameraFacing} style={styles.flipCameraBtn}>
                  <Ionicons name="camera-reverse" size={22} color="#334155" />
                </Pressable>
              </View>
            </View>
          )}

          {/* Document Preview & Process Action */}
          {step === "preview" && (
            <ScrollView contentContainerStyle={styles.contentWrap}>
              {processingError && (
                <View style={styles.alertBox}>
                  <Ionicons name="alert-circle" size={18} color={colors.error} />
                  <Text style={styles.alertText}>{processingError}</Text>
                </View>
              )}

              <Text style={styles.sectionHeading}>Document Preview</Text>
              <Text style={styles.bodySub}>Ensure document text is readable and well-lit before processing.</Text>

              <View style={styles.previewContainer}>
                {isPdf ? (
                  <View style={styles.pdfPreviewBox}>
                    <Ionicons name="document-text" size={64} color="#DC2626" />
                    <Text style={styles.pdfFileName}>{fileName}</Text>
                    <Text style={styles.pdfBadge}>PDF Document Ready</Text>
                  </View>
                ) : fileDataUrl ? (
                  <Image source={{ uri: fileDataUrl }} style={styles.imagePreview} resizeMode="contain" />
                ) : null}
              </View>

              <View style={styles.previewActionRow}>
                <Pressable
                  style={styles.retakeBtn}
                  onPress={() => {
                    setFileDataUrl(null);
                    setStep("select");
                  }}
                >
                  <Ionicons name="refresh" size={18} color={colors.muted} />
                  <Text style={styles.retakeBtnText}>Retake / Choose Another</Text>
                </Pressable>

                <Pressable style={styles.processBtn} onPress={processDocument}>
                  <Ionicons name="sparkles" size={18} color="#fff" />
                  <Text style={styles.processBtnText}>Extract Details with Groq AI</Text>
                </Pressable>
              </View>
            </ScrollView>
          )}

          {/* Processing Loading Spinner */}
          {step === "processing" && (
            <View style={styles.processingWrap}>
              <ActivityIndicator size="large" color={colors.brandPrimary} />
              <Text style={styles.processingTitle}>Analyzing Document</Text>
              <Text style={styles.processingDesc}>{processingStatus}</Text>
              <View style={styles.modelTag}>
                <Ionicons name="hardware-chip-outline" size={14} color={colors.brandPrimary} />
                <Text style={styles.modelTagText}>Groq Vision Llama-3.2 Sub-Pipeline</Text>
              </View>
            </View>
          )}

          {/* Review & Edit Screen */}
          {step === "review" && (
            <ScrollView contentContainerStyle={styles.contentWrap} keyboardShouldPersistTaps="handled">
              <View style={styles.reviewBanner}>
                <Ionicons name="create-outline" size={20} color={colors.brandPrimary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reviewBannerTitle}>Review & Verify Extracted Fields</Text>
                  <Text style={styles.reviewBannerSub}>
                    Check details against the document. You can edit any field before filling into the patient registration form.
                  </Text>
                </View>
              </View>

              {docType && (
                <View style={styles.detectedDocRow}>
                  <Text style={styles.docTypeLabel}>Detected Document:</Text>
                  <View style={styles.docTypeBadge}>
                    <Text style={styles.docTypeBadgeText}>{docType}</Text>
                  </View>
                  {docIdNumber ? (
                    <Text style={styles.docIdText}>ID: {docIdNumber}</Text>
                  ) : null}
                </View>
              )}

              {/* Multi-Model OCR Engine & Extraction Info Banner */}
              <View style={styles.modelInfoCard}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Ionicons name="hardware-chip-outline" size={16} color={colors.brandPrimary} />
                    <Text style={styles.modelInfoTitle}>
                      Engine: <Text style={{ fontWeight: "700" }}>{ocrModel}</Text>
                    </Text>
                  </View>
                  <View style={styles.statusPillActive}>
                    <Text style={styles.statusPillText}>
                      {extractedFieldsList.length > 0 ? `${extractedFieldsList.length}/4 Fields Found` : "Multi-Model Active"}
                    </Text>
                  </View>
                </View>
                {missingFieldsList.length > 0 && (
                  <View style={styles.missingFieldsRow}>
                    <Ionicons name="information-circle-outline" size={14} color="#D97706" />
                    <Text style={styles.missingFieldsText}>
                      Missing in document: {missingFieldsList.map((f) => f.replace("_", " ")).join(", ")} (can be filled manually or left blank)
                    </Text>
                  </View>
                )}
                <View style={styles.patientMatchNotice}>
                  <Ionicons name="person-circle-outline" size={14} color={colors.brandPrimary} />
                  <Text style={styles.patientMatchNoticeText}>
                    Existing patient verification: If mobile matches a registered patient, their profile will be linked automatically.
                  </Text>
                </View>
              </View>

              {warnings.length > 0 && (
                <View style={styles.warningsList}>
                  {warnings.map((w, idx) => (
                    <View key={idx} style={styles.warningItem}>
                      <Ionicons name="warning" size={14} color="#D97706" />
                      <Text style={styles.warningText}>{w}</Text>
                    </View>
                  ))}
                </View>
              )}

              {/* Form Fields */}
              <View style={styles.fieldGroup}>
                <View style={styles.fieldHeader}>
                  <Text style={styles.fieldLabel}>Patient Full Name*</Text>
                  {getConfidenceBadge(fullName.confidence, fullName.uncertain)}
                </View>
                <TextInput
                  value={fullName.value}
                  onChangeText={(t) => setFullName((prev) => ({ ...prev, value: t }))}
                  placeholder="e.g. Ramesh Kumar"
                  placeholderTextColor={colors.muted}
                  style={[styles.input, fullName.uncertain && styles.inputUncertain]}
                />
              </View>

              <View style={styles.fieldGroup}>
                <View style={styles.fieldHeader}>
                  <Text style={styles.fieldLabel}>Mobile Number (10 digits)</Text>
                  {getConfidenceBadge(mobileNumber.confidence, mobileNumber.uncertain)}
                </View>
                <TextInput
                  value={mobileNumber.value}
                  onChangeText={(t) => setMobileNumber((prev) => ({ ...prev, value: t.replace(/[^0-9]/g, "").slice(0, 10) }))}
                  placeholder="e.g. 9876543210 (or leave blank if none)"
                  placeholderTextColor={colors.muted}
                  keyboardType="phone-pad"
                  style={[styles.input, mobileNumber.uncertain && styles.inputUncertain]}
                />
              </View>

              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <View style={styles.fieldHeader}>
                    <Text style={styles.fieldLabel}>Date of Birth</Text>
                    {getConfidenceBadge(dateOfBirth.confidence, dateOfBirth.uncertain)}
                  </View>
                  <TextInput
                    value={dateOfBirth.value}
                    onChangeText={(t) => setDateOfBirth((prev) => ({ ...prev, value: t }))}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.muted}
                    style={[styles.input, dateOfBirth.uncertain && styles.inputUncertain]}
                  />
                </View>

                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <View style={styles.fieldHeader}>
                    <Text style={styles.fieldLabel}>Age</Text>
                    {getConfidenceBadge(age.confidence, age.uncertain)}
                  </View>
                  <TextInput
                    value={age.value}
                    onChangeText={(t) => setAge((prev) => ({ ...prev, value: t.replace(/[^0-9]/g, "").slice(0, 3) }))}
                    placeholder="e.g. 35"
                    placeholderTextColor={colors.muted}
                    keyboardType="number-pad"
                    style={[styles.input, age.uncertain && styles.inputUncertain]}
                  />
                </View>
              </View>

              {/* Gender selector chips */}
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>Gender</Text>
                <View style={styles.genderRow}>
                  {["Male", "Female", "Other"].map((g) => (
                    <Pressable
                      key={g}
                      onPress={() => setGender(g)}
                      style={[styles.genderChip, gender === g && styles.genderChipActive]}
                    >
                      <Text style={[styles.genderText, gender === g && { color: "#fff", fontWeight: "700" }]}>
                        {g}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <View style={styles.fieldHeader}>
                  <Text style={styles.fieldLabel}>Address / Area</Text>
                  {getConfidenceBadge(address.confidence, address.uncertain)}
                </View>
                <TextInput
                  value={address.value}
                  onChangeText={(t) => setAddress((prev) => ({ ...prev, value: t }))}
                  placeholder="Street / Locality"
                  placeholderTextColor={colors.muted}
                  style={[styles.input, address.uncertain && styles.inputUncertain]}
                />
              </View>

              <View style={{ flexDirection: "row", gap: spacing.sm }}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.fieldLabel}>City</Text>
                  <TextInput
                    value={city.value}
                    onChangeText={(t) => setCity((prev) => ({ ...prev, value: t }))}
                    placeholder="City"
                    placeholderTextColor={colors.muted}
                    style={styles.input}
                  />
                </View>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.fieldLabel}>PIN Code</Text>
                  <TextInput
                    value={postalCode.value}
                    onChangeText={(t) => setPostalCode((prev) => ({ ...prev, value: t.replace(/[^0-9]/g, "").slice(0, 6) }))}
                    placeholder="6-digit PIN"
                    placeholderTextColor={colors.muted}
                    keyboardType="number-pad"
                    style={styles.input}
                  />
                </View>
              </View>

              {/* Action Buttons */}
              <View style={styles.reviewActionContainer}>
                <Pressable
                  style={styles.confirmFillBtn}
                  onPress={handleConfirmAndFill}
                >
                  <Ionicons name="checkmark-done" size={20} color="#fff" />
                  <Text style={styles.confirmFillText}>Confirm & Fill Patient Form</Text>
                </Pressable>

                <Pressable
                  style={styles.discardBtn}
                  onPress={() => {
                    setStep("select");
                    setFileDataUrl(null);
                  }}
                >
                  <Ionicons name="arrow-back" size={16} color={colors.muted} />
                  <Text style={styles.discardText}>Scan Another Document</Text>
                </Pressable>
              </View>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.65)",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  modalSheet: {
    width: "100%",
    maxWidth: 620,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.brandSecondary,
    justifyContent: "center",
    alignItems: "center",
  },
  headerTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  headerSub: {
    fontSize: font.xs,
    color: colors.muted,
  },
  closeBtn: {
    padding: spacing.xs,
    borderRadius: radius.sm,
  },
  contentWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sectionHeading: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: spacing.xs,
  },
  bodySub: {
    fontSize: font.sm,
    color: colors.muted,
    marginVertical: spacing.xs,
    lineHeight: 18,
  },
  actionGrid: {
    gap: spacing.md,
    marginVertical: spacing.md,
  },
  optionCard: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
  },
  optionIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  optionTitle: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  optionDesc: {
    fontSize: font.xs,
    color: colors.muted,
    textAlign: "center",
    marginVertical: spacing.xs,
  },
  actionPill: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.pill,
    marginTop: spacing.xs,
  },
  actionPillText: {
    color: "#fff",
    fontSize: font.xs,
    fontWeight: "600",
  },
  securityNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#F0FDF4",
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#DCFCE7",
    marginTop: spacing.sm,
  },
  securityText: {
    fontSize: font.xs,
    color: "#166534",
    flex: 1,
    lineHeight: 16,
  },
  cameraContainer: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  videoWrapper: {
    width: "100%",
    position: "relative",
    borderRadius: radius.md,
    overflow: "hidden",
  },
  cameraOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "center",
    pointerEvents: "none",
  },
  viewfinderGuide: {
    width: "82%",
    height: "64%",
    borderWidth: 2,
    borderColor: "rgba(255, 255, 255, 0.8)",
    borderStyle: "dashed",
    borderRadius: radius.sm,
  },
  overlayHint: {
    color: "#fff",
    fontSize: font.xs,
    fontWeight: "600",
    backgroundColor: "rgba(0, 0, 0, 0.6)",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    marginTop: spacing.sm,
  },
  cameraControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    width: "100%",
    marginTop: spacing.md,
  },
  cancelCameraBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: spacing.sm,
  },
  cancelCameraText: {
    fontSize: font.sm,
    color: "#334155",
    fontWeight: "600",
  },
  captureBtn: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brandPrimary,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 4,
    borderColor: "#BAE6FD",
  },
  captureBtnInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#fff",
  },
  flipCameraBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    justifyContent: "center",
    alignItems: "center",
  },
  previewContainer: {
    backgroundColor: "#F8FAFC",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 220,
    maxHeight: 340,
    marginVertical: spacing.sm,
  },
  imagePreview: {
    width: "100%",
    height: 300,
  },
  pdfPreviewBox: {
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  pdfFileName: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: spacing.sm,
  },
  pdfBadge: {
    fontSize: font.xs,
    color: "#DC2626",
    fontWeight: "600",
    marginTop: 4,
  },
  previewActionRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  retakeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  retakeBtnText: {
    fontSize: font.sm,
    color: colors.muted,
    fontWeight: "600",
  },
  processBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: spacing.md,
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
  },
  processBtnText: {
    fontSize: font.sm,
    color: "#fff",
    fontWeight: "700",
  },
  processingWrap: {
    padding: spacing.xxl,
    alignItems: "center",
    justifyContent: "center",
  },
  processingTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: spacing.md,
  },
  processingDesc: {
    fontSize: font.sm,
    color: colors.muted,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  modelTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brandSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    marginTop: spacing.md,
  },
  modelTagText: {
    fontSize: font.xs,
    color: colors.brandPrimary,
    fontWeight: "600",
  },
  reviewBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: "#F0F9FF",
    borderWidth: 1,
    borderColor: "#BAE6FD",
    padding: spacing.sm,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  reviewBannerTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: "#0369A1",
  },
  reviewBannerSub: {
    fontSize: font.xs,
    color: "#0C4A6E",
    marginTop: 2,
    lineHeight: 16,
  },
  detectedDocRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: spacing.sm,
  },
  docTypeLabel: {
    fontSize: font.xs,
    color: colors.muted,
    fontWeight: "600",
  },
  docTypeBadge: {
    backgroundColor: "#E0E7FF",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  docTypeBadgeText: {
    fontSize: font.xs,
    color: "#3730A3",
    fontWeight: "700",
  },
  docIdText: {
    fontSize: font.xs,
    color: colors.muted,
  },
  warningsList: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  warningItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEF3C7",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: 4,
  },
  warningText: {
    fontSize: font.xs,
    color: "#B45309",
    flex: 1,
  },
  fieldGroup: {
    marginBottom: spacing.sm,
  },
  fieldHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  fieldLabel: {
    fontSize: font.xs,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: "700",
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontSize: font.sm,
    color: colors.onSurface,
  },
  inputUncertain: {
    borderColor: "#F59E0B",
    backgroundColor: "#FFFBEB",
  },
  genderRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 4,
  },
  genderChip: {
    flex: 1,
    paddingVertical: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  genderChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  genderText: {
    fontSize: font.sm,
    color: colors.onSurface,
    fontWeight: "500",
  },
  reviewActionContainer: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  confirmFillBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  confirmFillText: {
    color: "#fff",
    fontSize: font.base,
    fontWeight: "700",
  },
  discardBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: spacing.sm,
  },
  discardText: {
    color: colors.muted,
    fontSize: font.sm,
    fontWeight: "600",
  },
  alertBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FEE2E2",
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: spacing.sm,
  },
  alertText: {
    color: colors.error,
    fontSize: font.xs,
    flex: 1,
  },
  modelInfoCard: {
    backgroundColor: "#F0F9FF",
    borderWidth: 1,
    borderColor: "#BAE6FD",
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    gap: 6,
  },
  modelInfoTitle: {
    fontSize: 12,
    color: "#0369A1",
  },
  statusPillActive: {
    backgroundColor: "#E0F2FE",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  statusPillText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#0284C7",
  },
  missingFieldsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFFBEB",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  missingFieldsText: {
    fontSize: 11,
    color: "#B45309",
    flex: 1,
  },
  patientMatchNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 2,
  },
  patientMatchNoticeText: {
    fontSize: 10.5,
    color: colors.muted,
    flex: 1,
  },
});
