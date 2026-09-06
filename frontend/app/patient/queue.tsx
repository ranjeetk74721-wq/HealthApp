import { useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";

// Polling interval when WebSocket is NOT connected (fallback)
const POLL_INTERVAL_MS = 20_000;

export default function PatientQueue() {
  const router = useRouter();
  const { signOut } = useAuth();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const currentApptId = useRef<string | null>(null);
  const isFocused = useRef(true);

  const load = useCallback(async (silent = false, bypassCache = false) => {
    const shouldBypass = silent || bypassCache;
    if (!silent) setLoading(true);
    try {
      const appts = await api.get("/appointments/me", { bypassCache: shouldBypass });
      const active = appts.find((a: any) =>
        ["booked", "arrived", "in_consultation"].includes(a.status),
      );
      if (!active) {
        setData({ empty: true });
        currentApptId.current = null;
        return;
      }
      const q = await api.get(`/appointments/${active.id}/queue`, { bypassCache: shouldBypass });
      setData(q);
      // Only open a new WS if the active appointment changed
      if (currentApptId.current !== active.id) {
        currentApptId.current = active.id;
        connectWs(active.id);
      }
    } catch (err: any) {
      if (err?.message && (err.message.includes("401") || err.message.includes("authenticated") || err.message.includes("expired"))) {
        await signOut();
        router.replace("/login");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, signOut]);

  const connectWs = (apptId: string) => {
    // Close any existing connection cleanly
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    try {
      const ws = new WebSocket(`${getBackendWebSocketBase()}/api/ws/queue/appt/${apptId}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        // Clear fallback polling when WS is active — WS handles updates
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
      ws.onmessage = () => {
        if (isFocused.current) load(true);
      };
      ws.onerror = () => setWsConnected(false);
      ws.onclose = () => {
        setWsConnected(false);
        // WS dropped — restart fallback polling if still on screen
        if (isFocused.current && !timerRef.current) {
          timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
        }
      };
    } catch {
      setWsConnected(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      isFocused.current = true;
      load();
      // Start fallback polling only if WS is not connected
      if (!wsConnected) {
        timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
      }
      return () => {
        isFocused.current = false;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        // Close WS on screen blur to free resources
        if (wsRef.current) {
          try { wsRef.current.close(); } catch { /* ignore */ }
          wsRef.current = null;
        }
        setWsConnected(false);
        currentApptId.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />
      </SafeAreaView>
    );
  }

  if (data?.empty) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}>
            <Ionicons name="calendar-outline" size={44} color={colors.brand} />
          </View>
          <Text style={styles.emptyTitle}>No active queue</Text>
          <Text style={styles.emptySub}>
            Book an appointment to see your live queue position here.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const appt = data.appointment;
  const isServing = appt.status === "in_consultation";
  const isDone = appt.status === "completed";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(true); }}
          />
        }
      >
        <Text style={styles.title}>Live Queue</Text>
        <Text style={styles.doctorName}>{appt.doctor_name}</Text>
        <Text style={styles.slotText}>Token #{appt.token_number} · {appt.slot}</Text>

        {/* Doctor Break / Emergency Status Banner */}
        {data.doctor_status === "break" && (
          <View style={[styles.statusBanner, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B" }]}>
            <Ionicons name="cafe-outline" size={20} color="#D97706" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: "700", color: "#92400E", fontSize: font.sm }}>Doctor is on a short break</Text>
              <Text style={{ color: "#B45309", fontSize: font.xs, marginTop: 2 }}>
                Your place in queue is safely reserved. Wait time and expected turn have been updated.
              </Text>
            </View>
          </View>
        )}

        {data.doctor_status === "emergency" && (
          <View style={[styles.statusBanner, { backgroundColor: "#FEE2E2", borderColor: "#EF4444" }]}>
            <Ionicons name="warning-outline" size={20} color="#DC2626" />
            <View style={{ flex: 1 }}>
              <Text style={{ fontWeight: "700", color: "#991B1B", fontSize: font.sm }}>Doctor attending an emergency</Text>
              <Text style={{ color: "#B91C1C", fontSize: font.xs, marginTop: 2 }}>
                Doctor is attending an urgent emergency. Live queue will resume immediately afterwards.
              </Text>
            </View>
          </View>
        )}

        <View style={styles.hero}>
          <Text style={styles.heroLabel}>
            {isServing ? "IT'S YOUR TURN 🎉" : isDone ? "COMPLETED" : "YOU ARE NUMBER"}
          </Text>
          <Text style={styles.heroNumber} testID="queue-position">
            {isServing ? "NOW" : isDone ? "✓" : `#${data.my_position || 0}`}
          </Text>
          <Text style={styles.heroExpectedTime} testID="expected-turn-time">
            {isServing
              ? "Please head to the consultation room"
              : isDone
              ? "Consultation completed"
              : `Your expected turn: ${data.expected_turn_time || '~' + data.eta_minutes + ' min'}`}
          </Text>
          {!isServing && !isDone && (
            <Text style={styles.heroSub}>
              ~{data.eta_minutes} mins waiting time ({data.my_position > 1 ? `${data.my_position - 1} patient${data.my_position > 2 ? 's' : ''} ahead` : 'Next in line'})
            </Text>
          )}
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Currently serving</Text>
            <Text style={styles.statValue}>
              {data.currently_serving != null ? `#${data.currently_serving}` : "-"}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Completed today</Text>
            <Text style={styles.statValue}>{data.completed_count}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>In queue</Text>
            <Text style={styles.statValue}>{data.total_in_queue}</Text>
          </View>
        </View>

        <View style={styles.progressWrap}>
          <View
            style={[
              styles.progressBar,
              {
                width: `${Math.min(
                  100,
                  (data.completed_count /
                    Math.max(1, data.total_in_queue + data.completed_count)) *
                    100,
                )}%`,
              },
            ]}
          />
        </View>

        <View style={styles.notifyCard}>
          <Ionicons
            name={wsConnected ? "flash" : "notifications"}
            size={20}
            color={wsConnected ? colors.success : colors.brandPrimary}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.notifyTitle}>
              {wsConnected ? "Live updates active" : "Auto-refreshing"}
            </Text>
            <Text style={styles.notifySub}>
              {wsConnected
                ? "Real-time queue updates via WebSocket"
                : `Updates every ${POLL_INTERVAL_MS / 1000}s`}
            </Text>
          </View>
        </View>

        {!isDone && (
          <Pressable
            testID="cancel-appt-btn"
            onPress={async () => {
              try {
                await api.post(`/appointments/${appt.id}/cancel`);
                load(true);
              } catch { /* ignore */ }
            }}
            style={styles.cancelBtn}
          >
            <Text style={styles.cancelText}>Cancel Appointment</Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  scroll: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl },
  title: { fontSize: font.base, color: colors.muted, fontWeight: "500", letterSpacing: 1 },
  doctorName: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  slotText: { fontSize: font.base, color: colors.muted },
  hero: { backgroundColor: colors.brandPrimary, borderRadius: radius.lg, padding: spacing.xl, alignItems: "center", marginTop: spacing.md, gap: 4 },
  heroLabel: { color: colors.brandTertiary, fontSize: font.sm, fontWeight: "700", letterSpacing: 1 },
  heroNumber: { color: colors.onBrandPrimary, fontSize: 96, fontWeight: "800", lineHeight: 104, marginVertical: spacing.sm },
  heroExpectedTime: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700", textAlign: "center" },
  heroSub: { color: colors.brandTertiary, fontSize: font.sm, textAlign: "center", marginTop: 2 },
  statusBanner: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, marginTop: spacing.sm },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  statCard: { flex: 1, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  statLabel: { fontSize: 11, color: colors.muted },
  statValue: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface, marginTop: 4 },
  progressWrap: { height: 8, backgroundColor: colors.surfaceTertiary, borderRadius: radius.pill, overflow: "hidden", marginTop: spacing.sm },
  progressBar: { height: "100%", backgroundColor: colors.success, borderRadius: radius.pill },
  notifyCard: { flexDirection: "row", gap: spacing.md, alignItems: "center", backgroundColor: colors.brandSecondary, padding: spacing.md, borderRadius: radius.md, marginTop: spacing.md },
  notifyTitle: { fontSize: font.sm, fontWeight: "600", color: colors.onBrandSecondary },
  notifySub: { fontSize: 11, color: colors.onBrandSecondary, marginTop: 2 },
  cancelBtn: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", borderWidth: 1, borderColor: colors.error, marginTop: spacing.md },
  cancelText: { color: colors.error, fontSize: font.base, fontWeight: "600" },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl, gap: spacing.md },
  emptyIcon: { width: 88, height: 88, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  emptySub: { fontSize: font.base, color: colors.muted, textAlign: "center" },
});
