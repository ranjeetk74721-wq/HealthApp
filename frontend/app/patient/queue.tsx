import { useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { formatExpectedTimeRange } from "@/src/utils/timeFormat";
import NotificationPermissionBanner from "@/src/components/NotificationPermissionBanner";
import { setupForegroundNotificationListener } from "@/src/utils/pushNotifications";
import { useEffect } from "react";

// Polling interval when WebSocket is NOT connected (fallback)
const POLL_INTERVAL_MS = 20_000;

export default function PatientQueue() {
  const router = useRouter();
  const { signOut } = useAuth();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const currentApptId = useRef<string | null>(null);
  const isFocused = useRef(true);

  // Network and visibility listeners for weak connection resilience
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleOnline = () => {
        setIsOnline(true);
        setIsStale(false);
        load(true, true);
      };
      const handleOffline = () => {
        setIsOnline(false);
        setIsStale(true);
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          load(true, true);
        }
      };

      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      };
    }
  }, []);

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
      const nowStr = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
      setLastUpdated(nowStr);
      setIsStale(false);
      // Only open a new WS if the active appointment changed
      if (currentApptId.current !== active.id) {
        currentApptId.current = active.id;
        connectWs(active.id);
      }
    } catch (err: any) {
      setIsStale(true);
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

  useEffect(() => {
    const unsub = setupForegroundNotificationListener(() => {
      if (isFocused.current) {
        load(true);
      }
    });
    return () => unsub();
  }, [load]);

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

        {/* Weak Internet: Offline & Stale Indicators (Requirement 6) */}
        {!isOnline ? (
          <View style={[styles.statusBanner, { backgroundColor: "#DC2626", borderColor: "#B91C1C" }]}>
            <Ionicons name="cloud-offline" size={20} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: font.xs, flex: 1 }}>
              Offline · Showing cached queue data {lastUpdated ? `(as of ${lastUpdated})` : ""}
            </Text>
          </View>
        ) : isStale ? (
          <View style={[styles.statusBanner, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B" }]}>
            <Ionicons name="sync" size={18} color="#92400E" />
            <Text style={{ color: "#92400E", fontWeight: "600", fontSize: font.xs, flex: 1 }}>
              Reconnecting... Queue data may be stale {lastUpdated ? `(as of ${lastUpdated})` : ""}
            </Text>
          </View>
        ) : null}

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

        {/* Doctor Availability & Delay Banner */}
        {!isServing && !isDone && (data.is_delayed_awaited || data.return_time_unconfirmed || data.is_delayed || data.delay_reason) ? (
          (data.is_delayed_awaited || data.return_time_unconfirmed) ? (
            <View style={[styles.statusBanner, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B", flexDirection: "column", alignItems: "stretch", gap: 6 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="time" size={20} color="#D97706" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "700", color: "#92400E", fontSize: font.sm }}>
                    Doctor Availability: Delayed (Time Awaited)
                  </Text>
                  <Text style={{ fontSize: 11, color: "#B45309", fontWeight: "600" }}>
                    डॉक्टर के आने में देरी · समय की प्रतीक्षा है
                  </Text>
                </View>
              </View>
              {data.delay_reason ? (
                <View style={{ backgroundColor: "#FDE68A", paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, alignSelf: "flex-start" }}>
                  <Text style={{ fontSize: font.xs, fontWeight: "700", color: "#78350F" }}>
                    Reason: {data.delay_reason}
                  </Text>
                </View>
              ) : null}
              <Text style={{ color: "#92400E", fontSize: font.xs, lineHeight: 18, marginTop: 2 }}>
                {data.expected_turn_time?.includes("Doctor abhi available") || data.expected_turn_time?.includes("Doctor ke consultation")
                  ? data.expected_turn_time
                  : (data.delay_reason
                    ? `${data.delay_reason}. Doctor abhi available nahi hain. Naya anumanit samay confirm hote hi update hoga.`
                    : "Doctor abhi available nahi hain. Naya anumanit samay confirm hote hi update hoga.")}
              </Text>
              <Text style={{ color: "#B45309", fontSize: 11, lineHeight: 16 }}>
                डॉक्टर के परामर्श शुरू होने में देरी है—समय अभी तय नहीं है। क्लिनिक द्वारा उपलब्धता की पुष्टि होते ही आपका समय अपडेट हो जाएगा।
              </Text>
            </View>
          ) : (
            <View style={[styles.statusBanner, { backgroundColor: "#EFF6FF", borderColor: "#3B82F6", flexDirection: "column", alignItems: "stretch", gap: 6 }]}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Ionicons name="information-circle" size={20} color="#2563EB" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: "700", color: "#1E40AF", fontSize: font.sm }}>
                    Doctor Availability: Delayed
                  </Text>
                  <Text style={{ fontSize: 11, color: "#1D4ED8", fontWeight: "600" }}>
                    डॉक्टर के परामर्श शुरू होने में देरी
                  </Text>
                </View>
              </View>
              {data.delay_reason ? (
                <View style={{ backgroundColor: "#DBEAFE", paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, alignSelf: "flex-start" }}>
                  <Text style={{ fontSize: font.xs, fontWeight: "700", color: "#1E3A8A" }}>
                    Reason: {data.delay_reason}
                  </Text>
                </View>
              ) : null}
              <View style={{ backgroundColor: "#FFFFFF", padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: "#BFDBFE" }}>
                <Text style={{ fontSize: font.xs, color: "#1E40AF", fontWeight: "600" }}>
                  Expected consultation start: <Text style={{ fontWeight: "800", color: "#1D4ED8" }}>{data.expected_start_time || "11:30 AM"}</Text>
                </Text>
                <Text style={{ fontSize: font.xs, color: "#1E40AF", fontWeight: "600", marginTop: 2 }}>
                  Your estimated turn: <Text style={{ fontWeight: "800", color: colors.brandPrimary }}>{formatExpectedTimeRange(data.expected_turn_time || "Calculating...")}</Text>
                </Text>
              </View>
            </View>
          )
        ) : null}

        <NotificationPermissionBanner
          appointmentId={appt?.id}
          appointmentToken={appt?.secure_token}
        />

        <View style={styles.hero}>
          <Text style={styles.heroLabel}>
            {isServing ? "IT'S YOUR TURN 🎉" : isDone ? "COMPLETED" : "YOUR TOKEN NUMBER"}
          </Text>
          <Text style={styles.heroNumber} testID="queue-position">
            {isServing ? "NOW" : isDone ? "✓" : `#${appt.token_number || 0}`}
          </Text>
          <Text style={styles.heroExpectedTime} testID="expected-turn-time">
            {isServing
              ? "Consultation in progress."
              : isDone
              ? "Consultation completed"
              : data.expected_turn_time
              ? (data.expected_turn_time.includes("–") || data.expected_turn_time.includes("-")
                  ? `Estimated: ${formatExpectedTimeRange(data.expected_turn_time)}`
                  : data.expected_turn_time)
              : `Estimated: ${formatExpectedTimeRange(data.eta_minutes || "Calculating...")}`}
          </Text>
          {!isServing && !isDone && (
            <Text style={styles.heroSub}>
              {data.patients_ahead != null
                ? `${data.patients_ahead} patient${data.patients_ahead !== 1 ? 's' : ''} ahead of you`
                : data.my_position > 1
                ? `${data.my_position - 1} patient${data.my_position > 2 ? 's' : ''} ahead`
                : 'Next in line'}
            </Text>
          )}
        </View>

        {/* Separate Values: Your token, Now consulting, Patients ahead (Requirement 3) */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Your token</Text>
            <Text style={[styles.statValue, { color: colors.brandPrimary }]}>
              #{appt.token_number}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Now consulting</Text>
            <Text style={styles.statValue}>
              {data.currently_serving != null ? `#${data.currently_serving}` : "Waiting"}
            </Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Patients ahead</Text>
            <Text style={styles.statValue}>
              {data.patients_ahead != null
                ? data.patients_ahead
                : data.my_position > 1
                ? data.my_position - 1
                : 0}
            </Text>
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
