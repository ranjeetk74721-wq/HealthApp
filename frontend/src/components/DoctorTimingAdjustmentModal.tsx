import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  Modal,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";
import { api } from "@/src/api/client";

interface DoctorTimingAdjustmentModalProps {
  visible: boolean;
  doctorId: string;
  doctorName: string;
  sessionData: any;
  affectedCount: number;
  onClose: () => void;
  onSuccess: (updatedSession: any) => void;
}

const DELAY_SHORTCUTS = [
  { label: "+15 min", minutes: 15 },
  { label: "+30 min", minutes: 30 },
  { label: "+45 min", minutes: 45 },
  { label: "+60 min", minutes: 60 },
];

const STANDARD_REASONS = [
  { key: "emergency", label: "Doctor attending an emergency / डॉक्टर इमरजेंसी में हैं" },
  { key: "surgery", label: "Doctor in surgery / डॉक्टर सर्जरी में हैं" },
  { key: "running_late", label: "Doctor running late / डॉक्टर देर से आ रहे हैं" },
  { key: "other", label: "Other: enter a custom message / अन्य (कस्टम संदेश)" },
];

function addMinutesToTime(timeStr: string, minutes: number): string {
  if (!timeStr) return "10:00 AM";
  const m = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!m) return timeStr;
  let hr = parseInt(m[1], 10);
  const min = parseInt(m[2] || "0", 10);
  const meridiem = (m[3] || "AM").toUpperCase();

  if (meridiem === "PM" && hr < 12) hr += 12;
  if (meridiem === "AM" && hr === 12) hr = 0;

  const totalMin = hr * 60 + min + minutes;
  const newHr24 = Math.floor(totalMin / 60) % 24;
  const newMin = totalMin % 60;

  const newMeridiem = newHr24 >= 12 ? "PM" : "AM";
  let newHr12 = newHr24 % 12;
  if (newHr12 === 0) newHr12 = 12;

  const minPad = newMin < 10 ? `0${newMin}` : `${newMin}`;
  return `${newHr12}:${minPad} ${newMeridiem}`;
}

export default function DoctorTimingAdjustmentModal({
  visible,
  doctorId,
  doctorName,
  sessionData,
  affectedCount,
  onClose,
  onSuccess,
}: DoctorTimingAdjustmentModalProps) {
  const origStart = sessionData?.original_start_time || "10:00 AM";
  const currentExpected = sessionData?.expected_start_time || origStart;

  const [returnTimeUnconfirmed, setReturnTimeUnconfirmed] = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [selectedReasonKey, setSelectedReasonKey] = useState("emergency");
  const [customReasonText, setCustomReasonText] = useState("");
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setReturnTimeUnconfirmed(Boolean(sessionData?.return_time_unconfirmed));
      setSelectedMinutes(null);
      setCustomTime(sessionData?.expected_start_time || currentExpected);

      const existingReason = sessionData?.delay_reason || "";
      const match = STANDARD_REASONS.find(
        (r) => r.key !== "other" && existingReason.toLowerCase().includes(r.key.replace("_", " "))
      );
      if (match) {
        setSelectedReasonKey(match.key);
        setCustomReasonText("");
      } else if (existingReason) {
        setSelectedReasonKey("other");
        setCustomReasonText(existingReason);
      } else {
        setSelectedReasonKey("emergency");
        setCustomReasonText("");
      }

      setError(null);
      setSuccessMsg(null);
    }
  }, [visible, sessionData, currentExpected]);

  const targetTime = selectedMinutes
    ? addMinutesToTime(origStart, selectedMinutes)
    : customTime.trim() || currentExpected;

  const handleShortcutPress = (mins: number) => {
    if (selectedMinutes === mins) {
      setSelectedMinutes(null);
      setCustomTime(currentExpected);
    } else {
      setSelectedMinutes(mins);
      setCustomTime(addMinutesToTime(origStart, mins));
    }
  };

  const getResolvedReason = () => {
    if (selectedReasonKey === "other") {
      return customReasonText.trim();
    }
    const standard = STANDARD_REASONS.find((r) => r.key === selectedReasonKey);
    return standard?.label || customReasonText.trim();
  };

  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);

    if (!returnTimeUnconfirmed && !targetTime) {
      setError("Please select or enter an expected start time");
      return;
    }

    const finalReason = getResolvedReason();
    if (!finalReason) {
      setError("Please select or enter a delay reason");
      return;
    }

    setLoading(true);
    try {
      const payload: any = {
        date: sessionData?.date,
        expected_version: sessionData?.version,
        reason: finalReason,
        return_time_unconfirmed: returnTimeUnconfirmed,
      };

      if (!returnTimeUnconfirmed) {
        payload.new_start_time = targetTime;
        if (selectedMinutes) {
          payload.delay_minutes = selectedMinutes;
        }
      }

      const res = await api.post(`/doctor/${doctorId}/session/adjust-timing`, payload);
      setSuccessMsg(res.message || "Timing updated successfully");
      setTimeout(() => {
        onSuccess(res.session);
        onClose();
      }, 700);
    } catch (err: any) {
      setError(err?.message || "Failed to adjust doctor timing. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={styles.modalCard}>
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Adjust Consultation Start & Delay</Text>
              <Text style={styles.subtitle}>
                {doctorName} · {sessionData?.date || "Today"}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn} testID="close-timing-modal">
              <Ionicons name="close" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* Scheduled Baseline Card */}
            <View style={styles.baselineCard}>
              <View style={styles.baselineCol}>
                <Text style={styles.baselineLabel}>Scheduled Start</Text>
                <Text style={styles.baselineValue}>{origStart}</Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={colors.muted} />
              <View style={styles.baselineCol}>
                <Text style={styles.baselineLabel}>Current Expected</Text>
                <Text
                  style={[
                    styles.baselineValue,
                    { color: returnTimeUnconfirmed ? colors.warning : colors.brandPrimary },
                  ]}
                >
                  {sessionData?.return_time_unconfirmed
                    ? "Time Awaited"
                    : currentExpected}
                </Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusText}>
                  {(sessionData?.status || "not_started").replace("_", " ").toUpperCase()}
                </Text>
              </View>
            </View>

            {/* Availability Mode Toggle: Known Time vs Return Time Not Confirmed */}
            <Text style={styles.sectionTitle}>Expected Availability in Cabin</Text>
            <Pressable
              testID="toggle-unconfirmed-time"
              onPress={() => setReturnTimeUnconfirmed(!returnTimeUnconfirmed)}
              style={[
                styles.unconfirmedToggle,
                returnTimeUnconfirmed && styles.unconfirmedToggleActive,
              ]}
            >
              <Ionicons
                name={returnTimeUnconfirmed ? "checkbox" : "square-outline"}
                size={20}
                color={returnTimeUnconfirmed ? colors.warning : colors.muted}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.unconfirmedTitle, returnTimeUnconfirmed && { color: "#92400E" }]}>
                  Return time not confirmed / समय अभी तय नहीं है
                </Text>
                <Text style={styles.unconfirmedSub}>
                  Select this if the doctor cannot provide a reliable return time yet.
                </Text>
              </View>
            </Pressable>

            {!returnTimeUnconfirmed ? (
              <View style={{ marginTop: spacing.sm }}>
                {/* Quick Delay Shortcuts */}
                <Text style={styles.fieldLabel}>Add Delay Shortcut (from scheduled start)</Text>
                <View style={styles.shortcutsRow}>
                  {DELAY_SHORTCUTS.map((s) => {
                    const active = selectedMinutes === s.minutes;
                    return (
                      <Pressable
                        key={s.minutes}
                        onPress={() => handleShortcutPress(s.minutes)}
                        style={[styles.shortcutChip, active && styles.shortcutChipActive]}
                      >
                        <Ionicons
                          name="time-outline"
                          size={15}
                          color={active ? colors.onBrandPrimary : colors.brandPrimary}
                        />
                        <Text
                          style={[
                            styles.shortcutText,
                            active && { color: colors.onBrandPrimary, fontWeight: "700" },
                          ]}
                        >
                          {s.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Specific Expected Start Time */}
                <Text style={styles.fieldLabel}>Or Specify Expected Time (12-hour AM/PM format)</Text>
                <TextInput
                  style={styles.input}
                  value={customTime}
                  onChangeText={(text) => {
                    setSelectedMinutes(null);
                    setCustomTime(text);
                  }}
                  placeholder="e.g. 11:30 AM or 02:15 PM"
                  placeholderTextColor={colors.muted}
                  testID="timing-custom-time-input"
                />
              </View>
            ) : (
              <View style={styles.unconfirmedNotice}>
                <Ionicons name="time" size={18} color="#D97706" />
                <Text style={styles.unconfirmedNoticeText}>
                  Patients will be notified: "The consultation resume time is not yet confirmed. Your estimated turn time will update once the clinic confirms availability."
                </Text>
              </View>
            )}

            {/* Patient-Visible Delay Reason */}
            <View style={{ marginTop: spacing.md }}>
              <Text style={styles.sectionTitle}>
                Patient-Visible Delay Reason (मरीजों को दिखने वाला कारण)
              </Text>
              
              {/* Privacy & Medical Info Notice */}
              <View style={styles.privacyNotice}>
                <Ionicons name="shield-checkmark-outline" size={16} color="#047857" />
                <Text style={styles.privacyNoticeText}>
                  ⚠️ Visible to Patients: This reason is displayed publicly on patient screens and live queue tracking. Do NOT include another patient's personal name or confidential medical details.
                </Text>
              </View>

              {/* Standard Reason Options */}
              <View style={styles.reasonsList}>
                {STANDARD_REASONS.map((r) => {
                  const active = selectedReasonKey === r.key;
                  return (
                    <Pressable
                      key={r.key}
                      onPress={() => setSelectedReasonKey(r.key)}
                      style={[styles.reasonOption, active && styles.reasonOptionActive]}
                      testID={`reason-option-${r.key}`}
                    >
                      <Ionicons
                        name={active ? "radio-button-on" : "radio-button-off"}
                        size={18}
                        color={active ? colors.brandPrimary : colors.muted}
                      />
                      <Text
                        style={[
                          styles.reasonOptionText,
                          active && { color: colors.brandPrimary, fontWeight: "600" },
                        ]}
                      >
                        {r.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Custom Reason Text Input (shown always or when other is selected) */}
              {selectedReasonKey === "other" && (
                <TextInput
                  style={[styles.input, { marginTop: spacing.xs }]}
                  value={customReasonText}
                  onChangeText={setCustomReasonText}
                  placeholder="Enter custom patient-visible delay message..."
                  placeholderTextColor={colors.muted}
                  testID="custom-reason-input"
                />
              )}
            </View>

            {/* Impact Preview Card */}
            <View style={styles.impactCard}>
              <View style={styles.impactHeader}>
                <Ionicons name="people" size={18} color="#D97706" />
                <Text style={styles.impactTitle}>Patient Screen Preview</Text>
              </View>
              <Text style={styles.impactText}>
                {returnTimeUnconfirmed
                  ? "Status: Doctor Delayed — Resume Time Awaited"
                  : `Expected Availability: ${targetTime}`}
              </Text>
              <Text style={styles.impactSub}>
                • Reason shown: "{getResolvedReason() || "Doctor is delayed"}"
              </Text>
              <Text style={styles.impactSub}>
                • {affectedCount} waiting patient(s) will automatically receive recalculated queue turn estimates without page reload.
              </Text>
            </View>

            {/* Error Message with Simultaneous Edit / Conflict Handler */}
            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.errorText}>{error}</Text>
                  {error.includes("concurrently") && (
                    <Pressable
                      onPress={() => {
                        onSuccess(sessionData);
                        onClose();
                      }}
                      style={styles.refreshConflictBtn}
                    >
                      <Ionicons name="refresh" size={14} color="#B91C1C" />
                      <Text style={styles.refreshConflictText}>Refresh Latest Session Data</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ) : null}

            {/* Success Message */}
            {successMsg ? (
              <View style={styles.successBox}>
                <Ionicons name="checkmark-circle" size={18} color={colors.success} />
                <Text style={styles.successText}>{successMsg}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Footer Action Buttons */}
          <View style={styles.footer}>
            <Pressable
              onPress={onClose}
              disabled={loading}
              style={[styles.btn, styles.cancelBtn]}
              testID="cancel-timing-btn"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={loading}
              style={[styles.btn, styles.saveBtn, loading && { opacity: 0.8 }]}
              testID="save-timing-btn"
            >
              {loading ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.saveBtnText}>Updating Timing...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Save & Update Patients</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.md,
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    width: "100%",
    maxWidth: 540,
    maxHeight: "92%",
    padding: spacing.lg,
    ...Platform.select({
      web: { boxShadow: "0 10px 25px rgba(0,0,0,0.2)" },
      default: { elevation: 6 },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingBottom: spacing.sm,
  },
  title: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  subtitle: {
    fontSize: font.sm,
    color: colors.onSurfaceSecondary,
    marginTop: 2,
  },
  closeBtn: {
    padding: spacing.xs,
  },
  scroll: {
    marginVertical: spacing.xs,
  },
  baselineCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  baselineCol: {
    alignItems: "flex-start",
  },
  baselineLabel: {
    fontSize: font.xs,
    color: colors.muted,
  },
  baselineValue: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: 2,
  },
  statusPill: {
    backgroundColor: "#E0E7FF",
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  statusText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#4338CA",
  },
  sectionTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  fieldLabel: {
    fontSize: font.xs,
    color: colors.muted,
    marginBottom: 4,
  },
  unconfirmedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  unconfirmedToggleActive: {
    borderColor: "#F59E0B",
    backgroundColor: "#FEF3C7",
  },
  unconfirmedTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
  },
  unconfirmedSub: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  unconfirmedNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    backgroundColor: "#FEF3C7",
    borderColor: "#F59E0B",
    borderWidth: 1,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  unconfirmedNoticeText: {
    fontSize: font.xs,
    color: "#92400E",
    flex: 1,
    lineHeight: 16,
  },
  shortcutsRow: {
    flexDirection: "row",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  shortcutChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.brandPrimary,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  shortcutChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  shortcutText: {
    fontSize: font.xs,
    color: colors.brandPrimary,
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.base,
    color: colors.onSurface,
    backgroundColor: colors.surfaceSecondary,
    marginBottom: spacing.xs,
  },
  privacyNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
    borderWidth: 1,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: spacing.xs,
  },
  privacyNoticeText: {
    fontSize: 11,
    color: "#065F46",
    flex: 1,
    lineHeight: 15,
    fontWeight: "500",
  },
  reasonsList: {
    gap: 6,
    marginBottom: spacing.xs,
  },
  reasonOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: "transparent",
  },
  reasonOptionActive: {
    borderColor: colors.brandPrimary,
    backgroundColor: "#EEF2FF",
  },
  reasonOptionText: {
    fontSize: font.xs,
    color: colors.onSurface,
    flex: 1,
  },
  impactCard: {
    backgroundColor: "#FEF3C7",
    borderColor: "#F59E0B",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  impactHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  impactTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: "#92400E",
  },
  impactText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: "#78350F",
    marginBottom: 4,
  },
  impactSub: {
    fontSize: font.xs,
    color: "#92400E",
    marginTop: 2,
    lineHeight: 16,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: "#FEE2E2",
    borderColor: "#FECACA",
    borderWidth: 1,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  errorText: {
    fontSize: font.xs,
    color: colors.error,
    fontWeight: "600",
  },
  refreshConflictBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 6,
  },
  refreshConflictText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: "#B91C1C",
    textDecorationLine: "underline",
  },
  successBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#DCFCE7",
    borderColor: "#86EFAC",
    borderWidth: 1,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  successText: {
    fontSize: font.xs,
    color: "#166534",
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
  },
  cancelBtn: {
    backgroundColor: colors.surfaceSecondary,
  },
  cancelBtnText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
  },
  saveBtn: {
    backgroundColor: colors.brandPrimary,
  },
  saveBtnText: {
    fontSize: font.sm,
    fontWeight: "700",
    color: "#fff",
  },
});
