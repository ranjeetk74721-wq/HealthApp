import React, { useState, useEffect, useCallback, useMemo } from "react";
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

// Format { h, m, meridiem } → "10:30 AM" or "03:00 PM"
function formatTime12(h: number, m: number, meridiem: "AM" | "PM"): string {
  const hPad = h < 10 ? `0${h}` : `${h}`;
  const minPad = m < 10 ? `0${m}` : `${m}`;
  return `${hPad}:${minPad} ${meridiem}`;
}

// Parse user typed time string with optional meridiem.
// Flexible: accepts "03:00 PM", "3:00 PM", "3:00", "03:00", "3", "3:30", "15:00", "10:30 AM".
function parseTimeInput(
  val: string,
  fallbackMeridiem: "AM" | "PM" = "AM"
): {
  h: number;
  m: number;
  meridiem: "AM" | "PM";
  formatted12: string;
  explicitMeridiem?: "AM" | "PM";
} | null {
  if (!val) return null;
  const clean = val.trim().toUpperCase().replace(/\s+/g, " ");
  if (!clean) return null;

  const match = clean.match(/^(\d{1,2})(?::(\d{1,2}))?\s*(AM|PM)?$/);
  if (!match) return null;

  let h = parseInt(match[1], 10);
  const m = match[2] !== undefined ? parseInt(match[2], 10) : 0;
  const explicitMeridiem = match[3] as ("AM" | "PM" | undefined);

  if (m < 0 || m > 59) return null;

  // 24-hr format handling (e.g. 15:00 -> 03:00 PM, 00:30 -> 12:30 AM)
  if (h === 0) {
    return {
      h: 12,
      m,
      meridiem: "AM",
      formatted12: formatTime12(12, m, "AM"),
      explicitMeridiem: "AM",
    };
  }
  if (h > 12 && h < 24) {
    const h12 = h - 12;
    return {
      h: h12,
      m,
      meridiem: "PM",
      formatted12: formatTime12(h12, m, "PM"),
      explicitMeridiem: "PM",
    };
  }

  if (h < 1 || h > 12) return null;

  const meridiem = explicitMeridiem || fallbackMeridiem;
  return {
    h,
    m,
    meridiem,
    formatted12: formatTime12(h, m, meridiem),
    explicitMeridiem,
  };
}

function validateTimeInput(val: string, fallbackMeridiem: "AM" | "PM" = "AM"): string | null {
  if (!val || !val.trim()) return null;
  const parsed = parseTimeInput(val, fallbackMeridiem);
  if (!parsed) return "Enter a valid time: e.g. 03:00 PM or 10:30 AM";
  return null;
}

// Add minutes to a 12-hour time string → new 12-hour string
function addMinutesToTime(timeStr: string, minutes: number): string {
  const parsed = parseTimeInput(timeStr, "AM");
  if (!parsed) return timeStr || "10:00 AM";
  let { h, m, meridiem } = parsed;
  let h24 = (h % 12) + (meridiem === "PM" ? 12 : 0);
  const totalMin = h24 * 60 + m + minutes;
  const newH24 = (Math.floor(totalMin / 60) % 24 + 24) % 24;
  const newMin = (totalMin % 60 + 60) % 60;
  const newMeridiem: "AM" | "PM" = newH24 >= 12 ? "PM" : "AM";
  let newH12 = newH24 % 12;
  if (newH12 === 0) newH12 = 12;
  return formatTime12(newH12, newMin, newMeridiem);
}

// Calculate minute difference between two 12-hour time strings
function getMinuteDifference(startStr: string, endStr: string): number {
  const pStart = parseTimeInput(startStr, "AM");
  const pEnd = parseTimeInput(endStr, "AM");
  if (!pStart || !pEnd) return 0;
  const startMin = (pStart.h % 12 + (pStart.meridiem === "PM" ? 12 : 0)) * 60 + pStart.m;
  const endMin = (pEnd.h % 12 + (pEnd.meridiem === "PM" ? 12 : 0)) * 60 + pEnd.m;
  return endMin - startMin;
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
  // Scheduled Start state (original_start_time)
  const [scheduledStartInput, setScheduledStartInput] = useState("");
  const [scheduledAMPM, setScheduledAMPM] = useState<"AM" | "PM">("AM");
  const [scheduledInputError, setScheduledInputError] = useState<string | null>(null);

  // Expected availability controls
  const [returnTimeUnconfirmed, setReturnTimeUnconfirmed] = useState(false);
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [customTimeAMPM, setCustomTimeAMPM] = useState<"AM" | "PM">("AM");
  const [customTimeError, setCustomTimeError] = useState<string | null>(null);
  // Preserved active delay delta (in minutes) if doctor was already delayed
  const [activeDelayDelta, setActiveDelayDelta] = useState<number>(0);

  // Reason
  const [selectedReasonKey, setSelectedReasonKey] = useState("emergency");
  const [customReasonText, setCustomReasonText] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── Reset on open ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return;
    const origStart = sessionData?.original_start_time || "10:00 AM";
    const currentExp = sessionData?.expected_start_time || origStart;
    const isUnconfirmed = Boolean(sessionData?.return_time_unconfirmed || sessionData?.start_time_unconfirmed);

    // Parse Scheduled Start
    const parsedOrig = parseTimeInput(origStart, "AM");
    setScheduledStartInput(parsedOrig ? formatTime12(parsedOrig.h, parsedOrig.m, parsedOrig.meridiem) : origStart);
    setScheduledAMPM(parsedOrig?.meridiem || "AM");
    setScheduledInputError(null);

    // Compute existing active delay difference
    const diff = getMinuteDifference(origStart, currentExp);
    const existingDelay = diff > 0 ? diff : 0;
    setActiveDelayDelta(existingDelay);

    // Check if current delay matches one of the shortcut buttons
    const matchingShortcut = DELAY_SHORTCUTS.find((s) => s.minutes === existingDelay);
    setSelectedMinutes(matchingShortcut ? matchingShortcut.minutes : null);

    setReturnTimeUnconfirmed(isUnconfirmed);
    const parsedExp = parseTimeInput(currentExp, "AM");
    setCustomTime(isUnconfirmed ? "" : (parsedExp ? formatTime12(parsedExp.h, parsedExp.m, parsedExp.meridiem) : currentExp));
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

  // ── Derived Scheduled Start (purely local, instant) ────────────────────────
  const resolvedScheduledStart = useMemo(() => {
    if (sessionStarted) {
      return sessionData?.original_start_time || "10:00 AM";
    }
    if (scheduledStartInput.trim()) {
      const parsed = parseTimeInput(scheduledStartInput.trim(), scheduledAMPM);
      if (parsed) return parsed.formatted12;
    }
    return sessionData?.original_start_time || "10:00 AM";
  }, [scheduledStartInput, scheduledAMPM, sessionStarted, sessionData]);

  // Baseline for shortcuts: always latest Scheduled Start
  const shortcutBase = resolvedScheduledStart;

  // The final expected time to submit / preview
  const targetExpectedTime = useMemo(() => {
    if (returnTimeUnconfirmed) return null;

    // Shortcut has precedence if actively clicked
    if (selectedMinutes !== null) {
      return addMinutesToTime(shortcutBase, selectedMinutes);
    }

    // Explicit custom time entered by user
    if (customTime.trim()) {
      const parsed = parseTimeInput(customTime.trim(), customTimeAMPM);
      if (parsed) return parsed.formatted12;
    }

    // Preserve active delay delta if one was active previously
    if (activeDelayDelta > 0) {
      return addMinutesToTime(shortcutBase, activeDelayDelta);
    }

    // When no delay active, Current Expected follows Scheduled Start
    return shortcutBase;
  }, [returnTimeUnconfirmed, selectedMinutes, shortcutBase, customTime, customTimeAMPM, activeDelayDelta]);

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleShortcutPress = useCallback((mins: number) => {
    if (selectedMinutes === mins) {
      // Toggle off — clear shortcut, clear active delay, revert Expected to Scheduled Start
      setSelectedMinutes(null);
      setActiveDelayDelta(0);
      setCustomTime(shortcutBase);
      const p = parseTimeInput(shortcutBase, "AM");
      if (p) setCustomTimeAMPM(p.meridiem);
    } else {
      setSelectedMinutes(mins);
      setActiveDelayDelta(mins);
      const computed = addMinutesToTime(shortcutBase, mins);
      setCustomTime(computed);
      const p = parseTimeInput(computed, "AM");
      if (p) setCustomTimeAMPM(p.meridiem);
    }
  }, [selectedMinutes, shortcutBase]);

  const handleCustomTimeChange = (text: string) => {
    // Typing clears shortcut selection and preserved delta
    setSelectedMinutes(null);
    setActiveDelayDelta(0);
    setCustomTime(text);

    // Auto-detect AM/PM typed in text
    const parsed = parseTimeInput(text, customTimeAMPM);
    if (parsed && parsed.explicitMeridiem) {
      setCustomTimeAMPM(parsed.explicitMeridiem);
    }
    setCustomTimeError(validateTimeInput(text, customTimeAMPM));
  };

  const handleScheduledStartChange = (text: string) => {
    setScheduledStartInput(text);
    // Auto-detect AM/PM typed in text
    const parsed = parseTimeInput(text, scheduledAMPM);
    if (parsed && parsed.explicitMeridiem) {
      setScheduledAMPM(parsed.explicitMeridiem);
    }
    setScheduledInputError(validateTimeInput(text, scheduledAMPM));
  };

  const handleScheduledAMPMChange = (period: "AM" | "PM") => {
    setScheduledAMPM(period);
    // If input already has text, revalidate with new period
    if (scheduledStartInput.trim()) {
      const parsed = parseTimeInput(scheduledStartInput.trim(), period);
      if (parsed) {
        setScheduledStartInput(formatTime12(parsed.h, parsed.m, period));
        setScheduledInputError(null);
      }
    }
  };

  const handleCustomAMPMChange = (period: "AM" | "PM") => {
    setCustomTimeAMPM(period);
    setSelectedMinutes(null);
    if (customTime.trim()) {
      const parsed = parseTimeInput(customTime.trim(), period);
      if (parsed) {
        setCustomTime(formatTime12(parsed.h, parsed.m, period));
        setCustomTimeError(null);
      }
    }
  };

  const getResolvedReason = (): string => {
    if (selectedReasonKey === "other") return customReasonText.trim();
    return STANDARD_REASONS.find((r) => r.key === selectedReasonKey)?.label || customReasonText.trim();
  };

  // ── Preview (purely local — 0ms roundtrip) ─────────────────────────────────
  const previewExpected = returnTimeUnconfirmed
    ? "Time Awaited"
    : targetExpectedTime || resolvedScheduledStart;

  const previewReason = getResolvedReason() || "Doctor is delayed";

  const isScheduledChanged =
    !sessionStarted &&
    resolvedScheduledStart !== (sessionData?.original_start_time || "10:00 AM");

  const isDelayActive =
    returnTimeUnconfirmed ||
    (targetExpectedTime && targetExpectedTime !== resolvedScheduledStart) ||
    Boolean(sessionData?.delay_reason);

  // Preview ETAs with rolling 30-min window for first 3 waiting patients
  const previewPatientETAs = useMemo(() => {
    if (returnTimeUnconfirmed || !previewExpected || previewExpected === "Time Awaited") return null;
    const baseForQueue = targetExpectedTime || resolvedScheduledStart;
    return [0, 1, 2].map((i) => {
      const startEta = addMinutesToTime(baseForQueue, i * 5);
      const endEta = addMinutesToTime(startEta, 30);
      return {
        token: i + 1,
        eta: `${startEta} – ${endEta}`,
      };
    });
  }, [returnTimeUnconfirmed, previewExpected, targetExpectedTime, resolvedScheduledStart]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setError(null);
    setSuccessMsg(null);

    // Validate scheduled start if session not started
    if (!sessionStarted && scheduledStartInput.trim()) {
      const err = validateTimeInput(scheduledStartInput.trim(), scheduledAMPM);
      if (err) {
        setScheduledInputError(err);
        return;
      }
    }

    // Validate expected time if not unconfirmed
    if (!returnTimeUnconfirmed && customTime.trim()) {
      const err = validateTimeInput(customTime.trim(), customTimeAMPM);
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

      // Send new_scheduled_start_time if session has not started and value changed
      if (!sessionStarted && isScheduledChanged) {
        payload.new_scheduled_start_time = resolvedScheduledStart;
      }

      if (!returnTimeUnconfirmed) {
        if (selectedMinutes !== null) {
          payload.delay_minutes = selectedMinutes;
        } else if (targetExpectedTime) {
          payload.new_start_time = targetExpectedTime;
        }
      }

      const res = await api.post(`/doctor/${doctorId}/session/adjust-timing`, payload);
      setSuccessMsg(res.message || "Timing updated successfully");
      setTimeout(() => {
        onSuccess(res.session);
        onClose();
      }, 600);
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
            <Pressable
              onPress={() => { if (!loading) onClose(); }}
              style={styles.closeBtn}
              testID="close-timing-modal"
              hitSlop={10}
            >
              <Ionicons name="close" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

            {/* ── Status & Baseline Overview (Always Visible) ── */}
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

            {/* ── Section 1: Scheduled Start Editing ── */}
            <View style={styles.section}>
              <View style={styles.sectionHeaderRow}>
                <Text style={styles.sectionTitle}>Daily Scheduled Start (नियत समय)</Text>
                {sessionStarted && (
                  <View style={styles.lockedBadge}>
                    <Ionicons name="lock-closed" size={12} color={colors.muted} />
                    <Text style={styles.lockedBadgeText}>Locked</Text>
                  </View>
                )}
              </View>

              {!sessionStarted ? (
                <>
                  <Text style={styles.fieldHelpText}>
                    Directly type doctor's start time for today (e.g. 03:00 PM or 10:00).
                  </Text>
                  <View style={styles.timeInputRow}>
                    <TextInput
                      style={[styles.timeInput, scheduledInputError ? styles.inputError : null]}
                      value={scheduledStartInput}
                      onChangeText={handleScheduledStartChange}
                      placeholder="e.g. 03:00 PM"
                      placeholderTextColor={colors.muted}
                      keyboardType="numbers-and-punctuation"
                      testID="scheduled-start-input"
                      autoCorrect={false}
                    />
                    <View style={styles.ampmRow}>
                      {(["AM", "PM"] as const).map((period) => (
                        <Pressable
                          key={period}
                          onPress={() => handleScheduledAMPMChange(period)}
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
                  {scheduledInputError ? (
                    <Text style={styles.fieldError}>{scheduledInputError}</Text>
                  ) : null}

                  <View style={styles.infoNotice}>
                    <Ionicons name="information-circle-outline" size={14} color={colors.brandPrimary} />
                    <Text style={styles.infoNoticeText}>
                      Applies only to this doctor, date, and session. Delay shortcuts and queue estimates recalculate from this new baseline. Recurring doctor schedules and other dates remain untouched.
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.lockedNotice}>
                  <Ionicons name="lock-closed-outline" size={16} color={colors.muted} />
                  <Text style={styles.lockedNoticeText}>
                    Scheduled Start is locked ({origStart}) because consultation has already begun. Remaining queue estimates calculate from actual progress and delay adjustments below.
                  </Text>
                </View>
              )}
            </View>

            {/* ── Section 2: Expected Availability & Delay Shortcuts ── */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Expected Availability (अनुमानित उपलब्धता)</Text>

              {/* Return Time Unconfirmed Checkbox */}
              <Pressable
                testID="toggle-unconfirmed-time"
                onPress={() => {
                  const nextVal = !returnTimeUnconfirmed;
                  setReturnTimeUnconfirmed(nextVal);
                  if (nextVal) {
                    setSelectedMinutes(null);
                  }
                }}
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
                    Select this if doctor return/availability time is uncertain. Patients see a "Time Awaited" notice instead of an inaccurate ETA.
                  </Text>
                </View>
              </Pressable>

              {returnTimeUnconfirmed ? (
                <View style={styles.unconfirmedNotice}>
                  <Ionicons name="time" size={16} color="#D97706" />
                  <Text style={styles.unconfirmedNoticeText}>
                    Patients will see: "Doctor is unavailable — consultation resume time not yet confirmed. Your estimated turn will update once the clinic confirms availability." Specific time controls are disabled.
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
                      const previewTime = addMinutesToTime(shortcutBase, s.minutes);
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

                  {/* Manual Expected Time Entry */}
                  <Text style={styles.fieldLabel}>Or enter specific expected availability time</Text>
                  <View style={styles.timeInputRow}>
                    <TextInput
                      style={[styles.timeInput, customTimeError ? styles.inputError : null, { flex: 1 }]}
                      value={customTime}
                      onChangeText={handleCustomTimeChange}
                      placeholder="e.g. 03:30 PM"
                      placeholderTextColor={colors.muted}
                      keyboardType="numbers-and-punctuation"
                      testID="timing-custom-time-input"
                      autoCorrect={false}
                    />
                    <View style={styles.ampmRow}>
                      {(["AM", "PM"] as const).map((period) => (
                        <Pressable
                          key={period}
                          onPress={() => handleCustomAMPMChange(period)}
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

              {/* Privacy Warning */}
              <View style={styles.privacyNotice}>
                <Ionicons name="shield-checkmark-outline" size={15} color="#047857" />
                <Text style={styles.privacyNoticeText}>
                  ⚠️ Visible to all waiting patients: Do NOT enter another patient's name, disease details, or confidential information.
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
                  numberOfLines={2}
                  testID="custom-reason-input"
                />
              )}
            </View>

            {/* ── Section 4: Patient Screen Preview (Local & Immediate) ── */}
            <View style={styles.impactCard}>
              <View style={styles.impactHeader}>
                <Ionicons name="phone-portrait-outline" size={16} color="#D97706" />
                <Text style={styles.impactTitle}>Patient Screen Preview</Text>
                <Text style={styles.impactSubtitle}>(instant preview — not saved yet)</Text>
              </View>

              {returnTimeUnconfirmed ? (
                <View style={styles.previewBlock}>
                  <View style={[styles.previewBadge, { backgroundColor: "#FFEDD5" }]}>
                    <Text style={[styles.previewBadgeText, { color: "#C2410C" }]}>DELAYED · TIME AWAITED</Text>
                  </View>
                  <Text style={styles.previewMessage}>
                    "Doctor is unavailable — consultation resume time not yet confirmed. Your estimated turn will update once the clinic confirms availability."
                  </Text>
                </View>
              ) : (
                <View style={styles.previewBlock}>
                  <View style={[styles.previewBadge, { backgroundColor: isDelayActive ? "#DBEAFE" : "#DCFCE7" }]}>
                    <Text style={[styles.previewBadgeText, { color: isDelayActive ? "#1D4ED8" : "#166534" }]}>
                      {isDelayActive ? "DELAYED" : "ON SCHEDULE"}
                    </Text>
                  </View>
                  <Text style={styles.previewText}>
                    Expected availability: <Text style={{ fontWeight: "700", color: colors.brandPrimary }}>{previewExpected}</Text>
                  </Text>
                  {isScheduledChanged && (
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
                  <Text style={styles.previewEtaTitle}>Queue estimate preview (5 min/patient, 30 min window):</Text>
                  {previewPatientETAs.map(({ token, eta }) => (
                    <Text key={token} style={styles.previewEtaRow}>
                      Token #{token} → {eta}
                    </Text>
                  ))}
                </View>
              )}

              <Text style={styles.impactSub}>
                • {affectedCount} waiting patient(s) will receive recalculated ETAs via real-time WebSocket update.
              </Text>
              <Text style={styles.impactSub}>
                • Token numbers, booking order, and completed records are preserved.
              </Text>
              <Text style={styles.impactSub}>
                • Changes apply to this doctor, date, and session only.
              </Text>
            </View>

            {/* ── Error Feedback ── */}
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

            {/* ── Success Feedback ── */}
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
                (loading || Boolean(scheduledInputError) || Boolean(customTimeError)) && { opacity: 0.65 },
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
  fieldHelpText: {
    fontSize: font.xs,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  lockedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
  },
  lockedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
  },

  // Baseline card (overview)
  baselineCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.sm,
    borderRadius: radius.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
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
    gap: 8,
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  lockedNoticeText: { fontSize: 11, color: colors.muted, flex: 1, lineHeight: 16 },

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
