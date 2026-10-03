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
  { label: "+60 min", minutes: 60 },
];

const COMMON_REASONS = [
  "Doctor arriving late / डॉक्टर देर से आ रहे हैं",
  "Emergency patient / इमरजेंसी मरीज",
  "Traffic delay / ट्रैफिक में देरी",
  "OPD / Hospital round / ओपीडी राउंड",
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
  const currentExpected =
    sessionData?.expected_start_time ||
    sessionData?.original_start_time ||
    "10:00 AM";

  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setSelectedMinutes(null);
      setCustomTime(currentExpected);
      setReason(sessionData?.delay_reason || "");
      setError(null);
    }
  }, [visible, currentExpected, sessionData]);

  const targetTime = selectedMinutes
    ? addMinutesToTime(currentExpected, selectedMinutes)
    : customTime.trim() || currentExpected;

  const handleShortcutPress = (mins: number) => {
    if (selectedMinutes === mins) {
      setSelectedMinutes(null);
      setCustomTime(currentExpected);
    } else {
      setSelectedMinutes(mins);
      setCustomTime(addMinutesToTime(currentExpected, mins));
    }
  };

  const handleSave = async () => {
    setError(null);
    if (!targetTime) {
      setError("Please select or enter an expected start time");
      return;
    }

    setLoading(true);
    try {
      const payload: any = {
        date: sessionData?.date,
        expected_version: sessionData?.version,
        reason: reason.trim() || undefined,
      };

      payload.new_start_time = targetTime;
      if (selectedMinutes) {
        payload.delay_minutes = selectedMinutes;
      }

      const res = await api.post(`/doctor/${doctorId}/session/adjust-timing`, payload);
      onSuccess(res.session);
      onClose();
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
              <Text style={styles.title}>Adjust Doctor Timing</Text>
              <Text style={styles.subtitle}>
                {doctorName} · {sessionData?.date || "Today"}
              </Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* Current Baseline Card */}
            <View style={styles.baselineCard}>
              <View style={styles.baselineCol}>
                <Text style={styles.baselineLabel}>Original Start</Text>
                <Text style={styles.baselineValue}>
                  {sessionData?.original_start_time || "10:00 AM"}
                </Text>
              </View>
              <Ionicons name="arrow-forward" size={18} color={colors.muted} />
              <View style={styles.baselineCol}>
                <Text style={styles.baselineLabel}>Current Expected</Text>
                <Text style={[styles.baselineValue, { color: colors.brandPrimary }]}>
                  {currentExpected}
                </Text>
              </View>
              <View style={styles.statusPill}>
                <Text style={styles.statusText}>
                  {(sessionData?.status || "not_started").replace("_", " ").toUpperCase()}
                </Text>
              </View>
            </View>

            {/* Quick Delay Shortcuts */}
            <Text style={styles.sectionTitle}>Add Delay Shortcut</Text>
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
                      size={16}
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

            {/* Or Specific New Start Time */}
            <Text style={styles.sectionTitle}>Or Specific Expected Start Time</Text>
            <TextInput
              style={styles.input}
              value={customTime}
              onChangeText={(text) => {
                setSelectedMinutes(null);
                setCustomTime(text);
              }}
              placeholder="e.g. 11:00 AM or 11:30"
              placeholderTextColor={colors.muted}
            />

            {/* Delay Reason */}
            <Text style={styles.sectionTitle}>Reason for Delay (Optional)</Text>
            <View style={styles.reasonsList}>
              {COMMON_REASONS.map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setReason(r)}
                  style={[
                    styles.reasonChip,
                    reason === r && styles.reasonChipActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.reasonText,
                      reason === r && { color: colors.brandPrimary, fontWeight: "600" },
                    ]}
                    numberOfLines={1}
                  >
                    {r}
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={[styles.input, { marginTop: spacing.xs }]}
              value={reason}
              onChangeText={setReason}
              placeholder="Custom reason (e.g. Doctor in emergency surgery)"
              placeholderTextColor={colors.muted}
            />

            {/* Impact Preview Banner */}
            <View style={styles.impactCard}>
              <View style={styles.impactHeader}>
                <Ionicons name="people" size={18} color="#D97706" />
                <Text style={styles.impactTitle}>Patient Impact Preview</Text>
              </View>
              <Text style={styles.impactText}>
                New expected start time:{" "}
                <Text style={{ fontWeight: "700", color: "#92400E" }}>{targetTime}</Text>
              </Text>
              <Text style={styles.impactSub}>
                • {affectedCount} waiting patient(s) will automatically receive recalculated
                queue turn estimates.
              </Text>
              <Text style={styles.impactSub}>
                • Live Web Push notifications will be dispatched to their devices with
                updated times.
              </Text>
            </View>

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={18} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </ScrollView>

          {/* Action Buttons */}
          <View style={styles.footer}>
            <Pressable
              onPress={onClose}
              disabled={loading}
              style={[styles.btn, styles.cancelBtn]}
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={loading}
              style={[styles.btn, styles.saveBtn]}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={18} color="#fff" />
                  <Text style={styles.saveBtnText}>Save & Notify Patients</Text>
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
    maxWidth: 520,
    maxHeight: "90%",
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
    fontWeight: "600",
    color: colors.onSurface,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  shortcutsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  shortcutChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
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
    fontSize: font.sm,
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
  reasonsList: {
    gap: 6,
    marginBottom: spacing.xs,
  },
  reasonChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: "transparent",
  },
  reasonChipActive: {
    borderColor: colors.brandPrimary,
    backgroundColor: "#EEF2FF",
  },
  reasonText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
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
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FEE2E2",
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  errorText: {
    fontSize: font.xs,
    color: colors.error,
    flex: 1,
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
