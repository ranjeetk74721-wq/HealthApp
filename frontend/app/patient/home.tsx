import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, ActivityIndicator, RefreshControl, Image } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

interface Doctor {
  id: string;
  full_name: string;
  specialty: string;
  city: string;
  clinic_name: string;
  fees: number;
  timings: string;
  rating: number;
  photo: string | null;
  est_wait_minutes: number;
}

const specialtyIcons: Record<string, any> = {
  Cardiology: "heart",
  Dental: "medical",
  Dermatology: "hand-left",
  Pediatrics: "happy",
  "General Physician": "medkit",
  Orthopedics: "body",
  ENT: "ear",
  Ophthalmology: "eye",
};

// How long (ms) before data is considered stale and needs a re-fetch on focus
const STALE_AFTER_MS = 30_000;

export default function PatientHome() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [specialties, setSpecialties] = useState<any[]>([]);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedSpecialty, setSelectedSpecialty] = useState<string | null>(null);
  const [selectedHospital, setSelectedHospital] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [upcoming, setUpcoming] = useState<any | null>(null);
  const lastFetchedAt = useRef<number>(0);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search input — only triggers API call 400ms after user stops typing
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search);
    }, 400);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [search]);

  const load = useCallback(async (force = false) => {
    // Skip re-fetch if data is still fresh (within 30s) and no filter change
    if (!force && Date.now() - lastFetchedAt.current < STALE_AFTER_MS && doctors.length > 0) {
      return;
    }
    try {
      let doctorUrl = "/doctors";
      const params: string[] = [];
      if (debouncedSearch) params.push(`search=${encodeURIComponent(debouncedSearch)}`);
      if (selectedSpecialty) params.push(`specialty=${encodeURIComponent(selectedSpecialty)}`);
      if (selectedHospital) params.push(`hospital_id=${encodeURIComponent(selectedHospital)}`);
      if (params.length) doctorUrl += `?${params.join("&")}`;

      // Parallel data fetching
      const [docs, specs, appts, hosps] = await Promise.all([
        api.get(doctorUrl, { bypassCache: force }),
        api.get("/specialties", { bypassCache: force }).catch(() => []),
        api.get("/appointments/me", { bypassCache: force }),
        api.get("/hospitals", { bypassCache: force }).catch(() => []),
      ]);
      setDoctors(docs);
      const mappedSpecs = Array.isArray(specs) ? specs.map((s: any) => typeof s === "string" ? { name: s } : s) : [];
      setSpecialties(mappedSpecs);
      setHospitals(Array.isArray(hosps) ? hosps : []);
      const upcomingAppt = appts.find((a: any) => ["booked", "arrived", "in_consultation"].includes(a.status));
      setUpcoming(upcomingAppt || null);
      lastFetchedAt.current = Date.now();
    } catch (e: any) {
      if (e?.message && (e.message.includes("401") || e.message.includes("authenticated") || e.message.includes("expired"))) {
        await signOut();
        router.replace("/login");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [debouncedSearch, doctors.length, router, selectedSpecialty, selectedHospital, signOut]);

  // Reload when search/specialty/hospital filter changes
  useEffect(() => {
    load(true);
  }, [debouncedSearch, selectedSpecialty, selectedHospital, load]);

  // On screen focus: only reload if data is stale (not on every tab switch)
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
      >
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hello}>Namaste!</Text>
            <Text style={styles.name} testID="patient-name">{user?.full_name}</Text>
          </View>
          <Pressable onPress={async () => { await signOut(); router.replace("/login"); }} testID="logout-button" style={styles.iconBtn}>
            <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="doctor-search-input"
            placeholder="Search doctors, specialties, city, hospital..."
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          )}
        </View>

        {upcoming && (
          <Pressable testID="upcoming-appointment-card" onPress={() => router.push("/patient/queue")} style={styles.upcomingWrap}>
            <Image source={{ uri: "https://images.pexels.com/photos/8459996/pexels-photo-8459996.jpeg?auto=compress&cs=tinysrgb&w=800" }} style={styles.upcomingBg} />
            <LinearGradient colors={["rgba(3, 105, 161, 0.85)", "rgba(3, 105, 161, 0.95)"]} style={styles.upcomingOverlay}>
              <Text style={styles.upcomingLabel}>UPCOMING APPOINTMENT</Text>
              <Text style={styles.upcomingName}>{upcoming.doctor_name}</Text>
              <Text style={styles.upcomingMeta}>Token #{upcoming.token_number} · {upcoming.slot}</Text>
              <View style={styles.upcomingCta}>
                <Text style={styles.upcomingCtaText}>अपनी बारी देखे</Text>
                <Ionicons name="arrow-forward" size={16} color={colors.onBrandPrimary} />
              </View>
            </LinearGradient>
          </Pressable>
        )}

        {hospitals.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>Select Hospital</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.specsRow}>
              <Pressable onPress={() => setSelectedHospital(null)} style={[styles.specChip, !selectedHospital && styles.specChipActive]}>
                <Text style={[styles.specChipText, !selectedHospital && styles.specChipTextActive]}>All Hospitals</Text>
              </Pressable>
              {hospitals.map((h: any) => (
                <Pressable key={h.hospital_id} onPress={() => setSelectedHospital(selectedHospital === h.hospital_id ? null : h.hospital_id)} style={[styles.specChip, selectedHospital === h.hospital_id && styles.specChipActive]}>
                  <Ionicons name="business" size={14} color={selectedHospital === h.hospital_id ? colors.onBrandPrimary : colors.brand} />
                  <Text style={[styles.specChipText, selectedHospital === h.hospital_id && styles.specChipTextActive]}>{h.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        <Text style={styles.sectionTitle}>Specialties</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.specsRow}>
          <Pressable testID="specialty-all" onPress={() => setSelectedSpecialty(null)} style={[styles.specChip, !selectedSpecialty && styles.specChipActive]}>
            <Text style={[styles.specChipText, !selectedSpecialty && styles.specChipTextActive]}>All</Text>
          </Pressable>
          {specialties.map((s: any) => (
            <Pressable key={s.name} testID={`specialty-${s.name}`} onPress={() => setSelectedSpecialty(selectedSpecialty === s.name ? null : s.name)} style={[styles.specChip, selectedSpecialty === s.name && styles.specChipActive]}>
              <Ionicons name={specialtyIcons[s.name] || "medkit"} size={14} color={selectedSpecialty === s.name ? colors.onBrandPrimary : colors.brand} />
              <Text style={[styles.specChipText, selectedSpecialty === s.name && styles.specChipTextActive]}>{s.name}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Text style={styles.sectionTitle}>Available Doctors</Text>

        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: spacing.xl }} />
        ) : doctors.length === 0 ? (
          <View style={styles.empty}><Text style={styles.emptyText}>No doctors match your search</Text></View>
        ) : (
          doctors.map((d) => (
            <Pressable key={d.id} testID={`doctor-card-${d.id}`} onPress={() => router.push(`/patient/doctor/${d.id}` as any)} style={styles.doctorCard}>
              {d.photo ? (
                <Image source={{ uri: d.photo }} style={styles.doctorPhoto} />
              ) : (
                <View style={[styles.doctorPhoto, { backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="person" size={30} color={colors.brandPrimary} />
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.doctorName}>{d.full_name}</Text>
                <Text style={styles.doctorSpec}>{d.specialty} · {d.city}</Text>
                <Text style={styles.doctorClinic}>{d.clinic_name}</Text>
                <View style={styles.doctorMetaRow}>
                  <View style={styles.metaPill}>
                    <Ionicons name="star" size={12} color={colors.warning} />
                    <Text style={styles.metaPillText}>{d.rating}</Text>
                  </View>
                  <View style={styles.metaPill}>
                    <Ionicons name="time-outline" size={12} color={colors.brandPrimary} />
                    <Text style={styles.metaPillText}>~{d.est_wait_minutes}m wait</Text>
                  </View>
                  <Text style={styles.fees}>₹{d.fees}</Text>
                </View>
              </View>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  scroll: { padding: spacing.lg, paddingBottom: spacing.xxxl, gap: spacing.md },
  header: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  hello: { fontSize: font.base, color: colors.muted },
  name: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface, marginTop: 2 },
  iconBtn: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  searchWrap: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, borderRadius: radius.pill, paddingHorizontal: spacing.lg, borderWidth: 1, borderColor: colors.border, gap: spacing.sm },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: font.base, color: colors.onSurface },
  upcomingWrap: { borderRadius: radius.lg, overflow: "hidden", height: 140 },
  upcomingBg: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  upcomingOverlay: { flex: 1, padding: spacing.lg, justifyContent: "center", gap: 2 },
  upcomingLabel: { color: "rgba(255,255,255,0.85)", fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  upcomingName: { color: colors.onBrandPrimary, fontSize: font.xl, fontWeight: "700", marginTop: 4 },
  upcomingMeta: { color: "rgba(255,255,255,0.9)", fontSize: font.base },
  upcomingCta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.sm },
  upcomingCtaText: { color: colors.onBrandPrimary, fontWeight: "600", fontSize: font.sm },
  sectionTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginTop: spacing.sm },
  specsRow: { gap: spacing.sm, paddingRight: spacing.lg },
  specChip: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.md, height: 36, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  specChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  specChipText: { fontSize: font.sm, color: colors.onSurface, fontWeight: "500" },
  specChipTextActive: { color: colors.onBrandPrimary },
  doctorCard: { flexDirection: "row", gap: spacing.md, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  doctorPhoto: { width: 76, height: 76, borderRadius: radius.md },
  doctorName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  doctorSpec: { fontSize: font.sm, color: colors.brandPrimary, fontWeight: "500" },
  doctorClinic: { fontSize: font.sm, color: colors.muted },
  doctorMetaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 6 },
  metaPill: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.surfaceSecondary, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill },
  metaPillText: { fontSize: 11, color: colors.onSurfaceSecondary, fontWeight: "500" },
  fees: { fontSize: font.base, fontWeight: "700", color: colors.brandPrimary, marginLeft: "auto" },
  empty: { padding: spacing.xl, alignItems: "center" },
  emptyText: { color: colors.muted },
});
