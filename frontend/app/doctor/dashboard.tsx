import { useCallback, useEffect, useRef, useState } from "react";
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

const rowActions = [
  { label: "Arrived", path: "/reception/mark_arrived", color: colors.info, icon: "checkmark-circle" as const, showOn: ["booked"] },
  { label: "Call", path: "/reception/start_consultation", color: colors.brandPrimary, icon: "mic" as const, showOn: ["arrived", "booked"] },
  { label: "Done", path: "/reception/complete", color: colors.success, icon: "checkmark-done" as const, showOn: ["in_consultation", "arrived"] },
  { label: "Skip", path: "/reception/skip", color: colors.warning, icon: "arrow-forward" as const, showOn: ["booked", "arrived"] },
];

const STATUS_COLORS: Record<string, string> = {
  booked: colors.info,
  arrived: colors.warning,
  in_consultation: colors.brandPrimary,
  completed: colors.success,
  skipped: colors.muted,
};

const WS_BASE = (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/^http/, "ws");

export default function DoctorDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [data, setData] = useState<any | null>(null);
  const [appts, setAppts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [prescOpen, setPrescOpen] = useState<any | null>(null);
  const [prescText, setPrescText] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editFees, setEditFees] = useState("");
  const [editTimings, setEditTimings] = useState("");
  const [editBio, setEditBio] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      const [d, a] = await Promise.all([api.get("/doctor/dashboard"), api.get("/doctor/appointments")]);
      setData(d);
      setAppts(a);
    } catch (e) { console.log(e); }
    finally { if (!silent) setLoading(false); setRefreshing(false); }
  }, []);

  // WebSocket subscription per doctor id
  useEffect(() => {
    const doctorId = data?.doctor?.id;
    if (!doctorId || !WS_BASE) return;
    if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    try {
      const ws = new WebSocket(`${WS_BASE}/api/ws/queue/doctor/${doctorId}`);
      wsRef.current = ws;
      ws.onopen = () => setWsConnected(true);
      ws.onmessage = () => { load(true); };
      ws.onerror = () => setWsConnected(false);
      ws.onclose = () => setWsConnected(false);
    } catch { setWsConnected(false); }
    return () => {
      if (wsRef.current) { try { wsRef.current.close(); } catch {} wsRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.doctor?.id]);

  useFocusEffect(useCallback(() => {
    load();
    const t = setInterval(() => load(true), 15000);
    return () => clearInterval(t);
  }, [load]));

  const changeStatus = async (status: string) => {
    try { await api.post("/doctor/status", { status }); load(true); } catch (e) { console.log(e); }
  };

  const doAction = async (path: string, appt_id: string) => {
    try { await api.post(path, { appointment_id: appt_id }); load(true); } catch (e) { console.log(e); }
  };

  const savePresc = async () => {
    if (!prescOpen) return;
    try {
      await api.post("/doctor/prescription", { appointment_id: prescOpen.id, prescription: prescText });
      setPrescOpen(null);
      setPrescText("");
      load(true);
    } catch (e) { console.log(e); }
  };

  const openEditProfile = () => {
    setEditFees(String(data?.doctor?.fees ?? ""));
    setEditTimings(data?.doctor?.timings ?? "");
    setEditBio(data?.doctor?.bio ?? "");
    setEditOpen(true);
  };

  const saveProfile = async () => {
    setEditSaving(true);
    try {
      const updates: any = {};
      if (editFees && parseInt(editFees, 10) !== data?.doctor?.fees) updates.fees = parseInt(editFees, 10);
      if (editTimings && editTimings !== data?.doctor?.timings) updates.timings = editTimings;
      if (editBio !== (data?.doctor?.bio || "")) updates.bio = editBio;
      if (Object.keys(updates).length > 0) {
        await api.post("/doctor/update_profile", updates);
      }
      setEditOpen(false);
      load(true);
    } catch (e) { console.log(e); }
    finally { setEditSaving(false); }
  };

  if (loading || !data) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  const currentMode = data.status;
  const nextPatient = appts.find((a) => a.status === "in_consultation")
    || appts.find((a) => a.status === "arrived")
    || appts.find((a) => a.status === "booked");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Good day, Doctor</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.name}>{user?.full_name}</Text>
            <View style={[styles.liveDot, wsConnected && { backgroundColor: colors.success }]} />
          </View>
        </View>
        <Pressable onPress={openEditProfile} testID="doctor-edit-profile" style={styles.iconBtn}>
          <Ionicons name="create-outline" size={20} color={colors.brandPrimary} />
        </Pressable>
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
                <Ionicons name="mic" size={18} color={colors.brandPrimary} />
                <Text style={styles.callBtnText}>Call Next Patient</Text>
              </Pressable>
            ) : (
              <Pressable testID="complete-btn" onPress={() => doAction("/reception/complete", nextPatient.id)} style={[styles.callBtn, { backgroundColor: colors.success }]}>
                <Ionicons name="checkmark-circle" size={18} color="#fff" />
                <Text style={[styles.callBtnText, { color: "#fff" }]}>Mark Consultation Done</Text>
              </Pressable>
            )}
          </View>
        )}

        <Text style={styles.sectionTitle}>Today&apos;s Schedule</Text>
        {appts.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No patients scheduled today</Text></View>
        ) : (
          appts.map((a) => {
            const statusColor = STATUS_COLORS[a.status] || colors.muted;
            const availableActions = rowActions.filter((ra) => ra.showOn.includes(a.status));
            const isDone = a.status === "completed";
            return (
              <View key={a.id} style={[styles.apptCard, isDone && { opacity: 0.6 }]}>
                <View style={[styles.tokenBubble, a.status === "in_consultation" && { backgroundColor: colors.brandPrimary }]}>
                  <Text style={[styles.tokenText, a.status === "in_consultation" && { color: colors.onBrandPrimary }]}>#{a.token_number}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.apptName}>{a.patient_name}</Text>
                  <View style={styles.metaRow}>
                    <Text style={styles.apptMeta}>{a.slot}</Text>
                    <View style={[styles.statusPill, { backgroundColor: statusColor + "22" }]}>
                      <Text style={[styles.statusText, { color: statusColor }]}>{a.status.replace("_", " ")}</Text>
                    </View>
                  </View>
                  {a.symptoms ? <Text style={styles.symptoms} numberOfLines={1}>💊 {a.symptoms}</Text> : null}
                </View>
                <View style={styles.rowActions}>
                  {availableActions.map((act) => (
                    <Pressable
                      key={act.label}
                      testID={`doc-action-${act.label.toLowerCase()}-${a.id}`}
                      onPress={() => doAction(act.path, a.id)}
                      style={[styles.rowActBtn, { backgroundColor: act.color + "22" }]}
                    >
                      <Ionicons name={act.icon} size={14} color={act.color} />
                    </Pressable>
                  ))}
                  <Pressable testID={`presc-${a.id}`} onPress={() => { setPrescOpen(a); setPrescText(a.prescription || ""); }} style={[styles.rowActBtn, { backgroundColor: colors.brandSecondary }]}>
                    <Ionicons name="document-text-outline" size={14} color={colors.brandPrimary} />
                  </Pressable>
                </View>
              </View>
            );
          })
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

      <Modal transparent visible={editOpen} animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEditOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Update My Profile</Text>
            <Text style={styles.sheetSub}>Update your consultation fees & timings</Text>
            <Text style={styles.editLabel}>Consultation Fees (₹)</Text>
            <TextInput testID="edit-fees" value={editFees} onChangeText={(v) => setEditFees(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" placeholder="500" placeholderTextColor={colors.muted} style={styles.editInput} />
            <Text style={styles.editLabel}>Timings</Text>
            <TextInput testID="edit-timings" value={editTimings} onChangeText={setEditTimings} placeholder="10:00 AM - 4:00 PM" placeholderTextColor={colors.muted} style={styles.editInput} />
            <Text style={styles.editLabel}>Bio (optional)</Text>
            <TextInput testID="edit-bio" value={editBio} onChangeText={setEditBio} multiline placeholder="Short bio" placeholderTextColor={colors.muted} style={[styles.editInput, { minHeight: 80, textAlignVertical: "top" }]} />
            <Pressable testID="edit-save" onPress={saveProfile} disabled={editSaving} style={styles.saveBtn}>
              {editSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", padding: spacing.lg, alignItems: "center", gap: spacing.sm },
  hello: { fontSize: font.base, color: colors.muted },
  name: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted, marginLeft: 4 },
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
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4, flexWrap: "wrap" },
  apptMeta: { fontSize: font.sm, color: colors.muted },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  statusText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  symptoms: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 2 },
  rowActions: { flexDirection: "row", gap: 4, flexWrap: "wrap", maxWidth: 120, justifyContent: "flex-end" },
  rowActBtn: { width: 30, height: 30, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  smallBtn: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  prescInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, minHeight: 140, textAlignVertical: "top" },
  editLabel: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: 4, fontWeight: "600" },
  editInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, backgroundColor: colors.surface },
  saveBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.md },
  saveBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
});
