import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import CalendarSummary from "@/src/components/CalendarSummary";

const POLL_INTERVAL_MS = 10_000;

const actions = [
  { label: "Arrived",  path: "/reception/mark_arrived",      color: colors.info,         icon: "checkmark-circle" as const },
  { label: "Start",    path: "/reception/start_consultation", color: colors.brandPrimary, icon: "play"             as const },
  { label: "Complete", path: "/reception/complete",           color: colors.success,      icon: "checkmark-done"   as const },
  { label: "Skip",     path: "/reception/skip",               color: colors.warning,      icon: "arrow-forward"    as const },
];

const GENDERS = ["Male", "Female", "Other"];

export default function ReceptionistDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [doctors, setDoctors]       = useState<any[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [queue, setQueue]           = useState<any[]>([]);
  const [summaryData, setSummaryData] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyName, setEmergencyName] = useState("");

  // Refer patient state
  const [referModalOpen, setReferModalOpen] = useState(false);
  const [referAppt, setReferAppt]           = useState<any | null>(null);
  const [targetDocId, setTargetDocId]       = useState<string>("");
  const [referReason, setReferReason]       = useState<string>("");
  const [referLoading, setReferLoading]     = useState(false);
  const [referError, setReferError]         = useState<string | null>(null);

  // Add Patient sheet
  const [addOpen, setAddOpen]       = useState(false);
  const [pName, setPName]           = useState("");
  const [pMobile, setPMobile]       = useState("");
  const [pAge, setPAge]             = useState("");
  const [pGender, setPGender]       = useState<string | null>(null);
  const [pSymptoms, setPSymptoms]   = useState("");
  const [pAddress, setPAddress]     = useState("");
  const [pSlot, setPSlot]           = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError]     = useState<string | null>(null);
  const [addToast, setAddToast]     = useState<string | null>(null);

  const wsRef     = useRef<WebSocket | null>(null);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFocused = useRef(true);
  const [wsConnected, setWsConnected] = useState(false);

  // Use a ref so load() always reads the latest selectedDoc without stale closure
  const selectedDocRef = useRef<string | null>(null);
  useEffect(() => { selectedDocRef.current = selectedDoc; }, [selectedDoc]);

  const load = useCallback(async (silent = false, bypassCache = false) => {
    const shouldBypass = silent || bypassCache;
    try {
      const [docs, sum] = await Promise.all([
        api.get("/reception/doctors", { bypassCache: shouldBypass }),
        api.get("/appointments/calendar-summary", { bypassCache: shouldBypass }).catch(() => []),
      ]);
      setDoctors(docs);
      setSummaryData(sum || []);
      const doctorId = selectedDocRef.current || (docs[0]?.id ?? null);
      if (doctorId && !selectedDocRef.current) {
        setSelectedDoc(doctorId);
        selectedDocRef.current = doctorId;
      }
      if (doctorId) {
        const q = await api.get(`/reception/queue?doctor_id=${doctorId}`, { bypassCache: shouldBypass });
        setQueue(q);
      }
    } catch (err: any) {
      if (err?.message && (err.message.includes("401") || err.message.includes("authenticated") || err.message.includes("expired"))) {
        await signOut();
        router.replace("/login");
      }
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, [router, signOut]);

  // WebSocket — re-subscribe when selected doctor changes
  useEffect(() => {
    if (!selectedDoc) return;

    if (wsRef.current) { try { wsRef.current.close(); } catch { /* ignore */ } wsRef.current = null; }

    const url = `${getBackendWebSocketBase()}/api/ws/queue/doctor/${selectedDoc}`;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
      ws.onmessage = () => { if (isFocused.current) load(true); };
      ws.onerror   = () => setWsConnected(false);
      ws.onclose   = () => {
        setWsConnected(false);
        if (isFocused.current && !timerRef.current) {
          timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
        }
      };
    } catch { setWsConnected(false); }

    return () => {
      if (wsRef.current) { try { wsRef.current.close(); } catch { /* ignore */ } wsRef.current = null; }
    };
  }, [selectedDoc, load]);

  useFocusEffect(
    useCallback(() => {
      isFocused.current = true;
      load();
      if (!wsConnected) {
        timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
      }
      return () => {
        isFocused.current = false;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
    }, [load, wsConnected]),
  );

  // Reload queue when user manually picks a different doctor
  useEffect(() => {
    if (!selectedDoc) return;
    api.get(`/reception/queue?doctor_id=${selectedDoc}`, { bypassCache: true })
      .then(setQueue)
      .catch(() => {});
  }, [selectedDoc]);

  const doAction = async (path: string, appt_id: string) => {
    try { await api.post(path, { appointment_id: appt_id }); load(true); } catch { /* ignore */ }
  };

  const insertEmergency = async () => {
    if (!selectedDoc) return;
    try {
      await api.post("/reception/emergency_insert", {
        doctor_id: selectedDoc,
        patient_name: emergencyName || "Emergency Patient",
      });
      setEmergencyOpen(false); setEmergencyName(""); load(true);
    } catch { /* ignore */ }
  };

  const openReferModal = (appt: any) => {
    setReferAppt(appt);
    const otherDocs = doctors.filter((d) => d.id !== selectedDoc);
    setTargetDocId(otherDocs[0]?.id || "");
    setReferReason("");
    setReferError(null);
    setReferModalOpen(true);
  };

  const handleReferSubmit = async () => {
    if (!referAppt || !targetDocId) {
      setReferError("Please select a target doctor");
      return;
    }
    setReferLoading(true);
    setReferError(null);
    try {
      const res = await api.post("/reception/refer", {
        appointment_id: referAppt.id,
        target_doctor_id: targetDocId,
        reason: referReason.trim() || undefined,
      });
      const targetDoc = doctors.find((d) => d.id === targetDocId);
      setAddToast(`Referred ${referAppt.patient_name} to ${targetDoc?.full_name || "Doctor"} · Token #${res.appointment?.token_number}`);
      setReferModalOpen(false);
      setReferAppt(null);
      load(true);
      setTimeout(() => setAddToast(null), 3500);
    } catch (e: any) {
      setReferError(e.message || "Failed to refer patient");
    } finally {
      setReferLoading(false);
    }
  };

  const resetAddForm = () => {
    setPName(""); setPMobile(""); setPAge(""); setPGender(null);
    setPSymptoms(""); setPAddress(""); setPSlot(""); setAddError(null);
  };

  const onAddPatient = async () => {
    setAddError(null);
    if (!pName.trim()) return setAddError("Name is required");
    if (pMobile.replace(/[^0-9]/g, "").length < 10) return setAddError("Enter valid 10-digit mobile");
    if (!selectedDoc) return setAddError("Select a doctor first");
    setAddLoading(true);
    try {
      const res = await api.post("/reception/add-patient", {
        full_name: pName.trim(),
        mobile: pMobile.replace(/[^0-9]/g, ""),
        age: pAge ? parseInt(pAge, 10) : undefined,
        gender: pGender,
        symptoms: pSymptoms || undefined,
        address: pAddress || undefined,
        doctor_id: selectedDoc,
        slot: pSlot || "Walk-in",
      });
      setAddToast(`Added: ${res.patient.full_name} · Token #${res.appointment?.token_number}`);
      resetAddForm(); setAddOpen(false); load(true);
      setTimeout(() => setAddToast(null), 3000);
    } catch (e: any) {
      setAddError(e.message || "Could not add patient");
    } finally { setAddLoading(false); }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />
      </SafeAreaView>
    );
  }

  const activeQueue = queue.filter((q) => q.status !== "cancelled");
  const stats = {
    total:     activeQueue.length,
    arrived:   activeQueue.filter((q) => q.status === "arrived").length,
    completed: activeQueue.filter((q) => q.status === "completed").length,
    pending:   activeQueue.filter((q) => q.status === "booked").length,
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Reception</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.name}>{user?.full_name}</Text>
            <View style={[styles.liveDot, wsConnected && { backgroundColor: colors.success }]} />
          </View>
        </View>
        <Pressable onPress={async () => { await signOut(); router.replace("/login"); }} testID="reception-logout" style={styles.iconBtn}>
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      {/* ── Doctor picker ── */}
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

      {/* ── KPIs ── */}
      <View style={styles.kpiRow}>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Total</Text><Text style={styles.kpiValue}>{stats.total}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Arrived</Text><Text style={[styles.kpiValue, { color: colors.warning }]}>{stats.arrived}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Completed</Text><Text style={[styles.kpiValue, { color: colors.success }]}>{stats.completed}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Pending</Text><Text style={[styles.kpiValue, { color: colors.info }]}>{stats.pending}</Text></View>
      </View>

      {/* ── Queue list ── */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
      >
        {/* ── View-Only Calendar Summary ── */}
        <Text style={{ fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginBottom: spacing.sm }}>Daily Patient Calendar</Text>
        <CalendarSummary summaryData={summaryData} />

        {activeQueue.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No patients yet. Tap &quot;+ Add Patient&quot; to register a walk-in.</Text>
          </View>
        ) : (
          activeQueue.map((a) => (
            <View key={a.id} style={styles.apptCard}>
              <View style={[styles.tokenBubble, a.status === "in_consultation" && { backgroundColor: colors.brandPrimary }]}>
                <Text style={[styles.tokenText, a.status === "in_consultation" && { color: colors.onBrandPrimary }]}>#{a.token_number}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.apptName}>{a.patient_name}</Text>
                <Text style={styles.apptMeta}>{a.slot} · <Text style={{ color: colors.brandPrimary }}>{a.status.replace("_", " ")}</Text></Text>
                {a.symptoms ? <Text style={styles.symptoms} numberOfLines={1}>💊 {a.symptoms}</Text> : null}
              </View>
              <View style={styles.actionsRow}>
                {doctors.length > 1 && a.status !== "completed" && (
                  <Pressable testID={`action-refer-${a.id}`} onPress={() => openReferModal(a)} style={[styles.actBtn, { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}>
                    <Ionicons name="swap-horizontal" size={16} color={colors.brandPrimary} />
                  </Pressable>
                )}
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

      {/* ── Toast ── */}
      {addToast ? (
        <View style={styles.toast} testID="add-patient-toast">
          <Ionicons name="checkmark-circle" size={18} color="#fff" />
          <Text style={styles.toastText}>{addToast}</Text>
        </View>
      ) : null}

      {/* ── FABs ── */}
      <View style={styles.fabRow}>
        <Pressable testID="add-patient-btn" onPress={() => setAddOpen(true)} style={[styles.fab, { backgroundColor: colors.brandPrimary }]}>
          <Ionicons name="person-add" size={20} color="#fff" />
          <Text style={styles.fabText}>Add Patient</Text>
        </Pressable>
        <Pressable testID="emergency-insert-btn" onPress={() => setEmergencyOpen(true)} style={[styles.fab, { backgroundColor: colors.error }]}>
          <Ionicons name="alert" size={20} color="#fff" />
          <Text style={styles.fabText}>Emergency</Text>
        </Pressable>
      </View>

      {/* ── Add Patient Modal ── */}
      <Modal transparent visible={addOpen} animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAddOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ justifyContent: "flex-end", flex: 1 }}>
            <Pressable style={[styles.sheet, { maxHeight: "92%", minHeight: "70%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={styles.sheetTitle}>Add Walk-in Patient</Text>
                <Text style={styles.sheetSub}>Patient will be added to the queue for the selected doctor.</Text>
                <Text style={styles.label}>Full Name*</Text>
                <TextInput testID="ap-name" placeholder="Patient name" placeholderTextColor={colors.muted} value={pName} onChangeText={setPName} style={styles.input} />
                <Text style={styles.label}>Mobile Number*</Text>
                <View style={styles.mobileWrap}>
                  <View style={styles.ccBadge}><Text style={styles.ccText}>+91</Text></View>
                  <TextInput testID="ap-mobile" placeholder="98765 43210" placeholderTextColor={colors.muted} value={pMobile} onChangeText={(t) => setPMobile(t.replace(/[^0-9]/g, "").slice(0, 10))} keyboardType="phone-pad" style={styles.mobileInput} />
                </View>
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Age</Text>
                    <TextInput testID="ap-age" placeholder="32" placeholderTextColor={colors.muted} value={pAge} onChangeText={(t) => setPAge(t.replace(/[^0-9]/g, "").slice(0, 3))} keyboardType="number-pad" style={styles.input} />
                  </View>
                  <View style={{ flex: 2 }}>
                    <Text style={styles.label}>Gender</Text>
                    <View style={styles.genderRow}>
                      {GENDERS.map((g) => (
                        <Pressable key={g} testID={`ap-gender-${g}`} onPress={() => setPGender(g)} style={[styles.genderChip, pGender === g && styles.genderChipActive]}>
                          <Text style={[styles.genderText, pGender === g && { color: colors.onBrandPrimary }]}>{g}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </View>
                <Text style={styles.label}>Symptoms / Reason</Text>
                <TextInput testID="ap-symptoms" placeholder="Fever, cough..." placeholderTextColor={colors.muted} value={pSymptoms} onChangeText={setPSymptoms} multiline style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} />
                <Text style={styles.label}>Address</Text>
                <TextInput testID="ap-address" placeholder="Area, city" placeholderTextColor={colors.muted} value={pAddress} onChangeText={setPAddress} style={styles.input} />
                <Text style={styles.label}>Slot (optional)</Text>
                <TextInput testID="ap-slot" placeholder="e.g. 11:00 AM (leave blank for Walk-in)" placeholderTextColor={colors.muted} value={pSlot} onChangeText={setPSlot} style={styles.input} />
                {addError ? <Text style={styles.error}>{addError}</Text> : null}
                <Pressable testID="ap-submit" onPress={onAddPatient} disabled={addLoading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                  {addLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Add to Queue</Text>}
                </Pressable>
                <View style={{ height: spacing.xl }} />
              </ScrollView>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* ── Emergency Modal ── */}
      <Modal transparent visible={emergencyOpen} animationType="slide" onRequestClose={() => setEmergencyOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setEmergencyOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Emergency Insert</Text>
            <Text style={styles.sheetSub}>This patient will be pushed to the top of the queue.</Text>
            <TextInput testID="emergency-name-input" placeholder="Patient name" placeholderTextColor={colors.muted} value={emergencyName} onChangeText={setEmergencyName} style={styles.emergencyInput} />
            <Pressable testID="emergency-confirm" onPress={insertEmergency} style={styles.emergencyBtn}>
              <Text style={styles.emergencyBtnText}>Insert as Priority</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Refer / Transfer Patient Modal ── */}
      <Modal transparent visible={referModalOpen} animationType="slide" onRequestClose={() => setReferModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setReferModalOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Refer / Transfer Patient</Text>
            <Text style={styles.sheetSub}>
              Transfer {referAppt?.patient_name} (Token #{referAppt?.token_number}) to another doctor in the hospital.
            </Text>

            <Text style={styles.label}>Select Target Doctor*</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginVertical: 8 }}>
              {doctors
                .filter((d) => d.id !== selectedDoc)
                .map((d) => {
                  const isTarget = targetDocId === d.id;
                  return (
                    <Pressable
                      key={d.id}
                      testID={`refer-target-${d.id}`}
                      onPress={() => setTargetDocId(d.id)}
                      style={[
                        styles.docChip,
                        isTarget && styles.docChipActive,
                      ]}
                    >
                      <Text style={[styles.docChipText, isTarget && { color: colors.onBrandPrimary }]}>
                        {d.full_name} ({d.specialty || "General"})
                      </Text>
                    </Pressable>
                  );
                })}
            </ScrollView>

            <Text style={styles.label}>Reason for Transfer (Optional)</Text>
            <TextInput
              testID="refer-reason-input"
              placeholder="e.g. Doctor on emergency / specialist consultation"
              placeholderTextColor={colors.muted}
              value={referReason}
              onChangeText={setReferReason}
              style={styles.input}
            />

            {referError ? <Text style={styles.error}>{referError}</Text> : null}

            <Pressable testID="refer-confirm-btn" onPress={handleReferSubmit} disabled={referLoading} style={styles.primaryBtn}>
              {referLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Confirm Transfer</Text>}
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
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted, marginLeft: 4 },
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
  scroll: { padding: spacing.lg, gap: spacing.sm, paddingBottom: 140 },
  apptCard: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  tokenBubble: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  tokenText: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary },
  apptName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  apptMeta: { fontSize: font.sm, color: colors.muted, textTransform: "capitalize" },
  symptoms: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 2 },
  actionsRow: { flexDirection: "row", gap: 6 },
  actBtn: { width: 32, height: 32, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  fabRow: { position: "absolute", bottom: 24, left: 20, right: 20, flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  fab: { flex: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.pill, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, elevation: 4, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
  fabText: { color: "#fff", fontWeight: "700", fontSize: font.base },
  empty: { alignItems: "center", padding: spacing.xxl, gap: spacing.md },
  emptyText: { color: colors.muted, fontSize: font.base, textAlign: "center" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: spacing.xs, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: font.base, color: colors.onSurface, backgroundColor: colors.surface },
  mobileWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, overflow: "hidden" },
  ccBadge: { paddingHorizontal: spacing.md, paddingVertical: 12, backgroundColor: colors.surfaceSecondary, borderRightWidth: 1, borderRightColor: colors.border },
  ccText: { fontSize: font.base, color: colors.onSurface, fontWeight: "600" },
  mobileInput: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: font.base, color: colors.onSurface },
  genderRow: { flexDirection: "row", gap: 6, marginTop: spacing.xs },
  genderChip: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  genderChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  genderText: { fontSize: font.sm, color: colors.onSurface, fontWeight: "500" },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.sm },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
  emergencyInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface },
  emergencyBtn: { backgroundColor: colors.error, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.md },
  emergencyBtnText: { color: "#fff", fontSize: font.lg, fontWeight: "700" },
  toast: { position: "absolute", bottom: 100, left: 20, right: 20, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, elevation: 5 },
  toastText: { color: "#fff", fontWeight: "600", flex: 1 },
});
