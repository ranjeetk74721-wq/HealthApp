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

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef(true);

  // If not authenticated after auth is loaded, redirect to login
  useEffect(() => {
    if (authLoading) return;
    if (!authToken || !user) {
      router.replace({
        pathname: "/login",
        params: { redirect: `/appointment/${token}` },
      } as any);
    }
  }, [authLoading, authToken, user, token, router]);

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
        }
      } catch (err: any) {
        if (!isMounted.current) return;
        const msg = err.message || "";
        if (msg.includes("401") || msg.includes("Not authenticated")) {
          router.replace({
            pathname: "/login",
            params: { redirect: `/appointment/${token}` },
          } as any);
          return;
        }
        if (msg.includes("403")) {
          setErrorStatus(403);
          setErrorMessage(
            "Access Denied: This appointment is linked to another patient account."
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
    [token, router]
  );

  // Fetch data on load
  useEffect(() => {
    isMounted.current = true;
    if (authToken && user && token) {
      loadAppointment();
    }
    return () => {
      isMounted.current = false;
    };
  }, [authToken, user, token, loadAppointment]);

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
  const expectedTurnTime = queueData?.expected_turn_time || "Calculating...";
  const myPosition = queueData?.my_position ?? -1;
  const status = apptData?.status || "booked";

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

        {/* Doctor & Clinic Card */}
        <View style={styles.card}>
          <View style={styles.docHeader}>
            <View style={styles.avatarWrap}>
              <Ionicons name="medkit" size={24} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.doctorName}>{apptData?.doctor_name}</Text>
              <Text style={styles.metaSub}>
                {apptData?.date} · {apptData?.slot || "Walk-in"}
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

        {/* Live Token & ETA Hero */}
        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>YOUR TOKEN NUMBER</Text>
          <Text style={styles.tokenBig}>#{tokenNumber}</Text>
          <Text style={styles.patientName}>Patient: {apptData?.patient_name}</Text>

          <View style={styles.heroDivider} />

          <View style={styles.kpiGrid}>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiCaption}>Now Serving</Text>
              <Text style={styles.kpiValue}>
                {currentServing ? `#${currentServing}` : "Waiting"}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiCaption}>Estimated Turn</Text>
              <Text style={[styles.kpiValue, { color: colors.brandPrimary }]}>
                {expectedTurnTime}
              </Text>
            </View>
            <View style={styles.kpiItem}>
              <Text style={styles.kpiCaption}>Ahead in Queue</Text>
              <Text style={styles.kpiValue}>
                {myPosition > 0 ? `${myPosition - 1} patients` : myPosition === 0 ? "You're next!" : "—"}
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
    padding: spacing.xl,
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
    fontSize: font.xs,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: colors.muted,
  },
  tokenBig: {
    fontSize: 54,
    fontWeight: "800",
    color: colors.brandPrimary,
    marginVertical: spacing.xs,
  },
  patientName: {
    fontSize: font.base,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
  },
  heroDivider: {
    width: "100%",
    height: 1,
    backgroundColor: colors.divider,
    marginVertical: spacing.lg,
  },
  kpiGrid: {
    flexDirection: "row",
    width: "100%",
    justifyContent: "space-around",
  },
  kpiItem: {
    alignItems: "center",
  },
  kpiCaption: {
    fontSize: font.xs,
    color: colors.muted,
    marginBottom: 4,
  },
  kpiValue: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
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
