import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Pressable,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useLocalSearchParams } from "expo-router";
import { api, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { formatExpectedTimeRange } from "@/src/utils/timeFormat";
import NotificationPermissionBanner from "@/src/components/NotificationPermissionBanner";
import { setupForegroundNotificationListener } from "@/src/utils/pushNotifications";

const POLL_INTERVAL_MS = 15_000;

export default function DynamicAppointmentScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { user, token: authToken, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [apptData, setApptData] = useState<any | null>(null);
  const [queueData, setQueueData] = useState<any | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef(true);

  // Online / Offline and visibility listeners for weak connection resilience
  useEffect(() => {
    if (typeof window !== "undefined") {
      const handleOnline = () => {
        setIsOnline(true);
        setIsStale(false);
        loadAppointment(true);
      };
      const handleOffline = () => {
        setIsOnline(false);
        setIsStale(true);
      };
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          loadAppointment(true);
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

  // Fetch appointment data on load for both authenticated patients and guest walk-in patients
  const loadAppointment = useCallback(
    async (silent = false) => {
      if (!token) return;
      if (!silent) setLoading(true);
      setErrorStatus(null);
      setErrorMessage(null);

      try {
        const res = await api.get(`/appointments/by-token/${token}`, {
          bypassCache: true,
        });
        if (isMounted.current) {
          setApptData(res.appointment);
          setQueueData(res.queue);
          const nowStr = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
          setLastUpdated(nowStr);
          setIsStale(false);
        }
      } catch (err: any) {
        if (!isMounted.current) return;
        setIsStale(true);
        const msg = err.message || "";
        if (msg.includes("410")) {
          setErrorStatus(410);
          setErrorMessage("This appointment link has expired or was cancelled.");
        } else if (msg.includes("403")) {
          setErrorStatus(403);
          setErrorMessage(
            "Access Denied: This appointment link is not authorized."
          );
        } else if (msg.includes("404")) {
          setErrorStatus(404);
          setErrorMessage("Appointment not found or link has expired.");
        } else {
          setErrorMessage(err.message || "Unable to load appointment details.");
        }
      } finally {
        if (isMounted.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [token]
  );

  // Fetch data on initial load once auth status is determined
  useEffect(() => {
    isMounted.current = true;
    if (!authLoading && token) {
      loadAppointment();
    }
    return () => {
      isMounted.current = false;
    };
  }, [authLoading, token, loadAppointment]);


  // WebSocket for live updates
  useEffect(() => {
    if (!apptData?.id) return;
    const apptId = apptData.id;

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }

    try {
      const ws = new WebSocket(
        `${getBackendWebSocketBase()}/api/ws/queue/appt/${apptId}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      };
      ws.onmessage = () => {
        if (isMounted.current) loadAppointment(true);
      };
      ws.onerror = () => {
        if (isMounted.current && !timerRef.current) {
          timerRef.current = setInterval(
            () => loadAppointment(true),
            POLL_INTERVAL_MS
          );
        }
      };
      ws.onclose = () => {
        if (isMounted.current && !timerRef.current) {
          timerRef.current = setInterval(
            () => loadAppointment(true),
            POLL_INTERVAL_MS
          );
        }
      };
    } catch {
      if (isMounted.current && !timerRef.current) {
        timerRef.current = setInterval(
          () => loadAppointment(true),
          POLL_INTERVAL_MS
        );
      }
    }

    return () => {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [apptData?.id, loadAppointment]);

  // Listen for foreground push updates to immediately refresh live appointment
  useEffect(() => {
    const unsub = setupForegroundNotificationListener(() => {
      if (isMounted.current) {
        loadAppointment(true);
      }
    });
    return () => unsub();
  }, [loadAppointment]);

  if (authLoading || loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centerBox}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
          <Text style={styles.loadingText}>Fetching live queue status...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (errorMessage) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.errorContainer}>
          <Ionicons
            name={
              errorStatus === 403
                ? "shield-outline"
                : errorStatus === 404
                ? "search-outline"
                : "alert-circle-outline"
            }
            size={56}
            color={errorStatus === 403 ? colors.warning : colors.error}
          />
          <Text style={styles.errorTitle}>
            {errorStatus === 403
              ? "Restricted Access"
              : errorStatus === 404
              ? "Appointment Not Found"
              : "Something went wrong"}
          </Text>
          <Text style={styles.errorSubtitle}>{errorMessage}</Text>
          <Pressable
            style={styles.primaryBtn}
            onPress={() => router.replace("/patient/home" as any)}
          >
            <Text style={styles.primaryBtnText}>Go to My Dashboard</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const tokenNumber = apptData?.token_number;
  const currentServing = queueData?.currently_serving;
  const rawExpectedTurnTime = queueData?.expected_turn_time;
  const expectedTurnTime = queueData?.is_estimate_pending
    ? "Doctor unavailable — estimate pending"
    : rawExpectedTurnTime
    ? formatExpectedTimeRange(rawExpectedTurnTime)
    : "Calculating...";
  const myPosition = queueData?.my_position ?? -1;
  const status = apptData?.status || "booked";

  const formatTurnTimeDisplay = (rawTimeStr: string) => {
    if (!rawTimeStr) return "Calculating...";
    if (status === "in_consultation") return "Consultation in progress.";
    if (status === "completed") return "Completed";
    if (rawTimeStr.includes("–") || rawTimeStr.includes("-")) {
      return `Estimated: ${rawTimeStr.replace(/(\d{1,2}:\d{2})\s*(AM|PM)/gi, "$1\u00A0$2")}`;
    }
    return rawTimeStr.replace(/(\d{1,2}:\d{2})\s*(AM|PM)/gi, "$1\u00A0$2");
  };

  const displayTime = status === "in_consultation"
    ? "Consultation in progress."
    : status === "completed"
    ? "Completed"
    : formatTurnTimeDisplay(expectedTurnTime || queueData?.expected_turn_time);

  const patientsAhead =
    queueData?.patients_ahead != null
      ? queueData.patients_ahead
      : myPosition > 0
      ? myPosition - 1
      : myPosition === 0
      ? 0
      : null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              loadAppointment(true);
            }}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable
            onPress={() => router.replace("/patient/home" as any)}
            style={styles.backBtn}
          >
            <Ionicons name="arrow-back" size={22} color={colors.onSurface} />
          </Pressable>
          <Text style={styles.headerTitle}>Live Appointment</Text>
          <View style={{ width: 40 }} />
        </View>

        {/* Offline / Stale Banner for weak connection */}
        {!isOnline ? (
          <View style={[styles.infoBox, { backgroundColor: "#DC2626", borderColor: "#B91C1C", borderWidth: 1 }]}>
            <Ionicons name="cloud-offline" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: font.xs }}>
              Offline · Displaying cached queue data {lastUpdated ? `(as of ${lastUpdated})` : ""}
            </Text>
          </View>
        ) : isStale ? (
          <View style={[styles.infoBox, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B", borderWidth: 1 }]}>
            <Ionicons name="sync" size={16} color="#92400E" />
            <Text style={{ color: "#92400E", fontWeight: "600", fontSize: font.xs }}>
              Reconnecting... Queue data may be stale {lastUpdated ? `(as of ${lastUpdated})` : ""}
            </Text>
          </View>
        ) : null}

        {/* Doctor & Clinic Card */}
        <View style={styles.card}>
          <View style={styles.docHeader}>
            <View style={styles.avatarWrap}>
              <Ionicons name="medkit" size={24} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.doctorName}>{apptData?.doctor_name}</Text>
              <Text style={styles.metaSub}>
                {apptData?.date} · {apptData?.slot ? formatExpectedTimeRange(apptData.slot) : "Walk-in"}
              </Text>
            </View>
            <View
              style={[
                styles.statusPill,
                status === "in_consultation"
                  ? styles.statusPillActive
                  : status === "completed"
                  ? styles.statusPillSuccess
                  : styles.statusPillDefault,
              ]}
            >
              <Text style={styles.statusPillText}>
                {status.replace("_", " ").toUpperCase()}
              </Text>
            </View>
          </View>
        </View>

        {/* Enable Queue Push Notifications Banner */}
        <NotificationPermissionBanner
          appointmentId={apptData?.id}
          appointmentToken={apptData?.secure_token || token}
        />

        {/* Doctor Availability & Delay Banner */}
        {status !== "in_consultation" && status !== "completed" && (queueData?.is_delayed_awaited || queueData?.return_time_unconfirmed || queueData?.is_delayed || queueData?.delay_reason) ? (
          (queueData?.is_delayed_awaited || queueData?.return_time_unconfirmed) ? (
            <View style={[styles.infoBox, { backgroundColor: "#FEF3C7", borderColor: "#F59E0B", borderWidth: 1.5, flexDirection: "column", alignItems: "stretch", gap: 6 }]}>
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
              {queueData?.delay_reason ? (
                <View style={{ backgroundColor: "#FDE68A", paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, alignSelf: "flex-start" }}>
                  <Text style={{ fontSize: font.xs, fontWeight: "700", color: "#78350F" }}>
                    Reason: {queueData.delay_reason}
                  </Text>
                </View>
              ) : null}
              <Text style={{ color: "#92400E", fontSize: font.xs, lineHeight: 18, marginTop: 2 }}>
                {queueData?.delay_reason ? `${queueData.delay_reason}. ` : "Doctor is attending an emergency. "}
                The consultation resume time is not yet confirmed. Your estimated turn time will update once the clinic confirms availability.
              </Text>
              <Text style={{ color: "#B45309", fontSize: 11, lineHeight: 16 }}>
                डॉक्टर के परामर्श शुरू होने में देरी है—समय अभी तय नहीं है। क्लिनिक द्वारा उपलब्धता की पुष्टि होते ही आपका समय अपडेट हो जाएगा।
              </Text>
            </View>
          ) : (
            <View style={[styles.infoBox, { backgroundColor: "#EFF6FF", borderColor: "#3B82F6", borderWidth: 1.5, flexDirection: "column", alignItems: "stretch", gap: 6 }]}>
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
              {queueData?.delay_reason ? (
                <View style={{ backgroundColor: "#DBEAFE", paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, alignSelf: "flex-start" }}>
                  <Text style={{ fontSize: font.xs, fontWeight: "700", color: "#1E3A8A" }}>
                    Reason: {queueData.delay_reason}
                  </Text>
                </View>
              ) : null}
              <View style={{ backgroundColor: "#FFFFFF", padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: "#BFDBFE" }}>
                <Text style={{ fontSize: font.xs, color: "#1E40AF", fontWeight: "600" }}>
                  Expected consultation start: <Text style={{ fontWeight: "800", color: "#1D4ED8" }}>{queueData?.expected_start_time || "11:30 AM"}</Text>
                </Text>
                <Text style={{ fontSize: font.xs, color: "#1E40AF", fontWeight: "600", marginTop: 2 }}>
                  Your estimated turn: <Text style={{ fontWeight: "800", color: colors.brandPrimary }}>{expectedTurnTime}</Text>
                </Text>
              </View>
            </View>
          )
        ) : null}

        {/* Live Token & ETA Hero */}
        <View style={styles.heroCard}>
          {/* Top Section */}
          <Text style={styles.heroLabel}>आपका टोकन नंबर</Text>
          <Text style={styles.tokenBig}>#{tokenNumber}</Text>
          <Text style={styles.patientName}>Patient: {apptData?.patient_name}</Text>

          {/* Queue Details — 3 columns in 1 horizontal row */}
          <View style={styles.queueDetailsRow}>
            {/* Left Column: Currently Serving */}
            <View style={styles.colLeft}>
              <Text style={styles.colLabel}>{"अभी कितना नंबर\nचल रहा है"}</Text>
              <Text style={styles.colValue}>
                {currentServing ? `#${currentServing}` : "Waiting"}
              </Text>
            </View>

            {/* Center Column: Estimated Turn Time */}
            <View style={styles.colCenter}>
              <Text style={styles.colLabel}>{"आपके नंबर का\nअनुमानित समय"}</Text>
              <Text
                style={[styles.colValue, styles.colValueHighlight]}
                testID="expected-turn-time"
              >
                {displayTime}
              </Text>
            </View>

            {/* Right Column: Patients Ahead */}
            <View style={styles.colRight}>
              <Text style={styles.colLabel}>{"आपसे पहले\nमरीज"}</Text>
              <Text style={styles.colValue}>
                {patientsAhead !== null ? patientsAhead : "—"}
              </Text>
            </View>
          </View>
        </View>

        {/* Information Callout */}
        <View style={styles.infoBox}>
          <Ionicons
            name="information-circle-outline"
            size={20}
            color={colors.info}
          />
          <Text style={styles.infoText}>
            Queue moves dynamically based on live clinic consultations. This
            page automatically updates in real-time.
          </Text>
        </View>

        {/* Action Button */}
        <Pressable
          style={styles.dashboardActionBtn}
          onPress={() => router.replace("/patient/home" as any)}
        >
          <Ionicons name="home-outline" size={18} color="#fff" />
          <Text style={styles.dashboardActionText}>Go to My Dashboard</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  centerBox: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.md,
  },
  loadingText: {
    fontSize: font.base,
    color: colors.muted,
  },
  errorContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  errorTitle: {
    fontSize: font.xl,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
  },
  errorSubtitle: {
    fontSize: font.base,
    color: colors.muted,
    textAlign: "center",
    marginBottom: spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  docHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  avatarWrap: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSecondary,
    justifyContent: "center",
    alignItems: "center",
  },
  doctorName: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  metaSub: {
    fontSize: font.sm,
    color: colors.muted,
    marginTop: 2,
  },
  statusPill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  statusPillDefault: {
    backgroundColor: colors.surfaceTertiary,
  },
  statusPillActive: {
    backgroundColor: colors.brandPrimary + "22",
  },
  statusPillSuccess: {
    backgroundColor: colors.success + "22",
  },
  statusPillText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: colors.onSurfaceSecondary,
  },
  heroCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.brandSecondary,
    shadowColor: colors.brand,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 3,
  },
  heroLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.muted,
    textAlign: "center",
  },
  tokenBig: {
    fontSize: 50,
    fontWeight: "800",
    color: colors.brandPrimary,
    marginVertical: 4,
    textAlign: "center",
  },
  patientName: {
    fontSize: font.base,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
    textAlign: "center",
    marginBottom: spacing.lg,
  },
  queueDetailsRow: {
    flexDirection: "row",
    width: "100%",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  colLeft: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 2,
  },
  colCenter: {
    flex: 1.4,
    alignItems: "center",
    paddingHorizontal: 4,
  },
  colRight: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 2,
  },
  colLabel: {
    fontSize: 11,
    lineHeight: 16,
    color: colors.muted,
    textAlign: "center",
    fontWeight: "600",
    minHeight: 32,
    marginBottom: 6,
  },
  colValue: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
  },
  colValueHighlight: {
    color: colors.brandPrimary,
    fontSize: font.sm,
    lineHeight: 18,
  },
  infoBox: {
    flexDirection: "row",
    backgroundColor: colors.brandSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.sm,
    alignItems: "center",
  },
  infoText: {
    flex: 1,
    fontSize: font.xs,
    color: colors.onBrandTertiary,
    lineHeight: 18,
  },
  primaryBtn: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  primaryBtnText: {
    color: colors.onBrandPrimary,
    fontSize: font.base,
    fontWeight: "600",
  },
  dashboardActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dashboardActionText: {
    color: "#fff",
    fontSize: font.base,
    fontWeight: "600",
  },
});
