import { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, Pressable,
  RefreshControl, Modal, TextInput, Alert, Image, KeyboardAvoidingView, Platform,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { api, getApiBase, getBackendWebSocketBase, isConfirmedAuthError } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import CalendarSummary from "@/src/components/CalendarSummary";
import DoctorSessionBar from "@/src/components/DoctorSessionBar";
import DoctorSessionManagerModal from "@/src/components/DoctorSessionManagerModal";
import PatientDetailsModal from "@/src/components/PatientDetailsModal";
import { printPatientList } from "@/src/utils/printPatientList";

const POLL_INTERVAL_MS = 20_000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB limit

const modes = [
  { key: "active",    label: "Active",    icon: "play-circle"  as const, color: colors.success },
  { key: "break",     label: "Break",     icon: "pause-circle" as const, color: colors.warning },
  { key: "emergency", label: "Emergency", icon: "alert-circle" as const, color: colors.error },
];

const rowActions = [
  { label: "Arrived", path: "/reception/mark_arrived",      color: colors.info,         icon: "checkmark-circle" as const, showOn: ["booked"] },
  { label: "Call",    path: "/reception/start_consultation", color: colors.brandPrimary, icon: "mic"              as const, showOn: ["arrived", "booked"] },
  { label: "Done",    path: "/reception/complete",           color: colors.success,      icon: "checkmark-done"   as const, showOn: ["in_consultation", "arrived"] },
  { label: "Skip",    path: "/reception/skip",               color: colors.warning,      icon: "arrow-forward"    as const, showOn: ["booked", "arrived"] },
  { label: "Restore", path: "/reception/correct_status",     color: "#D97706",           icon: "refresh-circle"   as const, showOn: ["skipped"] },
];

const STATUS_COLORS: Record<string, string> = {
  booked: colors.info, arrived: colors.warning,
  in_consultation: colors.brandPrimary, completed: colors.success, skipped: colors.muted,
};

export default function DoctorDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const isSmallScreen = windowWidth < 600;
  const { user, loading: authLoading, signOut } = useAuth();
  const [docSession, setDocSession]   = useState<any | null>(null);
  const [data, setData]       = useState<any | null>(null);
  const [appts, setAppts]     = useState<any[]>([]);
  const [apptsError, setApptsError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [summaryData, setSummaryData] = useState<any[]>([]);
  const [receptionists, setReceptionists] = useState<any[]>([]);
  const [selectedPatientAppt, setSelectedPatientAppt] = useState<any | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toLocaleDateString("en-CA")
  );
  const selectedDateRef = useRef(selectedDate);
  useEffect(() => { selectedDateRef.current = selectedDate; }, [selectedDate]);
  const [filterStatus, setFilterStatus] = useState<"all" | "pending" | "completed">("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [prescOpen, setPrescOpen] = useState<any | null>(null);
  const [prescText, setPrescText] = useState("");
  const [editOpen, setEditOpen]   = useState(false);
  const [editName, setEditName]   = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editMobile, setEditMobile] = useState("");
  const [editSpecialization, setEditSpecialization] = useState("");
  const [editClinicName, setEditClinicName] = useState("");
  const [editFees, setEditFees]   = useState("");
  const [editTimings, setEditTimings] = useState("");
  const [editBio, setEditBio]         = useState("");
  const [editAvgMin, setEditAvgMin]   = useState("");
  const [editPhoto, setEditPhoto]     = useState<string | null>(null);
  const [editCurrentPassword, setEditCurrentPassword] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editError, setEditError]     = useState<string | null>(null);
  const [editSaving, setEditSaving]   = useState(false);
  const [sessionManagerOpen, setSessionManagerOpen] = useState(false);
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, string>>({});
  const [statusLoading, setStatusLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const verifiedDocIdRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  // Receptionist add state
  const [recModalOpen, setRecModalOpen] = useState(false);
  const [recName, setRecName] = useState("");
  const [recEmail, setRecEmail] = useState("");
  const [recPassword, setRecPassword] = useState("");
  const [recMobile, setRecMobile] = useState("");
  const [recSaving, setRecSaving] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  // Receptionist edit state
  const [editRecModalOpen, setEditRecModalOpen] = useState(false);
  const [editRecId, setEditRecId] = useState("");
  const [editRecName, setEditRecName] = useState("");
  const [editRecEmail, setEditRecEmail] = useState("");
  const [editRecMobile, setEditRecMobile] = useState("");
  const [editRecStatus, setEditRecStatus] = useState<"active" | "inactive">("active");
  const [editRecPassword, setEditRecPassword] = useState("");
  const [editRecSaving, setEditRecSaving] = useState(false);
  const [editRecError, setEditRecError] = useState<string | null>(null);


  const wsRef = useRef<WebSocket | null>(null);
  const wsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isFocused = useRef(true);
  const isLoggingOutRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<any>(null);

  const handleAuthExpired = useCallback(async () => {
    if (isLoggingOutRef.current) return;
    isLoggingOutRef.current = true;
    try {
      await signOut();
      router.replace("/hospital-id?redirect=/doctor/dashboard");
    } finally {
      isLoggingOutRef.current = false;
    }
  }, [router, signOut]);

  const load = useCallback(async (silent = false, bypassCache = false) => {
    const curReqId = ++requestIdRef.current;
    const shouldBypass = silent || bypassCache;
    const targetDate = selectedDateRef.current;
    const verifiedDocId = verifiedDocIdRef.current || (user as any)?.doctor_id || data?.doctor?.id;

    try {
      let d: any;
      let a: any[];
      let sum: any[];
      let recs: any[];
      let sessRes: any = null;

      if (verifiedDocId) {
        const [dashRes, apptsRes, sumRes, recsRes, sRes] = await Promise.all([
          api.get(`/doctor/dashboard?date=${targetDate}`, { bypassCache: shouldBypass }),
          api.get(`/doctor/appointments?date=${targetDate}`, { bypassCache: shouldBypass }),
          api.get("/appointments/calendar-summary", { bypassCache: shouldBypass }).catch(() => []),
          api.get("/doctor/receptionists", { bypassCache: shouldBypass }).catch(() => []),
          api.get(`/doctor/${verifiedDocId}/session?date=${targetDate}`, { bypassCache: shouldBypass }).catch(() => null),
        ]);
        d = dashRes;
        a = apptsRes;
        sum = sumRes;
        recs = recsRes;
        sessRes = sRes;
      } else {
        const [dashRes, apptsRes, sumRes, recsRes] = await Promise.all([
          api.get(`/doctor/dashboard?date=${targetDate}`, { bypassCache: shouldBypass }),
          api.get(`/doctor/appointments?date=${targetDate}`, { bypassCache: shouldBypass }),
          api.get("/appointments/calendar-summary", { bypassCache: shouldBypass }).catch(() => []),
          api.get("/doctor/receptionists", { bypassCache: shouldBypass }).catch(() => []),
        ]);
        d = dashRes;
        a = apptsRes;
        sum = sumRes;
        recs = recsRes;

        const docId = d?.doctor?.id;
        if (docId) {
          verifiedDocIdRef.current = docId;
          sessRes = await api.get(`/doctor/${docId}/session?date=${targetDate}`, { bypassCache: shouldBypass }).catch(() => null);
        }
      }

      if (curReqId !== requestIdRef.current) return;

      if (d && typeof d === "object") {
        setData(d);
        setProfileError(null);
        if (d.doctor?.id) verifiedDocIdRef.current = d.doctor.id;
      }
      if (Array.isArray(a)) {
        setAppts(a);
        setApptsError(null);
      }
      if (Array.isArray(sum)) setSummaryData(sum);
      if (Array.isArray(recs)) setReceptionists(recs);
      if (sessRes?.session) setDocSession(sessRes.session);
    } catch (err: any) {
      if (curReqId !== requestIdRef.current) return;
      if (isConfirmedAuthError(err)) {
        await handleAuthExpired();
        return;
      }
      setProfileError(err?.message || "Failed to load doctor dashboard");
    } finally {
      if (curReqId === requestIdRef.current) {
        if (!silent) setLoading(false);
        setRefreshing(false);
      }
    }
  }, [handleAuthExpired, user, data?.doctor?.id]);

  // Online & Visibility Listener for Mobile Backgrounding
  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const handleVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          load(true, true);
        }
      };
      const handleOnline = () => {
        load(true, true);
      };
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("online", handleOnline);
      return () => {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("online", handleOnline);
      };
    }
  }, [load]);

  // WebSocket with bounded exponential backoff
  useEffect(() => {
    const doctorId = data?.doctor?.id;
    if (!doctorId) return;

    let isDisposed = false;

    const connectWs = () => {
      if (isDisposed) return;
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }

      try {
        const ws = new WebSocket(`${getBackendWebSocketBase()}/api/ws/queue/doctor/${doctorId}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (isDisposed) { ws.close(); return; }
          setWsConnected(true);
          reconnectAttemptsRef.current = 0;
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        };

        ws.onmessage = (e: any) => {
          try {
            const msg = typeof e?.data === "string" ? JSON.parse(e.data) : e?.data;
            if (msg?.type === "ping" || msg?.type === "pong" || msg?.type === "connected") return;
          } catch {}
          if (isFocused.current) {
            if (wsDebounceRef.current) clearTimeout(wsDebounceRef.current);
            wsDebounceRef.current = setTimeout(() => {
              load(true);
            }, 300);
          }
        };

        ws.onerror = () => setWsConnected(false);

        ws.onclose = () => {
          setWsConnected(false);
          wsRef.current = null;
          if (!isDisposed) {
            const attempts = reconnectAttemptsRef.current;
            reconnectAttemptsRef.current = attempts + 1;
            const delay = Math.min(30000, Math.max(2000, Math.pow(1.5, attempts) * 1000 + Math.random() * 1000));
            reconnectTimerRef.current = setTimeout(() => {
              if (isFocused.current) connectWs();
            }, delay);

            if (isFocused.current && !timerRef.current) {
              timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
            }
          }
        };
      } catch {
        setWsConnected(false);
      }
    };

    connectWs();

    return () => {
      isDisposed = true;
      if (wsDebounceRef.current) { clearTimeout(wsDebounceRef.current); wsDebounceRef.current = null; }
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
    };
  }, [data?.doctor?.id, load]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace("/hospital-id?redirect=/doctor/dashboard");
    }
  }, [authLoading, user, router]);

  useFocusEffect(
    useCallback(() => {
      isFocused.current = true;
      load();
      if (!wsConnected && !timerRef.current) {
        timerRef.current = setInterval(() => load(true), POLL_INTERVAL_MS);
      }
      return () => {
        isFocused.current = false;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
    }, [load, wsConnected])
  );

  const changeStatus = async (status: string) => {
    if (statusLoading || currentMode === status) return;
    setStatusLoading(true);
    // Optimistic local update
    setData((prev: any) => (prev ? { ...prev, status } : prev));
    try {
      await api.post("/doctor/status", { status });
      if (status === "emergency") {
        const pendingCount = appts.filter((a) => ["booked", "arrived"].includes(a.status)).length;
        if (pendingCount > 0) {
          const doAutoRefer = async () => {
            try {
              const res = await api.post("/doctor/auto-refer", { from_doctor_id: data?.doctor?.id });
              Alert.alert("Auto-Referral", res?.message || `Transferred ${res?.count || 0} patient(s) successfully.`);
              load(true, true);
            } catch (err: any) {
              Alert.alert("Auto-Referral Error", err?.message || "Failed to auto-refer waiting queue.");
            }
          };
          if (Platform.OS === "web") {
            if (window.confirm(`Status switched to Emergency. Would you like to auto-refer ${pendingCount} waiting patient(s) to an available colleague?`)) {
              doAutoRefer();
            }
          } else {
            Alert.alert(
              "Emergency Duty",
              `Status switched to Emergency. Would you like to auto-refer ${pendingCount} waiting patient(s) to an available colleague?`,
              [
                { text: "Keep Queue Here", style: "cancel" },
                { text: "Auto-Refer All", style: "destructive", onPress: doAutoRefer },
              ]
            );
          }
        }
      }
      await load(true, true);
    } catch (err: any) {
      Alert.alert("Status Error", err?.message || "Failed to update doctor working mode");
      load(true, true);
    } finally {
      setStatusLoading(false);
    }
  };

  const doAction = async (path: string, appt_id: string, optimisticStatus?: string, actionName?: string) => {
    if (actionLoadingMap[appt_id]) return; // Per-patient immediate guard
    setActionLoadingMap((prev) => ({ ...prev, [appt_id]: actionName || "loading" }));
    try {
      const payload: any = { appointment_id: appt_id };
      if (path.includes("correct_status")) {
        payload.new_status = "arrived";
        payload.reason = "Restored from skipped by doctor";
      }
      await api.post(path, payload);
      // Optimistic local update upon confirmed backend write
      const targetStat = path.includes("correct_status") ? "arrived" : optimisticStatus;
      if (targetStat) {
        setAppts((prev) =>
          prev.map((a) => (a.id === appt_id ? { ...a, status: targetStat } : a))
        );
      }
      await load(true, true);
    } catch (err: any) {
      Alert.alert("Action Error", err.message || "Failed to update appointment");
    } finally {
      setActionLoadingMap((prev) => {
        const next = { ...prev };
        delete next[appt_id];
        return next;
      });
    }
  };

  const savePresc = async () => {
    if (!prescOpen) return;
    try {
      await api.post("/doctor/prescription", { appointment_id: prescOpen.id, prescription: prescText });
      setPrescOpen(null); setPrescText("");
      load(true);
    } catch { /* ignore */ }
  };

  const openEditProfile = () => {
    setEditName(data?.doctor?.full_name || user?.full_name || "");
    setEditEmail(data?.doctor?.email || user?.email || "");
    setEditMobile(data?.doctor?.mobile || data?.doctor?.phone || user?.mobile || "");
    setEditSpecialization(data?.doctor?.specialization || data?.doctor?.department || "");
    setEditClinicName(data?.doctor?.clinic_name || data?.doctor?.hospital_name || "");
    setEditFees(String(data?.doctor?.fees ?? ""));
    setEditTimings(data?.doctor?.timings ?? "");
    setEditBio(data?.doctor?.bio ?? "");
    setEditAvgMin(String(data?.doctor?.avg_consult_minutes ?? 15));
    setEditPhoto(data?.doctor?.photo || null);
    setEditCurrentPassword("");
    setEditPassword("");
    setEditError(null);
    setEditOpen(true);
  };

  const pickPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission required", "Camera roll permission is needed to upload photos.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: true,
      });
      if (!result.canceled && result.assets && result.assets[0]) {
        const asset = result.assets[0];
        if (asset.fileSize && asset.fileSize > MAX_PHOTO_BYTES) {
          setEditError("Photo size exceeds maximum limit of 5 MB");
          Alert.alert("File Too Large", "Photo size cannot exceed 5 MB. Please select a smaller image.");
          return;
        }
        if (asset.base64) {
          const approxBytes = asset.base64.length * 0.75;
          if (approxBytes > MAX_PHOTO_BYTES) {
            setEditError("Photo size exceeds maximum limit of 5 MB");
            Alert.alert("File Too Large", "Photo size cannot exceed 5 MB.");
            return;
          }
          const uri = `data:image/jpeg;base64,${asset.base64}`;
          setEditPhoto(uri);
          setEditError(null);
        } else if (asset.uri) {
          setEditPhoto(asset.uri);
          setEditError(null);
        }
      }
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to pick image");
    }
  };

  const saveProfile = async () => {
    setEditSaving(true);
    setEditError(null);
    try {
      if (!editName.trim() || editName.trim().length < 2) {
        setEditError("Full name must be at least 2 characters");
        setEditSaving(false);
        return;
      }
      if (editEmail.trim()) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(editEmail.trim())) {
          setEditError("Please enter a valid email address");
          setEditSaving(false);
          return;
        }
      }
      const cleanMob = editMobile.replace(/[^0-9]/g, "");
      if (editMobile.trim() && cleanMob.length < 10) {
        setEditError("Mobile number must contain at least 10 digits");
        setEditSaving(false);
        return;
      }

      const updates: any = {};
      if (editName.trim() !== (data?.doctor?.full_name || "")) updates.full_name = editName.trim();
      if (editEmail.trim().toLowerCase() !== (data?.doctor?.email || "").toLowerCase()) updates.email = editEmail.trim().toLowerCase();
      if (cleanMob !== (data?.doctor?.mobile || data?.doctor?.phone || "")) updates.mobile = cleanMob;
      if (editSpecialization.trim() !== (data?.doctor?.specialization || "")) updates.specialization = editSpecialization.trim();
      if (editClinicName.trim() !== (data?.doctor?.clinic_name || "")) updates.clinic_name = editClinicName.trim();
      if (editFees && parseInt(editFees, 10) !== data?.doctor?.fees) updates.fees = parseInt(editFees, 10);
      if (editTimings && editTimings !== data?.doctor?.timings) updates.timings = editTimings;
      if (editBio !== (data?.doctor?.bio || "")) updates.bio = editBio;
      const avgMinNum = parseInt(editAvgMin, 10);
      if (!isNaN(avgMinNum) && avgMinNum > 0 && avgMinNum !== (data?.doctor?.avg_consult_minutes ?? 15)) {
        updates.avg_consult_minutes = avgMinNum;
      }
      if (editCurrentPassword.trim()) {
        updates.current_password = editCurrentPassword.trim();
      }
      if (editPassword.trim()) {
        if (editPassword.length < 6) {
          setEditError("New password must be at least 6 characters");
          setEditSaving(false);
          return;
        }
        updates.new_password = editPassword.trim();
      }
      if (editPhoto !== (data?.doctor?.photo || null)) {
        updates.photo = editPhoto || "";
      }
      if (Object.keys(updates).length > 0) {
        await api.post("/doctor/update_profile", updates);
      }
      setEditOpen(false);
      load(true);
    } catch (e: any) {
      setEditError(e.message || "Failed to update profile");
    } finally {
      setEditSaving(false);
    }
  };

  const handleAddReceptionist = async () => {
    setRecError(null);
    if (!recName.trim() || !recEmail.trim() || !recPassword.trim()) {
      setRecError("Name, Email & Password are required");
      return;
    }
    setRecSaving(true);
    try {
      await api.post("/doctor/add-receptionist", {
        full_name: recName.trim(),
        email: recEmail.trim().toLowerCase(),
        password: recPassword,
        mobile: recMobile.trim() || undefined
      });
      setRecName(""); setRecEmail(""); setRecPassword(""); setRecMobile(""); setRecModalOpen(false);
      load(true);
    } catch (e: any) {
      setRecError(e.message || "Failed to add receptionist");
    } finally { setRecSaving(false); }
  };

  const openEditReceptionist = (r: any) => {
    setEditRecId(r.id);
    setEditRecName(r.full_name || "");
    setEditRecEmail(r.email || "");
    setEditRecMobile(r.mobile || r.phone || "");
    setEditRecStatus((r.status === "inactive" || r.login_disabled) ? "inactive" : "active");
    setEditRecPassword("");
    setEditRecError(null);
    setEditRecModalOpen(true);
  };

  const handleSaveEditReceptionist = async () => {
    setEditRecError(null);
    if (!editRecName.trim() || editRecName.trim().length < 2) {
      setEditRecError("Name must be at least 2 characters long");
      return;
    }
    if (!editRecEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editRecEmail.trim())) {
      setEditRecError("Please enter a valid email address");
      return;
    }
    const cleanMob = editRecMobile.replace(/[^0-9]/g, "");
    if (editRecMobile.trim() && cleanMob.length < 10) {
      setEditRecError("Mobile number must be at least 10 digits");
      return;
    }
    if (editRecPassword.trim() && editRecPassword.trim().length < 6) {
      setEditRecError("Password must be at least 6 characters");
      return;
    }

    setEditRecSaving(true);
    try {
      const payload: any = {
        full_name: editRecName.trim(),
        email: editRecEmail.trim().toLowerCase(),
        mobile: cleanMob || undefined,
        status: editRecStatus,
      };
      if (editRecPassword.trim()) {
        payload.password = editRecPassword.trim();
      }
      await api.put(`/doctor/receptionists/${editRecId}`, payload);
      setEditRecModalOpen(false);
      load(true);
    } catch (e: any) {
      setEditRecError(e.message || "Failed to update receptionist");
    } finally {
      setEditRecSaving(false);
    }
  };


  const handleDeleteReceptionist = (id: string, name?: string) => {
    Alert.alert(
      "Remove Receptionist?",
      `Are you sure you want to remove ${name || "this receptionist"}? This will permanently delete their account from the database.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            try {
              setReceptionists((prev) => prev.filter((r) => r.id !== id));
              await api.del(`/doctor/receptionists/${id}`);
              load(true);
            } catch (e: any) {
              Alert.alert("Error", e.message || "Failed to delete receptionist");
              load(true);
            }
          }
        }
      ]
    );
  };

  if (authLoading || (loading && !data)) {
    return (
      <SafeAreaView style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.brandPrimary} />
      </SafeAreaView>
    );
  }

  if (!data && profileError) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: spacing.xl }}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.error} />
          <Text style={{ fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginTop: 12 }}>
            Unable to Load Dashboard
          </Text>
          <Text style={{ fontSize: font.sm, color: colors.muted, textAlign: "center", marginTop: 8, marginBottom: 20 }}>
            {profileError}
          </Text>
          <Pressable
            onPress={() => { setLoading(true); load(false, true); }}
            style={{ backgroundColor: colors.brandPrimary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: radius.md }}
          >
            <Text style={{ color: colors.onBrandPrimary, fontWeight: "700" }}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const currentMode = data.status;
  const filteredAppts = appts.filter((a) => {
    if (filterStatus === "pending") return ["booked", "arrived", "in_consultation"].includes(a.status);
    if (filterStatus === "completed") return a.status === "completed";
    return true;
  });

  const nextPatient =
    appts.find((a) => a.status === "in_consultation") ||
    appts.find((a) => a.status === "arrived") ||
    appts.find((a) => a.status === "booked");

  const handleDownloadExcel = async () => {
    const docId = data?.doctor?.id || (user as any)?.doctor_id || (user as any)?.id;
    if (!docId) {
      Alert.alert("Error", "Doctor profile not loaded.");
      return;
    }
    setExportLoading(true);
    try {
      const token = await AsyncStorage.getItem("cq_token");
      const url = `${getApiBase()}/reception/export-excel?doctor_id=${docId}&date=${selectedDate}`;
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
        const docName = (data?.doctor?.full_name || user?.full_name || "Doctor").replace(/[^\w\-]/g, "_");
        a.download = `DoctorSchedule_${docName}_${selectedDate}.xlsx`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(blobUrl);
      } else {
        Alert.alert("Notice", "Excel export is optimized for web browser.");
      }
    } catch (err: any) {
      Alert.alert("Export Error", err?.message || "Failed to download Excel report");
    } finally {
      setExportLoading(false);
    }
  };

  const handlePrintPatientList = () => {
    const clinicTitle = data?.doctor?.hospital_name || data?.doctor?.clinic_name || "MeriBaari Clinic";
    const docTitle = data?.doctor?.full_name || user?.full_name || "Doctor";
    const filterLabel =
      filterStatus === "all"
        ? "All Patients"
        : filterStatus === "pending"
        ? "Pending Patients"
        : "Completed Patients";

    printPatientList({
      hospitalName: clinicTitle,
      doctorName: docTitle,
      date: selectedDate,
      filterLabel,
      patients: filteredAppts,
    });
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* ── Header ── */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Good day, Doctor</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Text style={styles.name}>{user?.full_name}</Text>
            <View style={[styles.liveDot, wsConnected && { backgroundColor: colors.success }]} />
          </View>
        </View>
        <Pressable
          onPress={() => setSessionManagerOpen(true)}
          testID="doctor-open-shifts-modal"
          style={[styles.iconBtn, { backgroundColor: colors.brandSecondary }]}
          accessibilityLabel="Manage OPD Shifts and Slots"
        >
          <Ionicons name="calendar-outline" size={20} color={colors.brandPrimary} />
        </Pressable>
        <Pressable onPress={openEditProfile} testID="doctor-edit-profile" style={styles.iconBtn}>
          <Ionicons name="create-outline" size={20} color={colors.brandPrimary} />
        </Pressable>
        <Pressable
          onPress={async () => { await signOut(); router.replace("/login"); }}
          testID="doctor-logout"
          style={styles.iconBtn}
        >
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: Math.max(insets.bottom + 40, 100) }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
      >
        {/* ── Doctor Session Timing Bar & Controls (with stable placeholder to eliminate layout jump) ── */}
        {docSession && data?.doctor?.id ? (
          <DoctorSessionBar
            doctorId={data.doctor.id}
            doctorName={data.doctor.full_name || user?.full_name || "Doctor"}
            session={docSession}
            waitingCount={appts.filter((a) => ["booked", "arrived"].includes(a.status)).length}
            onRefresh={() => load(true, true)}
          />
        ) : (
          <View style={styles.sessionBarPlaceholder}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              {loading ? (
                <ActivityIndicator size="small" color={colors.brandPrimary} />
              ) : (
                <Ionicons name="time-outline" size={24} color={colors.muted} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.placeholderTitle}>Consultation Session & Timing</Text>
                <Text style={styles.placeholderSub}>
                  {loading ? "Loading OPD session status and timings..." : "Session not started. Consultation session is inactive."}
                </Text>
              </View>
              {!loading && (
                <Pressable
                  onPress={() => load(false, true)}
                  style={{ padding: spacing.xs }}
                >
                  <Ionicons name="refresh" size={18} color={colors.brandPrimary} />
                </Pressable>
              )}
            </View>
          </View>
        )}

        {/* ── Quick Action: Shift & Custom Slot Management ── */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
          <View style={{ flex: 1, paddingRight: spacing.sm }}>
            <Text style={{ fontSize: font.sm, fontWeight: "700", color: colors.onSurface }}>OPD Sessions & Shifts</Text>
            <Text style={{ fontSize: 11, color: colors.muted }}>Day shift, Night shift, Emergency shift & Holidays</Text>
          </View>
          <Pressable
            testID="doctor-opd-sessions-shifts-btn"
            onPress={() => setSessionManagerOpen(true)}
            style={{ backgroundColor: colors.brandPrimary, paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: 6 }}
          >
            <Ionicons name="calendar-outline" size={16} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: font.sm }}>OPD Sessions & Shifts</Text>
          </Pressable>
        </View>

        {/* ── Doctor Working Mode / Alert Status ── */}
        <View style={styles.modeSectionHeader}>
          <Text style={styles.modeSectionTitle}>Doctor Working Mode / Alert Status</Text>
          <Text style={styles.modeSectionHint}>Controls triage availability and patient alert banners</Text>
        </View>
        <View style={styles.modeRow}>
          {modes.map((m) => {
            const active = currentMode === m.key;
            return (
              <Pressable
                key={m.key}
                testID={`mode-${m.key}`}
                disabled={statusLoading}
                onPress={() => changeStatus(m.key)}
                style={[
                  styles.modeChip,
                  active && { backgroundColor: m.color, borderColor: m.color },
                  statusLoading && { opacity: 0.7 },
                ]}
              >
                <Ionicons name={m.icon} size={16} color={active ? "#fff" : m.color} />
                <Text style={[styles.modeText, active && { color: "#fff" }]}>{m.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {/* ── KPIs ── */}
        <View style={styles.kpiRow}>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Total</Text><Text style={styles.kpiValue}>{data.total_patients}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Completed</Text><Text style={[styles.kpiValue, { color: colors.success }]}>{data.completed}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Pending</Text><Text style={[styles.kpiValue, { color: colors.warning }]}>{data.pending}</Text></View>
          <View style={styles.kpiCard}><Text style={styles.kpiLabel}>Earnings</Text><Text style={[styles.kpiValue, { color: colors.brandPrimary }]}>₹{data.earnings}</Text></View>
        </View>

        {/* ── View-Only Calendar Summary ── */}
        <Text style={styles.sectionTitle}>Daily Patient Calendar</Text>
        <CalendarSummary
          summaryData={summaryData}
          selectedDate={selectedDate}
          onSelectDate={(date) => {
            setSelectedDate(date);
            selectedDateRef.current = date;
            load(true, true);
          }}
        />

        {/* ── Receptionist Management ── */}
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: spacing.md }}>
          <Text style={styles.sectionTitle}>Assigned Receptionists</Text>
          <Pressable onPress={() => setRecModalOpen(true)} style={{ backgroundColor: colors.brandPrimary, paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "600", fontSize: font.sm }}>Add Receptionist</Text>
          </Pressable>
        </View>
        {receptionists.length === 0 ? (
          <Text style={{ color: colors.muted, fontSize: font.sm }}>No receptionists assigned yet.</Text>
        ) : (
          receptionists.map((r) => {
            const isInactive = r.status === "inactive" || r.login_disabled;
            return (
              <View key={r.id} style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginBottom: 4, gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={{ fontSize: font.base, fontWeight: "600", color: colors.onSurface }}>{r.full_name}</Text>
                    <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: radius.sm, backgroundColor: isInactive ? "#F1F5F9" : "#ECFDF5", borderWidth: 1, borderColor: isInactive ? "#CBD5E1" : "#A7F3D0" }}>
                      <Text style={{ fontSize: 9, fontWeight: "700", color: isInactive ? "#64748B" : "#059669" }}>
                        {isInactive ? "INACTIVE" : "ACTIVE"}
                      </Text>
                    </View>
                  </View>
                  <Text style={{ fontSize: 11, color: colors.muted, marginTop: 2 }}>{r.email} {r.mobile || r.phone ? `· ${r.mobile || r.phone}` : ""}</Text>
                </View>
                <Pressable
                  testID={`edit-receptionist-btn-${r.id}`}
                  onPress={() => openEditReceptionist(r)}
                  style={{ padding: spacing.xs, backgroundColor: colors.brandSecondary, borderRadius: radius.sm }}
                >
                  <Ionicons name="create-outline" size={17} color={colors.brandPrimary} />
                </Pressable>
                <Pressable
                  testID={`delete-receptionist-btn-${r.id}`}
                  onPress={() => handleDeleteReceptionist(r.id, r.full_name)}
                  style={{ padding: spacing.xs }}
                >
                  <Ionicons name="trash-outline" size={18} color={colors.error} />
                </Pressable>
              </View>
            );
          })
        )}

        {/* ── Next patient card ── */}
        {nextPatient && (
          <View style={styles.nextCard}>
            <Pressable
              testID="doctor-next-patient-clickable"
              onPress={() => setSelectedPatientAppt(nextPatient)}
              style={{ cursor: "pointer" } as any}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.nextLabel}>NEXT PATIENT</Text>
                <Text style={styles.viewDetailsHint}>View / Edit Details →</Text>
              </View>
              <Text style={styles.nextName}>{nextPatient.patient_name}</Text>
              <Text style={styles.nextMeta}>
                Token #{nextPatient.token_number} · {nextPatient.slot} · {nextPatient.status.replace("_", " ")}
              </Text>
            </Pressable>
            {nextPatient.status !== "in_consultation" ? (
              <Pressable
                testID="call-next-btn"
                onPress={() => doAction("/reception/start_consultation", nextPatient.id, "in_consultation", "Call")}
                disabled={!!actionLoadingMap[nextPatient.id]}
                style={[styles.callBtn, !!actionLoadingMap[nextPatient.id] && { opacity: 0.7 }]}
              >
                {actionLoadingMap[nextPatient.id] === "Call" ? (
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                ) : (
                  <>
                    <Ionicons name="mic" size={18} color={colors.brandPrimary} />
                    <Text style={styles.callBtnText}>Call Next Patient</Text>
                  </>
                )}
              </Pressable>
            ) : (
              <Pressable
                testID="complete-btn"
                onPress={() => doAction("/reception/complete", nextPatient.id, "completed", "Done")}
                disabled={!!actionLoadingMap[nextPatient.id]}
                style={[styles.callBtn, { backgroundColor: colors.success }, !!actionLoadingMap[nextPatient.id] && { opacity: 0.7 }]}
              >
                {actionLoadingMap[nextPatient.id] === "Done" ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <Ionicons name="checkmark-circle" size={18} color="#fff" />
                    <Text style={[styles.callBtnText, { color: "#fff" }]}>Mark Consultation Done</Text>
                  </>
                )}
              </Pressable>
            )}
          </View>
        )}

        {/* ── Patient queue section header with Print & Excel buttons ── */}
        <View style={styles.sectionHeaderRow}>
          <View style={{ flex: 1, minWidth: 160 }}>
            <Text style={styles.sectionTitle}>
              Today&apos;s Schedule · {selectedDate}
            </Text>
            <Text style={styles.sectionSub}>
              {filteredAppts.length} patient(s) · Tap any patient to view or edit details
            </Text>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pressable
              testID="doctor-print-patient-list-btn"
              onPress={handlePrintPatientList}
              style={styles.printBtn}
            >
              <Ionicons name="print-outline" size={16} color={colors.brandPrimary} />
              <Text style={styles.printBtnText}>Print</Text>
            </Pressable>
            <Pressable
              testID="doctor-export-excel-btn"
              onPress={handleDownloadExcel}
              disabled={exportLoading}
              style={[styles.exportBtn, exportLoading && { opacity: 0.6 }]}
            >
              {exportLoading ? (
                <ActivityIndicator size="small" color="#0F766E" />
              ) : (
                <>
                  <Ionicons name="download-outline" size={16} color="#0F766E" />
                  <Text style={styles.exportBtnText}>Excel</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        {/* ── Filter Tabs ── */}
        <View style={styles.filterChipsRow}>
          <Pressable
            testID="doctor-filter-all"
            onPress={() => setFilterStatus("all")}
            style={[styles.filterChip, filterStatus === "all" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, filterStatus === "all" && styles.filterChipTextActive]}>
              All ({appts.length})
            </Text>
          </Pressable>
          <Pressable
            testID="doctor-filter-pending"
            onPress={() => setFilterStatus("pending")}
            style={[styles.filterChip, filterStatus === "pending" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, filterStatus === "pending" && styles.filterChipTextActive]}>
              Pending ({appts.filter((a) => ["booked", "arrived", "in_consultation"].includes(a.status)).length})
            </Text>
          </Pressable>
          <Pressable
            testID="doctor-filter-completed"
            onPress={() => setFilterStatus("completed")}
            style={[styles.filterChip, filterStatus === "completed" && styles.filterChipActive]}
          >
            <Text style={[styles.filterChipText, filterStatus === "completed" && styles.filterChipTextActive]}>
              Completed ({appts.filter((a) => a.status === "completed").length})
            </Text>
          </Pressable>
        </View>

        {/* ── Schedule list ── */}
        {profileError ? (
          <View style={[styles.empty, { borderColor: "#FCA5A5", backgroundColor: "#FEF2F2", padding: 20 }]}>
            <Ionicons name="alert-circle-outline" size={40} color="#DC2626" />
            <Text style={[styles.emptyText, { color: "#991B1B", fontWeight: "700", marginTop: 8 }]}>Failed to Load Appointments</Text>
            <Text style={{ fontSize: 13, color: "#7F1D1D", textAlign: "center", marginTop: 4, marginBottom: 12 }}>{profileError}</Text>
            <Pressable
              onPress={() => load(false, true)}
              style={{ backgroundColor: "#DC2626", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 6 }}
            >
              <Ionicons name="refresh" size={16} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>Retry</Text>
            </Pressable>
          </View>
        ) : filteredAppts.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="people-outline" size={40} color={colors.muted} />
            {appts.length > 0 && filterStatus !== "all" ? (
              <>
                <Text style={[styles.emptyText, { fontWeight: "600" }]}>No {filterStatus} patients for {selectedDate}</Text>
                <Text style={[styles.emptyText, { fontSize: 12, marginTop: 4 }]}>There are {appts.length} total patient(s) in other statuses.</Text>
                <Pressable
                  onPress={() => setFilterStatus("all")}
                  style={{ marginTop: 10, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.brandPrimary, borderRadius: 6 }}
                >
                  <Text style={{ color: "#fff", fontWeight: "600", fontSize: 13 }}>View All Patients ({appts.length})</Text>
                </Pressable>
              </>
            ) : (
              <Text style={styles.emptyText}>No patients match the selected filter for {selectedDate}</Text>
            )}
          </View>
        ) : (
          filteredAppts.map((a) => {
            const statusColor = STATUS_COLORS[a.status] || colors.muted;
            const availableActions = rowActions.filter((ra) => ra.showOn.includes(a.status));
            const isDone = a.status === "completed";
            return (
              <View key={a.id} style={[styles.apptCard, isDone && { opacity: 0.6 }]}>
                {/* Clickable Patient Information Area */}
                <Pressable
                  testID={`doctor-patient-row-${a.id}`}
                  onPress={() => setSelectedPatientAppt(a)}
                  style={styles.patientInfoPressable}
                >
                  <View style={[styles.tokenBubble, a.status === "in_consultation" && { backgroundColor: colors.brandPrimary }]}>
                    <Text style={[styles.tokenText, a.status === "in_consultation" && { color: colors.onBrandPrimary }]}>#{a.token_number}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <Text style={styles.apptName}>{a.patient_name}</Text>
                      <Ionicons name="information-circle-outline" size={14} color={colors.brandPrimary} />
                    </View>
                    <View style={styles.metaRow}>
                      <Text style={styles.apptMeta}>{a.slot}</Text>
                      <View style={[styles.statusPill, { backgroundColor: statusColor + "22" }]}>
                        <Text style={[styles.statusText, { color: statusColor }]}>{a.status.replace("_", " ")}</Text>
                      </View>
                      {a.payment_status ? (
                        <View style={[styles.statusPill, { backgroundColor: (a.payment_status === "paid" ? colors.success : colors.warning) + "22" }]}>
                          <Text style={[styles.statusText, { color: a.payment_status === "paid" ? colors.success : colors.warning }]}>
                            {a.payment_status.toUpperCase()}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    {a.patient_mobile ? (
                      <Text style={styles.contactMeta}>📞 {a.patient_mobile}</Text>
                    ) : null}
                    {a.symptoms ? <Text style={styles.symptoms} numberOfLines={1}>💊 {a.symptoms}</Text> : null}
                  </View>
                </Pressable>

                <View style={styles.rowActions}>
                  {availableActions.map((act) => {
                    const isActing = actionLoadingMap[a.id] === act.label;
                    const targetStatus =
                      act.label === "Call" ? "in_consultation" :
                      act.label === "Done" ? "completed" :
                      act.label === "Arrived" ? "arrived" :
                      act.label === "Restore" ? "arrived" : "skipped";

                    return (
                      <Pressable
                        key={act.label}
                        testID={`doc-action-${act.label.toLowerCase()}-${a.id}`}
                        onPress={() => doAction(act.path, a.id, targetStatus, act.label)}
                        disabled={!!actionLoadingMap[a.id]}
                        style={[styles.rowActBtn, { backgroundColor: act.color + "18", borderColor: act.color + "44" }, !!actionLoadingMap[a.id] && { opacity: 0.6 }]}
                      >
                        {isActing ? (
                          <ActivityIndicator size="small" color={act.color} />
                        ) : (
                          <>
                            <Ionicons name={act.icon} size={15} color={act.color} />
                            <Text style={[styles.rowActBtnLabel, { color: act.color }]}>{act.label}</Text>
                          </>
                        )}
                      </Pressable>
                    );
                  })}
                  <Pressable
                    testID={`presc-${a.id}`}
                    onPress={() => { setPrescOpen(a); setPrescText(a.prescription || ""); }}
                    style={[styles.rowActBtn, { backgroundColor: colors.brandSecondary, borderColor: colors.brandPrimary + "44" }]}
                  >
                    <Ionicons name="document-text-outline" size={15} color={colors.brandPrimary} />
                    <Text style={[styles.rowActBtnLabel, { color: colors.brandPrimary }]}>Rx</Text>
                  </Pressable>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* ── Prescription Modal ── */}
      <Modal transparent visible={!!prescOpen} animationType="slide" onRequestClose={() => setPrescOpen(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
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
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Add Receptionist Modal ── */}
      <Modal transparent visible={recModalOpen} animationType="slide" onRequestClose={() => setRecModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.modalBackdrop} onPress={() => setRecModalOpen(false)}>
            <Pressable style={[styles.sheet, { maxHeight: "90%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Add Receptionist</Text>
              <Text style={styles.sheetSub}>Create a receptionist for your hospital (Hospital ID is locked to your hospital)</Text>
              
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
                <Text style={styles.editLabel}>Full Name*</Text>
                <TextInput value={recName} onChangeText={setRecName} placeholder="e.g. Rahul Sharma" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                <Text style={styles.editLabel}>Login Email*</Text>
                <TextInput value={recEmail} onChangeText={setRecEmail} keyboardType="email-address" autoCapitalize="none" placeholder="receptionist@hospital.com" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                <Text style={styles.editLabel}>Login Password*</Text>
                <TextInput value={recPassword} onChangeText={setRecPassword} secureTextEntry placeholder="Temporary password" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                <Text style={styles.editLabel}>Mobile Number (Optional)</Text>
                <TextInput value={recMobile} onChangeText={setRecMobile} keyboardType="phone-pad" placeholder="9876543210" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                {recError ? <Text style={{ color: colors.error, fontSize: font.sm, marginTop: 6, textAlign: "center" }}>{recError}</Text> : null}

                <Pressable onPress={handleAddReceptionist} disabled={recSaving} style={styles.saveBtn}>
                  {recSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Receptionist</Text>}
                </Pressable>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Edit Receptionist Modal ── */}
      <Modal transparent visible={editRecModalOpen} animationType="slide" onRequestClose={() => setEditRecModalOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.modalBackdrop} onPress={() => setEditRecModalOpen(false)}>
            <Pressable style={[styles.sheet, { maxHeight: "90%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Edit Receptionist</Text>
              <Text style={styles.sheetSub}>Update receptionist profile, status, or reset credentials</Text>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 20 }}>
                <Text style={styles.editLabel}>Full Name*</Text>
                <TextInput
                  testID="edit-rec-name"
                  value={editRecName}
                  onChangeText={setEditRecName}
                  placeholder="e.g. Rahul Sharma"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Login Email*</Text>
                <TextInput
                  testID="edit-rec-email"
                  value={editRecEmail}
                  onChangeText={setEditRecEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  placeholder="receptionist@hospital.com"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Mobile Number (Optional)</Text>
                <TextInput
                  testID="edit-rec-mobile"
                  value={editRecMobile}
                  onChangeText={setEditRecMobile}
                  keyboardType="phone-pad"
                  placeholder="9876543210"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Account Status</Text>
                <View style={{ flexDirection: "row", gap: 10, marginVertical: 4 }}>
                  <Pressable
                    testID="edit-rec-status-active"
                    onPress={() => setEditRecStatus("active")}
                    style={[
                      styles.segmentBtn,
                      editRecStatus === "active" && { backgroundColor: "#ECFDF5", borderColor: "#059669" },
                    ]}
                  >
                    <Ionicons name="checkmark-circle" size={16} color={editRecStatus === "active" ? "#059669" : colors.muted} />
                    <Text style={{ fontSize: font.sm, fontWeight: "700", color: editRecStatus === "active" ? "#059669" : colors.muted }}>
                      Active
                    </Text>
                  </Pressable>

                  <Pressable
                    testID="edit-rec-status-inactive"
                    onPress={() => setEditRecStatus("inactive")}
                    style={[
                      styles.segmentBtn,
                      editRecStatus === "inactive" && { backgroundColor: "#F1F5F9", borderColor: "#64748B" },
                    ]}
                  >
                    <Ionicons name="pause-circle" size={16} color={editRecStatus === "inactive" ? "#64748B" : colors.muted} />
                    <Text style={{ fontSize: font.sm, fontWeight: "700", color: editRecStatus === "inactive" ? "#64748B" : colors.muted }}>
                      Inactive (Disabled)
                    </Text>
                  </Pressable>
                </View>

                <Text style={styles.editLabel}>Reset Password (leave empty to keep current)</Text>
                <TextInput
                  testID="edit-rec-password"
                  value={editRecPassword}
                  onChangeText={setEditRecPassword}
                  secureTextEntry
                  placeholder="New password (min 6 chars)"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                {editRecError ? (
                  <Text style={{ color: colors.error, fontSize: font.sm, marginTop: 6, textAlign: "center" }}>
                    {editRecError}
                  </Text>
                ) : null}

                <Pressable
                  testID="save-edit-receptionist-btn"
                  onPress={handleSaveEditReceptionist}
                  disabled={editRecSaving}
                  style={styles.saveBtn}
                >
                  {editRecSaving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.saveBtnText}>Update Receptionist</Text>
                  )}
                </Pressable>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Edit Profile Modal ── */}
      <Modal transparent visible={editOpen} animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.modalBackdrop} onPress={() => setEditOpen(false)}>
            <Pressable style={[styles.sheet, { maxHeight: "88%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>Update My Profile</Text>
              <Text style={styles.sheetSub}>Update your personal details, consultation fees, timings, photo &amp; password</Text>
              
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs, paddingBottom: 20 }}>
                {/* Photo section */}
                <Text style={styles.editLabel}>Profile Photo (Max 5 MB)</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginVertical: 6 }}>
                  {editPhoto ? (
                    <Image source={{ uri: editPhoto }} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.border }} />
                  ) : (
                    <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border }}>
                      <Ionicons name="person-circle-outline" size={44} color={colors.muted} />
                    </View>
                  )}
                  <View style={{ gap: 6, flex: 1 }}>
                    <Pressable onPress={pickPhoto} style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.brandSecondary, paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.md, alignSelf: "flex-start" }}>
                      <Ionicons name="camera-outline" size={16} color={colors.brandPrimary} />
                      <Text style={{ color: colors.brandPrimary, fontWeight: "600", fontSize: font.sm }}>Change Photo</Text>
                    </Pressable>
                    {editPhoto ? (
                      <Pressable onPress={() => setEditPhoto(null)} style={{ alignSelf: "flex-start" }}>
                        <Text style={{ color: colors.error, fontSize: font.xs, fontWeight: "600" }}>Remove Photo</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </View>

                {/* Personal Information */}
                <Text style={styles.editLabel}>Full Name*</Text>
                <TextInput
                  testID="edit-doc-fullname"
                  value={editName}
                  onChangeText={setEditName}
                  placeholder="Dr. Full Name"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Login Email Address</Text>
                <TextInput
                  testID="edit-doc-email"
                  value={editEmail}
                  onChangeText={setEditEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  placeholder="doctor@hospital.com"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Contact / Mobile Number</Text>
                <TextInput
                  testID="edit-doc-mobile"
                  value={editMobile}
                  onChangeText={setEditMobile}
                  keyboardType="phone-pad"
                  placeholder="9876543210"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Specialization / Department</Text>
                <TextInput
                  testID="edit-doc-specialization"
                  value={editSpecialization}
                  onChangeText={setEditSpecialization}
                  placeholder="e.g. General Physician, Pediatrics"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Hospital or Clinic Name</Text>
                <TextInput
                  testID="edit-doc-clinic-name"
                  value={editClinicName}
                  onChangeText={setEditClinicName}
                  placeholder="e.g. MeriBaari Wellness Clinic"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                {/* Password section with current password verification */}
                <Text style={styles.editLabel}>Current Password (required only if changing password)</Text>
                <TextInput
                  testID="edit-doc-current-password"
                  value={editCurrentPassword}
                  onChangeText={setEditCurrentPassword}
                  secureTextEntry
                  placeholder="Current Password"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>New Password (leave empty to keep current)</Text>
                <TextInput
                  testID="edit-doc-new-password"
                  value={editPassword}
                  onChangeText={setEditPassword}
                  secureTextEntry
                  placeholder="New Password (min 6 chars)"
                  placeholderTextColor={colors.muted}
                  style={styles.editInput}
                />

                <Text style={styles.editLabel}>Consultation Fees (₹)</Text>
                <TextInput testID="edit-fees" value={editFees} onChangeText={(v) => setEditFees(v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" placeholder="500" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                <Text style={styles.editLabel}>⏱ Avg. Time per Patient (minutes)</Text>
                <TextInput testID="edit-avgmin" value={editAvgMin} onChangeText={(v) => setEditAvgMin(v.replace(/[^0-9]/g, "").slice(0, 3))} keyboardType="number-pad" placeholder="15" placeholderTextColor={colors.muted} style={styles.editInput} />
                <Text style={styles.hintTxt}>Patients ki live wait time is number × queue position se calculate hoti hai</Text>
                
                <Text style={styles.editLabel}>Timings</Text>
                <TextInput testID="edit-timings" value={editTimings} onChangeText={setEditTimings} placeholder="10:00 AM - 4:00 PM" placeholderTextColor={colors.muted} style={styles.editInput} />
                
                <Text style={styles.editLabel}>Bio (optional)</Text>
                <TextInput testID="edit-bio" value={editBio} onChangeText={setEditBio} multiline placeholder="Short bio" placeholderTextColor={colors.muted} style={[styles.editInput, { minHeight: 70, textAlignVertical: "top" }]} />
                
                {editError ? <Text style={{ color: colors.error, fontSize: font.sm, marginTop: 6, textAlign: "center" }}>{editError}</Text> : null}

                <Pressable testID="edit-save" onPress={saveProfile} disabled={editSaving} style={styles.saveBtn}>
                  {editSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Save Changes</Text>}
                </Pressable>
              </ScrollView>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>


      {/* ── Patient Details View / Edit Modal (deferred until selected) ── */}
      {!!selectedPatientAppt && (
        <PatientDetailsModal
          visible={!!selectedPatientAppt}
          appointment={selectedPatientAppt}
          onClose={() => setSelectedPatientAppt(null)}
          onUpdated={(updated) => {
            setAppts((prev) =>
              prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a))
            );
            setSelectedPatientAppt(updated);
          }}
        />
      )}

      {/* ── Shifts & Custom Slots Manager Modal (deferred until opened) ── */}
      {data?.doctor?.id && sessionManagerOpen && (
        <DoctorSessionManagerModal
          visible={sessionManagerOpen}
          doctorId={data.doctor.id}
          doctorName={data.doctor.full_name || user?.full_name || "Doctor"}
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
  header: { flexDirection: "row", padding: spacing.lg, alignItems: "center", gap: spacing.sm },
  hello: { fontSize: font.base, color: colors.muted },
  name: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.muted, marginLeft: 4 },
  iconBtn: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  sessionBarPlaceholder: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 120,
    justifyContent: "center",
  },
  placeholderTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
  },
  placeholderSub: {
    fontSize: font.xs,
    color: colors.muted,
    marginTop: 2,
  },
  modeSectionHeader: {
    marginTop: spacing.xs,
    marginBottom: 4,
  },
  modeSectionTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
  },
  modeSectionHint: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 1,
  },
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
  viewDetailsHint: { fontSize: font.xs, color: colors.brandTertiary, fontWeight: "600" },
  callBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.onBrandPrimary, padding: spacing.md, borderRadius: radius.md, marginTop: spacing.md },
  callBtnText: { color: colors.brandPrimary, fontWeight: "700", fontSize: font.base },
  sectionTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.md,
    flexWrap: "wrap",
    gap: 8,
  },
  sectionSub: {
    fontSize: font.xs,
    color: colors.muted,
    marginTop: 2,
  },
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
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
    backgroundColor: "#F0FDFA",
    borderWidth: 1,
    borderColor: "#0F766E",
  },
  exportBtnText: {
    fontSize: font.sm,
    fontWeight: "600",
    color: "#0F766E",
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
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  contactMeta: {
    fontSize: 11,
    color: colors.muted,
    marginTop: 2,
  },
  empty: { alignItems: "center", padding: spacing.xl },
  emptyText: { color: colors.muted },
  apptCard: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  tokenBubble: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  tokenText: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary },
  apptName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 4, flexWrap: "wrap" },
  apptMeta: { fontSize: font.sm, color: colors.muted },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  statusText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  symptoms: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 2 },
  rowActions: {
    flexDirection: "row",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 8,
  },
  rowActBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    minHeight: 38,
  },
  rowActBtnLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  prescInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, minHeight: 140, textAlignVertical: "top" },
  editLabel: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: 4, fontWeight: "600" },
  editInput: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, backgroundColor: colors.surface },
  hintTxt: { fontSize: 11, color: colors.muted, marginTop: 4, fontStyle: "italic" },
  saveBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.md },
  saveBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
  segmentBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
});

