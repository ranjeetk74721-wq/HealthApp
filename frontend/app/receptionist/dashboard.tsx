import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator,
  RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform, Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api, getApiBase, getBackendWebSocketBase } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import CalendarSummary from "@/src/components/CalendarSummary";
import DoctorSessionBar from "@/src/components/DoctorSessionBar";
import DoctorSessionManagerModal from "@/src/components/DoctorSessionManagerModal";
import PatientDetailsModal from "@/src/components/PatientDetailsModal";
import { printPatientList } from "@/src/utils/printPatientList";

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
  const [selectedPatientAppt, setSelectedPatientAppt] = useState<any | null>(null);
  const [queueFilter, setQueueFilter] = useState<"all" | "active" | "completed">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, string>>({});
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);

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
  const [rescheduleVerifying, setRescheduleVerifying] = useState(false);
  const [rescheduleIsTimeout, setRescheduleIsTimeout] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | null>(null);

  // Add Patient sheet (preserves inputs on error)
  const [addOpen, setAddOpen] = useState(false);
  const [configuredSessions, setConfiguredSessions] = useState<any[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const [pName, setPName] = useState("");
  const [pMobile, setPMobile] = useState("");
  const [pAge, setPAge] = useState("");
  const [pGender, setPGender] = useState<string | null>(null);
  const [pSymptoms, setPSymptoms] = useState("");
  const [pAddress, setPAddress] = useState("");
  const [pSlot, setPSlot] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addVerifying, setAddVerifying] = useState(false);
  const [addIsTimeout, setAddIsTimeout] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addToast, setAddToast] = useState<string | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [autoReferLoading, setAutoReferLoading] = useState(false);

  // View completed toggle
  const [showCompleted, setShowCompleted] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const wsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFocused = useRef(true);
  const [wsConnected, setWsConnected] = useState(false);

  // In-flight synchronous guards against rapid repeated clicks
  const addPatientSubmittingRef = useRef(false);
  const emergencySubmittingRef = useRef(false);
  const rescheduleSubmittingRef = useRef(false);
  const referSubmittingRef = useRef(false);

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
    const curReqId = ++requestIdRef.current;
    const shouldBypass = silent || bypassCache;
    try {
      const docs = await api.get("/reception/doctors", { bypassCache: shouldBypass });
      if (curReqId !== requestIdRef.current) return;
      setDoctors(docs);
      const doctorId = selectedDocRef.current || (docs[0]?.id ?? null);
      if (doctorId && !selectedDocRef.current) {
        setSelectedDoc(doctorId);
        selectedDocRef.current = doctorId;
      }
      if (doctorId) {
        const [q, sessRes, sum, confSessRes] = await Promise.all([
          api.get(`/reception/queue?doctor_id=${doctorId}&date=${selectedDate}`, { bypassCache: shouldBypass }),
          api.get(`/doctor/${doctorId}/session?date=${selectedDate}`, { bypassCache: shouldBypass }).catch(() => null),
          api.get(`/appointments/calendar-summary?doctor_id=${doctorId}`, { bypassCache: shouldBypass }).catch(() => []),
          api.get(`/doctor/${doctorId}/sessions?date=${selectedDate}&target_date=${selectedDate}`, { bypassCache: shouldBypass }).catch(() => ({ sessions: [] })),
        ]);
        if (curReqId !== requestIdRef.current) return;
        setQueue(q || []);
        if (sessRes?.session) setDocSession(sessRes.session);
        setSummaryData(sum || []);
        setConfiguredSessions(confSessRes?.sessions || []);
      }
      const nowStr = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
      setLastUpdated(nowStr);
      setIsStale(false);
    } catch (err: any) {
      if (curReqId !== requestIdRef.current) return;
      setIsStale(true);
      if (err?.message && (err.message.includes("401") || err.message.includes("authenticated") || err.message.includes("expired"))) {
        await signOut();
        router.replace("/login");
      }
    } finally {
      if (curReqId === requestIdRef.current) {
        if (!silent) setLoading(false);
        setRefreshing(false);
      }
    }
  }, [router, signOut, selectedDate]);

  // WebSocket — re-subscribe when selected doctor changes
  useEffect(() => {
    if (!selectedDoc) return;
    load(true, true);

    if (wsRef.current) { try { wsRef.current.close(); } catch { /* ignore */ } wsRef.current = null; }

    const url = `${getBackendWebSocketBase()}/api/ws/queue/doctor/${selectedDoc}`;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
      ws.onmessage = (e: any) => {
        try {
          const msg = typeof e?.data === "string" ? JSON.parse(e.data) : e?.data;
          if (msg?.type === "ping" || msg?.type === "pong" || msg?.type === "connected") return;
        } catch {}
        if (isFocused.current && (Platform.OS !== "web" || document.visibilityState === "visible")) {
          if (wsDebounceRef.current) clearTimeout(wsDebounceRef.current);
          wsDebounceRef.current = setTimeout(() => {
            load(true, true);
          }, 300);
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
      if (wsDebounceRef.current) { clearTimeout(wsDebounceRef.current); wsDebounceRef.current = null; }
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
  const handleAction = async (path: string, apptId: string, actionType: string, successMsg?: string) => {
    if (actionLoadingMap[apptId]) return; // Prevent double tap or concurrent actions on same patient
    setActionLoadingMap((prev) => ({ ...prev, [apptId]: actionType }));
    try {
      await api.post(path, { appointment_id: apptId });
      if (successMsg) {
        setAddToast(successMsg);
        setTimeout(() => setAddToast(null), 3000);
      }
      await load(true);
    } catch (err: any) {
      Alert.alert("Action Failed", err?.message || "Could not complete queue action");
    } finally {
      setActionLoadingMap((prev) => {
        const next = { ...prev };
        delete next[apptId];
        return next;
      });
    }
  };

  const startConsultation = (appt: any) => {
    handleAction(
      "/reception/start_consultation",
      appt.id,
      "start",
      `Consultation started for Token #${appt.token_number}`
    );
  };

  const completeConsultation = (appt: any) => {
    handleAction(
      "/reception/complete",
      appt.id,
      "complete",
      `Consultation completed for Token #${appt.token_number}. Patient record archived.`
    );
  };

  const skipPatient = (appt: any) => {
    handleAction(
      "/reception/skip",
      appt.id,
      "skip",
      `Token #${appt.token_number} skipped. Token preserved.`
    );
  };

  const rejoinQueue = (appt: any) => {
    handleAction(
      "/reception/rejoin",
      appt.id,
      "rejoin",
      `Token #${appt.token_number} rejoined active queue.`
    );
  };

  const markArrived = (appt: any) => {
    handleAction(
      "/reception/mark_arrived",
      appt.id,
      "arrived",
      `Token #${appt.token_number} marked arrived.`
    );
  };

  const cancelAppointment = (appt: any) => {
    const doCancel = () => {
      handleAction(
        "/reception/cancel",
        appt.id,
        "cancel",
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
    setRescheduleIsTimeout(false);
    setRescheduleVerifying(false);
    setRescheduleModalOpen(true);
  };

  const handleRescheduleSubmit = async () => {
    if (rescheduleSubmittingRef.current) return;
    if (!rescheduleAppt || !rescheduleDate) {
      setRescheduleError("Please select a valid new date");
      return;
    }
    rescheduleSubmittingRef.current = true;
    setRescheduleLoading(true);
    setRescheduleVerifying(false);
    setRescheduleIsTimeout(false);
    setRescheduleError(null);
    try {
      const res = await api.post(
        "/reception/reschedule",
        {
          appointment_id: rescheduleAppt.id,
          new_date: rescheduleDate,
          new_slot: rescheduleSlot.trim() || undefined,
        },
        { timeoutMs: 10000 }
      );
      setAddToast(
        `Rescheduled to ${res.new_date} · New Token #${res.token_number}`
      );
      setRescheduleModalOpen(false);
      setRescheduleAppt(null);
      await load(true);
      setTimeout(() => setAddToast(null), 3500);
    } catch (err: any) {
      if (err?.isTimeout || err?.name === "TimeoutError") {
        // A client timeout does NOT prove the server failed to save.
        // Before offering a repeated write after an ambiguous timeout,
        // use existing read endpoints to check whether the change already succeeded.
        // Do not automatically replay uncertain writes.
        setRescheduleVerifying(true);
        try {
          const check = await api.get(
            `/appointments/${rescheduleAppt.id}/patient-details`,
            { bypassCache: true, timeoutMs: 6000 }
          );
          if (check && check.date === rescheduleDate) {
            setAddToast(
              `Rescheduled to ${check.date} · Token #${check.token_number}`
            );
            setRescheduleModalOpen(false);
            setRescheduleAppt(null);
            await load(true);
            setTimeout(() => setAddToast(null), 3500);
            return;
          }
        } catch {
          // Verification read also failed/timed out
        } finally {
          setRescheduleVerifying(false);
        }

        setRescheduleIsTimeout(true);
        setRescheduleError(
          "Request timed out. Server verification confirmed appointment was not rescheduled. You can retry."
        );
      } else {
        setRescheduleError(err?.message || "Failed to reschedule appointment");
      }
    } finally {
      rescheduleSubmittingRef.current = false;
      setRescheduleLoading(false);
      setRescheduleVerifying(false);
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

  const handleDownloadExcel = async () => {
    if (!selectedDoc) {
      Alert.alert("Doctor Required", "Please select a doctor to download the Excel report.");
      return;
    }
    setExportLoading(true);
    try {
      const token = await AsyncStorage.getItem("cq_token");
      const url = `${getApiBase()}/reception/export-excel?doctor_id=${selectedDoc}&date=${selectedDate}`;
      if (Platform.OS === "web") {
        const response = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok) {
          throw new Error("Failed to export Excel report");
        }
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        const targetDoc = doctors.find((d) => d.id === selectedDoc);
        const docName = (targetDoc?.full_name || "Doctor").replace(/[^\w\-]/g, "_");
        a.download = `ClinicQueue_Report_${docName}_${selectedDate}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(blobUrl);
        setAddToast("Excel report downloaded");
        setTimeout(() => setAddToast(null), 3000);
      } else {
        Alert.alert("Notice", "Excel report download is optimized for web browser.");
      }
    } catch (err: any) {
      Alert.alert("Export Error", err?.message || "Failed to download Excel report");
    } finally {
      setExportLoading(false);
    }
  };

  const handleAutoReferQueue = async () => {
    if (!selectedDoc) return;
    const curDoc = doctors.find((d) => d.id === selectedDoc);
    const docName = curDoc?.full_name || "Doctor";
    const pendingCount = activeQueue.length;
    if (pendingCount === 0) {
      Alert.alert("No Patients", "There are no active or waiting patients to auto-refer.");
      return;
    }

    const doRefer = async () => {
      setAutoReferLoading(true);
      try {
        const res = await api.post("/reception/auto-refer", { from_doctor_id: selectedDoc });
        Alert.alert("Auto-Refer Complete", res?.message || `Transferred ${res?.count || 0} patient(s) successfully.`);
        load(true, true);
      } catch (err: any) {
        Alert.alert("Auto-Refer Error", err?.message || "Failed to auto-refer queue.");
      } finally {
        setAutoReferLoading(false);
      }
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Auto-refer ${pendingCount} waiting patient(s) of ${docName} to available active doctors in the hospital?`)) {
        doRefer();
      }
    } else {
      Alert.alert(
        "Auto-Refer Queue",
        `Auto-refer ${pendingCount} waiting patient(s) of ${docName} to available active doctors in the hospital?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Auto-Refer All", style: "destructive", onPress: doRefer },
        ]
      );
    }
  };

  const insertEmergency = async () => {
    if (!selectedDoc || emergencySubmittingRef.current) return;
    emergencySubmittingRef.current = true;
    try {
      await api.post("/reception/emergency_insert", {
        doctor_id: selectedDoc,
        patient_name: emergencyName || "Emergency Patient",
      });
      setEmergencyOpen(false);
      setEmergencyName("");
      load(true);
    } catch { /* ignore */ } finally {
      emergencySubmittingRef.current = false;
    }
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
    if (referSubmittingRef.current) return;
    if (!referAppt || !targetDocId) {
      setReferError("Please select a target doctor");
      return;
    }
    referSubmittingRef.current = true;
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
      load(true);
      setTimeout(() => setAddToast(null), 3500);
    } catch (e: any) {
      setReferError(e.message || "Failed to refer patient");
    } finally {
      referSubmittingRef.current = false;
      setReferLoading(false);
    }
  };

  const resetAddForm = () => {
    addPatientSubmittingRef.current = false;
    setPName(""); setPMobile(""); setPAge(""); setPGender(null);
    setPSymptoms(""); setPAddress(""); setPSlot(""); setAddError(null);
    setSelectedSessionId(null); setSelectedWindowId(null);
  };

  const onAddPatient = async () => {
    // Immediate synchronous in-flight guard: prevent duplicate submissions from rapid repeated clicks
    if (addPatientSubmittingRef.current) return;
    setAddError(null);
    setAddIsTimeout(false);
    if (!pName.trim()) return setAddError("Name is required");
    if (pMobile.replace(/[^0-9]/g, "").length < 10) return setAddError("Enter valid 10-digit mobile");
    if (!selectedDoc) return setAddError("Select a doctor first");

    addPatientSubmittingRef.current = true;
    setAddLoading(true);
    setAddVerifying(false);
    try {
      const selectedSession = configuredSessions.find((s) => s.id === selectedSessionId);
      const selectedWindow = selectedSession?.booking_windows?.find((w: any) => w.id === selectedWindowId);
      const effectiveSlot =
        pSlot ||
        (selectedWindow ? `${selectedWindow.start_time} - ${selectedWindow.end_time}` : (selectedSession ? selectedSession.session_name : "Walk-in"));

      const res = await api.post(
        "/reception/add-patient",
        {
          full_name: pName.trim(),
          mobile: pMobile.replace(/[^0-9]/g, ""),
          age: pAge ? parseInt(pAge, 10) : undefined,
          gender: pGender,
          symptoms: pSymptoms || undefined,
          address: pAddress || undefined,
          doctor_id: selectedDoc,
          session_id: selectedSessionId || undefined,
          booking_window_id: selectedWindowId || undefined,
          slot_time: (selectedWindow ? `${selectedWindow.start_time} - ${selectedWindow.end_time}` : pSlot) || undefined,
          slot: effectiveSlot,
          date: selectedDate,
        },
        { timeoutMs: 12000 }
      );
      setAddToast(`Added: ${res.patient.full_name} · Token #${res.appointment?.token_number}`);
      resetAddForm();
      setAddOpen(false);
      load(true);
      setTimeout(() => setAddToast(null), 3000);
    } catch (e: any) {
      if (e?.isTimeout || e?.name === "TimeoutError") {
        setAddVerifying(true);
        try {
          const qList = await api.get(
            `/reception/queue?doctor_id=${selectedDoc}&date=${selectedDate}`,
            { bypassCache: true, timeoutMs: 6000 }
          );
          const cleanMob = pMobile.replace(/[^0-9]/g, "");
          const found = Array.isArray(qList)
            ? qList.find(
                (a: any) =>
                  a.patient_mobile === cleanMob ||
                  (a.patient_name && a.patient_name.toLowerCase() === pName.trim().toLowerCase())
              )
            : null;
          if (found) {
            setAddToast(`Added: ${found.patient_name} · Token #${found.token_number}`);
            resetAddForm();
            setAddOpen(false);
            load(true);
            setTimeout(() => setAddToast(null), 3000);
            return;
          }
        } catch {
          // Verification read failed
        } finally {
          setAddVerifying(false);
        }

        setAddIsTimeout(true);
        setAddError("Request timed out. Server verification confirmed patient was not added. You can retry.");
      } else {
        // PRESERVE FORM INPUTS on error for weak connections!
        setAddError(e.message || "Could not add patient. Please check connection and retry.");
      }
    } finally {
      addPatientSubmittingRef.current = false;
      setAddLoading(false);
      setAddVerifying(false);
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

  const displayedQueue =
    queueFilter === "completed"
      ? completedQueue
      : queueFilter === "all"
      ? queue.filter((q) => q.status !== "cancelled")
      : activeQueue;

  const handlePrintPatientList = () => {
    const curDoc = doctors.find((d) => d.id === selectedDoc);
    const docName = curDoc?.full_name || "Doctor";
    const clinicName = curDoc?.hospital_name || curDoc?.clinic_name || (user as any)?.hospital_name || "MeriBaari Clinic";

    let patientsToPrint = queue.filter((q) => q.status !== "cancelled");
    let filterLabel = "All Patients";
    if (queueFilter === "active") {
      patientsToPrint = activeQueue;
      filterLabel = "Active Patients (Waiting & Consulting)";
    } else if (queueFilter === "completed") {
      patientsToPrint = completedQueue;
      filterLabel = "Completed Patients";
    }

    printPatientList({
      hospitalName: clinicName,
      doctorName: docName,
      date: selectedDate,
      filterLabel,
      patients: patientsToPrint,
    });
  };

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
        {selectedDoc && (
          docSession ? (
            <DoctorSessionBar
              doctorId={selectedDoc}
              doctorName={doctors.find((d) => d.id === selectedDoc)?.full_name || "Doctor"}
              session={docSession}
              waitingCount={activeQueue.filter((q) => ["booked", "arrived"].includes(q.status)).length}
              onRefresh={() => load(true, true)}
            />
          ) : (
            <View style={styles.sessionBarPlaceholder}>
              <ActivityIndicator size="small" color={colors.brandPrimary} />
              <Text style={styles.sessionBarPlaceholderText}>Loading doctor session & cabin state...</Text>
            </View>
          )
        )}

        {/* Doctor Shifts & Cabin Slots Management */}
        {selectedDoc && (
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md }}>
            <View style={{ flex: 1, paddingRight: spacing.sm }}>
              <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.onSurface }}>
                {doctors.find((d) => d.id === selectedDoc)?.full_name || "Doctor"}&apos;s Shifts & Cabin Slots
              </Text>
              <Text style={{ fontSize: 11, color: colors.muted }}>Day shift, Night shift, Emergency shift & Holidays</Text>
            </View>
            <Pressable
              testID="receptionist-manage-doctor-shifts-btn"
              onPress={() => setSessionManagerOpen(true)}
              style={{ backgroundColor: colors.brandPrimary, paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Ionicons name="calendar-outline" size={16} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: font.sm }}>Manage Doctor Shifts</Text>
            </Pressable>
          </View>
        )}

        {/* 2. Today's Patient Bookings and Active Queue (Requirement 5) */}
        <View style={styles.sectionHeaderRow}>
          <View>
            <Text style={styles.sectionTitle}>
              Patient Queue · {selectedDate}
            </Text>
            <Text style={styles.sectionSub}>
              {displayedQueue.length} patient(s) · Tap any patient to view or edit details
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pressable
              onPress={handlePrintPatientList}
              style={styles.printBtn}
              testID="reception-print-patient-list-btn"
            >
              <Ionicons name="print-outline" size={15} color={colors.brandPrimary} />
              <Text style={styles.printBtnText}>Print Patient List</Text>
            </Pressable>
            <Pressable
              onPress={handleDownloadExcel}
              disabled={exportLoading}
              style={[styles.exportBtn, exportLoading && { opacity: 0.6 }]}
              testID="export-excel-btn"
            >
              {exportLoading ? (
                <ActivityIndicator size="small" color="#0F766E" />
              ) : (
                <>
                  <Ionicons name="download-outline" size={15} color="#0F766E" />
                  <Text style={styles.exportBtnText}>Excel</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={handleAutoReferQueue}
              disabled={autoReferLoading || activeQueue.length === 0}
              style={[styles.autoReferBtn, (autoReferLoading || activeQueue.length === 0) && { opacity: 0.6 }]}
              testID="reception-auto-refer-queue-btn"
            >
              {autoReferLoading ? (
                <ActivityIndicator size="small" color="#7C3AED" />
              ) : (
                <>
                  <Ionicons name="git-branch-outline" size={15} color="#7C3AED" />
                  <Text style={styles.autoReferBtnText}>Auto-Refer</Text>
                </>
              )}
            </Pressable>
            <Pressable
              onPress={() => load(true, true)}
              style={styles.refreshBtn}
              testID="manual-refresh-btn"
            >
              <Ionicons name="refresh" size={16} color={colors.brandPrimary} />
              <Text style={styles.refreshBtnText}>Sync</Text>
            </Pressable>
          </View>
        </View>

        {/* ── Queue Filter Tabs ── */}
        <View style={styles.filterChipsRow}>
          <Pressable
            testID="reception-filter-all"
            onPress={() => setQueueFilter("all")}
            style={[styles.filterChip, queueFilter === "all" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, queueFilter === "all" && styles.filterChipTextActive]}>
              All ({queue.filter((q) => q.status !== "cancelled").length})
            </Text>
          </Pressable>
          <Pressable
            testID="reception-filter-active"
            onPress={() => setQueueFilter("active")}
            style={[styles.filterChip, queueFilter === "active" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, queueFilter === "active" && styles.filterChipTextActive]}>
              Active ({activeQueue.length})
            </Text>
          </Pressable>
          <Pressable
            testID="reception-filter-completed"
            onPress={() => setQueueFilter("completed")}
            style={[styles.filterChip, queueFilter === "completed" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, queueFilter === "completed" && styles.filterChipTextActive]}>
              Completed ({completedQueue.length})
            </Text>
          </Pressable>
        </View>

        {displayedQueue.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No patients match the selected filter for {selectedDate}. Tap &quot;+ Add Patient&quot; to register a walk-in.</Text>
          </View>
        ) : (
          displayedQueue.map((a) => {
            const isConsulting = a.status === "in_consultation";
            const isSkipped = a.status === "skipped";
            const isArrived = a.status === "arrived";
            const isBooked = a.status === "booked";
            const isCompleted = a.status === "completed";
            const currentAction = actionLoadingMap[a.id];
            const isItemBusy = !!currentAction;

            return (
              <View key={a.id} style={[styles.apptCard, isConsulting && styles.apptCardConsulting, isCompleted && { opacity: 0.8 }]}>
                {/* Clickable Patient Info Area */}
                <Pressable
                  testID={`reception-patient-row-${a.id}`}
                  onPress={() => setSelectedPatientAppt(a)}
                  style={styles.patientInfoPressable}
                >
                  <View style={[styles.tokenBubble, isConsulting && { backgroundColor: colors.brandPrimary }, isCompleted && { backgroundColor: colors.surfaceTertiary }]}>
                    <Text style={[styles.tokenText, isConsulting && { color: colors.onBrandPrimary }, isCompleted && { color: colors.onSurfaceSecondary }]}>
                      #{a.token_number}
                    </Text>
                  </View>

                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={styles.apptName}>{a.patient_name}</Text>
                      <Ionicons name="information-circle-outline" size={14} color={colors.brandPrimary} />
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
                      {isCompleted && (
                        <View style={[styles.consultingBadge, { backgroundColor: colors.success }]}>
                          <Text style={[styles.consultingBadgeText, { color: "#fff" }]}>COMPLETED</Text>
                        </View>
                      )}
                    </View>

                    <Text style={styles.apptMeta}>
                      {a.slot} · <Text style={{ fontWeight: "600" }}>{a.status.replace("_", " ").toUpperCase()}</Text>
                      {a.consultation_started_at ? ` · Started ${formatTime(a.consultation_started_at)}` : ""}
                    </Text>
                    {a.patient_mobile ? (
                      <Text style={styles.patientContactMeta}>📞 {a.patient_mobile}</Text>
                    ) : null}
                    {a.expected_turn_time && !isCompleted ? (
                      <View style={styles.etaRow}>
                        <Ionicons
                          name={a.is_estimate_pending ? "alert-circle-outline" : "time-outline"}
                          size={13}
                          color={a.is_estimate_pending ? "#D97706" : colors.brandPrimary}
                        />
                        <Text
                          style={[
                            styles.etaText,
                            a.is_estimate_pending && { color: "#D97706", fontWeight: "600" },
                          ]}
                        >
                          {a.is_estimate_pending ? a.expected_turn_time : `Expected: ${a.expected_turn_time}`}
                        </Text>
                      </View>
                    ) : null}
                    {a.symptoms ? <Text style={styles.symptoms} numberOfLines={1}>💊 {a.symptoms}</Text> : null}
                  </View>
                </Pressable>

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
                        {currentAction === "arrived" ? (
                          <ActivityIndicator size="small" color={colors.info} />
                        ) : (
                          <Ionicons name="checkmark-circle-outline" size={18} color={colors.info} />
                        )}
                        <Text style={styles.actionColBtnLabel}>Arrived</Text>
                      </Pressable>

                      <Pressable
                        testID={`action-start-${a.id}`}
                        onPress={() => startConsultation(a)}
                        disabled={isItemBusy}
                        style={[styles.actionColBtn, styles.actionColBtnPrimary, isItemBusy && { opacity: 0.5 }]}
                      >
                        {currentAction === "start" ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Ionicons name="play" size={18} color="#fff" />
                        )}
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
                        {currentAction === "skip" ? (
                          <ActivityIndicator size="small" color={colors.warning} />
                        ) : (
                          <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.warning} />
                        )}
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
                        {currentAction === "cancel" ? (
                          <ActivityIndicator size="small" color={colors.error} />
                        ) : (
                          <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        )}
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
                        {currentAction === "start" ? (
                          <ActivityIndicator size="small" color="#fff" />
                        ) : (
                          <Ionicons name="play" size={18} color="#fff" />
                        )}
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
                        {currentAction === "skip" ? (
                          <ActivityIndicator size="small" color={colors.warning} />
                        ) : (
                          <Ionicons name="arrow-forward-circle-outline" size={18} color={colors.warning} />
                        )}
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
                        {currentAction === "cancel" ? (
                          <ActivityIndicator size="small" color={colors.error} />
                        ) : (
                          <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        )}
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
                      {currentAction === "complete" ? (
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
                        {currentAction === "rejoin" ? (
                          <ActivityIndicator size="small" color="#B45309" />
                        ) : (
                          <Ionicons name="refresh-circle-outline" size={18} color="#B45309" />
                        )}
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
                        {currentAction === "cancel" ? (
                          <ActivityIndicator size="small" color={colors.error} />
                        ) : (
                          <Ionicons name="close-circle-outline" size={18} color={colors.error} />
                        )}
                        <Text style={[styles.actionColBtnLabel, { color: colors.error }]}>Cancel</Text>
                      </Pressable>
                    </>
                  )}
                </View>
              </View>
            );
          })
        )}

        {/* Lower-Page Order 1: Completed / History Records Section (Requirement 5) */}
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
                  <Pressable
                    key={item.id}
                    testID={`reception-completed-row-${item.id}`}
                    onPress={() => setSelectedPatientAppt(item)}
                    style={styles.historyItemCard}
                  >
                    <View style={styles.historyToken}>
                      <Text style={styles.historyTokenText}>#{item.token_number}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={styles.historyPatientName}>{item.patient_name}</Text>
                        <Ionicons name="information-circle-outline" size={13} color={colors.brandPrimary} />
                      </View>
                      <Text style={styles.historyTimeText}>
                        Started: {formatTime(item.consultation_started_at || item.started_at)} · Completed: {formatTime(item.consultation_completed_at || item.completed_at)}
                      </Text>
                      {item.patient_mobile ? (
                        <Text style={styles.patientContactMeta}>📞 {item.patient_mobile}</Text>
                      ) : null}
                    </View>
                    <View style={styles.completedBadge}>
                      <Ionicons name="checkmark-done" size={14} color="#065F46" />
                      <Text style={styles.completedBadgeText}>Completed</Text>
                    </View>
                  </Pressable>
                ))
              )}
            </View>
          )}
        </View>

        {/* Lower-Page Order 2: Daily Patient Calendar immediately above footer (Requirement 5) */}
        <View style={styles.calendarSection}>
          <View style={styles.sectionHeaderRow}>
            <View>
              <Text style={styles.sectionTitle}>Daily Patient Calendar</Text>
              <Text style={styles.sectionSub}>Selected Date: <Text style={{ fontWeight: "700", color: colors.brandPrimary }}>{selectedDate}</Text></Text>
            </View>
          </View>
          <CalendarSummary
            summaryData={summaryData}
            selectedDate={selectedDate}
            onSelectDate={(date) => {
              setSelectedDate(date);
            }}
          />
        </View>

        {/* Lower-Page Order 3: Footer (Requirement 5) */}
        <View style={styles.dashboardFooter}>
          <Text style={styles.dashboardFooterText}>MeriBaari Healthcare · Clinic Queue Management</Text>
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
          disabled={addLoading}
          onPress={() => setAddOpen(true)}
          style={[styles.fab, { backgroundColor: colors.brandPrimary }, addLoading && { opacity: 0.6 }]}
        >
          {addLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="person-add" size={20} color="#fff" />
          )}
          <Text style={styles.fabText}>{addLoading ? "Saving…" : "Add Patient"}</Text>
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
      <Modal
        transparent
        visible={addOpen}
        animationType="slide"
        onRequestClose={() => {
          if (!addLoading && !addVerifying) setAddOpen(false);
        }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.modalBackdrop}
        >
          <Pressable
            style={{ flex: 1, justifyContent: "flex-end", width: "100%" }}
            onPress={() => {
              if (!addLoading && !addVerifying) setAddOpen(false);
            }}
          >
            <Pressable style={[styles.sheet, { maxHeight: "92%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.xl }}>
                <Text style={styles.sheetTitle}>Add Patient to Queue</Text>
                <Text style={styles.sheetSub}>Select doctor session & slot (receptionist override enabled). Date: {selectedDate}</Text>

                {/* 1. Doctor Sessions Selection (All configured sessions accessible to receptionist) */}
                <Text style={styles.label}>1. Doctor Session (सत्र चुनें)</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginVertical: 4 }}>
                  <Pressable
                    onPress={() => {
                      setSelectedSessionId(null);
                      setSelectedWindowId(null);
                    }}
                    style={[
                      styles.recSessionChip,
                      selectedSessionId === null && styles.recSessionChipActive,
                    ]}
                  >
                    <Text style={[styles.recSessionText, selectedSessionId === null && { color: "#fff" }]}>
                      General Walk-in
                    </Text>
                  </Pressable>
                  {configuredSessions.map((sess) => {
                    const isSessActive = selectedSessionId === sess.id;
                    return (
                      <Pressable
                        key={sess.id}
                        onPress={() => {
                          setSelectedSessionId(sess.id);
                          setSelectedWindowId(null);
                          setPSlot(`${sess.start_time} - ${sess.end_time}`);
                        }}
                        style={[
                          styles.recSessionChip,
                          isSessActive && styles.recSessionChipActive,
                        ]}
                      >
                        <Text style={[styles.recSessionText, isSessActive && { color: "#fff" }]}>
                          {sess.session_name} ({sess.start_time} - {sess.end_time})
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

                {/* 2. Booking Windows / Slots (Receptionist has access to ALL windows including local-only) */}
                {selectedSessionId && (
                  (() => {
                    const chosen = configuredSessions.find((s) => s.id === selectedSessionId);
                    const wins = chosen?.booking_windows || [];
                    if (wins.length === 0) return null;
                    return (
                      <View style={{ marginTop: spacing.xs, marginBottom: spacing.sm }}>
                        <Text style={styles.label}>2. Booking Window / Slot (Receptionist Override: All Windows Available)</Text>
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginVertical: 4 }}>
                          {wins.map((w: any) => {
                            const isWinActive = selectedWindowId === w.id;
                            const target = w.target_patient_category || "all";
                            const badge = target === "local" ? "Local" : target === "distant" ? "Distant" : "All";
                            return (
                              <Pressable
                                key={w.id}
                                onPress={() => {
                                  setSelectedWindowId(w.id);
                                  setPSlot(`${w.start_time} - ${w.end_time}`);
                                }}
                                style={[
                                  styles.recWindowChip,
                                  isWinActive && styles.recWindowChipActive,
                                ]}
                              >
                                <Text style={[styles.recWindowTime, isWinActive && { color: "#fff" }]}>
                                  {w.start_time} - {w.end_time}
                                </Text>
                                <Text style={[styles.recWindowBadge, isWinActive && { color: "#E0E7FF" }]}>
                                  [{badge}]
                                </Text>
                              </Pressable>
                            );
                          })}
                        </ScrollView>
                      </View>
                    );
                  })()
                )}

                {/* 3. Patient Details */}
                <Text style={styles.label}>3. Patient Full Name*</Text>
                <TextInput testID="ap-name" editable={!addLoading} placeholder="Patient name" placeholderTextColor={colors.muted} value={pName} onChangeText={setPName} style={styles.input} />
                <Text style={styles.label}>Mobile Number*</Text>
                <View style={styles.mobileWrap}>
                  <View style={styles.ccBadge}><Text style={styles.ccText}>+91</Text></View>
                  <TextInput testID="ap-mobile" editable={!addLoading} placeholder="98765 43210" placeholderTextColor={colors.muted} value={pMobile} onChangeText={(t) => setPMobile(t.replace(/[^0-9]/g, "").slice(0, 10))} keyboardType="phone-pad" style={styles.mobileInput} />
                </View>
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Age</Text>
                    <TextInput testID="ap-age" editable={!addLoading} placeholder="32" placeholderTextColor={colors.muted} value={pAge} onChangeText={(t) => setPAge(t.replace(/[^0-9]/g, "").slice(0, 3))} keyboardType="number-pad" style={styles.input} />
                  </View>
                  <View style={{ flex: 2 }}>
                    <Text style={styles.label}>Gender</Text>
                    <View style={styles.genderRow}>
                      {GENDERS.map((g) => (
                        <Pressable key={g} testID={`ap-gender-${g}`} disabled={addLoading} onPress={() => setPGender(g)} style={[styles.genderChip, pGender === g && styles.genderChipActive, addLoading && { opacity: 0.6 }]}>
                          <Text style={[styles.genderText, pGender === g && { color: colors.onBrandPrimary }]}>{g}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                </View>
                <Text style={styles.label}>Symptoms / Reason</Text>
                <TextInput testID="ap-symptoms" editable={!addLoading} placeholder="Fever, cough..." placeholderTextColor={colors.muted} value={pSymptoms} onChangeText={setPSymptoms} multiline style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} />
                <Text style={styles.label}>Address / Area (Optional - ऐच्छिक)</Text>
                <TextInput testID="ap-address" editable={!addLoading} placeholder="Area, city (optional for receptionist)" placeholderTextColor={colors.muted} value={pAddress} onChangeText={setPAddress} style={styles.input} />
                <Text style={styles.label}>Custom Slot / Note (optional)</Text>
                <TextInput testID="ap-slot" editable={!addLoading} placeholder="e.g. 11:00 AM (or leave blank)" placeholderTextColor={colors.muted} value={pSlot} onChangeText={setPSlot} style={styles.input} />
                {addError ? <Text style={styles.error}>{addError}</Text> : null}
                <Pressable
                  testID="ap-submit"
                  onPress={onAddPatient}
                  disabled={addLoading || addVerifying}
                  style={({ pressed }) => [
                    styles.primaryBtn,
                    (pressed || addLoading || addVerifying) && { opacity: 0.75 },
                  ]}
                >
                  {addLoading || addVerifying ? (
                    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.primaryBtnText}>
                        {addVerifying ? "Verifying..." : "Saving…"}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.primaryBtnText}>
                      {addIsTimeout ? "Retry Add Patient" : "Confirm Booking & Add to Queue"}
                    </Text>
                  )}
                </Pressable>
                <View style={{ height: spacing.xl }} />
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
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
      <Modal
        transparent
        visible={rescheduleModalOpen}
        animationType="slide"
        onRequestClose={() => !rescheduleLoading && !rescheduleVerifying && setRescheduleModalOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={{ flex: 1 }}
          keyboardVerticalOffset={Platform.OS === "ios" ? 40 : 0}
        >
          <Pressable
            style={styles.modalBackdrop}
            onPress={() => !rescheduleLoading && !rescheduleVerifying && setRescheduleModalOpen(false)}
          >
            <Pressable style={[styles.sheet, { maxHeight: "90%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: spacing.lg }}
              >
                <Text style={styles.sheetTitle}>Reschedule Appointment</Text>
                <Text style={styles.sheetSub}>
                  Move Token #{rescheduleAppt?.token_number} ({rescheduleAppt?.patient_name}) to another appointment date.
                </Text>

                <Text style={styles.label}>New Appointment Date (YYYY-MM-DD)*</Text>
                <TextInput
                  testID="reschedule-date-input"
                  value={rescheduleDate}
                  onChangeText={(val) => {
                    setRescheduleDate(val);
                    if (rescheduleIsTimeout) setRescheduleIsTimeout(false);
                  }}
                  editable={!rescheduleLoading && !rescheduleVerifying}
                  placeholder="e.g. 2026-10-04"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />

                <Text style={styles.label}>Slot / Timing (Optional)</Text>
                <TextInput
                  testID="reschedule-slot-input"
                  value={rescheduleSlot}
                  onChangeText={(val) => {
                    setRescheduleSlot(val);
                    if (rescheduleIsTimeout) setRescheduleIsTimeout(false);
                  }}
                  editable={!rescheduleLoading && !rescheduleVerifying}
                  placeholder="e.g. 11:30 AM or Walk-in"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                />

                {rescheduleError ? <Text style={styles.error}>{rescheduleError}</Text> : null}

                <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
                  <Pressable
                    onPress={() => setRescheduleModalOpen(false)}
                    disabled={rescheduleLoading || rescheduleVerifying}
                    style={[styles.primaryBtn, { flex: 1, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border }]}
                  >
                    <Text style={[styles.primaryBtnText, { color: colors.onSurface }]}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    testID="reschedule-confirm-btn"
                    onPress={handleRescheduleSubmit}
                    disabled={rescheduleLoading || rescheduleVerifying}
                    style={[
                      styles.primaryBtn,
                      { flex: 2 },
                      rescheduleIsTimeout && { backgroundColor: colors.warning || "#d97706" },
                    ]}
                  >
                    {rescheduleVerifying ? (
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
                        <ActivityIndicator color="#fff" size="small" />
                        <Text style={styles.primaryBtnText}>Verifying...</Text>
                      </View>
                    ) : rescheduleLoading ? (
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
                        <ActivityIndicator color="#fff" size="small" />
                        <Text style={styles.primaryBtnText}>Saving...</Text>
                      </View>
                    ) : (
                      <Text style={styles.primaryBtnText}>
                        {rescheduleIsTimeout ? "Retry Reschedule" : "Confirm Reschedule"}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
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

      {/* ── Patient Details View / Edit Modal (deferred until selected) ── */}
      {!!selectedPatientAppt && (
        <PatientDetailsModal
          visible={!!selectedPatientAppt}
          appointment={selectedPatientAppt}
          onClose={() => setSelectedPatientAppt(null)}
          onUpdated={(updated) => {
            setQueue((prev) =>
              prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
            );
            setSelectedPatientAppt(updated);
          }}
        />
      )}
      {/* ── Shifts & Custom Slots Manager Modal (for Cabin Doctor - deferred until opened) ── */}
      {selectedDoc && sessionManagerOpen && (
        <DoctorSessionManagerModal
          visible={sessionManagerOpen}
          doctorId={selectedDoc}
          doctorName={doctors.find((d) => d.id === selectedDoc)?.full_name || "Doctor"}
          initialDate={selectedDate}
          onClose={() => setSessionManagerOpen(false)}
          onSessionsUpdated={() => load(true, true)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  printBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.brandPrimary,
  },
  printBtnText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.brandPrimary,
  },
  filterChipsRow: {
    flexDirection: "row",
    gap: 8,
    marginVertical: spacing.xs,
    flexWrap: "wrap",
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterChipActive: {
    backgroundColor: colors.brandSecondary,
    borderColor: colors.brandPrimary,
  },
  filterChipText: {
    fontSize: font.xs,
    fontWeight: "600",
    color: colors.onSurfaceSecondary,
  },
  filterChipTextActive: {
    color: colors.brandPrimary,
    fontWeight: "700",
  },
  patientInfoPressable: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  patientContactMeta: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
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
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#CCFBF1",
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "#99F6E4",
  },
  exportBtnText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: "#0F766E",
  },
  autoReferBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#F5F3FF",
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "#DDD6FE",
  },
  autoReferBtnText: {
    fontSize: font.xs,
    fontWeight: "700",
    color: "#7C3AED",
  },
  etaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  etaText: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.brandPrimary,
  },
  dashboardFooter: {
    paddingVertical: spacing.lg,
    paddingBottom: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  dashboardFooterText: {
    fontSize: 11,
    color: colors.muted,
  },
  toast: { position: "absolute", bottom: 100, left: 20, right: 20, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, elevation: 5 },
  toastText: { color: "#fff", fontWeight: "600", flex: 1 },
  recSessionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  recSessionChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  recSessionText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  recWindowChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#C7D2FE",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  recWindowChipActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  recWindowTime: {
    fontSize: 12,
    fontWeight: "600",
    color: colors.onSurface,
  },
  recWindowBadge: {
    fontSize: 10,
    fontWeight: "700",
    color: colors.brandPrimary,
  },
  sessionBarPlaceholder: {
    minHeight: 120,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
  },
  sessionBarPlaceholderText: {
    fontSize: font.sm,
    color: colors.muted,
  },
});
