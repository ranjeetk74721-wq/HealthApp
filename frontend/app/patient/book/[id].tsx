import { useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, Modal } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

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

const SLOTS = ["09:00 AM", "09:30 AM", "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "02:00 PM", "02:30 PM", "03:00 PM", "03:30 PM", "04:00 PM", "04:30 PM", "05:00 PM"];

export default function BookAppointment() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const dates = useMemo(() => getDates(7), []);
  const [selectedDate, setSelectedDate] = useState<Date>(dates[0]);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<any>(null);
  const [showPay, setShowPay] = useState(false);
  const [booking, setBooking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<any | null>(null);

  useEffect(() => {
    api.get(`/doctors/${id}`).then(setDoctor).catch(console.log);
  }, [id]);

  const iso = (d: Date) => d.toISOString().split("T")[0];

  const book = async (method: "online" | "pay_at_clinic") => {
    if (!selectedSlot) return;
    setBooking(true);
    setError(null);
    try {
      const res = await api.post("/appointments", {
        doctor_id: id,
        date: iso(selectedDate),
        slot: selectedSlot,
        payment_method: method,
      });
      setShowPay(false);
      setSuccess(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBooking(false);
    }
  };

  if (!doctor) return <View style={styles.safe}><ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} /></View>;

  if (success) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.successWrap}>
          <View style={styles.successIcon}><Ionicons name="checkmark" size={44} color="#fff" /></View>
          <Text style={styles.successTitle} testID="booking-success">Appointment Booked!</Text>
          <Text style={styles.successSub}>Your token number is</Text>
          <Text style={styles.tokenBig}>#{success.token_number}</Text>
          <View style={styles.successCard}>
            <Text style={styles.successRow}>{success.doctor_name}</Text>
            <Text style={styles.successMeta}>{success.date} · {success.slot}</Text>
          </View>
          <Pressable testID="view-queue-btn" onPress={() => router.replace("/patient/queue")} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>View Live Queue</Text>
          </Pressable>
          <Pressable onPress={() => router.replace("/patient/home")} style={styles.linkBtn}>
            <Text style={{ color: colors.muted }}>Back to home</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="book-back"><Ionicons name="chevron-back" size={24} color={colors.onSurface} /></Pressable>
        <Text style={styles.headerTitle}>Book Appointment</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120, gap: spacing.md }}>
        <View style={styles.docCard}>
          <Text style={styles.docName}>{doctor.full_name}</Text>
          <Text style={styles.docSpec}>{doctor.specialty} · {doctor.clinic_name}</Text>
          <Text style={styles.fees}>₹{doctor.fees}</Text>
        </View>

        <Text style={styles.sectionTitle}>Select Date</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
          {dates.map((d, i) => {
            const active = iso(d) === iso(selectedDate);
            return (
              <Pressable key={i} testID={`date-${iso(d)}`} onPress={() => setSelectedDate(d)} style={[styles.dateChip, active && styles.dateChipActive]}>
                <Text style={[styles.dateDay, active && { color: colors.onBrandPrimary }]}>{d.toLocaleDateString("en", { weekday: "short" })}</Text>
                <Text style={[styles.dateNum, active && { color: colors.onBrandPrimary }]}>{d.getDate()}</Text>
                <Text style={[styles.dateMonth, active && { color: colors.onBrandPrimary }]}>{d.toLocaleDateString("en", { month: "short" })}</Text>
              </Pressable>
            );
          })}
        </ScrollView>

        <Text style={styles.sectionTitle}>Select Time Slot</Text>
        <View style={styles.slotsGrid}>
          {SLOTS.map((s) => {
            const active = s === selectedSlot;
            return (
              <Pressable key={s} testID={`slot-${s}`} onPress={() => setSelectedSlot(s)} style={[styles.slotChip, active && styles.slotChipActive]}>
                <Text style={[styles.slotText, active && { color: colors.onBrandPrimary }]}>{s}</Text>
              </Pressable>
            );
          })}
        </View>

        {error ? <Text testID="book-error" style={{ color: colors.error, marginTop: spacing.md }}>{error}</Text> : null}
      </ScrollView>

      <SafeAreaView edges={["bottom"]} style={styles.stickyCta}>
        <Pressable
          testID="proceed-payment-cta"
          disabled={!selectedSlot}
          onPress={() => setShowPay(true)}
          style={[styles.ctaBtn, !selectedSlot && { opacity: 0.4 }]}
        >
          <Text style={styles.ctaText}>{selectedSlot ? `Proceed · ${selectedSlot}` : "Select a time slot"}</Text>
        </Pressable>
      </SafeAreaView>

      <Modal transparent visible={showPay} animationType="slide" onRequestClose={() => setShowPay(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setShowPay(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Payment</Text>
            <Text style={styles.sheetSub}>Consultation fee: ₹{doctor.fees}</Text>

            <Pressable testID="pay-online" disabled={booking} onPress={() => book("online")} style={styles.payOption}>
              <View style={styles.payIcon}><Ionicons name="card" size={22} color={colors.brandPrimary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.payTitle}>Pay Online (Mock)</Text>
                <Text style={styles.paySub}>UPI, Card, Wallet</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>

            <Pressable testID="pay-at-clinic" disabled={booking} onPress={() => book("pay_at_clinic")} style={styles.payOption}>
              <View style={styles.payIcon}><Ionicons name="cash" size={22} color={colors.success} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.payTitle}>Pay at Clinic</Text>
                <Text style={styles.paySub}>Cash or card at reception</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </Pressable>

            {booking && <ActivityIndicator style={{ marginTop: spacing.md }} color={colors.brand} />}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.divider },
  headerTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  docCard: { backgroundColor: colors.surfaceSecondary, padding: spacing.md, borderRadius: radius.md },
  docName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  docSpec: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  fees: { fontSize: font.xl, fontWeight: "700", color: colors.brandPrimary, marginTop: spacing.sm },
  sectionTitle: { fontSize: font.base, fontWeight: "700", color: colors.onSurface, marginTop: spacing.sm },
  dateChip: { width: 68, alignItems: "center", padding: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, gap: 2 },
  dateChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  dateDay: { fontSize: font.sm, color: colors.muted },
  dateNum: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  dateMonth: { fontSize: 11, color: colors.muted },
  slotsGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  slotChip: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border },
  slotChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  slotText: { fontSize: font.sm, color: colors.onSurface, fontWeight: "500" },
  stickyCta: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md },
  ctaBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center" },
  ctaText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  payOption: { flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, marginBottom: spacing.sm },
  payIcon: { width: 44, height: 44, borderRadius: radius.pill, backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  payTitle: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  paySub: { fontSize: font.sm, color: colors.muted },
  successWrap: { flex: 1, alignItems: "center", padding: spacing.xl, gap: spacing.md, justifyContent: "center" },
  successIcon: { width: 80, height: 80, borderRadius: radius.pill, backgroundColor: colors.success, alignItems: "center", justifyContent: "center" },
  successTitle: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  successSub: { fontSize: font.base, color: colors.muted },
  tokenBig: { fontSize: 72, fontWeight: "800", color: colors.brandPrimary, lineHeight: 80 },
  successCard: { backgroundColor: colors.surfaceSecondary, padding: spacing.lg, borderRadius: radius.md, alignItems: "center", width: "100%" },
  successRow: { fontSize: font.lg, fontWeight: "600", color: colors.onSurface },
  successMeta: { fontSize: font.base, color: colors.muted, marginTop: 4 },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", width: "100%", marginTop: spacing.md },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
  linkBtn: { padding: spacing.sm },
});
