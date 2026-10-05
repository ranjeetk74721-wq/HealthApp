import React, { useState, useEffect, useCallback } from "react";
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

// Parse a 12-hour time string like "10:30 AM" → { h: 10, m: 30, meridiem: "AM" } | null
function parseTime12(str: string): { h: number; m: number; meridiem: "AM" | "PM" } | null {
  if (!str) return null;
  const clean = str.trim().toUpperCase();
  const match = clean.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2] || "0", 10);
  const meridiem = match[3] as "AM" | "PM";
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;
  return { h, m, meridiem };
}

// Format { h, m, meridiem } → "10:30 AM"
function formatTime12(h: number, m: number, meridiem: "AM" | "PM"): string {
  const minPad = m < 10 ? `0${m}` : `${m}`;
  return `${h}:${minPad} ${meridiem}`;
}

// Add minutes to a 12-hour time string → new 12-hour string
function addMinutesToTime(timeStr: string, minutes: number): string {
  const parsed = parseTime12(timeStr);
  if (!parsed) return timeStr || "10:00 AM";
  let { h, m, meridiem } = parsed;
  let h24 = h % 12 + (meridiem === "PM" ? 12 : 0);
  const totalMin = h24 * 60 + m + minutes;
  const newH24 = Math.floor(totalMin / 60) % 24;
  const newMin = totalMin % 60;
  const newMeridiem: "AM" | "PM" = newH24 >= 12 ? "PM" : "AM";
  let newH12 = newH24 % 12;
  if (newH12 === 0) newH12 = 12;
  return formatTime12(newH12, newMin, newMeridiem);
}

// Validate a typed time string — returns error message or null
function validateTimeInput(val: string): string | null {
  if (!val.trim()) return null; // empty ok — caller validates required
  const parsed = parseTime12(val);
  if (!parsed) return "Use 12-hour format: e.g. 10:30 AM or 03:00 PM";
  return null;
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
  const sessionStarted = Boolean(sessionData?.actual_start_time);

  // ── State ─────────────────────────────────────────────────────────────────
  // Editable Scheduled Start (updates original_start_time in DB)
  const [editingScheduled, setEditingScheduled] = useState(false);
  const [scheduledStartInput, setScheduledStartInput] = useState("");
  const [scheduledAMPM, setScheduledAMPM] = useState<"AM" | "PM">("AM");
  const [scheduledInputError, setScheduledInputError] = useState<string | null>(null);

  // Expected availability controls
  const [returnTimeUnconfirmed, setReturnTimeUnconfirmed] = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [customTimeAMPM, setCustomTimeAMPM] = useState<"AM" | "PM">("AM");
  const [customTimeError, setCustomTimeError] = useState<string | null>(null);

  // Reason
  const [selectedReasonKey, setSelectedReasonKey] = useState("emergency");
  const [customReasonText, setCustomReasonText] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Derived values (local, no server round-trip) ───────────────────────────
  // Use editingScheduled value if changed, otherwise fall back to session
  const resolvedScheduledStart = (() => {
    if (editingScheduled && scheduledStartInput.trim()) {
      const err = validateTimeInput(scheduledStartInput.trim());
      if (!err) {
        const raw = scheduledStartInput.trim();
        // Ensure correct AM/PM if user didn't type it
        if (!/AM|PM/i.test(raw)) return `${raw} ${scheduledAMPM}`;
        return raw.toUpperCase().replace(/am/i, "AM").replace(/pm/i, "PM");
      }
    }
    return sessionData?.original_start_time || "10:00 AM";
  })();

  // What time the shortcuts calculate FROM — always latest Scheduled Start
  const shortcutBase = resolvedScheduledStart;

  // The final expected time to submit
  const targetExpectedTime = (() => {
    if (returnTimeUnconfirmed) return null;
    if (selectedMinutes !== null) return addMinutesToTime(shortcutBase, selectedMinutes);
    const raw = customTime.trim();
    if (raw) {
      if (!/AM|PM/i.test(raw)) return `${raw} ${customTimeAMPM}`;
      return raw.toUpperCase().replace(/am/i, "AM").replace(/pm/i, "PM");
    }
    return sessionData?.expected_start_time || shortcutBase;
  })();

  // ── Reset on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const origStart = sessionData?.original_start_time || "10:00 AM";
    const currentExp = sessionData?.expected_start_time || origStart;
    const isUnconfirmed = Boolean(sessionData?.return_time_unconfirmed);

    setEditingScheduled(false);
    setScheduledStartInput(origStart);
    // Parse AM/PM from existing value
    const parsedOrig = parseTime12(origStart);
    setScheduledAMPM(parsedOrig?.meridiem || "AM");
    setScheduledInputError(null);

    setReturnTimeUnconfirmed(isUnconfirmed);
    setSelectedMinutes(null);
    setCustomTime(isUnconfirmed ? "" : currentExp);
    const parsedExp = parseTime12(isUnconfirmed ? currentExp : currentExp);
    setCustomTimeAMPM(parsedExp?.meridiem || "AM");
    setCustomTimeError(null);

    // Pre-fill reason
    const existingReason = sessionData?.delay_reason || "";
    const matchedReason = STANDARD_REASONS.find(
      (r) => r.key !== "other" && existingReason.toLowerCase().includes(r.key.replace("_", " "))
    );
    if (matchedReason) {
      setSelectedReasonKey(matchedReason.key);
      setCustomReasonText("");
    } else if (existingReason) {
      setSelectedReasonKey("other");
      setCustomReasonText(existingReason);
    } else {
      setSelectedReasonKey("emergency");
      setCustomReasonText("");
    }

    setLoading(false);
    setSuccessMsg(null);
    setError(null);
  }, [visible, sessionData]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleShortcutPress = useCallback((mins: number) => {
    if (selectedMinutes === mins) {
      // Toggle off — clear shortcut, keep typed value or fall back to current expected
      setSelectedMinutes(null);
      setCustomTime(sessionData?.expected_start_time || resolvedScheduledStart);
    } else {
      setSelectedMinutes(mins);
      const computed = addMinutesToTime(shortcutBase, mins);
      setCustomTime(computed);
      const p = parseTime12(computed);
      if (p) setCustomTimeAMPM(p.meridiem);
    }
  }, [selectedMinutes, shortcutBase, sessionData, resolvedScheduledStart]);

  const handleCustomTimeChange = (text: string) => {
    setSelectedMinutes(null); // typing clears shortcut selection
    setCustomTime(text);
    setCustomTimeError(validateTimeInput(text));
  };

  const handleScheduledStartChange = (text: string) => {
    setScheduledStartInput(text);
    setScheduledInputError(validateTimeInput(text));
    // When scheduled start changes, clear shortcut so preview recalculates
    setSelectedMinutes(null);
  };

  const getResolvedReason = (): string => {
    if (selectedReasonKey === "other") return customReasonText.trim();
    return STANDARD_REASONS.find((r) => r.key === selectedReasonKey)?.label || customReasonText.trim();
  };

  // ── Preview (purely local — no API call) ───────────────────────────────────
  const previewExpected = returnTimeUnconfirmed
    ? "Time Awaited"
    : targetExpectedTime || resolvedScheduledStart;

  const previewReason = getResolvedReason() || "Doctor is delayed";

  // Show preview of queue impact: Scheduled Start changed → all ETAs shift
  const scheduledChanged =
    editingScheduled &&
    scheduledStartInput.trim() &&
    !scheduledInputError &&
    resolvedScheduledStart !== (sessionData?.original_start_time || "10:00 AM");

  // Example 5-min interval preview for first 3 patients
  const previewPatientETAs = (() => {
    if (returnTimeUnconfirmed || !previewExpected || previewExpected === "Time Awaited") return null;
    const base = resolvedScheduledStart;
    const expTime = targetExpectedTime || base;
    // Use whichever is later: scheduled start or expected time
    const baseForQueue = expTime;
    return [0, 1, 2].map((i) => ({
      token: i + 1,
      eta: addMinutesToTime(baseForQueue, i * 5),
    }));
  })();

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);

    // Validate scheduled start if being edited
    if (editingScheduled && scheduledStartInput.trim()) {
      const err = validateTimeInput(scheduledStartInput.trim());
      if (err) {
        setScheduledInputError(err);
        return;
      }
    }

    // Validate expected time if set
    if (!returnTimeUnconfirmed && customTime.trim()) {
      const err = validateTimeInput(customTime.trim());
      if (err) {
        setCustomTimeError(err);
        return;
      }
    }

    if (!returnTimeUnconfirmed && !targetExpectedTime) {
      setError("Please select or enter an expected start time, or use a shortcut.");
      return;
    }

    const finalReason = getResolvedReason();
    if (!finalReason) {
      setError("Please select or enter a delay reason.");
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

      // Editable Scheduled Start — send only if changed and session not yet started
      if (editingScheduled && scheduledStartInput.trim() && !scheduledInputError && !sessionStarted) {
        const raw = scheduledStartInput.trim();
        payload.new_scheduled_start_time = /AM|PM/i.test(raw)
          ? raw.toUpperCase().replace(/am/i, "AM").replace(/pm/i, "PM")
          : `${raw} ${scheduledAMPM}`;
      }

      if (!returnTimeUnconfirmed) {
        // If shortcut selected, send delay_minutes (backend calculates from new scheduled start)
        if (selectedMinutes !== null) {
          payload.delay_minutes = selectedMinutes;
        } else if (customTime.trim()) {
          const raw = customTime.trim();
          payload.new_start_time = /AM|PM/i.test(raw)
            ? raw.toUpperCase().replace(/am/i, "AM").replace(/pm/i, "PM")
            : `${raw} ${customTimeAMPM}`;
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

  // ── Render ─────────────────────────────────────────────────────────────────
  const origStart = sessionData?.original_start_time || "10:00 AM";
  const currentExpected = sessionData?.expected_start_time || origStart;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => { if (!loading) onClose(); }}
    >
      <View style={styles.backdrop}>
        <View style={styles.modalCard}>
          {/* ── Header ── */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Adjust Consultation Start & Delay</Text>
              <Text style={styles.subtitle}>
                {doctorName} · {sessionData?.date || "Today"}
              </Text>
            </View>
            <Pressable onPress={() => { if (!loading) onClose(); }} style={styles.closeBtn} testID="close-timing-modal">
              <Ionicons name="close" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* ── Section 1: Scheduled Start (editable) ── */}
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Scheduled Start</Text>
                {!sessionStarted && (
                  <Pressable
                    onPress={() => setEditingScheduled(!editingScheduled)}
                    style={styles.editToggleBtn}
                    testID="edit-scheduled-start-btn"
                  >
                    <Ionicons
                      name={editingScheduled ? "close-circle-outline" : "create-outline"}
                      size={16}
                      color={colors.brandPrimary}
                    />
                    <Text style={styles.editToggleBtnText}>
                      {editingScheduled ? "Cancel Edit" : "Edit"}
                    </Text>
                  </Pressable>
                )}
              </View>

              {editingScheduled && !sessionStarted ? (
                <View style={styles.timeInputRow}>
                  <TextInput
                    style={[styles.timeInput, scheduledInputError ? styles.inputError : null]}
                    value={scheduledStartInput}
                    onChangeText={handleScheduledStartChange}
                    placeholder="e.g. 10:00"
                    placeholderTextColor={colors.muted}
                    keyboardType="numbers-and-punctuation"
                    testID="scheduled-start-input"
                    autoCorrect={false}
                  />
                  <View style={styles.ampmRow}>
                    {(["AM", "PM"] as const).map((period) => (
                      <Pressable
                        key={period}
                        onPress={() => {
                          setScheduledAMPM(period);
                          setSelectedMinutes(null);
                        }}
                        style={[styles.ampmBtn, scheduledAMPM === period && styles.ampmBtnActive]}
                        testID={`scheduled-ampm-${period}`}
                      >
                        <Text style={[styles.ampmText, scheduledAMPM === period && styles.ampmTextActive]}>
                          {period}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                <View style={styles.baselineCard}>
                  <View style={styles.baselineCol}>
                    <Text style={styles.baselineLabel}>Scheduled Start</Text>
                    <Text style={styles.baselineValue}>{origStart}</Text>
                  </View>
                  <Ionicons name="arrow-forward" size={16} color={colors.muted} />
                  <View style={styles.baselineCol}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                      <Text style={styles.baselineLabel}>Current Expected</Text>
                      {(sessionData?.return_time_unconfirmed || sessionData?.delay_reason) && (
                        <View style={styles.delayedPill}>
                          <Text style={styles.delayedPillText}>
                            {sessionData?.return_time_unconfirmed ? "AWAITED" : "DELAYED"}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[
                      styles.baselineValue,
                      sessionData?.return_time_unconfirmed
                        ? { color: "#D97706" }
                        : sessionData?.delay_reason
                        ? { color: colors.brandPrimary }
                        : {},
                    ]}>
                      {sessionData?.return_time_unconfirmed ? "Time Awaited" : currentExpected}
                    </Text>
                  </View>
                  <View style={[styles.statusPill, {
                    backgroundColor: sessionData?.status === "in_consultation" ? "#D1FAE5" :
                      sessionData?.status === "paused" ? "#FEF3C7" : "#E0E7FF",
                  }]}>
                    <Text style={[styles.statusText, {
                      color: sessionData?.status === "in_consultation" ? "#065F46" :
                        sessionData?.status === "paused" ? "#92400E" : "#4338CA",
                    }]}>
                      {(sessionData?.status || "not_started").replace("_", " ").toUpperCase()}
                    </Text>
                  </View>
                </View>
              )}

              {scheduledInputError && (
                <Text style={styles.fieldError}>{scheduledInputError}</Text>
              )}

              {editingScheduled && !sessionStarted && (
                <View style={styles.infoNotice}>
                  <Ionicons name="information-circle-outline" size={14} color={colors.brandPrimary} />
                  <Text style={styles.infoNoticeText}>
                    Updates the daily Scheduled Start for today only. Queue estimates and delay shortcuts will recalculate from this new baseline. Does not affect recurring schedules or other dates.
                  </Text>
                </View>
              )}

              {sessionStarted && (
                <View style={styles.lockedNotice}>
                  <Ionicons name="lock-closed-outline" size={14} color={colors.muted} />
                  <Text style={styles.lockedNoticeText}>
                    Scheduled Start is locked — consultation has already begun. Use delay shortcuts or enter a specific time below to adjust the Expected time.
                  </Text>
                </View>
              )}
            </View>

            {/* ── Section 2: Return Time Unconfirmed Toggle ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Expected Availability</Text>
              <Pressable
                testID="toggle-unconfirmed-time"
                onPress={() => setReturnTimeUnconfirmed(!returnTimeUnconfirmed)}
                style={[styles.unconfirmedToggle, returnTimeUnconfirmed && styles.unconfirmedToggleActive]}
              >
                <Ionicons
                  name={returnTimeUnconfirmed ? "checkbox" : "square-outline"}
                  size={20}
                  color={returnTimeUnconfirmed ? "#D97706" : colors.muted}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.unconfirmedTitle, returnTimeUnconfirmed && { color: "#92400E" }]}>
                    Return time not confirmed / समय अभी तय नहीं है
                  </Text>
                  <Text style={styles.unconfirmedSub}>
                    Select this if the doctor cannot give a reliable return time yet. Patients will see a "Time Awaited" notice instead of an incorrect ETA.
                  </Text>
                </View>
              </Pressable>

              {returnTimeUnconfirmed ? (
                <View style={styles.unconfirmedNotice}>
                  <Ionicons name="time" size={16} color="#D97706" />
                  <Text style={styles.unconfirmedNoticeText}>
                    Patients will see: "Doctor is unavailable — consultation resume time not yet confirmed. Your estimated turn will update once the clinic confirms availability." Time input and shortcuts are disabled until a confirmed time is provided.
                  </Text>
                </View>
              ) : (
                <View style={{ marginTop: spacing.sm }}>
                  {/* Delay Shortcuts */}
                  <Text style={styles.fieldLabel}>
                    Delay Shortcuts (calculated from Scheduled Start: {resolvedScheduledStart})
                  </Text>
                  <View style={styles.shortcutsRow}>
                    {DELAY_SHORTCUTS.map((s) => {
                      const active = selectedMinutes === s.minutes;
                      const previewTime = addMinutesToTime(resolvedScheduledStart, s.minutes);
                      return (
                        <Pressable
                          key={s.minutes}
                          onPress={() => handleShortcutPress(s.minutes)}
                          style={[styles.shortcutChip, active && styles.shortcutChipActive]}
                          testID={`shortcut-${s.minutes}`}
                        >
                          <Ionicons
                            name="time-outline"
                            size={13}
                            color={active ? "#fff" : colors.brandPrimary}
                          />
                          <Text style={[styles.shortcutText, active && { color: "#fff", fontWeight: "700" }]}>
                            {s.label}
                          </Text>
                          <Text style={[styles.shortcutPreview, active && { color: "rgba(255,255,255,0.85)" }]}>
                            → {previewTime}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  {/* Or manual time entry */}
                  <Text style={styles.fieldLabel}>Or enter a specific expected time</Text>
                  <View style={styles.timeInputRow}>
                    <TextInput
                      style={[styles.timeInput, customTimeError ? styles.inputError : null, { flex: 1 }]}
                      value={customTime}
                      onChangeText={handleCustomTimeChange}
                      placeholder="e.g. 11:30"
                      placeholderTextColor={colors.muted}
                      keyboardType="numbers-and-punctuation"
                      testID="timing-custom-time-input"
                      autoCorrect={false}
                    />
                    <View style={styles.ampmRow}>
                      {(["AM", "PM"] as const).map((period) => (
                        <Pressable
                          key={period}
                          onPress={() => {
                            setCustomTimeAMPM(period);
                            setSelectedMinutes(null);
                            // Update displayed time to reflect new period
                            if (customTime.trim() && !/AM|PM/i.test(customTime)) {
                              // time entered without period — just keep it, period will be appended on save
                            }
                          }}
                          style={[styles.ampmBtn, customTimeAMPM === period && styles.ampmBtnActive]}
                          testID={`expected-ampm-${period}`}
                        >
                          <Text style={[styles.ampmText, customTimeAMPM === period && styles.ampmTextActive]}>
                            {period}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                  {customTimeError ? (
                    <Text style={styles.fieldError}>{customTimeError}</Text>
                  ) : null}
                </View>
              )}
            </View>

            {/* ── Section 3: Delay Reason ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>
                Patient-Visible Delay Reason (मरीजों को दिखने वाला कारण)
              </Text>

              {/* Privacy warning */}
              <View style={styles.privacyNotice}>
                <Ionicons name="shield-checkmark-outline" size={15} color="#047857" />
                <Text style={styles.privacyNoticeText}>
                  ⚠️ Visible to all patients: Do NOT include another patient's name or confidential medical details in this message.
                </Text>
              </View>

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
                      <Text style={[styles.reasonOptionText, active && { color: colors.brandPrimary, fontWeight: "600" }]}>
                        {r.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {selectedReasonKey === "other" && (
                <TextInput
                  style={[styles.input, { marginTop: spacing.xs }]}
                  value={customReasonText}
                  onChangeText={setCustomReasonText}
                  placeholder="Enter custom patient-visible message (keep it general, no patient names)..."
                  placeholderTextColor={colors.muted}
                  multiline
                  testID="custom-reason-input"
                />
              )}
            </View>

            {/* ── Section 4: Patient Screen Preview ── */}
            <View style={styles.impactCard}>
              <View style={styles.impactHeader}>
                <Ionicons name="phone-portrait-outline" size={16} color="#D97706" />
                <Text style={styles.impactTitle}>Patient Screen Preview</Text>
                <Text style={styles.impactSubtitle}>(preview only — not saved yet)</Text>
              </View>

              {returnTimeUnconfirmed ? (
                <View style={styles.previewBlock}>
                  <View style={[styles.previewBadge, { backgroundColor: "#FFEDD5" }]}>
                    <Text style={[styles.previewBadgeText, { color: "#C2410C" }]}>DELAYED · TIME AWAITED</Text>
                  </View>
                  <Text style={styles.previewMessage}>
                    "Doctor is unavailable — consultation resume time not yet confirmed."
                  </Text>
                </View>
              ) : (
                <View style={styles.previewBlock}>
                  <View style={[styles.previewBadge, { backgroundColor: "#DBEAFE" }]}>
                    <Text style={[styles.previewBadgeText, { color: "#1D4ED8" }]}>DELAYED</Text>
                  </View>
                  <Text style={styles.previewText}>
                    Expected availability: <Text style={{ fontWeight: "700", color: colors.brandPrimary }}>{previewExpected}</Text>
                  </Text>
                  {scheduledChanged && (
                    <Text style={[styles.previewText, { color: "#7C3AED", marginTop: 2 }]}>
                      Scheduled Start: <Text style={{ fontWeight: "700" }}>{resolvedScheduledStart}</Text> (updated)
                    </Text>
                  )}
                </View>
              )}

              <Text style={styles.previewReason}>
                Reason shown to patients: <Text style={{ fontWeight: "700" }}>"{previewReason}"</Text>
              </Text>

              {previewPatientETAs && (
                <View style={styles.previewEtas}>
                  <Text style={styles.previewEtaTitle}>Queue estimate preview (5 min/patient):</Text>
                  {previewPatientETAs.map(({ token, eta }) => (
                    <Text key={token} style={styles.previewEtaRow}>
                      Token #{token} → {eta}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={styles.impactSub}>
                • {affectedCount} waiting patient(s) will get recalculated ETAs via live update — no refresh needed.
              </Text>
              <Text style={styles.impactSub}>
                • Completed appointments and actual consultation timestamps are not affected.
              </Text>
              <Text style={styles.impactSub}>
                • Changes apply to this doctor, this date, and this session only.
              </Text>
            </View>

            {/* ── Error ── */}
            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={colors.error} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.errorText}>{error}</Text>
                  {error.includes("concurrently") && (
                    <Pressable
                      onPress={() => { onSuccess(sessionData); onClose(); }}
                      style={styles.refreshConflictBtn}
                    >
                      <Ionicons name="refresh" size={13} color="#B91C1C" />
                      <Text style={styles.refreshConflictText}>Refresh Latest Session Data</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            ) : null}

            {/* ── Success ── */}
            {successMsg ? (
              <View style={styles.successBox}>
                <Ionicons name="checkmark-circle" size={16} color="#166534" />
                <Text style={styles.successText}>{successMsg}</Text>
              </View>
            ) : null}

            <View style={{ height: spacing.md }} />
          </ScrollView>

          {/* ── Footer Buttons ── */}
          <View style={styles.footer}>
            <Pressable
              onPress={() => { if (!loading) onClose(); }}
              disabled={loading}
              style={[styles.btn, styles.cancelBtn]}
              testID="cancel-timing-btn"
            >
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={loading || Boolean(scheduledInputError) || Boolean(customTimeError)}
              style={[
                styles.btn,
                styles.saveBtn,
                (loading || Boolean(scheduledInputError) || Boolean(customTimeError)) && { opacity: 0.7 },
              ]}
              testID="save-timing-btn"
            >
              {loading ? (
                <>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.saveBtnText}>Saving...</Text>
                </>
              ) : (
                <>
                  <Ionicons name="checkmark-circle" size={16} color="#fff" />
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
    maxHeight: "94%",
    padding: spacing.lg,
    ...Platform.select({
      web: { boxShadow: "0 10px 25px rgba(0,0,0,0.2)" },
      default: { elevation: 6 },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingBottom: spacing.sm,
  },
  title: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: 2 },
  closeBtn: { padding: spacing.xs },
  scroll: { marginVertical: spacing.xs },

  // Section
  section: {
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  editToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSecondary,
  },
  editToggleBtnText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: colors.brandPrimary,
  },

  // Baseline card (read-only view)
  baselineCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.sm,
    borderRadius: radius.md,
    gap: spacing.xs,
    flexWrap: "wrap",
  },
  baselineCol: { alignItems: "flex-start", flex: 1, minWidth: 80 },
  baselineLabel: { fontSize: font.xs, color: colors.muted, textTransform: "uppercase" },
  baselineValue: { fontSize: font.sm, fontWeight: "700", color: colors.onSurface, marginTop: 2 },
  delayedPill: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  delayedPillText: { fontSize: 9, fontWeight: "800", color: "#D97706" },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  statusText: { fontSize: 9, fontWeight: "700" },

  // Time input row (input + AM/PM)
  timeInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  timeInput: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.brandPrimary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
    backgroundColor: colors.surface,
    minWidth: 80,
  },
  inputError: {
    borderColor: colors.error,
  },
  ampmRow: {
    flexDirection: "row",
    borderRadius: radius.md,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
  },
  ampmBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSecondary,
  },
  ampmBtnActive: {
    backgroundColor: colors.brandPrimary,
  },
  ampmText: { fontSize: font.sm, fontWeight: "700", color: colors.muted },
  ampmTextActive: { color: "#fff" },

  // Notices
  infoNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: colors.brandSecondary,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  infoNoticeText: { fontSize: 11, color: colors.brandPrimary, flex: 1, lineHeight: 16 },
  lockedNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  lockedNoticeText: { fontSize: 11, color: colors.muted, flex: 1, lineHeight: 16, fontStyle: "italic" },

  // Unconfirmed toggle
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
  unconfirmedTitle: { fontSize: font.sm, fontWeight: "700", color: colors.onSurface },
  unconfirmedSub: { fontSize: 11, color: colors.muted, marginTop: 2, lineHeight: 15 },
  unconfirmedNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.sm,
    backgroundColor: "#FEF3C7",
    borderColor: "#F59E0B",
    borderWidth: 1,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  unconfirmedNoticeText: { fontSize: font.xs, color: "#92400E", flex: 1, lineHeight: 16 },

  // Shortcuts
  fieldLabel: { fontSize: font.xs, color: colors.muted, marginBottom: 6, marginTop: 4 },
  shortcutsRow: { flexDirection: "row", gap: 6, marginBottom: spacing.sm, flexWrap: "wrap" },
  shortcutChip: {
    flex: 1,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderWidth: 1.5,
    borderColor: colors.brandPrimary,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    gap: 2,
  },
  shortcutChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  shortcutText: { fontSize: font.xs, color: colors.brandPrimary, fontWeight: "600" },
  shortcutPreview: { fontSize: 10, color: colors.brandPrimary, fontWeight: "500" },

  // Input
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
  fieldError: {
    fontSize: font.xs,
    color: colors.error,
    marginTop: 2,
    marginBottom: spacing.xs,
    fontWeight: "600",
  },

  // Privacy notice
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
  privacyNoticeText: { fontSize: 11, color: "#065F46", flex: 1, lineHeight: 15, fontWeight: "500" },

  // Reasons
  reasonsList: { gap: 6, marginBottom: spacing.xs },
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
  reasonOptionActive: { borderColor: colors.brandPrimary, backgroundColor: "#EEF2FF" },
  reasonOptionText: { fontSize: font.xs, color: colors.onSurface, flex: 1 },

  // Preview / Impact card
  impactCard: {
    backgroundColor: "#FFFBEB",
    borderColor: "#FDE68A",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.xs,
    gap: 6,
  },
  impactHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  impactTitle: { fontSize: font.sm, fontWeight: "700", color: "#92400E" },
  impactSubtitle: { fontSize: 10, color: "#B45309", fontStyle: "italic" },
  previewBlock: { gap: 4 },
  previewBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    marginBottom: 2,
  },
  previewBadgeText: { fontSize: 10, fontWeight: "800" },
  previewText: { fontSize: font.xs, color: "#78350F" },
  previewMessage: { fontSize: font.xs, color: "#92400E", fontStyle: "italic", lineHeight: 16 },
  previewReason: { fontSize: font.xs, color: "#78350F", marginTop: 2 },
  previewEtas: {
    backgroundColor: "#FEF3C7",
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: 4,
  },
  previewEtaTitle: { fontSize: 10, fontWeight: "700", color: "#92400E", marginBottom: 4 },
  previewEtaRow: { fontSize: 11, color: "#78350F", fontWeight: "600" },
  impactSub: { fontSize: font.xs, color: "#92400E", lineHeight: 16 },

  // Error / success
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
  errorText: { fontSize: font.xs, color: colors.error, fontWeight: "600" },
  refreshConflictBtn: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 },
  refreshConflictText: { fontSize: font.xs, fontWeight: "700", color: "#B91C1C", textDecorationLine: "underline" },
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
  successText: { fontSize: font.xs, color: "#166534", fontWeight: "600" },

  // Footer
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    marginTop: spacing.sm,
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
  cancelBtn: { backgroundColor: colors.surfaceSecondary },
  cancelBtnText: { fontSize: font.sm, fontWeight: "600", color: colors.onSurfaceSecondary },
  saveBtn: { backgroundColor: colors.brandPrimary },
  saveBtnText: { fontSize: font.sm, fontWeight: "700", color: "#fff" },
});
