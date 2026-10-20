import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

interface PatientDetailsModalProps {
  visible: boolean;
  appointment: any | null;
  onClose: () => void;
  onUpdated?: (updatedAppt: any) => void;
}

export default function PatientDetailsModal({
  visible,
  appointment,
  onClose,
  onUpdated,
}: PatientDetailsModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [loadingFresh, setLoadingFresh] = useState(false);

  // Status correction states
  const [isCorrectingStatus, setIsCorrectingStatus] = useState(false);
  const [targetStatus, setTargetStatus] = useState("arrived");
  const [correctionReason, setCorrectionReason] = useState("");
  const [statusUpdating, setStatusUpdating] = useState(false);

  // Form states
  const [name, setName] = useState("");
  const [mobile, setMobile] = useState("");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("pending");
  const [paymentMethod, setPaymentMethod] = useState("pay_at_clinic");

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [sendingSms, setSendingSms] = useState(false);

  // Current active details object
  const [details, setDetails] = useState<any | null>(null);


  useEffect(() => {
    if (appointment && visible) {
      setDetails(appointment);
      setIsEditing(false);
      setErrorMsg(null);
      setSuccessMsg(null);

      // Pre-fill form from passed appointment
      setName(appointment.patient_name || "");
      setMobile(appointment.patient_mobile || "");
      setAddress(appointment.patient_address || "");
      setAmount(
        appointment.payment_amount !== undefined && appointment.payment_amount !== null
          ? String(appointment.payment_amount)
          : ""
      );
      setPaymentStatus((appointment.payment_status || "pending").toLowerCase());
      setPaymentMethod((appointment.payment_method || "pay_at_clinic").toLowerCase());

      // Fetch fresh details from backend
      setLoadingFresh(true);
      api
        .get(`/appointments/${appointment.id}/patient-details`, { bypassCache: true })
        .then((res) => {
          if (res) {
            setDetails(res);
            setName(res.patient_name || "");
            setMobile(res.patient_mobile || "");
            setAddress(res.patient_address || "");
            setAmount(
              res.payment_amount !== undefined && res.payment_amount !== null
                ? String(res.payment_amount)
                : ""
            );
            setPaymentStatus((res.payment_status || "pending").toLowerCase());
            setPaymentMethod((res.payment_method || "pay_at_clinic").toLowerCase());
          }
        })
        .catch(() => {
          // If fresh fetch fails, fallback to passed appointment
        })
        .finally(() => {
          setLoadingFresh(false);
        });
    }
  }, [appointment, visible]);

  if (!visible || !appointment) return null;

  const currentData = details || appointment;

  const handleStartEdit = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setName(currentData.patient_name || "");
    setMobile(currentData.patient_mobile || "");
    setAddress(currentData.patient_address || "");
    setAmount(
      currentData.payment_amount !== undefined && currentData.payment_amount !== null
        ? String(currentData.payment_amount)
        : ""
    );
    setPaymentStatus((currentData.payment_status || "pending").toLowerCase());
    setPaymentMethod((currentData.payment_method || "pay_at_clinic").toLowerCase());
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsEditing(false);
  };

  const handleSave = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length < 2) {
      setErrorMsg("Please enter a valid patient name (at least 2 characters).");
      return;
    }

    const cleanMobile = mobile.trim() ? mobile.replace(/[^0-9]/g, "") : null;
    if (mobile.trim() && (!cleanMobile || cleanMobile.length < 10)) {
      setErrorMsg("Please enter a valid 10-digit contact number.");
      return;
    }

    let parsedAmount: number | null = null;
    if (amount.trim()) {
      const num = parseFloat(amount.trim());
      if (isNaN(num) || num < 0) {
        setErrorMsg("Payment amount must be a valid non-negative number.");
        return;
      }
      parsedAmount = num;
    }

    setSaving(true);
    try {
      const payload: any = {
        patient_name: trimmedName,
        patient_mobile: cleanMobile,
        patient_address: address.trim() || null,
        payment_amount: parsedAmount,
        payment_status: paymentStatus,
        payment_method: paymentMethod,
      };

      const res = await api.put(`/appointments/${currentData.id}/patient-details`, payload);
      const updatedAppt = (res && res.appointment) || {
        ...currentData,
        ...payload,
      };

      setDetails(updatedAppt);
      setSuccessMsg("Patient details updated successfully!");
      if (onUpdated) {
        onUpdated(updatedAppt);
      }

      // Automatically switch back to view mode after short delay to show success
      setTimeout(() => {
        setIsEditing(false);
      }, 700);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to update patient details.");
    } finally {
      setSaving(false);
    }
  };

  const handleSendSmsLink = async () => {
    if (!currentData?.id) return;
    if (!currentData.patient_mobile) {
      setErrorMsg("Patient does not have a contact number on file.");
      return;
    }
    setSendingSms(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      await api.post(`/reception/appointments/${currentData.id}/send-link`, {});
      setSuccessMsg("Live tracking SMS sent to patient successfully!");
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to send SMS tracking link.");
    } finally {
      setSendingSms(false);
    }
  };

  const handleCorrectStatus = async (overrideStatus?: string) => {
    const desired = overrideStatus || targetStatus;
    if (!desired) return;
    const current = currentData.status || "booked";
    if (desired === current) {
      setErrorMsg(`Patient is already in '${desired.replace("_", " ")}' status.`);
      return;
    }

    const doCorrection = async () => {
      setStatusUpdating(true);
      setErrorMsg(null);
      setSuccessMsg(null);
      try {
        const res = await api.post("/reception/correct_status", {
          appointment_id: currentData.id,
          new_status: desired,
          reason: correctionReason.trim() || undefined,
        });

        const updated = res.appointment || {
          ...currentData,
          status: desired === "waiting" ? "arrived" : desired,
        };

        setDetails(updated);
        setSuccessMsg(res.message || "Patient status updated successfully!");
        setIsCorrectingStatus(false);
        setCorrectionReason("");
        if (onUpdated) {
          onUpdated(updated);
        }
      } catch (err: any) {
        setErrorMsg(err.message || "Failed to correct patient status.");
      } finally {
        setStatusUpdating(false);
      }
    };

    const oldLabel = String(current).replace("_", " ").toUpperCase();
    const newLabel = String(desired).replace("_", " ").toUpperCase();
    const promptText = `Change patient Token #${currentData.token_number} (${currentData.patient_name}) from ${oldLabel} to ${newLabel}?`;

    if (Platform.OS === "web") {
      const ok = typeof window !== "undefined" && window.confirm ? window.confirm(`Confirm Status Correction:\n${promptText}`) : true;
      if (ok) {
        await doCorrection();
      }
    } else {
      Alert.alert("Confirm Status Correction", promptText, [
        { text: "Cancel", style: "cancel" },
        { text: "Confirm", onPress: doCorrection },
      ]);
    }
  };

  const STATUS_CHOICES = [
    { id: "arrived", label: "Waiting", desc: "Return to active queue at original token position", icon: "time-outline", color: colors.warning },
    { id: "in_consultation", label: "In Consultation", desc: "Currently inside doctor cabin", icon: "play-circle-outline", color: colors.brandPrimary },
    { id: "completed", label: "Completed", desc: "Consultation finished", icon: "checkmark-done-circle-outline", color: colors.success },
    { id: "skipped", label: "Skipped", desc: "Patient not present when called", icon: "arrow-forward-circle-outline", color: "#B45309" },
    { id: "cancelled", label: "Cancelled", desc: "Cancelled appointment", icon: "close-circle-outline", color: colors.error },
  ];

  const statusColor =
    currentData.status === "completed"
      ? colors.success
      : currentData.status === "in_consultation"
      ? colors.brandPrimary
      : currentData.status === "arrived"
      ? colors.warning
      : currentData.status === "skipped"
      ? "#B45309"
      : currentData.status === "cancelled"
      ? colors.error
      : colors.info;


  const paymentStatusColor =
    (currentData.payment_status || "").toLowerCase() === "paid"
      ? colors.success
      : colors.warning;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={styles.container}
          onPress={(e) => e.stopPropagation()}
        >
          {/* Modal Header */}
          <View style={styles.header}>
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={styles.tokenBadge}>
                <Text style={styles.tokenBadgeText}>
                  #{currentData.token_number || "--"}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle} numberOfLines={1}>
                  {isEditing ? "Edit Patient Details" : currentData.patient_name || "Patient Details"}
                </Text>
                <Text style={styles.headerSub}>
                  {isEditing
                    ? "Update contact & payment information"
                    : `Token #${currentData.token_number} · ${currentData.slot || "Slot"}`}
                </Text>
              </View>
            </View>

            <Pressable
              testID="close-patient-details-modal"
              onPress={onClose}
              style={styles.closeBtn}
            >
              <Ionicons name="close" size={20} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          {loadingFresh ? (
            <View style={{ paddingVertical: 12, alignItems: "center" }}>
              <ActivityIndicator size="small" color={colors.brandPrimary} />
            </View>
          ) : null}

          <ScrollView
            style={styles.scrollArea}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Success Message Banner */}
            {successMsg ? (
              <View style={styles.successBanner}>
                <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                <Text style={styles.successBannerText}>{successMsg}</Text>
              </View>
            ) : null}

            {/* Error Message Banner */}
            {errorMsg ? (
              <View style={styles.errorBanner}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <Text style={styles.errorBannerText}>{errorMsg}</Text>
              </View>
            ) : null}

            {!isEditing ? (
              /* ────────── VIEW MODE ────────── */
              <View style={styles.viewContent}>
                {/* Status and Doctor Banner */}
                <View style={styles.infoBanner}>
                  <View style={styles.infoCol}>
                    <Text style={styles.infoLabel}>Status</Text>
                    <View style={[styles.pill, { backgroundColor: statusColor + "1A" }]}>
                      <Text style={[styles.pillText, { color: statusColor }]}>
                        {String(currentData.status || "booked").replace("_", " ").toUpperCase()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.infoCol}>
                    <Text style={styles.infoLabel}>Doctor</Text>
                    <Text style={styles.infoVal} numberOfLines={1}>
                      {currentData.doctor_name || "Doctor"}
                    </Text>
                  </View>
                  <View style={styles.infoCol}>
                    <Text style={styles.infoLabel}>Date</Text>
                    <Text style={styles.infoVal}>
                      {currentData.date || "--"}
                    </Text>
                  </View>
                </View>

                {/* ── Status Correction & Accidental Skip Recovery Card ── */}
                <View style={styles.card}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Ionicons name="swap-horizontal-outline" size={18} color={colors.brandPrimary} />
                      <Text style={styles.cardTitle}>Queue Status &amp; Correction</Text>
                    </View>
                    <Pressable
                      testID="toggle-correct-status-panel-btn"
                      onPress={() => {
                        setIsCorrectingStatus(!isCorrectingStatus);
                        setTargetStatus(currentData.status === "skipped" ? "arrived" : currentData.status || "arrived");
                      }}
                      style={styles.correctStatusToggleBtn}
                    >
                      <Ionicons name={isCorrectingStatus ? "close" : "create-outline"} size={14} color={colors.brandPrimary} />
                      <Text style={styles.correctStatusToggleText}>
                        {isCorrectingStatus ? "Cancel" : "Correct Status"}
                      </Text>
                    </Pressable>
                  </View>

                  {/* Quick-Recovery Banner for Skipped Patients */}
                  {currentData.status === "skipped" && !isCorrectingStatus && (
                    <View style={styles.skippedRecoveryBox}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.skippedRecoveryTitle}>Accidentally Skipped?</Text>
                        <Text style={styles.skippedRecoverySub}>
                          Restore this patient back to the active Waiting queue with their original Token #{currentData.token_number}.
                        </Text>
                      </View>
                      <Pressable
                        testID="quick-recover-skipped-btn"
                        disabled={statusUpdating}
                        onPress={() => handleCorrectStatus("arrived")}
                        style={styles.quickRecoverBtn}
                      >
                        {statusUpdating ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <>
                            <Ionicons name="refresh-circle-outline" size={16} color="#fff" />
                            <Text style={styles.quickRecoverBtnText}>Restore to Waiting</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  )}

                  {/* Expanded Status Correction Panel */}
                  {isCorrectingStatus && (
                    <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                      <Text style={styles.helperText}>
                        Select the correct status to fix an accidental change. Token #{currentData.token_number} and payment records remain completely intact.
                      </Text>

                      <View style={{ gap: 6, marginTop: 4 }}>
                        {STATUS_CHOICES.map((choice) => {
                          const isSelected = targetStatus === choice.id;
                          const isCurrent = (currentData.status || "booked") === choice.id;
                          return (
                            <Pressable
                              key={choice.id}
                              testID={`status-option-${choice.id}`}
                              onPress={() => setTargetStatus(choice.id)}
                              style={[
                                styles.statusOptionCard,
                                isSelected && { borderColor: choice.color, backgroundColor: choice.color + "12" },
                              ]}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                                <Ionicons name={choice.icon as any} size={18} color={choice.color} />
                                <View style={{ flex: 1 }}>
                                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                    <Text style={[styles.statusOptionLabel, isSelected && { color: choice.color, fontWeight: "700" }]}>
                                      {choice.label}
                                    </Text>
                                    {isCurrent && (
                                      <Text style={styles.currentStatusBadge}>(Current)</Text>
                                    )}
                                  </View>
                                  <Text style={styles.statusOptionDesc}>{choice.desc}</Text>
                                </View>
                              </View>
                              <View
                                style={[
                                  styles.radioCircle,
                                  isSelected && { borderColor: choice.color, backgroundColor: choice.color },
                                ]}
                              >
                                {isSelected && <View style={styles.radioInner} />}
                              </View>
                            </Pressable>
                          );
                        })}
                      </View>

                      <View style={{ marginTop: 6 }}>
                        <Text style={styles.formLabel}>Reason for Correction (Optional)</Text>
                        <TextInput
                          testID="input-correction-reason"
                          value={correctionReason}
                          onChangeText={setCorrectionReason}
                          placeholder="e.g. Patient was present, accidental button tap"
                          placeholderTextColor={colors.muted}
                          style={[styles.textInput, { fontSize: font.sm }]}
                        />
                      </View>

                      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                        <Pressable
                          onPress={() => setIsCorrectingStatus(false)}
                          disabled={statusUpdating}
                          style={[styles.secondaryBtn, { flex: 1, paddingVertical: 10 }]}
                        >
                          <Text style={styles.secondaryBtnText}>Cancel</Text>
                        </Pressable>

                        <Pressable
                          testID="apply-status-correction-btn"
                          disabled={statusUpdating}
                          onPress={() => handleCorrectStatus()}
                          style={[styles.primaryBtn, { flex: 2, paddingVertical: 10 }]}
                        >
                          {statusUpdating ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <Ionicons name="checkmark-circle-outline" size={16} color="#fff" />
                              <Text style={styles.primaryBtnText}>Apply Correction</Text>
                            </>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  )}
                </View>

                {/* Section 1: Patient Information */}
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Ionicons name="person-outline" size={16} color={colors.brandPrimary} />
                    <Text style={styles.cardTitle}>Patient Information</Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Full Name</Text>
                    <Text style={styles.detailValue}>
                      {currentData.patient_name || "Not provided"}
                    </Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Contact Number</Text>
                    <Text style={styles.detailValue}>
                      {currentData.patient_mobile || "Not provided"}
                    </Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Address</Text>
                    <Text style={[styles.detailValue, !currentData.patient_address && styles.notProvided]}>
                      {currentData.patient_address || "Not provided"}
                    </Text>
                  </View>
                </View>

                {/* Section 2: Payment Details */}
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Ionicons name="cash-outline" size={16} color={colors.brandPrimary} />
                    <Text style={styles.cardTitle}>Payment Details</Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Amount</Text>
                    <Text style={[styles.detailValue, { fontWeight: "700" }]}>
                      {currentData.payment_amount !== undefined &&
                      currentData.payment_amount !== null &&
                      currentData.payment_amount !== ""
                        ? `₹${currentData.payment_amount}`
                        : "Not provided"}
                    </Text>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Payment Status</Text>
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      {currentData.payment_status ? (
                        <View style={[styles.pill, { backgroundColor: paymentStatusColor + "1A" }]}>
                          <Text style={[styles.pillText, { color: paymentStatusColor }]}>
                            {currentData.payment_status.toUpperCase()}
                          </Text>
                        </View>
                      ) : (
                        <Text style={styles.notProvided}>Not provided</Text>
                      )}
                    </View>
                  </View>

                  <View style={styles.detailRow}>
                    <Text style={styles.detailLabel}>Payment Method</Text>
                    <Text style={styles.detailValue}>
                      {currentData.payment_method
                        ? currentData.payment_method === "pay_at_clinic"
                          ? "Pay at Clinic"
                          : currentData.payment_method.replace("_", " ").toUpperCase()
                        : "Not provided"}
                    </Text>
                  </View>
                </View>

                {/* Section 3: Live Queue SMS Notification */}
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.brandPrimary} />
                    <Text style={styles.cardTitle}>Live Queue SMS Notification</Text>
                  </View>
                  <Text style={styles.helperText}>
                    Send real-time tracking link and estimated turn time to patient&apos;s phone via SMS.
                  </Text>
                  <Pressable
                    testID="patient-details-send-sms-btn"
                    disabled={sendingSms || !currentData.patient_mobile}
                    onPress={handleSendSmsLink}
                    style={[
                      styles.sendSmsBtn,
                      (!currentData.patient_mobile || sendingSms) && { opacity: 0.6 },
                    ]}
                  >
                    {sendingSms ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Ionicons name="paper-plane-outline" size={16} color="#fff" />
                        <Text style={styles.sendSmsBtnText}>
                          {currentData.patient_mobile ? "Send Live Queue Link via SMS" : "Mobile Number Required for SMS"}
                        </Text>
                      </>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              /* ────────── EDIT MODE ────────── */
              <View style={styles.editForm}>
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Patient Full Name *</Text>
                  <TextInput
                    testID="input-patient-name"
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. John Doe"
                    placeholderTextColor={colors.muted}
                    style={styles.textInput}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Contact Number (Optional)</Text>
                  <TextInput
                    testID="input-patient-mobile"
                    value={mobile}
                    onChangeText={(val) => setMobile(val.replace(/[^0-9]/g, "").slice(0, 10))}
                    keyboardType="phone-pad"
                    placeholder="10-digit mobile number (or leave blank)"
                    placeholderTextColor={colors.muted}
                    style={styles.textInput}
                  />
                  <Text style={styles.helperText}>
                    Updates contact records for this patient. Does not change account login credentials.
                  </Text>
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Address</Text>
                  <TextInput
                    testID="input-patient-address"
                    value={address}
                    onChangeText={setAddress}
                    placeholder="Enter street address, locality, city"
                    placeholderTextColor={colors.muted}
                    multiline
                    numberOfLines={3}
                    style={[styles.textInput, styles.multilineInput]}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Payment Amount (₹)</Text>
                  <TextInput
                    testID="input-payment-amount"
                    value={amount}
                    onChangeText={(val) => setAmount(val.replace(/[^0-9.]/g, ""))}
                    keyboardType="numeric"
                    placeholder="e.g. 500"
                    placeholderTextColor={colors.muted}
                    style={styles.textInput}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Payment Status</Text>
                  <View style={styles.segmentRow}>
                    <Pressable
                      testID="status-pending-btn"
                      onPress={() => setPaymentStatus("pending")}
                      style={[
                        styles.segmentBtn,
                        paymentStatus === "pending" && styles.segmentBtnActiveWarning,
                      ]}
                    >
                      <Ionicons
                        name="time-outline"
                        size={15}
                        color={paymentStatus === "pending" ? "#fff" : colors.onSurfaceSecondary}
                      />
                      <Text
                        style={[
                          styles.segmentBtnText,
                          paymentStatus === "pending" && styles.segmentBtnTextActive,
                        ]}
                      >
                        Pending
                      </Text>
                    </Pressable>

                    <Pressable
                      testID="status-paid-btn"
                      onPress={() => setPaymentStatus("paid")}
                      style={[
                        styles.segmentBtn,
                        paymentStatus === "paid" && styles.segmentBtnActiveSuccess,
                      ]}
                    >
                      <Ionicons
                        name="checkmark-circle-outline"
                        size={15}
                        color={paymentStatus === "paid" ? "#fff" : colors.onSurfaceSecondary}
                      />
                      <Text
                        style={[
                          styles.segmentBtnText,
                          paymentStatus === "paid" && styles.segmentBtnTextActive,
                        ]}
                      >
                        Paid
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Payment Method</Text>
                  <View style={styles.segmentRow}>
                    <Pressable
                      testID="method-clinic-btn"
                      onPress={() => setPaymentMethod("pay_at_clinic")}
                      style={[
                        styles.segmentBtn,
                        paymentMethod === "pay_at_clinic" && styles.segmentBtnActivePrimary,
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentBtnText,
                          paymentMethod === "pay_at_clinic" && styles.segmentBtnTextActive,
                        ]}
                      >
                        Pay at Clinic
                      </Text>
                    </Pressable>

                    <Pressable
                      testID="method-online-btn"
                      onPress={() => setPaymentMethod("online")}
                      style={[
                        styles.segmentBtn,
                        paymentMethod === "online" && styles.segmentBtnActivePrimary,
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentBtnText,
                          paymentMethod === "online" && styles.segmentBtnTextActive,
                        ]}
                      >
                        Online
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            )}
          </ScrollView>

          {/* Modal Footer */}
          <View style={styles.footer}>
            {!isEditing ? (
              <Pressable
                testID="edit-patient-details-btn"
                onPress={handleStartEdit}
                style={styles.primaryBtn}
              >
                <Ionicons name="create-outline" size={17} color="#fff" />
                <Text style={styles.primaryBtnText}>Edit Details</Text>
              </Pressable>
            ) : (
              <View style={styles.btnRow}>
                <Pressable
                  testID="cancel-edit-patient-btn"
                  onPress={handleCancelEdit}
                  disabled={saving}
                  style={styles.secondaryBtn}
                >
                  <Text style={styles.secondaryBtnText}>Cancel</Text>
                </Pressable>

                <Pressable
                  testID="save-edit-patient-btn"
                  onPress={handleSave}
                  disabled={saving}
                  style={[styles.primaryBtn, { flex: 1 }, saving && { opacity: 0.7 }]}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-outline" size={17} color="#fff" />
                      <Text style={styles.primaryBtnText}>Save Changes</Text>
                    </>
                  )}
                </Pressable>
              </View>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.md,
  },
  container: {
    width: "100%",
    maxWidth: 500,
    maxHeight: "90%",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 10,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tokenBadge: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.brandSecondary,
    justifyContent: "center",
    alignItems: "center",
  },
  tokenBadgeText: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.brandPrimary,
  },
  headerTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  headerSub: {
    fontSize: font.sm,
    color: colors.muted,
    marginTop: 2,
  },
  closeBtn: {
    padding: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#DCFCE7",
    borderColor: "#86EFAC",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 8,
  },
  successBannerText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: "#166534",
    flex: 1,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FEE2E2",
    borderColor: "#FCA5A5",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 8,
  },
  errorBannerText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: "#991B1B",
    flex: 1,
  },
  viewContent: {
    gap: spacing.md,
  },
  infoBanner: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  infoCol: {
    flex: 1,
  },
  infoLabel: {
    fontSize: font.xs,
    color: colors.muted,
    textTransform: "uppercase",
    fontWeight: "600",
    marginBottom: 4,
  },
  infoVal: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    paddingBottom: spacing.xs,
    marginBottom: 4,
  },
  cardTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.brandPrimary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingVertical: 3,
  },
  detailLabel: {
    fontSize: font.sm,
    color: colors.onSurfaceSecondary,
    width: 120,
  },
  detailValue: {
    flex: 1,
    fontSize: font.sm,
    fontWeight: "500",
    color: colors.onSurface,
    textAlign: "right",
  },
  notProvided: {
    color: colors.muted,
    fontStyle: "italic",
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  pillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  editForm: {
    gap: spacing.md,
  },
  formGroup: {
    gap: 4,
  },
  formLabel: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  textInput: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === "ios" ? 12 : 8,
    fontSize: font.sm,
    color: colors.onSurface,
  },
  multilineInput: {
    minHeight: 64,
    textAlignVertical: "top",
    paddingTop: 8,
  },
  helperText: {
    fontSize: font.xs,
    color: colors.muted,
    marginTop: 2,
  },
  segmentRow: {
    flexDirection: "row",
    gap: 8,
  },
  segmentBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
  },
  segmentBtnActiveWarning: {
    backgroundColor: colors.warning,
    borderColor: colors.warning,
  },
  segmentBtnActiveSuccess: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  segmentBtnActivePrimary: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  segmentBtnText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
  },
  segmentBtnTextActive: {
    color: "#fff",
  },
  footer: {
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  primaryBtnText: {
    color: colors.onBrandPrimary,
    fontSize: font.base,
    fontWeight: "700",
  },
  btnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  secondaryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.md,
    justifyContent: "center",
    alignItems: "center",
  },
  secondaryBtnText: {
    color: colors.onSurfaceSecondary,
    fontSize: font.base,
    fontWeight: "600",
  },
  sendSmsBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  sendSmsBtnText: {
    color: "#fff",
    fontSize: font.sm,
    fontWeight: "700",
  },
  correctStatusToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.md,
    backgroundColor: colors.brandSecondary,
  },
  correctStatusToggleText: {
    fontSize: 12,
    fontWeight: "700",
    color: colors.brandPrimary,
  },
  skippedRecoveryBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: "#FEF3C7",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#FCD34D",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  skippedRecoveryTitle: {
    fontSize: font.sm,
    fontWeight: "800",
    color: "#92400E",
  },
  skippedRecoverySub: {
    fontSize: 11,
    color: "#78350F",
    marginTop: 2,
  },
  quickRecoverBtn: {
    backgroundColor: "#D97706",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  quickRecoverBtnText: {
    color: "#fff",
    fontSize: font.xs,
    fontWeight: "700",
  },
  statusOptionCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  statusOptionLabel: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  currentStatusBadge: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.muted,
  },
  statusOptionDesc: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
  radioCircle: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 8,
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#fff",
  },
});

