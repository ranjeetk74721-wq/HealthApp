import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { api, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import CalendarSummary from "@/src/components/CalendarSummary";
import DoctorSessionBar from "@/src/components/DoctorSessionBar";

const POLL_INTERVAL_MS = 10_000;
const GENDERS = ["Male", "Female", "Other"];

function formatTime(isoStr?: string | null): string {
  if (!isoStr) return "--";
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  } catch {
    return isoStr;
  }
}

export default function ReceptionistDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [doctors, setDoctors] = useState<any[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docSession, setDocSession] = useState<any | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [summaryData, setSummaryData] = useState<any[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toLocaleDateString("en-CA")
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  // Network and stale tracking
  const [isOnline, setIsOnline] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);

  // Modals
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [emergencyName, setEmergencyName] = useState("");

  // Refer patient state
  const [referModalOpen, setReferModalOpen] = useState(false);
  const [referAppt, setReferAppt] = useState<any | null>(null);
  const [targetDocId, setTargetDocId] = useState<string>("");
  const [referReason, setReferReason] = useState<string>("");
  const [referLoading, setReferLoading] = useState(false);
  const [referError, setReferError] = useState<string | null>(null);

  // Reschedule state
  const [rescheduleModalOpen, setRescheduleModalOpen] = useState(false);
  const [rescheduleAppt, setRescheduleAppt] = useState<any | null>(null);
  const [rescheduleDate, setRescheduleDate] = useState("");
  const [rescheduleSlot, setRescheduleSlot] = useState("");
  const [rescheduleLoading, setRescheduleLoading] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  // Add Patient sheet (preserves inputs on error)
  const [addOpen, setAddOpen] = useState(false);
  const [pName, setPName] = useState("");
  const [pMobile, setPMobile] = useState("");
  const [pAge, setPAge] = useState("");
  const [pGender, setPGender] = useState<string | null>(null);
  const [pSymptoms, setPSymptoms] = useState("");
  const [pAddress, setPAddress] = useState("");
  const [pSlot, setPSlot] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addToast, setAddToast] = useState<string | null>(null);

  // View completed toggle
  const [showCompleted, setShowCompleted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFocused = useRef(true);
  const [wsConnected, setWsConnected] = useState(false);

  // Use a ref so load() always reads the latest selectedDoc without stale closure
  const selectedDocRef = useRef<string | null>(null);
  useEffect(() => { selectedDocRef.current = selectedDoc; }, [selectedDoc]);

  // Online / Offline listeners
  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
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
          // Tab became active: immediately refresh authoritative state
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
        const [q, sessRes] = await Promise.all([
          api.get(`/reception/queue?doctor_id=${doctorId}&date=${selectedDate}`, { bypassCache: shouldBypass }),
          api.get(`/doctor/${doctorId}/session?date=${selectedDate}`, { bypassCache: shouldBypass }).catch(() => null),
        ]);
        setQueue(q || []);
        if (sessRes?.session) setDocSession(sessRes.session);
      }
      const nowStr = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
      setLastUpdated(nowStr);
      setIsStale(false);
    } catch (err: any) {
      setIsStale(true);
      if (err?.message && (err.message.includes("401") || err.message.includes("authenticated") || err.message.includes("expired"))) {
        await signOut();
        router.replace("/login");
      }
    } finally {
      if (!silent) setLoading(false);
      setRefreshing(false);
    }
  }, [router, signOut, selectedDate]);

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
      ws.onmessage = () => {
        if (isFocused.current && (Platform.OS !== "web" || document.visibilityState === "visible")) {
          load(true, true);
        }
      };
      ws.onerror = () => setWsConnected(false);
      ws.onclose = () => {
        setWsConnected(false);
        if (isFocused.current && !timerRef.current) {
          timerRef.current = setInterval(() => {
            if (Platform.OS !== "web" || document.visibilityState === "visible") {
              load(true);
            }
          }, POLL_INTERVAL_MS);
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
        timerRef.current = setInterval(() => {
          if (Platform.OS !== "web" || document.visibilityState === "visible") {
            load(true);
          }
        }, POLL_INTERVAL_MS);
      }
      return () => {
        isFocused.current = false;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
    }, [load, wsConnected]),
  );

  // Queue Action Handlers
  const handleAction = async (path: string, apptId: string, successMsg?: string) => {
    if (actionLoadingId) return; // Prevent double tap or concurrent actions
    setActionLoadingId(apptId);
    try {
      await api.post(path, { appointment_id: apptId });
      if (successMsg) {
        setAddToast(successMsg);
        setTimeout(() => setAddToast(null), 3000);
      }
      await load(true, true);
    } catch (err: any) {
      Alert.alert("Action Failed", err?.message || "Could not complete queue action");
    } finally {
      setActionLoadingId(null);
    }
  };

  const startConsultation = (appt: any) => {
    handleAction(
      "/reception/start_consultation",
      appt.id,
      `Consultation started for Token #${appt.token_number}`
    );
  };

  const completeConsultation = (appt: any) => {
    handleAction(
      "/reception/complete",
      appt.id,
      `Consultation completed for Token #${appt.token_number}. Patient record archived.`
    );
  };

  const skipPatient = (appt: any) => {
    handleAction(
      "/reception/skip",
      appt.id,
      `Token #${appt.token_number} skipped. Token preserved.`
    );
  };

  const rejoinQueue = (appt: any) => {
    handleAction(
      "/reception/rejoin",
      appt.id,
      `Token #${appt.token_number} rejoined active queue.`
    );
  };

  const markArrived = (appt: any) => {
    handleAction(
      "/reception/mark_arrived",
      appt.id,
      `Token #${appt.token_number} marked arrived.`
    );
  };

  const cancelAppointment = (appt: any) => {
    const doCancel = () => {
      handleAction(
        "/reception/cancel",
        appt.id,
        `Token #${appt.token_number} cancelled.`
      );
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Cancel appointment for Token #${appt.token_number} (${appt.patient_name})?`)) {
        doCancel();
      }
    } else {
      Alert.alert(
        "Cancel Appointment",
        `Cancel appointment for Token #${appt.token_number} (${appt.patient_name})?`,
        [
          { text: "No", style: "cancel" },
          { text: "Yes, Cancel", style: "destructive", onPress: doCancel },
        ]
      );
    }
  };

  const openRescheduleModal = (appt: any) => {
    setRescheduleAppt(appt);
    setRescheduleDate(appt.date || selectedDate);
    setRescheduleSlot(appt.slot || "");
    setRescheduleError(null);
    setRescheduleModalOpen(true);
  };

  const handleRescheduleSubmit = async () => {
    if (!rescheduleAppt || !rescheduleDate) {
      setRescheduleError("Please select a valid new date");
      return;
    }
    setRescheduleLoading(true);
    setRescheduleError(null);
    try {
      const res = await api.post("/reception/reschedule", {
        appointment_id: rescheduleAppt.id,
        new_date: rescheduleDate,
        new_slot: rescheduleSlot.trim() || undefined,
      });
      setAddToast(
        `Rescheduled to ${res.new_date} · New Token #${res.token_number}`
      );
      setRescheduleModalOpen(false);
      setRescheduleAppt(null);
      await load(true, true);
      setTimeout(() => setAddToast(null), 3500);
    } catch (err: any) {
      setRescheduleError(err?.message || "Failed to reschedule appointment");
    } finally {
      setRescheduleLoading(false);
    }
  };

  const sendAppointmentLink = async (appt: any) => {
    try {
      await api.post(`/reception/appointments/${appt.id}/send-link`, {});
      setAddToast(`Link sent to ${appt.patient_mobile || "patient"}`);
      setTimeout(() => setAddToast(null), 3500);
    } catch (err: any) {
      setAddToast(err.message || "Could not send link");
      setTimeout(() => setAddToast(null), 3500);
    }
  };

  const insertEmergency = async () => {
    if (!selectedDoc) return;
    try {
      await api.post("/reception/emergency_insert", {
        doctor_id: selectedDoc,
        patient_name: emergencyName || "Emergency Patient",
      });
      setEmergencyOpen(false);
      setEmergencyName("");
      load(true, true);
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
      setAddToast(
        `Referred ${referAppt.patient_name} to ${targetDoc?.full_name || "Doctor"} · Token #${res.appointment?.token_number}`
      );
      setReferModalOpen(false);
      setReferAppt(null);
      load(true, true);
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
        date: selectedDate,
      });
      setAddToast(`Added: ${res.patient.full_name} · Token #${res.appointment?.token_number}`);
      resetAddForm();
      setAddOpen(false);
      load(true, true);
      setTimeout(() => setAddToast(null), 3000);
    } catch (e: any) {
      // PRESERVE FORM INPUTS on error for weak connections!
      setAddError(e.message || "Could not add patient. Please check connection and retry.");
    } finally {
      setAddLoading(false);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} />
      </SafeAreaView>
    );
  }

  // Active queue vs Completed/History separation (Requirement 1)
  const activeQueue = queue.filter(
    (q) => q.status !== "completed" && q.status !== "cancelled"
  );
  const completedQueue = queue.filter((q) => q.status === "completed");

  const stats = {
    total: queue.filter((q) => q.status !== "cancelled").length,
    active: activeQueue.length,
    arrived: activeQueue.filter((q) => q.status === "arrived").length,
    consulting: activeQueue.filter((q) => q.status === "in_consultation").length,
    completed: completedQueue.length,
    skipped: activeQueue.filter((q) => q.status === "skipped").length,
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* ── Offline & Stale Status Banner (Requirement 6) ── */}
      {!isOnline ? (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline" size={16} color="#fff" />
          <Text style={styles.offlineBannerText}>
            Offline Mode · Displaying cached data {lastUpdated ? `(as of ${lastUpdated})` : ""}
          </Text>
        </View>
      ) : isStale ? (
        <View style={styles.staleBanner}>
          <Ionicons name="sync" size={14} color="#92400E" />
          <Text style={styles.staleBannerText}>
            Reconnecting... Queue data may be stale {lastUpdated ? `(as of ${lastUpdated})` : ""}
          </Text>
        </View>
      ) : null}

      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Reception Dashboard</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.name}>{user?.full_name}</Text>
            <View
              style={[
                styles.liveDot,
                wsConnected && isOnline ? { backgroundColor: colors.success } : { backgroundColor: colors.warning },
              ]}
            />
            <Text style={styles.syncText}>
              {wsConnected && isOnline ? "Live" : "Polling"}
              {lastUpdated ? ` · Updated ${lastUpdated}` : ""}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={async () => { await signOut(); router.replace("/login"); }}
          testID="reception-logout"
          style={styles.iconBtn}
        >
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      {/* ── Doctor selection (Requirement 5) ── */}
      <View style={styles.docPickerWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.docPickerRow}>
          {doctors.map((d) => {
            const active = selectedDoc === d.id;
            return (
              <Pressable
                key={d.id}
                testID={`select-doc-${d.id}`}
                onPress={() => setSelectedDoc(d.id)}
                style={[styles.docChip, active && styles.docChipActive]}
              >
                <Text style={[styles.docChipText, active && { color: colors.onBrandPrimary }]} numberOfLines={1}>
                  {d.full_name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* ── KPIs ── */}
      <View style={styles.kpiRow}>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Waiting</Text><Text style={styles.kpiValue}>{stats.active}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>In Cabin</Text><Text style={[styles.kpiValue, { color: colors.brandPrimary }]}>{stats.consulting}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Completed</Text><Text style={[styles.kpiValue, { color: colors.success }]}>{stats.completed}</Text></View>
        <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Skipped</Text><Text style={[styles.kpiValue, { color: colors.warning }]}>{stats.skipped}</Text></View>
      </View>

      {/* ── Main Dashboard Scroll (Layout order matching Requirement 5) ── */}
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true, true); }} />}
      >
        {/* 1. Doctor Session Timing & Availability Controls (Requirements 4 & 5) */}
        {selectedDoc && docSession && (
          <DoctorSessionBar
            doctorId={selectedDoc}
            doctorName={doctors.find((d) => d.id === selectedDoc)?.full_name || "Doctor"}
            session={docSession}
            waitingCount={activeQueue.filter((q) => ["booked", "arrived"].includes(q.status)).length}
            onRefresh={() => load(true, true)}
          />
        )}

        {/* 2. Today's Patient Bookings and Active Queue (Requirement 5) */}
        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={styles.sectionTitle}>
              Active Queue · {selectedDate}
            </Text>
            <Text style={styles.sectionSub}>
              {activeQueue.length} patient(s) waiting / consulting
            </Text>
          </View>
          <Pressable
            onPress={() => load(true, true)}
            style={styles.refreshBtn}
            testID="manual-refresh-btn"
          >
            <Ionicons name="refresh" size={16} color={colors.brandPrimary} />
            <Text style={styles.refreshBtnText}>Sync</Text>
          </Pressable>
        </View>

        {activeQueue.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No active patients waiting. Tap &quot;+ Add Patient&quot; to register a walk-in.</Text>
          </View>
        ) : (
          activeQueue.map((a) => {
            const isConsulting = a.status === "in_consultation";
            const isSkipped = a.status === "skipped";
            const isArrived = a.status === "arrived";
            const isBooked = a.status === "booked";
            const isItemBusy = actionLoadingId === a.id;

            return (
              <View key={a.id} style={[styles.apptCard, isConsulting && styles.apptCardConsulting]}>
                <View style={[styles.tokenBubble, isConsulting && { backgroundColor: colors.brandPrimary }]}>
                  <Text style={[styles.tokenText, isConsulting && { color: colors.onBrandPrimary }]}>
                    #{a.token_number}
                  </Text>
                </View>

                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.apptName}>{a.patient_name}</Text>
                    {isConsulting && (
                      <View style={styles.consultingBadge}>
                        <Text style={styles.consultingBadgeText}>CONSULTING</Text>
                      </View>
                    )}
                    {isSkipped && (
                      <View style={styles.skippedBadge}>
                        <Text style={styles.skippedBadgeText}>SKIPPED</Text>
                      </View>
                    )}
                  </View>

                  <Text style={styles.apptMeta}>
                    {a.slot} · <Text style={{ fontWeight: "600" }}>{a.status.replace("_", " ").toUpperCase()}</Text>
                    {a.consultation_started_at ? ` · Started ${formatTime(a.consultation_started_at)}` : ""}
                  </Text>
                  {a.symptoms ? <Text style={styles.symptoms} numberOfLines={1}>💊 {a.symptoms}</Text> : null}
                </View>

                {/* Patient-specific utility icons (SMS link & Transfer) */}
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginRight: 4 }}>
                  {a.patient_mobile ? (
                    <Pressable
                      testID={`action-send-link-${a.id}`}
                      onPress={() => sendAppointmentLink(a)}
                      style={[styles.smallIconBtn, { backgroundColor: colors.brandSecondary }]}
                    >
                      <Ionicons name="send" size={13} color={colors.brandPrimary} />
                    </Pressable>
                  ) : null}
                  {doctors.length > 1 && (
                    <Pressable
                      testID={`action-refer-${a.id}`}
                      onPress={() => openReferModal(a)}
                      style={[styles.smallIconBtn, { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}
                    >
                      <Ionicons name="swap-horizontal" size={14} color={colors.brandPrimary} />
                    </Pressable>
                  )}
                </View>

                {/* Relevant Queue Actions: Visible text label below every action icon (Requirement 5) */}
                <View style={styles.actionsContainer}>
                  {/* For BOOKED status */}
                  {isBooked && (
                    <>
                      <Pressable
                        testID={`action-arrived-${a.id}`}
                        onPress={() => markArrived(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="checkmark-circle-outline" size={18} color={colors.info} />
                        <Text style={styles.actionColBtnLabel}>Arrived</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-start-${a.id}`}
                        onPress={() => startConsultation(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, styles.actionColBtnPrimary, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="play" size={18} color="#fff" />
                        <Text style={[styles.actionColBtnLabel, { color: "#fff", fontWeight: "700" }]}>
                          Start Consultation
                        </Text>
                      </Pressable>

                      <Pressable
                        testID={`action-skip-${a.id}`}
                        onPress={() => skipPatient(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.warning} />
                        <Text style={styles.actionColBtnLabel}>Skip Patient</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-reschedule-${a.id}`}
                        onPress={() => openRescheduleModal(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="calendar-outline" size={18} color={colors.brandPrimary} />
                        <Text style={styles.actionColBtnLabel}>Reschedule</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-cancel-${a.id}`}
                        onPress={() => cancelAppointment(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        <Text style={[styles.actionColBtnLabel, { color: colors.error }]}>Cancel</Text>
                      </Pressable>
                    </>
                  )}

                  {/* For ARRIVED status */}
                  {isArrived && (
                    <>
                      <Pressable
                        testID={`action-start-${a.id}`}
                        onPress={() => startConsultation(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, styles.actionColBtnPrimary, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="play" size={18} color="#fff" />
                        <Text style={[styles.actionColBtnLabel, { color: "#fff", fontWeight: "700" }]}>
                          Start Consultation
                        </Text>
                      </Pressable>

                      <Pressable
                        testID={`action-skip-${a.id}`}
                        onPress={() => skipPatient(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.warning} />
                        <Text style={styles.actionColBtnLabel}>Skip Patient</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-reschedule-${a.id}`}
                        onPress={() => openRescheduleModal(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="calendar-outline" size={18} color={colors.brandPrimary} />
                        <Text style={styles.actionColBtnLabel}>Reschedule</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-cancel-${a.id}`}
                        onPress={() => cancelAppointment(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        <Text style={[styles.actionColBtnLabel, { color: colors.error }]}>Cancel</Text>
                      </Pressable>
                    </>
                  )}

                  {/* For IN_CONSULTATION status */}
                  {isConsulting && (
                    <Pressable
                      testID={`action-complete-${a.id}`}
                      onPress={() => completeConsultation(a)}
                      disabled={isItemBusy}
                      style={[styles.actionColBtn, styles.actionColBtnSuccess, isItemBusy && { opacity: 0.5 }]}
                    >
                      {isItemBusy ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <>
                          <Ionicons name="checkmark-done" size={20} color="#fff" />
                          <Text style={[styles.actionColBtnLabel, { color: "#fff", fontWeight: "700" }]}>
                            Complete Consultation
                          </Text>
                        </>
                      )}
                    </Pressable>
                  )}

                  {/* For SKIPPED status */}
                  {isSkipped && (
                    <>
                      <Pressable
                        testID={`action-rejoin-${a.id}`}
                        onPress={() => rejoinQueue(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, { backgroundColor: "#FEF3C7", borderColor: "#FCD34D" }, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="refresh-circle-outline" size={18} color="#B45309" />
                        <Text style={[styles.actionColBtnLabel, { color: "#92400E" }]}>
                          Rejoin Queue
                        </Text>
                      </Pressable>

                      <Pressable
                        testID={`action-cancel-${a.id}`}
                        onPress={() => cancelAppointment(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, isItemBusy && { opacity: 0.5 }]}
                      >
                        <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        <Text style={[styles.actionColBtnLabel, { color: colors.error }]}>Cancel</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
            );
          })
        )}

        {/* 3. Calendar / Date Selection placed BELOW the patient list (Requirement 5) */}
        <View style={styles.calendarSection}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Daily Patient Calendar</Text>
              <Text style={styles.sectionSub}>Selected Date: <Text style={{ fontWeight: "700", color: colors.brandPrimary }}>{selectedDate}</Text></Text>
            </View>
          </View>
          <CalendarSummary
            summaryData={summaryData}
            onSelectDate={(date) => {
              setSelectedDate(date);
            }}
          />
        </View>

        {/* 4. Completed / History Records Section (Preserving history, Requirement 1) */}
        <View style={styles.historySection}>
          <Pressable
            onPress={() => setShowCompleted(!showCompleted)}
            style={styles.historyHeader}
            testID="toggle-completed-records-btn"
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Ionicons name="file-tray-full-outline" size={18} color={colors.onSurface} />
              <Text style={styles.historyTitle}>
                Completed Records ({completedQueue.length})
              </Text>
            </View>
            <Ionicons
              name={showCompleted ? "chevron-up" : "chevron-down"}
              size={18}
              color={colors.muted}
            />
          </Pressable>

          {showCompleted && (
            <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
              {completedQueue.length === 0 ? (
                <Text style={styles.historyEmptyText}>No consultations completed yet today.</Text>
              ) : (
                completedQueue.map((item) => (
                  <View key={item.id} style={styles.historyItemCard}>
                    <View style={styles.historyToken}>
                      <Text style={styles.historyTokenText}>#{item.token_number}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.historyPatientName}>{item.patient_name}</Text>
                      <Text style={styles.historyTimeText}>
                        Started: {formatTime(item.consultation_started_at || item.started_at)} · Completed: {formatTime(item.consultation_completed_at || item.completed_at)}
                      </Text>
                    </View>
                    <View style={styles.completedBadge}>
                      <Ionicons name="checkmark-done" size={14} color="#065F46" />
                      <Text style={styles.completedBadgeText}>Completed</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}
        </View>
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
        <Pressable
          testID="add-patient-btn"
          onPress={() => setAddOpen(true)}
          style={[styles.fab, { backgroundColor: colors.brandPrimary }]}
        >
          <Ionicons name="person-add" size={20} color="#fff" />
          <Text style={styles.fabText}>Add Patient</Text>
        </Pressable>
        <Pressable
          testID="emergency-insert-btn"
          onPress={() => setEmergencyOpen(true)}
          style={[styles.fab, { backgroundColor: colors.error }]}
        >
          <Ionicons name="alert" size={20} color="#fff" />
          <Text style={styles.fabText}>Emergency</Text>
        </Pressable>
      </View>

      {/* ── Add Patient Modal (Preserves inputs during connection glitches) ── */}
      <Modal transparent visible={addOpen} animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAddOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ justifyContent: "flex-end", flex: 1 }}>
            <Pressable style={[styles.sheet, { maxHeight: "92%", minHeight: "70%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={styles.sheetTitle}>Add Walk-in Patient</Text>
                <Text style={styles.sheetSub}>Patient will be assigned next atomic token for {selectedDate}.</Text>
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
            <Text style={styles.sheetTitle}>Emergency Priority Insert</Text>
            <Text style={styles.sheetSub}>Patient will be inserted with highest priority without disturbing existing token numbers.</Text>
            <TextInput testID="emergency-name-input" placeholder="Patient name" placeholderTextColor={colors.muted} value={emergencyName} onChangeText={setEmergencyName} style={styles.emergencyInput} />
            <Pressable testID="emergency-confirm" onPress={insertEmergency} style={styles.emergencyBtn}>
              <Text style={styles.emergencyBtnText}>Insert as Priority</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ── Reschedule Appointment Modal (Requirement 5) ── */}
      <Modal transparent visible={rescheduleModalOpen} animationType="slide" onRequestClose={() => setRescheduleModalOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setRescheduleModalOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Reschedule Appointment</Text>
            <Text style={styles.sheetSub}>
              Move Token #{rescheduleAppt?.token_number} ({rescheduleAppt?.patient_name}) to another appointment date.
            </Text>

            <Text style={styles.label}>New Appointment Date (YYYY-MM-DD)*</Text>
            <TextInput
              testID="reschedule-date-input"
              value={rescheduleDate}
              onChangeText={setRescheduleDate}
              placeholder="e.g. 2026-10-04"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />

            <Text style={styles.label}>Slot / Timing (Optional)</Text>
            <TextInput
              testID="reschedule-slot-input"
              value={rescheduleSlot}
              onChangeText={setRescheduleSlot}
              placeholder="e.g. 11:30 AM or Walk-in"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />

            {rescheduleError ? <Text style={styles.error}>{rescheduleError}</Text> : null}

            <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
              <Pressable
                onPress={() => setRescheduleModalOpen(false)}
                style={[styles.primaryBtn, { flex: 1, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}
              >
                <Text style={[styles.primaryBtnText, { color: colors.onSurface }]}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="reschedule-confirm-btn"
                onPress={handleRescheduleSubmit}
                disabled={rescheduleLoading}
                style={[styles.primaryBtn, { flex: 2 }]}
              >
                {rescheduleLoading ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Confirm Reschedule</Text>}
              </Pressable>
            </View>
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
                      style={[styles.docChip, isTarget && styles.docChipActive]}
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
  offlineBanner: {
    backgroundColor: "#DC2626",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  offlineBannerText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  staleBanner: {
    backgroundColor: "#FEF3C7",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: "#FDE68A",
  },
  staleBannerText: {
    color: "#92400E",
    fontSize: 11,
    fontWeight: "600",
  },
  header: { flexDirection: "row", padding: spacing.lg, paddingBottom: spacing.sm, alignItems: "center" },
  hello: { fontSize: font.xs, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  name: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  syncText: { fontSize: 11, color: colors.muted, marginLeft: 4 },
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
  scroll: { padding: spacing.lg, gap: spacing.md, paddingBottom: 140 },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  sectionTitle: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  sectionSub: { fontSize: font.xs, color: colors.muted, marginTop: 1 },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSecondary,
  },
  refreshBtnText: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.brandPrimary,
  },
  apptCard: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  apptCardConsulting: {
    borderColor: colors.brandPrimary,
    backgroundColor: "#F0FDF4",
    borderWidth: 1.5,
  },
  tokenBubble: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  tokenText: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary },
  apptName: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  consultingBadge: {
    backgroundColor: "#D1FAE5",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  consultingBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#065F46",
  },
  skippedBadge: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  skippedBadgeText: {
    fontSize: 9,
    fontWeight: "800",
    color: "#92400E",
  },
  apptMeta: { fontSize: font.xs, color: colors.muted, textTransform: "capitalize", marginTop: 2 },
  symptoms: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 3 },
  smallIconBtn: {
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  actionColBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 2,
    minWidth: 64,
  },
  actionColBtnPrimary: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  actionColBtnSuccess: {
    backgroundColor: "#059669",
    borderColor: "#059669",
    flex: 1,
    flexDirection: "row",
    paddingVertical: 10,
    gap: 8,
  },
  actionColBtnLabel: {
    fontSize: 9,
    fontWeight: "700",
    color: colors.onSurface,
    textAlign: "center",
  },
  calendarSection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  historySection: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  historyTitle: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  historyEmptyText: {
    fontSize: font.xs,
    color: colors.muted,
    fontStyle: "italic",
    paddingVertical: 8,
  },
  historyItemCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  historyToken: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#E2E8F0",
    alignItems: "center",
    justifyContent: "center",
  },
  historyTokenText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#475569",
  },
  historyPatientName: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  historyTimeText: {
    fontSize: 10,
    color: colors.muted,
    marginTop: 1,
  },
  completedBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#D1FAE5",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  completedBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#065F46",
  },
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
