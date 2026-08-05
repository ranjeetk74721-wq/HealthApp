import { useEffect, useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Image, ActivityIndicator, RefreshControl } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

export default function DoctorProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [doctor, setDoctor] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/doctors/${id}`);
      setDoctor(d);
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 40 }} color={colors.brand} /></SafeAreaView>;
  if (!doctor) return <SafeAreaView style={styles.safe}><Text>Doctor not found</Text></SafeAreaView>;

  return (
    <View style={styles.safe}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        <View style={styles.heroWrap}>
          {doctor.photo ? (
            <Image source={{ uri: doctor.photo }} style={styles.heroImg} />
          ) : (
            <View style={[styles.heroImg, { backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="person" size={80} color={colors.brandPrimary} />
            </View>
          )}
          <SafeAreaView edges={["top"]} style={styles.heroOverlay}>
            <Pressable testID="doctor-back" onPress={() => router.back()} style={styles.backBtn}>
              <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
            </Pressable>
          </SafeAreaView>
        </View>

        <View style={styles.body}>
          <Text style={styles.name} testID="doctor-name">{doctor.full_name}</Text>
          <Text style={styles.spec}>{doctor.specialty}</Text>
          <View style={styles.metaRow}>
            <Ionicons name="star" size={14} color={colors.warning} />
            <Text style={styles.metaText}>{doctor.rating}</Text>
            <Text style={styles.dot}>·</Text>
            <Ionicons name="location" size={14} color={colors.muted} />
            <Text style={styles.metaText}>{doctor.city}</Text>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Fee</Text>
              <Text style={styles.infoValue}>₹{doctor.fees}</Text>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Wait time</Text>
              <Text style={styles.infoValue}>~{doctor.est_wait_minutes}m</Text>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Status</Text>
              <Text style={[styles.infoValue, { color: doctor.status === "active" ? colors.success : colors.warning, fontSize: font.base }]}>{doctor.status.toUpperCase()}</Text>
            </View>
          </View>

          <Text style={styles.sectionTitle}>Clinic</Text>
          <View style={styles.detailCard}>
            <Ionicons name="business" size={20} color={colors.brand} />
            <View style={{ flex: 1 }}>
              <Text style={styles.detailTitle}>{doctor.clinic_name}</Text>
              <Text style={styles.detailSub}>{doctor.city}, India</Text>
              {doctor.address ? <Text style={styles.detailSub}>{doctor.address}</Text> : null}
            </View>
          </View>

          {(doctor.degree || doctor.experience_years) ? (
            <>
              <Text style={styles.sectionTitle}>Credentials</Text>
              {doctor.degree ? (
                <View style={styles.detailCard}>
                  <Ionicons name="school" size={20} color={colors.brand} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailTitle}>{doctor.degree}</Text>
                    <Text style={styles.detailSub}>Degree qualification</Text>
                  </View>
                </View>
              ) : null}
              {doctor.experience_years ? (
                <View style={styles.detailCard}>
                  <Ionicons name="briefcase" size={20} color={colors.brand} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.detailTitle}>{doctor.experience_years} years experience</Text>
                    <Text style={styles.detailSub}>In {doctor.specialty}</Text>
                  </View>
                </View>
              ) : null}
            </>
          ) : null}

          <Text style={styles.sectionTitle}>Timings</Text>
          <View style={styles.detailCard}>
            <Ionicons name="time" size={20} color={colors.brand} />
            <Text style={styles.detailTitle}>{doctor.timings}</Text>
          </View>

          {doctor.bio ? (
            <>
              <Text style={styles.sectionTitle}>About</Text>
              <Text style={styles.bio}>{doctor.bio}</Text>
            </>
          ) : null}
        </View>
      </ScrollView>

      <SafeAreaView edges={["bottom"]} style={styles.stickyCta}>
        <Pressable
          testID="book-appointment-cta"
          onPress={() => router.push(`/patient/book/${doctor.id}` as any)}
          style={({ pressed }) => [styles.ctaBtn, pressed && { opacity: 0.85 }]}
          disabled={doctor.status !== "active"}
        >
          <Text style={styles.ctaText}>{doctor.status === "active" ? "Book Appointment" : "Currently Unavailable"}</Text>
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  heroWrap: { height: 320, position: "relative" },
  heroImg: { width: "100%", height: "100%" },
  heroOverlay: { position: "absolute", top: 0, left: 0, right: 0, padding: spacing.md },
  backBtn: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: "rgba(255,255,255,0.9)", alignItems: "center", justifyContent: "center" },
  body: { padding: spacing.lg, gap: spacing.sm },
  name: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  spec: { fontSize: font.base, color: colors.brandPrimary, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: spacing.md },
  metaText: { fontSize: font.sm, color: colors.onSurfaceSecondary },
  dot: { color: colors.muted, marginHorizontal: 4 },
  infoRow: { flexDirection: "row", gap: spacing.sm },
  infoCard: { flex: 1, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, padding: spacing.md, gap: 4 },
  infoLabel: { fontSize: font.sm, color: colors.muted },
  infoValue: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sectionTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md },
  detailCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surfaceSecondary, padding: spacing.md, borderRadius: radius.md },
  detailTitle: { fontSize: font.base, color: colors.onSurface, fontWeight: "500" },
  detailSub: { fontSize: font.sm, color: colors.muted },
  bio: { fontSize: font.base, color: colors.onSurfaceSecondary, lineHeight: 22 },
  stickyCta: { position: "absolute", bottom: 0, left: 0, right: 0, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, padding: spacing.md },
  ctaBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center" },
  ctaText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "700" },
});
