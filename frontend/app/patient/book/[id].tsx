import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Modal,
  TextInput,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { api, isConfirmedAuthError } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { formatExpectedTimeRange } from "@/src/utils/timeFormat";
import NotificationPermissionBanner from "@/src/components/NotificationPermissionBanner";

function getDates(count: number) {
  const arr = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    arr.push(d);
  }
  return arr;
}

export default function BookAppointment() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const dates = useMemo(() => getDates(7), []);
  const [selectedDate, setSelectedDate] = useState<Date>(dates[0]);
  const [doctor, setDoctor] = useState<any>(null);

  // Patient Location state
  const [patientCity, setPatientCity] = useState("");
  const [patientArea, setPatientArea] = useState("");
  const [patientLat, setPatientLat] = useState<number | null>(null);
  const [patientLon, setPatientLon] = useState<number | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsMessage, setGpsMessage] = useState<string | null>(null);

  // Sessions state
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedWindowId, setSelectedWindowId] = useState<string | null>(null);
  const [selectedSlotTime, setSelectedSlotTime] = useState<string>("");

  // Booking & payment state
  const [showPay, setShowPay] = useState(false);
  const [booking, setBooking] = useState(false);
  const [bookingMethod, setBookingMethod] = useState<"online" | "pay_at_clinic" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<any | null>(null);
  const isSubmittingRef = useRef(false);

  const iso = (d: Date) => d.toISOString().split("T")[0];

  // Fetch doctor profile
  useEffect(() => {
    api.get(`/doctors/${id}`).then(setDoctor).catch(console.log);
  }, [id]);

  // Fetch sessions for selected date and patient location
  const fetchSessions = useCallback(async () => {
    if (!id) return;
    setSessionsLoading(true);
    try {
      const targetDate = iso(selectedDate);
      let url = `/doctors/${id}/sessions?target_date=${targetDate}`;
      if (patientCity.trim()) url += `&patient_city=${encodeURIComponent(patientCity.trim())}`;
      if (patientArea.trim()) url += `&patient_area=${encodeURIComponent(patientArea.trim())}`;
      if (patientLat !== null && patientLon !== null) {
        url += `&lat=${patientLat}&lon=${patientLon}`;
      }
      const res = await api.get(url);
      const fetchedSessions = res.sessions || [];
      setSessions(fetchedSessions);

      // Verify if current selection is still eligible; if not, deselect rather than silently moving
      if (selectedSessionId) {
        const curSession = fetchedSessions.find((s: any) => s.id === selectedSessionId);
        if (!curSession || curSession.status === "cancelled" || curSession.booking_closed) {
          setSelectedSessionId(null);
          setSelectedWindowId(null);
          setSelectedSlotTime("");
        } else if (selectedWindowId) {
          const curWin = curSession.booking_windows?.find((w: any) => w.id === selectedWindowId);
          if (!curWin || !curWin.eligible) {
            setSelectedWindowId(null);
            setSelectedSlotTime("");
          }
        }
      }
    } catch (e: any) {
      console.log("Error loading sessions:", e);
    } finally {
      setSessionsLoading(false);
    }
  }, [id, selectedDate, patientCity, patientArea, patientLat, patientLon, selectedSessionId, selectedWindowId]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  // Optional "Use my current location" GPS shortcut (non-blocking)
  const handleUseGps = () => {
    setGpsLoading(true);
    setGpsMessage(null);

    if (Platform.OS === "web" && typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setPatientLat(pos.coords.latitude);
          setPatientLon(pos.coords.longitude);
          setGpsMessage(
            `Location pinpointed (${pos.coords.latitude.toFixed(2)}°, ${pos.coords.longitude.toFixed(2)}°)`
          );
          setGpsLoading(false);
        },
        (err) => {
          setGpsMessage("GPS permission skipped or unavailable. You can enter your city/area manually.");
          setGpsLoading(false);
        },
        { enableHighAccuracy: false, timeout: 8000 }
      );
    } else {
      setGpsMessage("GPS shortcut unavailable on this browser. Please type your city/area manually.");
      setGpsLoading(false);
    }
  };

  const selectedSession = sessions.find((s) => s.id === selectedSessionId);
  const selectedWindow = selectedSession?.booking_windows?.find((w: any) => w.id === selectedWindowId);

  // Check if any eligible slots exist across all sessions for this date
  const hasEligibleSlots = sessions.some((sess) =>
    sess.booking_windows?.some((w: any) => w.eligible && !sess.booking_closed && sess.status !== "cancelled")
  );

  const canProceedToBook =
    sessions.length === 0 ||
    (selectedSessionId && (!selectedSession?.booking_windows?.length || selectedWindowId));

  const book = async (method: "online" | "pay_at_clinic") => {
    // Immediate synchronous in-flight guard: prevent duplicate submissions from rapid repeated clicks
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setBooking(true);
    setBookingMethod(method);
    setError(null);
    try {
      const payload: any = {
        doctor_id: id,
        date: iso(selectedDate),
        slot: selectedSlotTime || selectedWindow?.window_name || "Token Booking",
        payment_method: method,
      };

      if (selectedSessionId) {
        payload.session_id = selectedSessionId;
      }
      if (selectedWindowId) {
        payload.booking_window_id = selectedWindowId;
      }
      if (selectedSlotTime) {
        payload.slot_time = selectedSlotTime;
      }
      if (patientCity.trim()) payload.patient_city = patientCity.trim();
      if (patientArea.trim()) payload.patient_area = patientArea.trim();
      if (patientLat !== null) payload.patient_latitude = patientLat;
      if (patientLon !== null) payload.patient_longitude = patientLon;

      const res = await api.post("/appointments", payload, { timeoutMs: 12000 });
      setShowPay(false);
      setSuccess(res);
    } catch (e: any) {
      if (e?.isTimeout || e?.name === "TimeoutError") {
        // A client timeout does not prove server failure.
        // Reconcile result using existing supported read endpoint before allowing another submission.
        try {
          const myAppts = await api.get("/appointments/me", { bypassCache: true, timeoutMs: 6000 });
          const targetDateStr = iso(selectedDate);
          const matched = Array.isArray(myAppts)
            ? myAppts.find(
                (a: any) =>
                  a.doctor_id === id &&
                  a.date === targetDateStr &&
                  ["booked", "arrived", "in_consultation"].includes(a.status)
              )
            : null;
          if (matched) {
            setShowPay(false);
            setSuccess(matched);
            return;
          }
        } catch {
          // Reconcile read failed
        }
        setShowPay(false);
        setError("Booking request timed out. Server verification confirmed no appointment was created. You can retry.");
      } else if (isConfirmedAuthError(e) || e?.status === 401) {
        setShowPay(false);
        router.push(`/login?redirect=${encodeURIComponent(`/patient/book/${id}`)}`);
      } else {
        setShowPay(false);
        setError(e.message || "Booking failed. Please review session eligibility.");
      }
    } finally {
      // Synchronously release in-flight guard so legitimate subsequent booking remains possible and errors do not permanently lock button
      isSubmittingRef.current = false;
      setBooking(false);
      setBookingMethod(null);
    }
  };

  if (!doctor) {
    return (
      <View style={styles.safe}>
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} />
      </View>
    );
  }

  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={styles.successWrap}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark" size={44} color="#fff" />
          </View>
          <Text style={styles.successTitle} testID="booking-success">
            Appointment Booked!
          </Text>
          <Text style={styles.successSub}>Your sequential token number is</Text>
          <Text style={styles.tokenBig}>#{success.token_number}</Text>
          <View style={styles.successCard}>
            <Text style={styles.successRow}>{success.doctor_name}</Text>
            <Text style={styles.successMeta}>
              Date: {success.date} · Token #{success.token_number}
            </Text>
            {success.slot ? (
              <Text style={{ fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: 4 }}>
                Slot: {success.slot}
              </Text>
            ) : null}
            {success.expected_turn_time || success.expected_time ? (
              <Text style={styles.successTime} testID="success-expected-time">
                Expected Time: {formatExpectedTimeRange(success.expected_turn_time || success.expected_time)}
              </Text>
            ) : null}
          </View>

          <View style={{ width: "100%", marginVertical: spacing.xs }}>
            <NotificationPermissionBanner
              appointmentId={success.id}
              appointmentToken={success.secure_token}
            />
          </View>

          <Pressable
            testID="view-queue-btn"
            onPress={() => router.replace("/patient/queue")}
            style={styles.primaryBtn}
          >
            <Text style={styles.primaryBtnText}>अपनी बारी देखे</Text>
          </Pressable>
          <Pressable onPress={() => router.replace("/patient/home")} style={styles.linkBtn}>
            <Text style={{ color: colors.muted }}>Back to home</Text>
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="book-back">
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Book Appointment</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 130 + Math.max(insets.bottom, spacing.md), gap: spacing.md }}>
        {/* Step 1: Doctor & Clinic Header */}
        <View style={styles.docCard}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.docName}>{doctor.full_name}</Text>
              <Text style={styles.docSpec}>{doctor.specialty || "General Physician"}</Text>
            </View>
            <Text style={styles.fees}>₹{doctor.fees}</Text>
          </View>

          {/* Clinic Location distinction */}
          <View style={styles.clinicLocBadge}>
            <Ionicons name="business" size={15} color={colors.brandPrimary} />
            <Text style={styles.clinicLocText}>
              <Text style={{ fontWeight: "700" }}>Clinic Location: </Text>
              {doctor.hospital_name || doctor.clinic_name || "Main Clinic"}
              {doctor.city ? ` · ${doctor.city}` : ""}
              {doctor.address ? ` (${doctor.address})` : ""}
            </Text>
          </View>
        </View>

        {/* Step 2: Date Selection */}
        <Text style={styles.sectionTitle}>1. Select Date (तारीख चुनें)</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          {dates.map((d, i) => {
            const active = iso(d) === iso(selectedDate);
            return (
              <Pressable
                key={i}
                testID={`date-${iso(d)}`}
                onPress={() => setSelectedDate(d)}
                style={[styles.dateChip, active && styles.dateChipActive]}
              >
                <Text style={[styles.dateDay, active && { color: colors.onBrandPrimary }]}>
                  {d.toLocaleDateString("en", { weekday: "short" })}
                </Text>
                <Text style={[styles.dateNum, active && { color: colors.onBrandPrimary }]}>
                  {d.getDate()}
                </Text>
                <Text style={[styles.dateMonth, active && { color: colors.onBrandPrimary }]}>
                  {d.toLocaleDateString("en", { month: "short" })}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Step 3: Patient Location Input */}
        <View style={styles.patientLocBox}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Ionicons name="location" size={18} color="#D97706" />
              <Text style={styles.patientLocTitle}>2. Patient's Location (आपकी लोकेशन)</Text>
            </View>
            <Pressable
              onPress={handleUseGps}
              disabled={gpsLoading}
              style={styles.gpsBtn}
              testID="use-gps-btn"
            >
              {gpsLoading ? (
                <ActivityIndicator size="small" color={colors.brandPrimary} />
              ) : (
                <>
                  <Ionicons name="navigate" size={14} color={colors.brandPrimary} />
                  <Text style={styles.gpsBtnText}>Use My Location</Text>
                </>
              )}
            </Pressable>
          </View>

          <Text style={styles.patientLocNotice}>
            Doctors reserve specific slots for local vs distant patients. GPS permission is completely optional.
          </Text>

          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputMiniLabel}>City / Town</Text>
              <TextInput
                testID="patient-city-input"
                placeholder="e.g. Jaipur, Sikar"
                placeholderTextColor={colors.muted}
                value={patientCity}
                onChangeText={setPatientCity}
                style={styles.locInput}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.inputMiniLabel}>Area / Locality</Text>
              <TextInput
                testID="patient-area-input"
                placeholder="e.g. Vaishali Nagar"
                placeholderTextColor={colors.muted}
                value={patientArea}
                onChangeText={setPatientArea}
                style={styles.locInput}
              />
            </View>
          </View>

          {/* Quick presets for convenience */}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
            <Text style={{ fontSize: 11, color: colors.muted, alignSelf: "center" }}>Quick select:</Text>
            {[
              { label: "Local / Same Town", city: doctor.city || "Local", area: "Local Area" },
              { label: "Nearby Tehsil", city: doctor.city || "Tehsil", area: "Sub-district" },
              { label: "Distant / Outstation", city: "Outstation", area: "Distant District" },
            ].map((p, idx) => (
              <Pressable
                key={idx}
                onPress={() => {
                  setPatientCity(p.city);
                  setPatientArea(p.area);
                }}
                style={styles.presetChip}
              >
                <Text style={styles.presetChipText}>{p.label}</Text>
              </Pressable>
            ))}
          </View>

          {gpsMessage ? (
            <Text style={{ fontSize: 11, color: colors.brandPrimary, marginTop: 4 }}>{gpsMessage}</Text>
          ) : null}
        </View>

        {/* Step 4: Eligible Sessions & Slots */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={styles.sectionTitle}>3. Eligible Sessions & Slots (समय स्लॉट)</Text>
          {sessionsLoading && <ActivityIndicator size="small" color={colors.brandPrimary} />}
        </View>

        {sessions.length === 0 ? (
          <View style={styles.tokenInfoBox}>
            <Ionicons name="ticket-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.tokenInfoText}>
              Standard walk-in tokens available for this date. Sequential token will be assigned upon booking.
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            {sessions.map((sess) => {
              const isSessionSelected = selectedSessionId === sess.id;
              const isClosed = sess.booking_closed || sess.status === "cancelled";
              const windows = sess.booking_windows || [];

              return (
                <View
                  key={sess.id}
                  style={[
                    styles.sessionCard,
                    isSessionSelected && styles.sessionCardActive,
                    isClosed && { opacity: 0.65 },
                  ]}
                >
                  {/* Session Header */}
                  <View style={styles.sessionHeaderRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sessionName}>{sess.session_name}</Text>
                      <Text style={styles.sessionTime}>
                        {sess.start_time} - {sess.end_time}
                        {sess.clinic_location_name ? ` · ${sess.clinic_location_name}` : ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      {isClosed ? (
                        <View style={[styles.badge, { backgroundColor: "#FEE2E2" }]}>
                          <Text style={[styles.badgeText, { color: "#DC2626" }]}>
                            {sess.status === "cancelled" ? "Cancelled" : "Bookings Closed"}
                          </Text>
                        </View>
                      ) : (
                        <View style={[styles.badge, { backgroundColor: "#ECFDF5" }]}>
                          <Text style={[styles.badgeText, { color: "#059669" }]}>
                            {sess.max_bookings
                              ? `${sess.current_bookings || 0}/${sess.max_bookings} Booked`
                              : "Open Capacity"}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>

                  {/* Booking Windows inside Session */}
                  {windows.length > 0 ? (
                    <View style={{ marginTop: spacing.sm, gap: 8 }}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary }}>
                        Location Windows:
                      </Text>
                      {windows.map((win: any) => {
                        const isWinSelected = selectedWindowId === win.id;
                        const isEligible = win.eligible && !isClosed;
                        const targetType = win.target_patient_category || "all";

                        const badgeColor =
                          targetType === "local"
                            ? { bg: "#ECFDF5", text: "#065F46", border: "#A7F3D0", label: "Local Patients" }
                            : targetType === "distant"
                            ? { bg: "#EEF2FF", text: "#3730A3", border: "#C7D2FE", label: "Distant Patients" }
                            : { bg: "#F1F5F9", text: "#334155", border: "#CBD5E1", label: "All Patients" };

                        return (
                          <Pressable
                            key={win.id}
                            disabled={!isEligible}
                            onPress={() => {
                              setSelectedSessionId(sess.id);
                              setSelectedWindowId(win.id);
                              setSelectedSlotTime(`${win.start_time} - ${win.end_time}`);
                            }}
                            style={[
                              styles.windowCard,
                              isWinSelected && styles.windowCardSelected,
                              !isEligible && styles.windowCardIneligible,
                            ]}
                          >
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                                <Text
                                  style={[
                                    styles.windowTime,
                                    isWinSelected && { color: colors.brandPrimary, fontWeight: "700" },
                                    !isEligible && { color: colors.muted },
                                  ]}
                                >
                                  {win.start_time} - {win.end_time}
                                </Text>
                                <View
                                  style={[
                                    styles.miniBadge,
                                    { backgroundColor: badgeColor.bg, borderColor: badgeColor.border },
                                  ]}
                                >
                                  <Text style={[styles.miniBadgeText, { color: badgeColor.text }]}>
                                    {badgeColor.label}
                                  </Text>
                                </View>
                              </View>

                              {win.window_name ? (
                                <Text style={styles.windowSub}>{win.window_name}</Text>
                              ) : null}

                              {!isEligible && win.ineligible_reason ? (
                                <Text style={styles.ineligibleNote}>
                                  <Ionicons name="lock-closed" size={11} color="#DC2626" />{" "}
                                  {win.ineligible_reason}
                                </Text>
                              ) : null}
                            </View>

                            <View style={styles.selectionRadio}>
                              <Ionicons
                                name={
                                  isWinSelected
                                    ? "checkmark-circle"
                                    : isEligible
                                    ? "ellipse-outline"
                                    : "lock-closed-outline"
                                }
                                size={20}
                                color={
                                  isWinSelected
                                    ? colors.brandPrimary
                                    : isEligible
                                    ? colors.borderStrong
                                    : colors.muted
                                }
                              />
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : (
                    <Pressable
                      disabled={isClosed}
                      onPress={() => {
                        setSelectedSessionId(sess.id);
                        setSelectedWindowId(null);
                        setSelectedSlotTime(`${sess.start_time} - ${sess.end_time}`);
                      }}
                      style={[
                        styles.windowCard,
                        isSessionSelected && styles.windowCardSelected,
                        isClosed && styles.windowCardIneligible,
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.windowTime}>
                          Full Session ({sess.start_time} - {sess.end_time})
                        </Text>
                        <Text style={styles.windowSub}>Open to all patients</Text>
                      </View>
                      <Ionicons
                        name={isSessionSelected ? "checkmark-circle" : "ellipse-outline"}
                        size={20}
                        color={isSessionSelected ? colors.brandPrimary : colors.borderStrong}
                      />
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* Explain if no eligible slots remain */}
        {sessions.length > 0 && !hasEligibleSlots ? (
          <View style={styles.noSlotBox}>
            <Ionicons name="alert-circle" size={24} color="#D97706" />
            <View style={{ flex: 1 }}>
              <Text style={styles.noSlotTitle}>No Eligible Slots for Selected Location</Text>
              <Text style={styles.noSlotText}>
                The doctor's sessions on this date are reserved for patients in specific categories or have reached full capacity.
              </Text>
              <Text style={[styles.noSlotText, { marginTop: 4, fontWeight: "600" }]}>
                Options: Select another date above, or contact reception directly at clinic for walk-in availability.
              </Text>
            </View>
          </View>
        ) : null}

        {error ? (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle" size={22} color="#DC2626" />
            <Text testID="book-error" style={styles.errorText}>
              {error}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Sticky CTA with Hindi and English requirement: "नंबर लगाएँ (Book Appointment)" */}
      <View style={[styles.stickyCta, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <Pressable
          testID="proceed-payment-cta"
          disabled={!canProceedToBook || booking}
          onPress={() => setShowPay(true)}
          style={[styles.ctaBtn, (!canProceedToBook || booking) && { opacity: 0.6 }]}
        >
          {booking ? (
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.ctaText}>Booking…</Text>
            </View>
          ) : (
            <>
              <Text style={styles.ctaText}>नंबर लगाएँ (Book Appointment)</Text>
              {selectedSlotTime ? (
                <Text style={styles.ctaSub}>Selected: {selectedSlotTime}</Text>
              ) : null}
            </>
          )}
        </Pressable>
      </View>

      {/* Payment / Confirmation Modal */}
      <Modal
        transparent
        visible={showPay}
        animationType="slide"
        onRequestClose={() => {
          if (!booking) setShowPay(false);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            if (!booking) setShowPay(false);
          }}
        >
          <Pressable style={[styles.sheet, { maxHeight: "90%" }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Confirm Booking & Payment</Text>
            <Text style={styles.sheetSub}>
              {doctor.full_name} · {iso(selectedDate)}
              {selectedSlotTime ? ` · ${selectedSlotTime}` : ""}
            </Text>
            <Text style={{ fontSize: font.sm, color: colors.muted, marginBottom: spacing.sm }}>
              Consultation fee: ₹{doctor.fees}
            </Text>

            <Pressable
              testID="pay-online"
              disabled={booking}
              onPress={() => book("online")}
              style={[
                styles.payOption,
                booking && { opacity: bookingMethod === "online" ? 0.95 : 0.4 },
              ]}
            >
              <View style={styles.payIcon}>
                {booking && bookingMethod === "online" ? (
                  <ActivityIndicator size="small" color={colors.brandPrimary} />
                ) : (
                  <Ionicons name="card" size={22} color={colors.brandPrimary} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.payTitle}>
                  {booking && bookingMethod === "online" ? "Booking…" : "Pay Online (Mock)"}
                </Text>
                <Text style={styles.paySub}>
                  {booking && bookingMethod === "online"
                    ? "Confirming appointment with doctor…"
                    : "UPI, Card, Net Banking"}
                </Text>
              </View>
              {!(booking && bookingMethod === "online") && (
                <Ionicons name="chevron-forward" size={20} color={colors.muted} />
              )}
            </Pressable>

            <Pressable
              testID="pay-at-clinic"
              disabled={booking}
              onPress={() => book("pay_at_clinic")}
              style={[
                styles.payOption,
                booking && { opacity: bookingMethod === "pay_at_clinic" ? 0.95 : 0.4 },
              ]}
            >
              <View style={styles.payIcon}>
                {booking && bookingMethod === "pay_at_clinic" ? (
                  <ActivityIndicator size="small" color={colors.success} />
                ) : (
                  <Ionicons name="cash" size={22} color={colors.success} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.payTitle}>
                  {booking && bookingMethod === "pay_at_clinic" ? "Booking…" : "Pay at Clinic"}
                </Text>
                <Text style={styles.paySub}>
                  {booking && bookingMethod === "pay_at_clinic"
                    ? "Confirming appointment with doctor…"
                    : "Pay cash or UPI at doctor reception"}
                </Text>
              </View>
              {!(booking && bookingMethod === "pay_at_clinic") && (
                <Ionicons name="chevron-forward" size={20} color={colors.muted} />
              )}
            </Pressable>

            {booking && (
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.md }}>
                <ActivityIndicator size="small" color={colors.brand} />
                <Text style={{ fontSize: font.sm, color: colors.onSurfaceSecondary, fontWeight: "500" }}>
                  Booking appointment…
                </Text>
              </View>
            )}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  docCard: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  docName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  docSpec: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  fees: { fontSize: font.xl, fontWeight: "700", color: colors.brandPrimary },
  clinicLocBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#F0FDF4",
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#DCFCE7",
    marginTop: spacing.sm,
  },
  clinicLocText: { fontSize: 12, color: "#166534", flex: 1 },
  sectionTitle: { fontSize: font.base, fontWeight: "700", color: colors.onSurface, marginTop: spacing.xs },
  dateChip: {
    width: 68,
    flexShrink: 0,
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 2,
  },
  dateChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  dateDay: { fontSize: font.sm, color: colors.muted },
  dateNum: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  dateMonth: { fontSize: 11, color: colors.muted },
  patientLocBox: {
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  patientLocTitle: { fontSize: font.sm, fontWeight: "700", color: "#92400E" },
  gpsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#EFF6FF",
    borderWidth: 1,
    borderColor: "#BFDBFE",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  gpsBtnText: { fontSize: 11, fontWeight: "600", color: colors.brandPrimary },
  patientLocNotice: { fontSize: 11, color: "#B45309", lineHeight: 16 },
  inputMiniLabel: { fontSize: 11, fontWeight: "600", color: colors.onSurfaceSecondary, marginBottom: 2 },
  locInput: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: font.sm,
    color: colors.onSurface,
  },
  presetChip: {
    backgroundColor: "#FEF3C7",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: "#FDE68A",
  },
  presetChipText: { fontSize: 10, color: "#92400E", fontWeight: "600" },
  sessionCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  sessionCardActive: {
    borderColor: colors.brandPrimary,
    backgroundColor: "#F8FAFC",
  },
  sessionHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  sessionName: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  sessionTime: { fontSize: 12, color: colors.muted, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 11, fontWeight: "700" },
  windowCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: spacing.sm,
  },
  windowCardSelected: {
    borderColor: colors.brandPrimary,
    backgroundColor: "#EEF2FF",
  },
  windowCardIneligible: {
    backgroundColor: "#F8FAFC",
    borderColor: colors.border,
    opacity: 0.6,
  },
  windowTime: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface },
  windowSub: { fontSize: 11, color: colors.muted, marginTop: 2 },
  ineligibleNote: { fontSize: 11, color: "#DC2626", marginTop: 2, fontWeight: "500" },
  miniBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  miniBadgeText: { fontSize: 10, fontWeight: "700" },
  selectionRadio: { marginLeft: spacing.sm },
  noSlotBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    backgroundColor: "#FFFBEB",
    borderWidth: 1,
    borderColor: "#FCD34D",
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  noSlotTitle: { fontSize: font.sm, fontWeight: "700", color: "#92400E" },
  noSlotText: { fontSize: 12, color: "#78350F", lineHeight: 16, marginTop: 2 },
  errorBox: {
    backgroundColor: "#FEE2E2",
    borderColor: "#EF4444",
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: spacing.md,
  },
  errorText: { color: "#B91C1C", fontWeight: "600", flex: 1, fontSize: font.sm },
  tokenInfoBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.brandSecondary,
    borderRadius: radius.md,
  },
  tokenInfoText: { flex: 1, fontSize: font.sm, color: colors.onBrandSecondary, lineHeight: 18 },
  stickyCta: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    padding: spacing.md,
  },
  ctaBtn: {
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
  },
  ctaText: { color: colors.onBrandPrimary, fontSize: font.base, fontWeight: "700" },
  ctaSub: { color: colors.onBrandPrimary, fontSize: 11, opacity: 0.9, marginTop: 2 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    backgroundColor: colors.borderStrong,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: spacing.md,
  },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  payOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  payIcon: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  payTitle: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  paySub: { fontSize: font.sm, color: colors.muted },
  successWrap: { flex: 1, alignItems: "center", padding: spacing.xl, gap: spacing.md, justifyContent: "center" },
  successIcon: {
    width: 80,
    height: 80,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
  },
  successTitle: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  successSub: { fontSize: font.base, color: colors.muted },
  tokenBig: { fontSize: 72, fontWeight: "800", color: colors.brandPrimary, lineHeight: 80 },
  successCard: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
    width: "100%",
  },
  successRow: { fontSize: font.lg, fontWeight: "600", color: colors.onSurface },
  successMeta: { fontSize: font.base, color: colors.muted, marginTop: 4 },
  successTime: { fontSize: font.base, fontWeight: "700", color: colors.brandPrimary, marginTop: 6 },
  primaryBtn: {
    backgroundColor: colors.brandPrimary,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
    width: "100%",
    marginTop: spacing.md,
  },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
  linkBtn: { padding: spacing.sm },
});
