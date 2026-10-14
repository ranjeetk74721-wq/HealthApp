import React, { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Platform,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";
import { api } from "@/src/api/client";

interface DoctorSessionManagerModalProps {
  visible: boolean;
  doctorId: string;
  doctorName: string;
  initialDate?: string;
  onClose: () => void;
  onSessionsUpdated?: () => void;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

interface BookingWindowItem {
  id: string;
  start_time: string;
  end_time: string;
  category: "local" | "distant" | "all";
  max_bookings?: number | null;
  description?: string;
}

export default function DoctorSessionManagerModal({
  visible,
  doctorId,
  doctorName,
  initialDate,
  onClose,
  onSessionsUpdated,
}: DoctorSessionManagerModalProps) {
  const [selectedDate, setSelectedDate] = useState<string>(
    initialDate || new Date().toISOString().split("T")[0]
  );
  const [sessions, setSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "form" | "date_override">("list");
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);

  // Form states
  const [sessionName, setSessionName] = useState("Morning OPD");
  const [clinicName, setClinicName] = useState("");
  const [clinicCity, setClinicCity] = useState("");
  const [clinicAddress, setClinicAddress] = useState("");
  const [dateType, setDateType] = useState<"recurring" | "date">("recurring");
  const [specificDate, setSpecificDate] = useState(selectedDate);
  const [selectedDays, setSelectedDays] = useState<string[]>([
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"
  ]);
  const [startTime, setStartTime] = useState("10:00 AM");
  const [endTime, setEndTime] = useState("02:00 PM");
  const [bookingOpenTime, setBookingOpenTime] = useState("");
  const [bookingCloseTime, setBookingCloseTime] = useState("");
  const [isUnlimitedCapacity, setIsUnlimitedCapacity] = useState(false);
  const [maxBookings, setMaxBookings] = useState("30");
  const [slotDuration, setSlotDuration] = useState("15");
  const [selfBookingEnabled, setSelfBookingEnabled] = useState(true);

  // Location Rules
  const [ruleType, setRuleType] = useState<"both" | "radius" | "areas" | "none">("both");
  const [radiusKm, setRadiusKm] = useState("15");
  const [localAreasInput, setLocalAreasInput] = useState("");
  const [localAreas, setLocalAreas] = useState<string[]>([]);

  // Booking Windows
  const [bookingWindows, setBookingWindows] = useState<BookingWindowItem[]>([
    { id: "w1", start_time: "10:00 AM", end_time: "11:00 AM", category: "local", description: "Local patients only" },
    { id: "w2", start_time: "11:00 AM", end_time: "01:00 PM", category: "distant", description: "Distant patients only" },
    { id: "w3", start_time: "01:00 PM", end_time: "02:00 PM", category: "all", description: "All patients" },
  ]);

  // Date Override Modal state
  const [overrideSession, setOverrideSession] = useState<any | null>(null);
  const [overrideStatus, setOverrideStatus] = useState<"active" | "closed" | "cancelled">("cancelled");
  const [overrideStartTime, setOverrideStartTime] = useState("");
  const [overrideEndTime, setOverrideEndTime] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [savingOverride, setSavingOverride] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch sessions for doctor & selected date
  const loadSessions = useCallback(async () => {
    if (!doctorId) return;
    setLoading(true);
    try {
      const res = await api.get(`/doctor/${doctorId}/sessions?date=${selectedDate}`);
      setSessions(res?.sessions || []);
    } catch (e: any) {
      console.log("Error loading doctor sessions:", e);
    } finally {
      setLoading(false);
    }
  }, [doctorId, selectedDate]);

  useEffect(() => {
    if (visible) {
      loadSessions();
    }
  }, [visible, loadSessions]);

  const toggleDay = (day: string) => {
    if (selectedDays.includes(day)) {
      if (selectedDays.length === 1) return; // Keep at least one day
      setSelectedDays(selectedDays.filter((d) => d !== day));
    } else {
      setSelectedDays([...selectedDays, day]);
    }
  };

  const addLocalAreaTag = () => {
    const val = localAreasInput.trim();
    if (val && !localAreas.includes(val)) {
      setLocalAreas([...localAreas, val]);
      setLocalAreasInput("");
    }
  };

  const removeLocalAreaTag = (tag: string) => {
    setLocalAreas(localAreas.filter((t) => t !== tag));
  };

  const addWindow = () => {
    const newId = `w_${Date.now()}`;
    setBookingWindows([
      ...bookingWindows,
      { id: newId, start_time: startTime, end_time: endTime, category: "all", description: "Open to all patients" }
    ]);
  };

  const updateWindow = (idx: number, patch: Partial<BookingWindowItem>) => {
    const next = [...bookingWindows];
    next[idx] = { ...next[idx], ...patch };
    setBookingWindows(next);
  };

  const removeWindow = (idx: number) => {
    setBookingWindows(bookingWindows.filter((_, i) => i !== idx));
  };

  const resetForm = () => {
    setEditingSessionId(null);
    setSessionName("Morning OPD");
    setDateType("recurring");
    setSpecificDate(selectedDate);
    setSelectedDays(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
    setStartTime("10:00 AM");
    setEndTime("02:00 PM");
    setBookingOpenTime("");
    setBookingCloseTime("");
    setIsUnlimitedCapacity(false);
    setMaxBookings("30");
    setSlotDuration("15");
    setSelfBookingEnabled(true);
    setRuleType("both");
    setRadiusKm("15");
    setLocalAreas(["Jaipur", "Malviya Nagar", "Mansarovar"]);
    setBookingWindows([
      { id: "w1", start_time: "10:00 AM", end_time: "11:00 AM", category: "local", description: "Local patients" },
      { id: "w2", start_time: "11:00 AM", end_time: "01:00 PM", category: "distant", description: "Distant patients" },
      { id: "w3", start_time: "01:00 PM", end_time: "02:00 PM", category: "all", description: "All patients" },
    ]);
    setErrorMsg(null);
  };

  const openAddForm = () => {
    resetForm();
    setViewMode("form");
  };

  const openEditForm = (sess: any) => {
    setEditingSessionId(sess.id);
    setSessionName(sess.session_name || "Consultation Session");
    setClinicName(sess.clinic_name || "");
    setClinicCity(sess.clinic_city || "");
    setClinicAddress(sess.clinic_address || "");
    setDateType(sess.date_type || "recurring");
    setSpecificDate(sess.date || selectedDate);
    setSelectedDays(sess.days_of_week || WEEKDAYS.slice(0, 6));
    setStartTime(sess.start_time || "10:00 AM");
    setEndTime(sess.end_time || "02:00 PM");
    setBookingOpenTime(sess.booking_open_time || "");
    setBookingCloseTime(sess.booking_close_time || "");
    setIsUnlimitedCapacity(Boolean(sess.is_unlimited_capacity));
    setMaxBookings(sess.max_bookings ? String(sess.max_bookings) : "30");
    setSlotDuration(sess.slot_duration_minutes ? String(sess.slot_duration_minutes) : "15");
    setSelfBookingEnabled(sess.patient_self_booking_enabled !== false);

    const r = sess.location_rule || {};
    setRuleType(r.rule_type || "both");
    setRadiusKm(r.radius_km ? String(r.radius_km) : "15");
    setLocalAreas(r.local_areas || []);

    if (sess.booking_windows && sess.booking_windows.length > 0) {
      setBookingWindows(
        sess.booking_windows.map((w: any) => ({
          id: w.id || `w_${Math.random()}`,
          start_time: w.start_time,
          end_time: w.end_time,
          category: w.category || "all",
          max_bookings: w.max_bookings,
          description: w.description,
        }))
      );
    } else {
      setBookingWindows([
        { id: "w1", start_time: sess.start_time || "10:00 AM", end_time: sess.end_time || "02:00 PM", category: "all", description: "All patients" }
      ]);
    }
    setErrorMsg(null);
    setViewMode("form");
  };

  const openDateOverride = (sess: any) => {
    setOverrideSession(sess);
    setOverrideStatus("cancelled");
    setOverrideStartTime(sess.start_time || "");
    setOverrideEndTime(sess.end_time || "");
    setOverrideReason("Holiday / Doctor on leave for this day");
    setViewMode("date_override");
  };

  const handleSaveSession = async () => {
    setErrorMsg(null);
    if (!sessionName.trim()) {
      setErrorMsg("Session name is required (e.g. 'Morning OPD').");
      return;
    }
    if (!startTime.trim() || !endTime.trim()) {
      setErrorMsg("Start time and end time are required.");
      return;
    }

    const payload: any = {
      session_name: sessionName.trim(),
      clinic_name: clinicName.trim() || undefined,
      clinic_city: clinicCity.trim() || undefined,
      clinic_address: clinicAddress.trim() || undefined,
      date_type: dateType,
      date: dateType === "date" ? specificDate : undefined,
      days_of_week: dateType === "recurring" ? selectedDays : undefined,
      start_time: startTime.trim(),
      end_time: endTime.trim(),
      booking_open_time: bookingOpenTime.trim() || undefined,
      booking_close_time: bookingCloseTime.trim() || undefined,
      max_bookings: isUnlimitedCapacity ? null : (parseInt(maxBookings, 10) || null),
      is_unlimited_capacity: isUnlimitedCapacity,
      slot_duration_minutes: parseInt(slotDuration, 10) || 15,
      patient_self_booking_enabled: selfBookingEnabled,
      location_rule: {
        rule_type: ruleType,
        radius_km: (ruleType === "radius" || ruleType === "both") ? (parseFloat(radiusKm) || null) : null,
        local_areas: (ruleType === "areas" || ruleType === "both") ? localAreas : [],
        distant_definition: "outside_local"
      },
      booking_windows: bookingWindows.map((w) => ({
        id: w.id,
        start_time: w.start_time.trim(),
        end_time: w.end_time.trim(),
        category: w.category,
        max_bookings: w.max_bookings ? Number(w.max_bookings) : null,
        description: w.description || undefined,
      })),
    };

    setSaving(true);
    try {
      if (editingSessionId && !editingSessionId.endsWith("_default")) {
        await api.put(`/doctor/${doctorId}/sessions/${editingSessionId}`, payload);
      } else {
        await api.post(`/doctor/${doctorId}/sessions`, payload);
      }
      await loadSessions();
      if (onSessionsUpdated) onSessionsUpdated();
      setViewMode("list");
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to save session schedule.");
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDateOverride = async () => {
    if (!overrideSession) return;
    setSavingOverride(true);
    try {
      await api.post(`/doctor/${doctorId}/sessions/${overrideSession.id}/date-override`, {
        date: selectedDate,
        status: overrideStatus,
        start_time: overrideStartTime.trim() || undefined,
        end_time: overrideEndTime.trim() || undefined,
        reason: overrideReason.trim() || undefined,
      });
      await loadSessions();
      if (onSessionsUpdated) onSessionsUpdated();
      setViewMode("list");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to save date override.");
    } finally {
      setSavingOverride(false);
    }
  };

  const handleCloseSession = async (sess: any) => {
    const confirmAction = async () => {
      try {
        await api.post(`/doctor/${doctorId}/sessions/${sess.id}/close`, { date: selectedDate });
        await loadSessions();
        if (onSessionsUpdated) onSessionsUpdated();
      } catch (e: any) {
        Alert.alert("Error", e.message || "Failed to close session.");
      }
    };

    if (Platform.OS === "web") {
      if (window.confirm(`Close bookings for "${sess.session_name}" on ${selectedDate}?`)) {
        confirmAction();
      }
    } else {
      Alert.alert("Close Bookings", `Close bookings for "${sess.session_name}" on ${selectedDate}?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Close Bookings", onPress: confirmAction },
      ]);
    }
  };

  const handleCancelSessionPrompt = (sess: any) => {
    Alert.alert(
      "Cancel Session",
      `How would you like to cancel "${sess.session_name}"?`,
      [
        {
          text: `Cancel for ${selectedDate} only`,
          onPress: async () => {
            try {
              await api.post(`/doctor/${doctorId}/sessions/${sess.id}/cancel`, { date: selectedDate });
              await loadSessions();
              if (onSessionsUpdated) onSessionsUpdated();
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
          },
        },
        {
          text: "Cancel all future occurrences",
          style: "destructive",
          onPress: async () => {
            try {
              await api.post(`/doctor/${doctorId}/sessions/${sess.id}/cancel`, {});
              await loadSessions();
              if (onSessionsUpdated) onSessionsUpdated();
            } catch (e: any) {
              Alert.alert("Error", e.message);
            }
          },
        },
        { text: "Abort", style: "cancel" },
      ]
    );
  };

  const handleDeleteSession = async (sess: any) => {
    const doDelete = async () => {
      try {
        await api.delete(`/doctor/${doctorId}/sessions/${sess.id}`);
        await loadSessions();
        if (onSessionsUpdated) onSessionsUpdated();
      } catch (e: any) {
        Alert.alert("Error", e.message || "Failed to delete session.");
      }
    };
    if (Platform.OS === "web") {
      if (window.confirm(`Permanently delete session "${sess.session_name}"?`)) doDelete();
    } else {
      Alert.alert("Delete Session", `Permanently delete session "${sess.session_name}"?`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ]);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.headerTitle}>Doctor Daily Sessions & Slots</Text>
            <Text style={styles.headerSub}>{doctorName} · Asia/Kolkata</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeBtn} testID="close-session-manager-btn">
            <Ionicons name="close" size={24} color={colors.onSurface} />
          </Pressable>
        </View>

        {viewMode === "list" && (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            {/* Top Toolbar */}
            <View style={styles.topToolbar}>
              <View style={styles.dateSelectorWrap}>
                <Ionicons name="calendar-outline" size={18} color={colors.brandPrimary} />
                <Text style={styles.dateLabel}>Selected Date:</Text>
                <TextInput
                  style={styles.dateInput}
                  value={selectedDate}
                  onChangeText={setSelectedDate}
                  placeholder="YYYY-MM-DD"
                />
                <Pressable onPress={loadSessions} style={styles.dateRefreshBtn}>
                  <Ionicons name="refresh" size={16} color={colors.brandPrimary} />
                </Pressable>
              </View>

              <Pressable onPress={openAddForm} style={styles.addBtn} testID="add-new-session-btn">
                <Ionicons name="add-circle" size={18} color="#fff" />
                <Text style={styles.addBtnText}>+ Add Session</Text>
              </Pressable>
            </View>

            {/* Sessions List */}
            {loading ? (
              <ActivityIndicator size="large" color={colors.brandPrimary} style={{ marginTop: 40 }} />
            ) : sessions.length === 0 ? (
              <View style={styles.emptyBox}>
                <Ionicons name="calendar" size={48} color={colors.muted} />
                <Text style={styles.emptyTitle}>No Sessions Configured</Text>
                <Text style={styles.emptySub}>Add as many sessions as needed within a day (e.g. Morning OPD, Evening Clinic).</Text>
                <Pressable onPress={openAddForm} style={styles.primaryBtn}>
                  <Text style={styles.primaryBtnText}>+ Add First Session</Text>
                </Pressable>
              </View>
            ) : (
              sessions.map((sess: any) => {
                const isCancelled = sess.status === "cancelled";
                const isClosed = sess.status === "closed";
                return (
                  <View key={sess.id} style={[styles.sessionCard, (isCancelled || isClosed) && { opacity: 0.8 }]}>
                    <View style={styles.cardHeader}>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          <Text style={styles.cardTitle}>{sess.session_name}</Text>
                          <View
                            style={[
                              styles.statusBadge,
                              isCancelled ? styles.statusBadgeCancelled : isClosed ? styles.statusBadgeClosed : styles.statusBadgeActive,
                            ]}
                          >
                            <Text style={styles.statusBadgeText}>
                              {sess.status ? sess.status.toUpperCase() : "ACTIVE"}
                            </Text>
                          </View>
                          {sess.has_date_override && (
                            <View style={styles.overrideBadge}>
                              <Text style={styles.overrideBadgeText}>Date-Specific Override</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.cardClinic}>
                          🏥 {sess.clinic_name} {sess.clinic_city ? `· ${sess.clinic_city}` : ""}
                        </Text>
                      </View>
                      <Text style={styles.cardTime}>
                        {sess.start_time} – {sess.end_time}
                      </Text>
                    </View>

                    {/* Capacity & Recurrence Row */}
                    <View style={styles.metaRow}>
                      <View style={styles.metaPill}>
                        <Ionicons name="people-outline" size={14} color={colors.onSurfaceSecondary} />
                        <Text style={styles.metaPillText}>
                          {sess.is_unlimited_capacity ? "Unlimited Capacity" : `${sess.current_bookings || 0} / ${sess.max_bookings} Bookings`}
                        </Text>
                      </View>
                      <View style={styles.metaPill}>
                        <Ionicons name="repeat-outline" size={14} color={colors.onSurfaceSecondary} />
                        <Text style={styles.metaPillText}>
                          {sess.date_type === "recurring"
                            ? (sess.days_of_week?.map((d: string) => d.slice(0, 3)).join(", ") || "Mon–Sat")
                            : `Single Date: ${sess.date}`}
                        </Text>
                      </View>
                      <View style={styles.metaPill}>
                        <Ionicons name="phone-portrait-outline" size={14} color={colors.onSurfaceSecondary} />
                        <Text style={styles.metaPillText}>
                          Self-booking: {sess.patient_self_booking_enabled ? "Enabled" : "Staff Only"}
                        </Text>
                      </View>
                    </View>

                    {/* Rule summaries preview */}
                    {sess.rule_summaries && sess.rule_summaries.length > 0 && (
                      <View style={styles.ruleSummaryBox}>
                        <Text style={styles.ruleSummaryTitle}>Booking Windows & Location Allocation:</Text>
                        {sess.rule_summaries.map((ruleText: string, rIdx: number) => (
                          <Text key={rIdx} style={styles.ruleSummaryLine}>• {ruleText}</Text>
                        ))}
                      </View>
                    )}

                    {/* Windows Badges Row */}
                    {sess.booking_windows && sess.booking_windows.length > 0 && (
                      <View style={styles.windowsRow}>
                        {sess.booking_windows.map((w: any) => (
                          <View
                            key={w.id}
                            style={[
                              styles.windowChip,
                              w.category === "local" ? styles.windowChipLocal : w.category === "distant" ? styles.windowChipDistant : styles.windowChipAll
                            ]}
                          >
                            <Text style={styles.windowChipText}>
                              {w.start_time}–{w.end_time} ({w.category.toUpperCase()})
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {/* Action Buttons */}
                    <View style={styles.actionRow}>
                      <Pressable onPress={() => openEditForm(sess)} style={styles.editActionBtn}>
                        <Ionicons name="pencil" size={14} color={colors.brandPrimary} />
                        <Text style={styles.editActionText}>Edit</Text>
                      </Pressable>

                      <Pressable onPress={() => openDateOverride(sess)} style={styles.overrideActionBtn}>
                        <Ionicons name="calendar" size={14} color={colors.warning} />
                        <Text style={styles.overrideActionText}>Date-Specific Change</Text>
                      </Pressable>

                      <Pressable onPress={() => handleCloseSession(sess)} style={styles.closeActionBtn}>
                        <Ionicons name="lock-closed-outline" size={14} color={colors.onSurfaceSecondary} />
                        <Text style={styles.closeActionText}>Close</Text>
                      </Pressable>

                      <Pressable onPress={() => handleCancelSessionPrompt(sess)} style={styles.cancelActionBtn}>
                        <Ionicons name="ban-outline" size={14} color={colors.error} />
                        <Text style={styles.cancelActionText}>Cancel</Text>
                      </Pressable>

                      {!sess.id.endsWith("_default") && (
                        <Pressable onPress={() => handleDeleteSession(sess)} style={styles.deleteActionBtn}>
                          <Ionicons name="trash-outline" size={14} color={colors.muted} />
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        )}

        {/* ── ADD / EDIT SESSION FORM ── */}
        {viewMode === "form" && (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <View style={styles.formHeaderRow}>
              <Pressable onPress={() => setViewMode("list")} style={styles.backBtn}>
                <Ionicons name="arrow-back" size={20} color={colors.onSurface} />
                <Text style={styles.backBtnText}>Back to Sessions</Text>
              </Pressable>
              <Text style={styles.formTitle}>
                {editingSessionId ? "Edit Session Schedule" : "Add New Daily Session"}
              </Text>
            </View>

            {errorMsg && (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={18} color="#DC2626" />
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            )}

            {/* Basic Info */}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>1. Session & Clinic Details</Text>
              <Text style={styles.fieldLabel}>Session Name *</Text>
              <TextInput
                style={styles.textInput}
                value={sessionName}
                onChangeText={setSessionName}
                placeholder="e.g. Session 1: Morning OPD, Session 2: Evening Clinic"
                testID="session-name-input"
              />

              <Text style={styles.fieldLabel}>Clinic / Location Name</Text>
              <TextInput
                style={styles.textInput}
                value={clinicName}
                onChangeText={setClinicName}
                placeholder="e.g. City Health Care Center"
              />

              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Clinic City</Text>
                  <TextInput
                    style={styles.textInput}
                    value={clinicCity}
                    onChangeText={setClinicCity}
                    placeholder="e.g. Jaipur"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Clinic Address</Text>
                  <TextInput
                    style={styles.textInput}
                    value={clinicAddress}
                    onChangeText={setClinicAddress}
                    placeholder="e.g. Civil Lines, Main Road"
                  />
                </View>
              </View>
            </View>

            {/* Date / Recurrence */}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>2. Schedule & Recurrence</Text>
              <View style={styles.toggleRow}>
                <Pressable
                  onPress={() => setDateType("recurring")}
                  style={[styles.toggleBtn, dateType === "recurring" && styles.toggleBtnActive]}
                >
                  <Text style={[styles.toggleBtnText, dateType === "recurring" && styles.toggleBtnTextActive]}>
                    Weekly Recurring Weekdays
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setDateType("date")}
                  style={[styles.toggleBtn, dateType === "date" && styles.toggleBtnActive]}
                >
                  <Text style={[styles.toggleBtnText, dateType === "date" && styles.toggleBtnTextActive]}>
                    Specific Single Date
                  </Text>
                </Pressable>
              </View>

              {dateType === "recurring" ? (
                <View style={styles.weekdaysWrap}>
                  {WEEKDAYS.map((day) => {
                    const active = selectedDays.includes(day);
                    return (
                      <Pressable
                        key={day}
                        onPress={() => toggleDay(day)}
                        style={[styles.dayChip, active && styles.dayChipActive]}
                      >
                        <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                          {day.slice(0, 3)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <View style={{ marginTop: spacing.sm }}>
                  <Text style={styles.fieldLabel}>Target Date (YYYY-MM-DD)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={specificDate}
                    onChangeText={setSpecificDate}
                    placeholder="YYYY-MM-DD"
                  />
                </View>
              )}
            </View>

            {/* Time Ranges */}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>3. Session Timings (12-hour AM/PM · Asia/Kolkata)</Text>
              <View style={{ flexDirection: "row", gap: spacing.md }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Start Time * (e.g. 10:00 AM)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={startTime}
                    onChangeText={setStartTime}
                    placeholder="10:00 AM"
                    testID="session-start-time-input"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>End Time * (e.g. 02:00 PM)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={endTime}
                    onChangeText={setEndTime}
                    placeholder="02:00 PM"
                    testID="session-end-time-input"
                  />
                </View>
              </View>

              <View style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Booking Opens (Optional)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={bookingOpenTime}
                    onChangeText={setBookingOpenTime}
                    placeholder="e.g. 08:00 AM"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Booking Closes (Optional)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={bookingCloseTime}
                    onChangeText={setBookingCloseTime}
                    placeholder="e.g. 01:30 PM"
                  />
                </View>
              </View>
            </View>

            {/* Capacity & Patient Booking */}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>4. Capacity & Patient Self-Booking</Text>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Unlimited Capacity (No maximum booking limit)</Text>
                <Pressable
                  onPress={() => setIsUnlimitedCapacity(!isUnlimitedCapacity)}
                  style={[styles.checkbox, isUnlimitedCapacity && styles.checkboxActive]}
                >
                  {isUnlimitedCapacity && <Ionicons name="checkmark" size={16} color="#fff" />}
                </Pressable>
              </View>

              {!isUnlimitedCapacity && (
                <View style={{ marginTop: spacing.sm }}>
                  <Text style={styles.fieldLabel}>Maximum Bookings for Session</Text>
                  <TextInput
                    style={styles.textInput}
                    value={maxBookings}
                    onChangeText={setMaxBookings}
                    keyboardType="numeric"
                    placeholder="30"
                  />
                </View>
              )}

              <View style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Slot Duration (Minutes)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={slotDuration}
                    onChangeText={setSlotDuration}
                    keyboardType="numeric"
                    placeholder="15"
                  />
                </View>
                <View style={{ flex: 1, justifyContent: "center" }}>
                  <Text style={styles.fieldLabel}>Patient Self-Booking</Text>
                  <Pressable
                    onPress={() => setSelfBookingEnabled(!selfBookingEnabled)}
                    style={[styles.smallToggle, selfBookingEnabled ? styles.smallToggleOn : styles.smallToggleOff]}
                  >
                    <Text style={styles.smallToggleText}>{selfBookingEnabled ? "Enabled (Online)" : "Reception Only"}</Text>
                  </Pressable>
                </View>
              </View>
            </View>

            {/* Location Eligibility Rule Editor */}
            <View style={styles.section}>
              <Text style={styles.sectionHeader}>5. Location Eligibility Rules (Local vs Distant)</Text>
              <Text style={styles.subHint}>
                Configure what counts as "Local". Distant category is automatically defined as patients outside the local radius or area.
              </Text>

              <View style={styles.ruleTypeRow}>
                <Pressable
                  onPress={() => setRuleType("both")}
                  style={[styles.radioItem, ruleType === "both" && styles.radioItemActive]}
                >
                  <Text style={[styles.radioText, ruleType === "both" && styles.radioTextActive]}>
                    Distance Radius + Areas
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRuleType("radius")}
                  style={[styles.radioItem, ruleType === "radius" && styles.radioItemActive]}
                >
                  <Text style={[styles.radioText, ruleType === "radius" && styles.radioTextActive]}>
                    Distance Radius Only
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRuleType("areas")}
                  style={[styles.radioItem, ruleType === "areas" && styles.radioItemActive]}
                >
                  <Text style={[styles.radioText, ruleType === "areas" && styles.radioTextActive]}>
                    Specific Cities/Areas Only
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setRuleType("none")}
                  style={[styles.radioItem, ruleType === "none" && styles.radioItemActive]}
                >
                  <Text style={[styles.radioText, ruleType === "none" && styles.radioTextActive]}>
                    No Restrictions (All Patients)
                  </Text>
                </Pressable>
              </View>

              {(ruleType === "radius" || ruleType === "both") && (
                <View style={{ marginTop: spacing.md }}>
                  <Text style={styles.fieldLabel}>Local Distance Radius from Clinic (km) * (Not Hardcoded)</Text>
                  <TextInput
                    style={styles.textInput}
                    value={radiusKm}
                    onChangeText={setRadiusKm}
                    keyboardType="numeric"
                    placeholder="e.g. 15"
                    testID="radius-km-input"
                  />
                  <Text style={styles.fieldNote}>
                    Patients within {radiusKm || "15"} km are classified as Local. Patients outside are Distant.
                  </Text>
                </View>
              )}

              {(ruleType === "areas" || ruleType === "both") && (
                <View style={{ marginTop: spacing.md }}>
                  <Text style={styles.fieldLabel}>Local Cities / Areas</Text>
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <TextInput
                      style={[styles.textInput, { flex: 1 }]}
                      value={localAreasInput}
                      onChangeText={setLocalAreasInput}
                      placeholder="Enter city or area name and tap Add"
                      onSubmitEditing={addLocalAreaTag}
                    />
                    <Pressable onPress={addLocalAreaTag} style={styles.addTagBtn}>
                      <Text style={styles.addTagBtnText}>+ Add</Text>
                    </Pressable>
                  </View>
                  <View style={styles.tagsWrap}>
                    {localAreas.map((area) => (
                      <View key={area} style={styles.tagChip}>
                        <Text style={styles.tagChipText}>{area}</Text>
                        <Pressable onPress={() => removeLocalAreaTag(area)}>
                          <Ionicons name="close-circle" size={16} color={colors.muted} />
                        </Pressable>
                      </View>
                    ))}
                  </View>
                </View>
              )}
            </View>

            {/* Booking Windows within Session */}
            <View style={styles.section}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={styles.sectionHeader}>6. Booking Windows Allocation</Text>
                <Pressable onPress={addWindow} style={styles.addSmallBtn}>
                  <Ionicons name="add" size={16} color={colors.brandPrimary} />
                  <Text style={styles.addSmallBtnText}>+ Add Window</Text>
                </Pressable>
              </View>
              <Text style={styles.subHint}>
                Decide which time windows are available to local patients, distant patients, or everyone.
              </Text>

              {bookingWindows.map((win, idx) => (
                <View key={win.id || idx} style={styles.windowCard}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={styles.windowCardTitle}>Window #{idx + 1}</Text>
                    {bookingWindows.length > 1 && (
                      <Pressable onPress={() => removeWindow(idx)}>
                        <Ionicons name="trash-outline" size={16} color={colors.error} />
                      </Pressable>
                    )}
                  </View>

                  <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>Start Time</Text>
                      <TextInput
                        style={styles.textInputMini}
                        value={win.start_time}
                        onChangeText={(val) => updateWindow(idx, { start_time: val })}
                        placeholder="10:00 AM"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>End Time</Text>
                      <TextInput
                        style={styles.textInputMini}
                        value={win.end_time}
                        onChangeText={(val) => updateWindow(idx, { end_time: val })}
                        placeholder="11:00 AM"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.miniLabel}>Max Bookings</Text>
                      <TextInput
                        style={styles.textInputMini}
                        value={win.max_bookings ? String(win.max_bookings) : ""}
                        onChangeText={(val) => updateWindow(idx, { max_bookings: val ? parseInt(val, 10) : null })}
                        placeholder="All"
                        keyboardType="numeric"
                      />
                    </View>
                  </View>

                  <View style={{ marginTop: spacing.sm }}>
                    <Text style={styles.miniLabel}>Patient Eligibility Category:</Text>
                    <View style={styles.categoryPickerRow}>
                      <Pressable
                        onPress={() => updateWindow(idx, { category: "local", description: "Local patients only" })}
                        style={[styles.catBtn, win.category === "local" && styles.catBtnLocal]}
                      >
                        <Text style={[styles.catBtnText, win.category === "local" && styles.catBtnTextActive]}>
                          Local Patients
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => updateWindow(idx, { category: "distant", description: "Distant patients only" })}
                        style={[styles.catBtn, win.category === "distant" && styles.catBtnDistant]}
                      >
                        <Text style={[styles.catBtnText, win.category === "distant" && styles.catBtnTextActive]}>
                          Distant Patients
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => updateWindow(idx, { category: "all", description: "All patients" })}
                        style={[styles.catBtn, win.category === "all" && styles.catBtnAll]}
                      >
                        <Text style={[styles.catBtnText, win.category === "all" && styles.catBtnTextActive]}>
                          All Patients
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </View>

            {/* Readable Summary Card Before Saving */}
            <View style={styles.summaryCard}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Ionicons name="document-text-outline" size={18} color={colors.brandPrimary} />
                <Text style={styles.summaryCardTitle}>Readable Summary of Configured Rules:</Text>
              </View>
              <Text style={styles.summaryCardText}>
                • Session "{sessionName}" runs from {startTime} to {endTime} ({dateType === "recurring" ? selectedDays.join(", ") : specificDate}).
              </Text>
              <Text style={styles.summaryCardText}>
                • Capacity: {isUnlimitedCapacity ? "Unlimited capacity" : `Up to ${maxBookings} patients`} (Slot: {slotDuration}m).
              </Text>
              <Text style={styles.summaryCardText}>
                • Local definition: {ruleType === "none" ? "All patients" : `${radiusKm ? `Within ${radiusKm} km radius` : ""} ${localAreas.length > 0 ? `or in [${localAreas.join(", ")}]` : ""}`}.
              </Text>
              <Text style={styles.summaryCardText}>
                • Distant definition: Outside the configured local area/radius.
              </Text>
              {bookingWindows.map((w, idx) => (
                <Text key={idx} style={styles.summaryCardText}>
                  • Window {w.start_time}–{w.end_time}: {w.category === "local" ? "Local patients only" : w.category === "distant" ? "Distant patients only" : "All patients"} ({w.max_bookings ? `max ${w.max_bookings}` : "unlimited"}).
                </Text>
              ))}
            </View>

            {/* Save Buttons */}
            <View style={styles.bottomCtaRow}>
              <Pressable
                disabled={saving}
                onPress={handleSaveSession}
                style={styles.saveBtn}
                testID="save-session-btn"
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveBtnText}>Save Session & Allocation Rules</Text>
                )}
              </Pressable>
            </View>
          </ScrollView>
        )}

        {/* ── DATE-SPECIFIC OVERRIDE FORM ── */}
        {viewMode === "date_override" && overrideSession && (
          <ScrollView contentContainerStyle={styles.scrollBody}>
            <View style={styles.formHeaderRow}>
              <Pressable onPress={() => setViewMode("list")} style={styles.backBtn}>
                <Ionicons name="arrow-back" size={20} color={colors.onSurface} />
                <Text style={styles.backBtnText}>Back to Sessions</Text>
              </Pressable>
              <Text style={styles.formTitle}>Date-Specific Schedule Override</Text>
            </View>

            <View style={styles.overrideNoticeBox}>
              <Ionicons name="information-circle-outline" size={20} color={colors.brandPrimary} />
              <Text style={styles.overrideNoticeText}>
                Changes made here apply ONLY to <Text style={{ fontWeight: "700" }}>{selectedDate}</Text>. Future recurring occurrences of "{overrideSession.session_name}" will remain completely unchanged.
              </Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.fieldLabel}>Status for {selectedDate}</Text>
              <View style={styles.toggleRow}>
                <Pressable
                  onPress={() => setOverrideStatus("cancelled")}
                  style={[styles.toggleBtn, overrideStatus === "cancelled" && { backgroundColor: colors.error, borderColor: colors.error }]}
                >
                  <Text style={[styles.toggleBtnText, overrideStatus === "cancelled" && { color: "#fff" }]}>
                    Cancel for this date
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setOverrideStatus("closed")}
                  style={[styles.toggleBtn, overrideStatus === "closed" && { backgroundColor: colors.warning, borderColor: colors.warning }]}
                >
                  <Text style={[styles.toggleBtnText, overrideStatus === "closed" && { color: "#fff" }]}>
                    Close bookings for this date
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setOverrideStatus("active")}
                  style={[styles.toggleBtn, overrideStatus === "active" && styles.toggleBtnActive]}
                >
                  <Text style={[styles.toggleBtnText, overrideStatus === "active" && styles.toggleBtnTextActive]}>
                    Custom Hours
                  </Text>
                </Pressable>
              </View>

              {overrideStatus === "active" && (
                <View style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.md }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Revised Start Time</Text>
                    <TextInput
                      style={styles.textInput}
                      value={overrideStartTime}
                      onChangeText={setOverrideStartTime}
                      placeholder="10:00 AM"
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Revised End Time</Text>
                    <TextInput
                      style={styles.textInput}
                      value={overrideEndTime}
                      onChangeText={setOverrideEndTime}
                      placeholder="02:00 PM"
                    />
                  </View>
                </View>
              )}

              <Text style={[styles.fieldLabel, { marginTop: spacing.md }]}>Reason for Date Change (Shown in Queue)</Text>
              <TextInput
                style={styles.textInput}
                value={overrideReason}
                onChangeText={setOverrideReason}
                placeholder="e.g. Doctor attending hospital emergency / Holiday"
              />
            </View>

            <Pressable
              disabled={savingOverride}
              onPress={handleSaveDateOverride}
              style={styles.saveBtn}
            >
              {savingOverride ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.saveBtnText}>Apply Date-Specific Override</Text>
              )}
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  headerSub: { fontSize: font.xs, color: colors.muted, marginTop: 2 },
  closeBtn: { padding: spacing.xs },
  scrollBody: { padding: spacing.lg, paddingBottom: 60, gap: spacing.lg },
  topToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  dateSelectorWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateLabel: { fontSize: font.sm, fontWeight: "600", color: colors.onSurfaceSecondary },
  dateInput: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.brandPrimary,
    minWidth: 90,
    padding: 0,
  },
  dateRefreshBtn: { padding: 4 },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
  },
  addBtnText: { color: "#fff", fontWeight: "700", fontSize: font.sm },
  emptyBox: {
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  emptyTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  emptySub: { fontSize: font.sm, color: colors.muted, textAlign: "center", maxWidth: 360 },
  primaryBtn: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  primaryBtnText: { color: "#fff", fontWeight: "700", fontSize: font.base },
  sessionCard: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  cardTitle: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  cardClinic: { fontSize: font.xs, color: colors.muted, marginTop: 4 },
  cardTime: { fontSize: font.base, fontWeight: "700", color: colors.brandPrimary },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  statusBadgeActive: { backgroundColor: "#DCFCE7" },
  statusBadgeClosed: { backgroundColor: "#FEF3C7" },
  statusBadgeCancelled: { backgroundColor: "#FEE2E2" },
  statusBadgeText: { fontSize: 10, fontWeight: "700", color: colors.onSurface },
  overrideBadge: {
    backgroundColor: colors.brandSecondary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  overrideBadgeText: { fontSize: 10, fontWeight: "600", color: colors.brandPrimary },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  metaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  metaPillText: { fontSize: font.xs, color: colors.onSurfaceSecondary },
  ruleSummaryBox: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  ruleSummaryTitle: { fontSize: font.xs, fontWeight: "700", color: colors.onSurface },
  ruleSummaryLine: { fontSize: font.xs, color: colors.onSurfaceSecondary },
  windowsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  windowChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
  },
  windowChipLocal: { backgroundColor: "#DBEAFE" },
  windowChipDistant: { backgroundColor: "#F3E8FF" },
  windowChipAll: { backgroundColor: "#DCFCE7" },
  windowChipText: { fontSize: 11, fontWeight: "600", color: colors.onSurface },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    flexWrap: "wrap",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  editActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  editActionText: { fontSize: font.xs, fontWeight: "600", color: colors.brandPrimary },
  overrideActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: "#FEF3C7",
  },
  overrideActionText: { fontSize: font.xs, fontWeight: "600", color: "#B45309" },
  closeActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  closeActionText: { fontSize: font.xs, color: colors.onSurfaceSecondary },
  cancelActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: "#FEE2E2",
  },
  cancelActionText: { fontSize: font.xs, color: colors.error },
  deleteActionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  formHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  backBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  backBtnText: { fontSize: font.sm, fontWeight: "600", color: colors.brandPrimary },
  formTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  section: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  sectionHeader: { fontSize: font.base, fontWeight: "700", color: colors.onSurface, marginBottom: 2 },
  subHint: { fontSize: font.xs, color: colors.muted },
  fieldLabel: { fontSize: font.xs, fontWeight: "600", color: colors.onSurfaceSecondary, marginTop: 4 },
  fieldNote: { fontSize: 11, color: colors.muted, marginTop: 2 },
  textInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: font.sm,
    color: colors.onSurface,
  },
  textInputMini: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: font.xs,
    color: colors.onSurface,
  },
  miniLabel: { fontSize: 11, color: colors.muted, marginBottom: 2 },
  toggleRow: { flexDirection: "row", gap: spacing.sm },
  toggleBtn: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  toggleBtnActive: {
    backgroundColor: colors.brandPrimary,
    borderColor: colors.brandPrimary,
  },
  toggleBtnText: { fontSize: font.xs, fontWeight: "600", color: colors.onSurfaceSecondary },
  toggleBtnTextActive: { color: "#fff" },
  weekdaysWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.xs },
  dayChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  dayChipText: { fontSize: font.xs, fontWeight: "600", color: colors.onSurfaceSecondary },
  dayChipTextActive: { color: "#fff" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4 },
  switchLabel: { fontSize: font.sm, color: colors.onSurface },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  smallToggle: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
  smallToggleOn: { backgroundColor: "#DCFCE7" },
  smallToggleOff: { backgroundColor: "#F1F5F9" },
  smallToggleText: { fontSize: font.xs, fontWeight: "600", color: colors.onSurface },
  ruleTypeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  radioItem: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  radioItemActive: { backgroundColor: colors.brandSecondary, borderColor: colors.brandPrimary },
  radioText: { fontSize: font.xs, color: colors.onSurfaceSecondary },
  radioTextActive: { color: colors.brandPrimary, fontWeight: "700" },
  addTagBtn: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    justifyContent: "center",
  },
  addTagBtnText: { color: "#fff", fontWeight: "700", fontSize: font.xs },
  tagsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.xs },
  tagChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  tagChipText: { fontSize: font.xs, color: colors.onSurface },
  addSmallBtn: { flexDirection: "row", alignItems: "center", gap: 2 },
  addSmallBtnText: { fontSize: font.xs, fontWeight: "700", color: colors.brandPrimary },
  windowCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: spacing.xs,
  },
  windowCardTitle: { fontSize: font.xs, fontWeight: "700", color: colors.onSurface },
  categoryPickerRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  catBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  catBtnLocal: { backgroundColor: "#DBEAFE", borderColor: "#3B82F6" },
  catBtnDistant: { backgroundColor: "#F3E8FF", borderColor: "#A855F7" },
  catBtnAll: { backgroundColor: "#DCFCE7", borderColor: "#22C55E" },
  catBtnText: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary },
  catBtnTextActive: { color: colors.onSurface, fontWeight: "700" },
  summaryCard: {
    backgroundColor: "#F0FDF4",
    borderColor: "#86EFAC",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 4,
  },
  summaryCardTitle: { fontSize: font.xs, fontWeight: "700", color: "#166534" },
  summaryCardText: { fontSize: font.xs, color: "#166534", lineHeight: 18 },
  bottomCtaRow: { marginTop: spacing.sm },
  saveBtn: {
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: font.base, fontWeight: "700" },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#FEE2E2",
    borderColor: "#EF4444",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  errorText: { fontSize: font.xs, color: "#B91C1C", fontWeight: "600", flex: 1 },
  overrideNoticeBox: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: colors.brandSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brandTertiary,
  },
  overrideNoticeText: { fontSize: font.xs, color: colors.onBrandSecondary, flex: 1, lineHeight: 18 },
});
