import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Modal, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";

const actions = [
  { label: "Arrived", path: "/reception/mark_arrived", color: colors.info, icon: "checkmark-circle" as const },
  { label: "Start", path: "/reception/start_consultation", color: colors.brandPrimary, icon: "play" as const },
  { label: "Complete", path: "/reception/complete", color: colors.success, icon: "checkmark-done" as const },
  { label: "Skip", path: "/reception/skip", color: colors.warning, icon: "arrow-forward" as const },
];

export default function ReceptionistDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [doctors, setDoctors] = useState<any[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyName, setEmergencyName] = useState("");

  const load = useCallback(async () => {
    try {
      const docs = await api.get("/reception/doctors");
      setDoctors(docs);
      const doctorId = selectedDoc || (docs[0] && docs[0].id);
      if (doctorId && !selectedDoc) setSelectedDoc(doctorId);
      if (doctorId) {
        const q = await api.get(`/reception/queue?doctor_id=${doctorId}`);
        setQueue(q);
      }
    } catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [selectedDoc]);

  useFocusEffect(useCallback(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]));

  const doAction = async (path: string, appt_id: string) => {
    try { await api.post(path, { appointment_id: appt_id }); load(); } catch (e) { console.log(e); }
  };

  const insertEmergency = async () => {
    if (!selectedDoc) return;
    try {
      await api.post("/reception/emergency_insert", { doctor_id: selectedDoc, patient_name: emergencyName || "Emergency Patient" });
      setEmergencyOpen(false); setEmergencyName(""); load();
    } catch (e) { console.log(e); }
  };

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  const activeQueue = queue.filter((q) => q.status !== "cancelled");
  const stats = {
    total: activeQueue.length,
    arrived: activeQueue.filter((q) => q.status === "arrived").length,
    completed: activeQueue.filter((q) => q.status === "completed").length,
    pending: activeQueue.filter((q) => q.status === "booked").length,
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Reception</Text>
          <Text style={styles.name}>{user?.full_name}</Text>
        </View>
        <Pressable onPress={async () => { await signOut(); router.replace("/login"); }} testID="reception-logout" style={styles.iconBtn}>
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      <View style={styles.docPickerWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.docPickerRow}>
          {doctors.map((d) => {
            const active = selectedDoc === d.id;
            return (
              <Pressable key={d.id} testID={`select-doc-${d.id}`} onPress={() => setSelectedDoc(d.id)} style={[styles.docChip, active && styles.docChipActive]}>
                <Text style={[styles.docChipText, active && { color: colors.onBrandPrimary }]} numberOfLines={1}>{d.full_name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.kpiRow}>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Total</Text><Text style={styles.kpiValue}>{stats.total}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Arrived</Text><Text style={[styles.kpiValue, { color: colors.warning }]}>{stats.arrived}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Completed</Text><Text style={[styles.kpiValue, { color: colors.success }]}>{stats.completed}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Pending</Text><Text style={[styles.kpiValue, { color: colors.info }]}>{stats.pending}</Text></View>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        {activeQueue.length === 0 ? (
          <View style={styles.empty}><Ionicons name="people-outline" size={44} color={colors.muted} /><Text style={styles.emptyText}>No patients yet</Text></View>
        ) : (
          activeQueue.map((a) => (
            <View key={a.id} style={styles.apptCard}>
              <View style={[styles.tokenBubble, a.status === "in_consultation" && { backgroundColor: colors.brandPrimary }]}>
                <Text style={[styles.tokenText, a.status === "in_consultation" && { color: colors.onBrandPrimary }]}>#{a.token_number}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.apptName}>{a.patient_name}</Text>
                <Text style={styles.apptMeta}>{a.slot} · <Text style={{ color: colors.brandPrimary }}>{a.status.replace("_", " ")}</Text></Text>
              </View>
              <View style={styles.actionsRow}>
                {actions.map((act) => (
                  <Pressable key={act.label} testID={`action-${act.label.toLowerCase()}-${a.id}`} onPress={() => doAction(act.path, a.id)} style={[styles.actBtn, { backgroundColor: act.color + "22" }]}>
                    <Ionicons name={act.icon} size={16} color={act.color} />
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <Pressable testID="emergency-insert-btn" onPress={() => setEmergencyOpen(true)} style={styles.fab}>
        <Ionicons name="alert" size={22} color="#fff" />
        <Text style={styles.fabText}>Emergency</Text>
      </Pressable>

      <Modal transparent visible={emergencyOpen} animationType="slide" onRequestClose={() => setEmergencyOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEmergencyOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Emergency Insert</Text>
            <Text style={styles.sheetSub}>This patient will be pushed to the top of the queue.</Text>
            <TextInput
              testID="emergency-name-input"
              placeholder="Patient name"
              placeholderTextColor={colors.muted}
              value={emergencyName}
              onChangeText={setEmergencyName}
              style={styles.emergencyInput}
            />
            <Pressable testID="emergency-confirm" onPress={insertEmergency} style={styles.emergencyBtn}>
              <Text style={styles.emergencyBtnText}>Insert as Priority</Text>
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
  docPickerWrap: { paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider, backgroundColor: colors.surfaceSecondary },
  docPickerRow: { gap: spacing.sm, paddingHorizontal: spacing.lg },
  docChip: { flexShrink: 0, paddingHorizontal: spacing.md, height: 36, justifyContent: "center", borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, maxWidth: 200 },
  docChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  docChipText: { fontSize: font.sm, color: colors.onSurface, fontWeight: "500" },
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  kpiCard: { flex: 1, minWidth: "22%", backgroundColor: colors.surface, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, alignItems: "center" },
  kpiLabel: { fontSize: 11, color: colors.muted },
  kpiValue: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  scroll: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 120 },
  apptCard: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  tokenBubble: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  tokenText: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary },
  apptName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  apptMeta: { fontSize: font.sm, color: colors.muted, textTransform: "capitalize" },
  actionsRow: { flexDirection: "row", gap: 6 },
  actBtn: { width: 32, height: 32, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  fab: { position: "absolute", bottom: 24, right: 20, backgroundColor: colors.error, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", gap: 6, elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
  fabText: { color: "#fff", fontWeight: "700", fontSize: font.base },
  empty: { alignItems: "center", padding: spacing.xxl, gap: spacing.md },
  emptyText: { color: colors.muted, fontSize: font.base },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  emergencyInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface },
  emergencyBtn: { backgroundColor: colors.error, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.md },
  emergencyBtnText: { color: "#fff", fontSize: font.lg, fontWeight: "700" },
});
