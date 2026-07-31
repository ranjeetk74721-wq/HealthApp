import { useEffect, useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

export default function PatientQueue() {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<any>(null);

  const load = useCallback(async () => {
    try {
      const appts = await api.get("/appointments/me");
      const active = appts.find((a: any) => ["booked", "arrived", "in_consultation"].includes(a.status));
      if (!active) {
        setData({ empty: true });
        return;
      }
      const q = await api.get(`/appointments/${active.id}/queue`);
      setData(q);
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      timerRef.current = setInterval(load, 5000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }, [load]),
  );

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  if (data?.empty) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.emptyWrap}>
          <View style={styles.emptyIcon}><Ionicons name="calendar-outline" size={44} color={colors.brand} /></View>
          <Text style={styles.emptyTitle}>No active queue</Text>
          <Text style={styles.emptySub}>Book an appointment to see your live queue position here.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const appt = data.appointment;
  const isServing = appt.status === "in_consultation";
  const isDone = appt.status === "completed";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        <Text style={styles.title}>Live Queue</Text>
        <Text style={styles.doctorName}>{appt.doctor_name}</Text>
        <Text style={styles.slotText}>Token #{appt.token_number} · {appt.slot}</Text>

        <View style={styles.hero}>
          <Text style={styles.heroLabel}>{isServing ? "IT'S YOUR TURN 🎉" : isDone ? "COMPLETED" : "YOU ARE NUMBER"}</Text>
          <Text style={styles.heroNumber} testID="queue-position">
            {isServing ? "NOW" : isDone ? "✓" : `#${data.my_position || 0}`}
          </Text>
          <Text style={styles.heroSub}>
            {isServing ? "Please head to the consultation room" : isDone ? "Consultation completed" : `~${data.eta_minutes} minutes waiting time`}
          </Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Currently serving</Text>
            <Text style={styles.statValue}>{data.currently_serving != null ? `#${data.currently_serving}` : "-"}</Text>
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
          <View style={[styles.progressBar, { width: `${Math.min(100, (data.completed_count / Math.max(1, data.total_in_queue + data.completed_count)) * 100)}%` }]} />
        </View>

        <View style={styles.notifyCard}>
          <Ionicons name="notifications" size={20} color={colors.brandPrimary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.notifyTitle}>Auto-refreshing every 5s</Text>
            <Text style={styles.notifySub}>You'll be alerted 1hr, 30min, 10min before your turn</Text>
          </View>
        </View>

        {!isDone && (
          <Pressable
            testID="cancel-appt-btn"
            onPress={async () => {
              try {
                await api.post(`/appointments/${appt.id}/cancel`);
                load();
              } catch (e) { console.log(e); }
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
  heroSub: { color: colors.brandTertiary, fontSize: font.base, textAlign: "center" },
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
