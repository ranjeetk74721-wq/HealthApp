import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";
import { api } from "@/src/api/client";
import DoctorTimingAdjustmentModal from "./DoctorTimingAdjustmentModal";
import DoctorSessionPauseModal from "./DoctorSessionPauseModal";

interface DoctorSessionBarProps {
  doctorId: string;
  doctorName: string;
  session: any;
  waitingCount: number;
  onRefresh: () => void;
  canEdit?: boolean;
}

export default function DoctorSessionBar({
  doctorId,
  doctorName,
  session,
  waitingCount,
  onRefresh,
  canEdit = true,
}: DoctorSessionBarProps) {
  const [timingModalOpen, setTimingModalOpen] = useState(false);
  const [pauseModalOpen, setPauseModalOpen] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [endingSession, setEndingSession] = useState(false);

  if (!session) return null;

  const status = session.status || "not_started";
  const origStart = session.original_start_time || "10:00 AM";
  const isUnconfirmed = Boolean(session.return_time_unconfirmed);
  const expStart = isUnconfirmed ? "Time Awaited" : (session.expected_start_time || origStart);
  const isDelayed = isUnconfirmed || expStart !== origStart || Boolean(session.delay_reason);
  const actualStart = session.actual_start_time;
  const isPaused = status === "paused";

  const handleStartConsultation = async () => {
    const confirmStart = () => {
      setStartingSession(true);
      api
        .post(`/doctor/${doctorId}/session/start-consultation`, { date: session.date })
        .then(() => onRefresh())
        .catch((err) => {
          Alert.alert("Error", err.message || "Failed to start consultation session");
        })
        .finally(() => setStartingSession(false));
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Start consultation session for ${doctorName} now?`)) {
        confirmStart();
      }
    } else {
      Alert.alert(
        "Start Consultation",
        `Start consultation session for ${doctorName} now?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Start", onPress: confirmStart },
        ]
      );
    }
  };

  const handleEndSession = async () => {
    const confirmEnd = () => {
      setEndingSession(true);
      api
        .post(`/doctor/${doctorId}/session/end`, { date: session.date })
        .then(() => onRefresh())
        .catch((err) => {
          Alert.alert("Error", err.message || "Failed to end doctor session");
        })
        .finally(() => setEndingSession(false));
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Are you sure you want to end today's session for ${doctorName}?`)) {
        confirmEnd();
      }
    } else {
      Alert.alert(
        "End Session",
        `Are you sure you want to end today's session for ${doctorName}?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "End Session", style: "destructive", onPress: confirmEnd },
        ]
      );
    }
  };

  const isBusy = startingSession || endingSession;

  return (
    <View style={styles.container}>
      {/* Top row: Status, Times & Badges */}
      <View style={styles.topRow}>
        <View style={styles.titleWrap}>
          <Text style={styles.sessionTitle}>Doctor Availability & Session Timing</Text>
          <Text style={styles.doctorSub}>{doctorName} · {session.date || "Today"}</Text>
        </View>

        {/* Status Badge */}
        <View
          style={[
            styles.statusBadge,
            status === "in_consultation" || status === "in_progress"
              ? styles.statusInConsult
              : status === "paused"
              ? styles.statusPaused
              : isUnconfirmed
              ? { backgroundColor: "#FFEDD5", borderColor: "#FDBA74" }
              : isDelayed
              ? { backgroundColor: "#FEF3C7", borderColor: "#FCD34D" }
              : status === "completed" || status === "ended"
              ? styles.statusCompleted
              : styles.statusNotStarted,
          ]}
        >
          <Ionicons
            name={
              status === "in_consultation" || status === "in_progress"
                ? "play-circle"
                : status === "paused"
                ? "pause-circle"
                : isUnconfirmed
                ? "alert-circle"
                : isDelayed
                ? "time"
                : status === "completed" || status === "ended"
                ? "checkmark-circle"
                : "time"
            }
            size={14}
            color={
              status === "in_consultation" || status === "in_progress"
                ? "#065F46"
                : status === "paused"
                ? "#92400E"
                : isUnconfirmed
                ? "#C2410C"
                : isDelayed
                ? "#B45309"
                : status === "completed" || status === "ended"
                ? "#475569"
                : "#9A3412"
            }
          />
          <Text
            style={[
              styles.statusBadgeText,
              status === "in_consultation" || status === "in_progress"
                ? { color: "#065F46" }
                : status === "paused"
                ? { color: "#92400E" }
                : isUnconfirmed
                ? { color: "#C2410C" }
                : isDelayed
                ? { color: "#B45309" }
                : status === "completed" || status === "ended"
                ? { color: "#475569" }
                : { color: "#9A3412" },
            ]}
          >
            {status === "in_consultation" || status === "in_progress"
              ? "In Progress"
              : status === "paused"
              ? "Paused"
              : isUnconfirmed
              ? "Delayed (Time Awaited)"
              : isDelayed
              ? "Delayed"
              : status === "completed" || status === "ended"
              ? "Ended"
              : "Not Started"}
          </Text>
        </View>
      </View>

      {/* Timing comparison & info cards */}
      <View style={styles.infoRow}>
        <View style={styles.infoBlock}>
          <Text style={styles.infoLabel}>Scheduled Start</Text>
          <Text style={styles.infoVal}>{origStart}</Text>
        </View>

        <Ionicons name="arrow-forward" size={16} color={colors.muted} />

        <View style={styles.infoBlock}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={styles.infoLabel}>Expected Start</Text>
            {isDelayed && (
              <View style={[styles.delayedPill, isUnconfirmed && { backgroundColor: "#FFEDD5" }]}>
                <Text style={[styles.delayedPillText, isUnconfirmed && { color: "#C2410C" }]}>
                  {isUnconfirmed ? "TIME AWAITED" : "DELAYED"}
                </Text>
              </View>
            )}
          </View>
          <Text
            style={[
              styles.infoVal,
              isDelayed && { color: isUnconfirmed ? "#C2410C" : "#D97706", fontWeight: "800" },
            ]}
          >
            {expStart}
          </Text>
        </View>

        {actualStart ? (
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Actual Start</Text>
            <Text style={[styles.infoVal, { color: colors.success }]}>
              {actualStart}
            </Text>
          </View>
        ) : null}

        {isPaused && session.expected_resume_time ? (
          <View style={styles.infoBlock}>
            <Text style={styles.infoLabel}>Expected Resume</Text>
            <Text style={[styles.infoVal, { color: "#D97706" }]}>
              {session.expected_resume_time}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Patient-Visible Delay / Pause Reason Banner */}
      {isDelayed && session.delay_reason ? (
        <View style={styles.reasonBanner}>
          <Ionicons name="alert-circle-outline" size={16} color="#B45309" />
          <Text style={styles.reasonText}>
            Patient-Visible Reason: <Text style={{ fontWeight: "700" }}>{session.delay_reason}</Text>
          </Text>
        </View>
      ) : null}

      {isPaused && session.pause_reason ? (
        <View style={[styles.reasonBanner, { backgroundColor: "#FEF3C7" }]}>
          <Ionicons name="pause-circle-outline" size={16} color="#D97706" />
          <Text style={[styles.reasonText, { color: "#92400E" }]}>
            Paused: {session.pause_reason}
            {session.expected_resume_time ? ` · Resuming at ${session.expected_resume_time}` : ""}
          </Text>
        </View>
      ) : null}

      {/* Action Buttons: Visible text label below every action icon matching its actual function */}
      {canEdit && status !== "completed" ? (
        <View style={styles.actionsRow}>
          {/* Adjust Doctor Timing Button */}
          <Pressable
            testID="adjust-doctor-timing-btn"
            onPress={() => setTimingModalOpen(true)}
            disabled={isBusy}
            style={[styles.actionColBtn, isBusy && { opacity: 0.6 }]}
          >
            <Ionicons name="time-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.actionColLabel}>Adjust Doctor Timing</Text>
          </Pressable>

          {/* Start Session Button (when not started) */}
          {status === "not_started" && (
            <Pressable
              testID="start-consultation-btn"
              onPress={handleStartConsultation}
              disabled={isBusy}
              style={[styles.actionColBtn, styles.actionColBtnPrimary, isBusy && { opacity: 0.6 }]}
            >
              {startingSession ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="play" size={20} color="#fff" />
                  <Text style={[styles.actionColLabel, { color: "#fff", fontWeight: "700" }]}>
                    Start Session
                  </Text>
                </>
              )}
            </Pressable>
          )}

          {/* Pause / Resume Button (when in progress or paused) */}
          {(status === "in_consultation" || isPaused) && (
            <Pressable
              testID="pause-resume-session-btn"
              onPress={() => setPauseModalOpen(true)}
              disabled={isBusy}
              style={[
                styles.actionColBtn,
                isPaused ? { backgroundColor: "#DCFCE7", borderColor: "#86EFAC" } : {},
                isBusy && { opacity: 0.6 },
              ]}
            >
              <Ionicons
                name={isPaused ? "play" : "pause"}
                size={20}
                color={isPaused ? "#059669" : colors.warning}
              />
              <Text
                style={[
                  styles.actionColLabel,
                  isPaused ? { color: "#059669" } : { color: colors.warning },
                ]}
              >
                {isPaused ? "Resume Session" : "Pause Session"}
              </Text>
            </Pressable>
          )}

          {/* End Session Button (when active or paused) */}
          {(status === "in_consultation" || isPaused) && (
            <Pressable
              testID="end-doctor-session-btn"
              onPress={handleEndSession}
              disabled={isBusy}
              style={[styles.actionColBtn, { borderColor: "#FECACA", backgroundColor: "#FEF2F2" }, isBusy && { opacity: 0.6 }]}
            >
              {endingSession ? (
                <ActivityIndicator size="small" color={colors.error} />
              ) : (
                <>
                  <Ionicons name="stop-circle-outline" size={20} color={colors.error} />
                  <Text style={[styles.actionColLabel, { color: colors.error }]}>End Session</Text>
                </>
              )}
            </Pressable>
          )}
        </View>
      ) : null}

      {/* Timing Adjustment Modal */}
      <DoctorTimingAdjustmentModal
        visible={timingModalOpen}
        doctorId={doctorId}
        doctorName={doctorName}
        sessionData={session}
        affectedCount={waitingCount}
        onClose={() => setTimingModalOpen(false)}
        onSuccess={() => onRefresh()}
      />

      {/* Pause / Resume Modal */}
      <DoctorSessionPauseModal
        visible={pauseModalOpen}
        doctorId={doctorId}
        doctorName={doctorName}
        isPaused={isPaused}
        onClose={() => setPauseModalOpen(false)}
        onSuccess={() => onRefresh()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...Platform.select({
      web: { boxShadow: "0 2px 8px rgba(0,0,0,0.04)" },
      default: { elevation: 2 },
    }),
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  titleWrap: {
    flex: 1,
  },
  sessionTitle: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  doctorSub: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    marginTop: 1,
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: "700",
  },
  statusNotStarted: {
    backgroundColor: "#FFEDD5",
  },
  statusInConsult: {
    backgroundColor: "#D1FAE5",
  },
  statusPaused: {
    backgroundColor: "#FEF3C7",
  },
  statusCompleted: {
    backgroundColor: "#E2E8F0",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  infoBlock: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 10,
    color: colors.muted,
    textTransform: "uppercase",
  },
  infoVal: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
    marginTop: 2,
  },
  delayedPill: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  delayedPillText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#D97706",
  },
  reasonBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#FFFBEB",
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    marginTop: 6,
  },
  reasonText: {
    fontSize: font.xs,
    color: "#92400E",
    flex: 1,
  },
  actionsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  actionColBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4,
  },
  actionColBtnPrimary: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  actionColLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
  },
  actionBtnSecondary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  actionBtnSecondaryText: {
    fontSize: font.xs,
    fontWeight: "600",
    color: colors.onSurface,
  },
  actionBtnPrimary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: radius.sm,
  },
  actionBtnPrimaryText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: "#fff",
  },
});
