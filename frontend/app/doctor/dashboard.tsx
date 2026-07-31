import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable, RefreshControl, Modal, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";

const modes = [
  { key: "active", label: "Active", icon: "play-circle" as const, color: colors.success },
  { key: "break", label: "Break", icon: "pause-circle" as const, color: colors.warning },
  { key: "emergency", label: "Emergency", icon: "alert-circle" as const, color: colors.error },
];

export default function DoctorDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [data, setData] = useState<any | null>(null);
  const [appts, setAppts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [prescOpen, setPrescOpen] = useState<any | null>(null);
  const [prescText, setPrescText] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([api.get("/doctor/dashboard"), api.get("/doctor/appointments")]);
      setData(d);
      setAppts(a);
    } catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]));

  const changeStatus = async (status: string) => {
    try { await api.post("/doctor/status", { status }); load(); } catch (e) { console.log(e); }
  };

  const doAction = async (path: string, appt_id: string) => {
    try { await api.post(path, { appointment_id: appt_id }); load(); } catch (e) { console.log(e); }
  };

  const savePresc = async () => {
    if (!prescOpen) return;
    try {
      await api.post("/doctor/prescription", { appointment_id: prescOpen.id, prescription: prescText });
      setPrescOpen(null);
      setPrescText("");
      load();
    } catch (e) { console.log(e); }
  };

  if (loading || !data) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  const currentMode = data.status;
  const nextPatient = appts.find((a) => a.status === "arrived" || a.status === "in_consultation") || appts.find((a) => a.status === "booked");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Good day, Doctor</Text>
          <Text style={styles.name}>{user?.full_name}</Text>
        </View>
        <Pressable onPress={async () => { await signOut(); router.replace("/login"); }} testID="doctor-logout" style={styles.iconBtn}>
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        <View style={styles.modeRow}>
          {modes.map((m) => {
            const active = currentMode === m.key;
            return (
              <Pressable key={m.key} testID={`mode-${m.key}`} onPress={() => changeStatus(m.key)} style={[styles.modeChip, active && { backgroundColor: m.color, borderColor: m.color }]}>
                <Ionicons name={m.icon} size={16} color={active ? "#fff" : m.color} />
                <Text style={[styles.modeText, active && { color: "#fff" }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.kpiRow}>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Total</Text><Text style={styles.kpiValue}>{data.total_patients}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Completed</Text><Text style={[styles.kpiValue, { color: colors.success }]}>{data.completed}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Pending</Text><Text style={[styles.kpiValue, { color: colors.warning }]}>{data.pending}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Earnings</Text><Text style={[styles.kpiValue, { color: colors.brandPrimary }]}>₹{data.earnings}</Text></View>
        </View>

        {nextPatient && (
          <View style={styles.nextCard}>
            <Text style={styles.nextLabel}>NEXT PATIENT</Text>
            <Text style={styles.nextName}>{nextPatient.patient_name}</Text>
            <Text style={styles.nextMeta}>Token #{nextPatient.token_number} · {nextPatient.slot} · {nextPatient.status.replace("_", " ")}</Text>
            {nextPatient.status !== "in_consultation" ? (
              <Pressable testID="call-next-btn" onPress={() => doAction("/reception/start_consultation", nextPatient.id)} style={styles.callBtn}>
                <Ionicons name="mic" size={18} color="#fff" />
                <Text style={styles.callBtnText}>Call Next Patient</Text>
              </Pressable>
            ) : (
              <Pressable testID="complete-btn" onPress={() => doAction("/reception/complete", nextPatient.id)} style={[styles.callBtn, { backgroundColor: colors.success }]}>
                <Ionicons name="checkmark-circle" size={18} color="#fff" />
                <Text style={styles.callBtnText}>Mark Completed</Text>
              </Pressable>
            )}
          </View>
        )}

        <Text style={styles.sectionTitle}>Today's Schedule</Text>
        {appts.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No patients scheduled today</Text></View>
        ) : (
          appts.map((a) => (
            <View key={a.id} style={styles.apptCard}>
              <View style={styles.tokenBubble}><Text style={styles.tokenText}>#{a.token_number}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.apptName}>{a.patient_name}</Text>
                <Text style={styles.apptMeta}>{a.slot} · <Text style={{ color: colors.brandPrimary, fontWeight: "600" }}>{a.status.replace("_", " ")}</Text></Text>
              </View>
              <Pressable testID={`presc-${a.id}`} onPress={() => { setPrescOpen(a); setPrescText(a.prescription || ""); }} style={styles.smallBtn}>
                <Ionicons name="document-text-outline" size={16} color={colors.brandPrimary} />
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>

      <Modal transparent visible={!!prescOpen} animationType="slide" onRequestClose={() => setPrescOpen(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPrescOpen(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Prescription</Text>
            <Text style={styles.sheetSub}>{prescOpen?.patient_name}</Text>
            <TextInput
              testID="presc-input"
              value={prescText}
              onChangeText={setPrescText}
              multiline
              placeholder="Rx: medication, dosage, notes..."
              placeholderTextColor={colors.muted}
              style={styles.prescInput}
            />
            <Pressable testID="presc-save" onPress={savePresc} style={styles.saveBtn}>
              <Text style={styles.saveBtnText}>Save Prescription</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", padding: spacing.lg, alignItems: "center" },
  hello: { fontSize: font.base, color: colors.muted },
  name: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  iconBtn: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  scroll: { padding: spacing.lg, paddingTop: 0, gap: spacing.md, paddingBottom: spacing.xxxl },
  modeRow: { flexDirection: "row", gap: spacing.sm },
  modeChip: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  modeText: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface },
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  kpiCard: { flex: 1, minWidth: "45%", backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  kpiLabel: { fontSize: font.sm, color: colors.muted },
  kpiValue: { fontSize: font.xxl, fontWeight: "800", color: colors.onSurface, marginTop: 4 },
  nextCard: { backgroundColor: colors.brandPrimary, padding: spacing.lg, borderRadius: radius.lg, gap: 4 },
  nextLabel: { fontSize: font.sm, color: colors.brandTertiary, fontWeight: "700", letterSpacing: 1 },
  nextName: { fontSize: font.xxl, fontWeight: "700", color: colors.onBrandPrimary, marginTop: 4 },
  nextMeta: { fontSize: font.base, color: colors.brandTertiary, textTransform: "capitalize" },
  callBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.onBrandPrimary, padding: spacing.md, borderRadius: radius.md, marginTop: spacing.md },
  callBtnText: { color: colors.brandPrimary, fontWeight: "700", fontSize: font.base },
  sectionTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md },
  empty: { alignItems: "center", padding: spacing.xl },
  emptyText: { color: colors.muted },
  apptCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  tokenBubble: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  tokenText: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary },
  apptName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  apptMeta: { fontSize: font.sm, color: colors.muted, textTransform: "capitalize" },
  smallBtn: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  prescInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, minHeight: 140, textAlignVertical: "top" },
  saveBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.md },
  saveBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
});
