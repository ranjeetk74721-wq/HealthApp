import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  Modal,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";
import { api } from "@/src/api/client";

interface DoctorSessionPauseModalProps {
  visible: boolean;
  doctorId: string;
  doctorName: string;
  isPaused: boolean;
  onClose: () => void;
  onSuccess: (updatedSession: any) => void;
}

const RESUME_SHORTCUTS = [
  { label: "+15 min", minutes: 15 },
  { label: "+30 min", minutes: 30 },
  { label: "+45 min", minutes: 45 },
];

function addMinutesToCurrentTime(minutes: number): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() + minutes);
  let hr = d.getHours();
  const min = d.getMinutes();
  const meridiem = hr >= 12 ? "PM" : "AM";
  hr = hr % 12;
  if (hr === 0) hr = 12;
  const minPad = min < 10 ? `0${min}` : `${min}`;
  return `${hr}:${minPad} ${meridiem}`;
}

export default function DoctorSessionPauseModal({
  visible,
  doctorId,
  doctorName,
  isPaused,
  onClose,
  onSuccess,
}: DoctorSessionPauseModalProps) {
  const [selectedMinutes, setSelectedMinutes] = useState<number | null>(30);
  const [resumeTime, setResumeTime] = useState("");
  const [reason, setReason] = useState("Doctor on short break");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setSelectedMinutes(30);
      setResumeTime(addMinutesToCurrentTime(30));
      setReason("Doctor on short break");
      setError(null);
    }
  }, [visible]);

  const handleShortcutPress = (mins: number) => {
    setSelectedMinutes(mins);
    setResumeTime(addMinutesToCurrentTime(mins));
  };

  const handlePause = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/doctor/${doctorId}/session/pause`, {
        expected_resume_time: resumeTime.trim() || undefined,
        pause_reason: reason.trim() || undefined,
      });
      onSuccess(res.session);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to pause consultation");
    } finally {
      setLoading(false);
    }
  };

  const handleResume = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/doctor/${doctorId}/session/resume`, {});
      onSuccess(res.session);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to resume consultation");
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
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>
                {isPaused ? "Resume Consultation" : "Pause Consultation"}
              </Text>
              <Text style={styles.subtitle}>{doctorName}</Text>
            </View>
            <Pressable onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={colors.onSurfaceSecondary} />
            </Pressable>
          </View>

          {isPaused ? (
            <View style={{ marginVertical: spacing.md }}>
              <View style={styles.infoBanner}>
                <Ionicons name="information-circle" size={20} color="#D97706" />
                <Text style={styles.infoBannerText}>
                  Consultation is currently paused. Resuming will restore the active live queue
                  and notify waiting patients.
                </Text>
              </View>
              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : null}
              <View style={styles.footer}>
                <Pressable onPress={onClose} style={[styles.btn, styles.cancelBtn]}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handleResume}
                  disabled={loading}
                  style={[styles.btn, { backgroundColor: colors.success }]}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="play" size={18} color="#fff" />
                      <Text style={styles.saveBtnText}>Resume Queue</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={{ marginVertical: spacing.xs }}>
              <Text style={styles.sectionTitle}>Expected Resume Time</Text>
              <View style={styles.shortcutsRow}>
                {RESUME_SHORTCUTS.map((s) => {
                  const active = selectedMinutes === s.minutes;
                  return (
                    <Pressable
                      key={s.minutes}
                      onPress={() => handleShortcutPress(s.minutes)}
                      style={[styles.shortcutChip, active && styles.shortcutChipActive]}
                    >
                      <Text
                        style={[
                          styles.shortcutText,
                          active && { color: "#fff", fontWeight: "700" },
                        ]}
                      >
                        {s.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput
                style={styles.input}
                value={resumeTime}
                onChangeText={(t) => {
                  setSelectedMinutes(null);
                  setResumeTime(t);
                }}
                placeholder="e.g. 1:30 PM"
                placeholderTextColor={colors.muted}
              />

              <Text style={styles.sectionTitle}>Pause Reason (Optional)</Text>
              <TextInput
                style={styles.input}
                value={reason}
                onChangeText={setReason}
                placeholder="e.g. Lunch break, Rounds, Emergency"
                placeholderTextColor={colors.muted}
              />

              {error ? (
                <Text style={styles.errorText}>{error}</Text>
              ) : null}

              <View style={styles.footer}>
                <Pressable onPress={onClose} style={[styles.btn, styles.cancelBtn]}>
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={handlePause}
                  disabled={loading}
                  style={[styles.btn, { backgroundColor: colors.warning }]}
                >
                  {loading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <>
                      <Ionicons name="pause" size={18} color="#fff" />
                      <Text style={styles.saveBtnText}>Pause Consultation</Text>
                    </>
                  )}
                </Pressable>
              </View>
            </View>
          )}
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
    maxWidth: 480,
    padding: spacing.lg,
    ...Platform.select({
      web: { boxShadow: "0 10px 25px rgba(0,0,0,0.2)" },
      default: { elevation: 6 },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
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
    marginBottom: spacing.xs,
  },
  shortcutChip: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.warning,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  shortcutChipActive: {
    backgroundColor: colors.warning,
    borderColor: colors.warning,
  },
  shortcutText: {
    fontSize: font.sm,
    color: "#B45309",
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
    marginBottom: spacing.sm,
  },
  infoBanner: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: "#FEF3C7",
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  infoBannerText: {
    flex: 1,
    fontSize: font.sm,
    color: "#92400E",
    lineHeight: 18,
  },
  errorText: {
    fontSize: font.xs,
    color: colors.error,
    marginBottom: spacing.xs,
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
  saveBtnText: {
    fontSize: font.sm,
    fontWeight: "700",
    color: "#fff",
  },
});
