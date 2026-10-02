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

  if (!session) return null;

  const status = session.status || "not_started";
  const origStart = session.original_start_time || "10:00 AM";
  const expStart = session.expected_start_time || origStart;
  const isDelayed = expStart !== origStart || Boolean(session.delay_reason);
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

  return (
    <View style={styles.container}>
      {/* Top row: Status, Times & Badges */}
      <View style={styles.topRow}>
        <View style={styles.titleWrap}>
          <Text style={styles.sessionTitle}>Doctor Session Timing</Text>
          <Text style={styles.doctorSub}>{doctorName} · {session.date || "Today"}</Text>
        </View>

        {/* Status Badge */}
        <View
          style={[
            styles.statusBadge,
            status === "in_consultation"
              ? styles.statusInConsult
              : status === "paused"
              ? styles.statusPaused
              : status === "completed"
              ? styles.statusCompleted
              : styles.statusNotStarted,
          ]}
        >
          <Ionicons
            name={
              status === "in_consultation"
                ? "play-circle"
                : status === "paused"
                ? "pause-circle"
                : status === "completed"
                ? "checkmark-circle"
                : "time"
            }
            size={14}
            color={
              status === "in_consultation"
                ? "#065F46"
                : status === "paused"
                ? "#92400E"
                : status === "completed"
                ? "#475569"
                : "#9A3412"
            }
          />
          <Text
            style={[
              styles.statusBadgeText,
              status === "in_consultation"
                ? { color: "#065F46" }
                : status === "paused"
                ? { color: "#92400E" }
                : status === "completed"
                ? { color: "#475569" }
                : { color: "#9A3412" },
            ]}
          >
            {status === "in_consultation"
              ? "In Consultation"
              : status === "paused"
              ? "Paused"
              : status === "completed"
              ? "Completed"
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
              <View style={styles.delayedPill}>
                <Text style={styles.delayedPillText}>DELAYED</Text>
              </View>
            )}
          </View>
          <Text
            style={[
              styles.infoVal,
              isDelayed && { color: "#D97706", fontWeight: "800" },
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

      {/* Delay / Pause Reason Banner */}
      {isDelayed && session.delay_reason ? (
        <View style={styles.reasonBanner}>
          <Ionicons name="alert-circle-outline" size={16} color="#B45309" />
          <Text style={styles.reasonText}>
            Reason: <Text style={{ fontWeight: "600" }}>{session.delay_reason}</Text>
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

      {/* Action Buttons */}
      {canEdit && status !== "completed" ? (
        <View style={styles.actionsRow}>
          {/* Adjust Doctor Timing Button */}
          <Pressable
            testID="adjust-doctor-timing-btn"
            onPress={() => setTimingModalOpen(true)}
            style={styles.actionBtnSecondary}
          >
            <Ionicons name="time" size={16} color={colors.brandPrimary} />
            <Text style={styles.actionBtnSecondaryText}>Adjust Timing</Text>
          </Pressable>

          {/* Start Consultation Button (when not started) */}
          {status === "not_started" && (
            <Pressable
              testID="start-consultation-btn"
              onPress={handleStartConsultation}
              disabled={startingSession}
              style={[styles.actionBtnPrimary, { backgroundColor: colors.brandPrimary }]}
            >
              {startingSession ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="play" size={16} color="#fff" />
                  <Text style={styles.actionBtnPrimaryText}>Start Consultation</Text>
                </>
              )}
            </Pressable>
          )}

          {/* Pause / Resume Button (when in progress or paused) */}
          {(status === "in_consultation" || isPaused) && (
            <Pressable
              testID="pause-resume-session-btn"
              onPress={() => setPauseModalOpen(true)}
              style={[
                styles.actionBtnSecondary,
                isPaused && { backgroundColor: "#DCFCE7", borderColor: "#86EFAC" },
              ]}
            >
              <Ionicons
                name={isPaused ? "play" : "pause"}
                size={16}
                color={isPaused ? "#059669" : colors.warning}
              />
              <Text
                style={[
                  styles.actionBtnSecondaryText,
                  isPaused && { color: "#059669" },
                ]}
              >
                {isPaused ? "Resume Session" : "Pause Session"}
              </Text>
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
