import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, ActivityIndicator, RefreshControl, Modal, TextInput, KeyboardAvoidingView, Platform, Image, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";

const SPECIALTIES = [
  "Cardiology", "Dermatology", "Pediatrics", "Dental",
  "General Physician", "Orthopedics", "ENT", "Ophthalmology",
];

interface DocRow {
  id: string;
  full_name: string;
  specialty: string;
  city: string;
  clinic_name: string;
  fees: number;
  photo?: string | null;
  degree?: string | null;
  experience_years?: number | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: string;
  todays_appts?: number;
  id_proof_photo?: string | null;
  degree_photo?: string | null;
  bio?: string | null;
  timings?: string;
}

export default function OwnerDashboard() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [stats, setStats] = useState<any | null>(null);
  const [doctors, setDoctors] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [viewDoc, setViewDoc] = useState<DocRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Form state
  const [f, setF] = useState({
    full_name: "", email: "", password: "", phone: "", address: "",
    specialty: "", degree: "", experience_years: "", clinic_name: "",
    city: "", fees: "", timings: "", bio: "",
  });
  const [photo, setPhoto] = useState<string | null>(null);
  const [idProof, setIdProof] = useState<string | null>(null);
  const [degreePhoto, setDegreePhoto] = useState<string | null>(null);

  const setField = (k: string, v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const resetForm = () => {
    setF({
      full_name: "", email: "", password: "", phone: "", address: "",
      specialty: "", degree: "", experience_years: "", clinic_name: "",
      city: "", fees: "", timings: "", bio: "",
    });
    setPhoto(null); setIdProof(null); setDegreePhoto(null); setError(null);
  };

  const load = useCallback(async () => {
    try {
      const [s, docs] = await Promise.all([api.get("/owner/stats"), api.get("/owner/doctors")]);
      setStats(s);
      setDoctors(docs);
    } catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const pickImage = async (setter: (v: string) => void) => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Permission needed", "Please allow photo library access to upload images.");
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        base64: true,
        quality: 0.6,
        allowsEditing: false,
      });
      if (!res.canceled && res.assets[0]?.base64) {
        const mime = res.assets[0].mimeType || "image/jpeg";
        setter(`data:${mime};base64,${res.assets[0].base64}`);
      }
    } catch (e) {
      Alert.alert("Error", "Could not pick image");
    }
  };

  const onSubmit = async () => {
    setError(null);
    if (!f.full_name.trim() || !f.email.trim() || !f.password.trim()) return setError("Name, email & password required");
    if (!f.specialty) return setError("Select a specialty");
    if (!f.clinic_name || !f.city || !f.fees || !f.timings) return setError("Clinic, city, fees, timings required");
    setSubmitting(true);
    try {
      await api.post("/owner/add-doctor", {
        full_name: f.full_name.trim(),
        email: f.email.trim().toLowerCase(),
        password: f.password,
        phone: f.phone || undefined,
        address: f.address || undefined,
        specialty: f.specialty,
        degree: f.degree || undefined,
        experience_years: f.experience_years ? parseInt(f.experience_years, 10) : undefined,
        clinic_name: f.clinic_name,
        city: f.city,
        fees: parseInt(f.fees, 10),
        timings: f.timings,
        bio: f.bio || undefined,
        photo, id_proof_photo: idProof, degree_photo: degreePhoto,
      });
      setToast(`Doctor added: ${f.full_name}`);
      resetForm();
      setAddOpen(false);
      load();
      setTimeout(() => setToast(null), 3000);
    } catch (e: any) {
      setError(e.message || "Failed to add doctor");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = (d: DocRow) => {
    Alert.alert(
      "Remove Doctor?",
      `${d.full_name} will be removed. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove", style: "destructive",
          onPress: async () => {
            try { await api.del(`/owner/doctors/${d.id}`); load(); setToast("Doctor removed"); setTimeout(() => setToast(null), 2500); }
            catch (e: any) { Alert.alert("Error", e.message); }
          },
        },
      ],
    );
  };

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>Owner Panel</Text>
          <Text style={styles.name}>{user?.full_name}</Text>
        </View>
        <Pressable onPress={async () => { await signOut(); router.replace("/login"); }} testID="owner-logout" style={styles.iconBtn}>
          <Ionicons name="log-out-outline" size={22} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        {stats && (
          <>
            <View style={styles.kpiRow}>
              <View style={styles.kpiCard}>
                <Ionicons name="medkit" size={20} color={colors.brandPrimary} />
                <Text style={styles.kpiValue}>{stats.total_doctors}</Text>
                <Text style={styles.kpiLabel}>Doctors</Text>
              </View>
              <View style={styles.kpiCard}>
                <Ionicons name="people" size={20} color={colors.success} />
                <Text style={styles.kpiValue}>{stats.total_patients}</Text>
                <Text style={styles.kpiLabel}>Patients</Text>
              </View>
              <View style={styles.kpiCard}>
                <Ionicons name="calendar" size={20} color={colors.warning} />
                <Text style={styles.kpiValue}>{stats.todays_appointments}</Text>
                <Text style={styles.kpiLabel}>Today&apos;s Appts</Text>
              </View>
              <View style={styles.kpiCard}>
                <Ionicons name="cash" size={20} color={colors.info} />
                <Text style={styles.kpiValue}>₹{stats.revenue_today}</Text>
                <Text style={styles.kpiLabel}>Today&apos;s Revenue</Text>
              </View>
            </View>
          </>
        )}

        <View style={styles.sectionRow}>
          <Text style={styles.sectionTitle}>Doctors ({doctors.length})</Text>
          <Pressable testID="add-doctor-btn" onPress={() => setAddOpen(true)} style={styles.addBtnSmall}>
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={styles.addBtnSmallText}>Add Doctor</Text>
          </Pressable>
        </View>

        {doctors.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="medical-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No doctors added yet</Text>
          </View>
        ) : (
          doctors.map((d) => (
            <Pressable key={d.id} testID={`doc-row-${d.id}`} onPress={() => setViewDoc(d)} style={styles.docCard}>
              {d.photo ? (
                <Image source={{ uri: d.photo }} style={styles.docPhoto} />
              ) : (
                <View style={[styles.docPhoto, { backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" }]}>
                  <Ionicons name="person" size={26} color={colors.brandPrimary} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.docName}>{d.full_name}</Text>
                <Text style={styles.docSpec}>{d.specialty} · {d.city}</Text>
                <View style={styles.chipsRow}>
                  {d.degree ? <View style={styles.chip}><Text style={styles.chipText}>{d.degree}</Text></View> : null}
                  {d.experience_years ? <View style={styles.chip}><Text style={styles.chipText}>{d.experience_years} yrs</Text></View> : null}
                  <View style={styles.chip}><Text style={styles.chipText}>₹{d.fees}</Text></View>
                  {typeof d.todays_appts === "number" ? <View style={[styles.chip, { backgroundColor: colors.warning + "22" }]}><Text style={[styles.chipText, { color: colors.warning }]}>{d.todays_appts} today</Text></View> : null}
                </View>
              </View>
              <Pressable testID={`del-doc-${d.id}`} onPress={() => onDelete(d)} style={styles.delBtn} hitSlop={8}>
                <Ionicons name="trash-outline" size={18} color={colors.error} />
              </Pressable>
            </Pressable>
          ))
        )}
      </ScrollView>

      {toast ? (
        <View style={styles.toast}>
          <Ionicons name="checkmark-circle" size={18} color="#fff" />
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/* Add Doctor Modal */}
      <Modal transparent visible={addOpen} animationType="slide" onRequestClose={() => setAddOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setAddOpen(false)}>
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, justifyContent: "flex-end" }}>
            <Pressable style={[styles.sheet, { maxHeight: "92%", minHeight: "80%" }]} onPress={(e) => e.stopPropagation()}>
              <View style={styles.sheetHandle} />
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={styles.sheetTitle}>Add New Doctor</Text>
                <Text style={styles.sheetSub}>Fill all details. Doctor will login with the credentials you set.</Text>

                <Text style={styles.groupLabel}>Basic Info</Text>
                <TextInput testID="ad-name" placeholder="Full Name*" placeholderTextColor={colors.muted} value={f.full_name} onChangeText={(v) => setField("full_name", v)} style={styles.input} />
                <TextInput testID="ad-email" placeholder="Login Email*" placeholderTextColor={colors.muted} value={f.email} onChangeText={(v) => setField("email", v)} keyboardType="email-address" autoCapitalize="none" style={styles.input} />
                <TextInput testID="ad-password" placeholder="Temp Password*" placeholderTextColor={colors.muted} value={f.password} onChangeText={(v) => setField("password", v)} secureTextEntry style={styles.input} />
                <TextInput testID="ad-phone" placeholder="Phone" placeholderTextColor={colors.muted} value={f.phone} onChangeText={(v) => setField("phone", v.replace(/[^0-9+]/g, ""))} keyboardType="phone-pad" style={styles.input} />
                <TextInput testID="ad-address" placeholder="Home / Personal Address" placeholderTextColor={colors.muted} value={f.address} onChangeText={(v) => setField("address", v)} style={styles.input} />

                <Text style={styles.groupLabel}>Professional</Text>
                <Text style={styles.subLabel}>Specialty*</Text>
                <View style={styles.specWrap}>
                  {SPECIALTIES.map((s) => {
                    const active = f.specialty === s;
                    return (
                      <Pressable key={s} testID={`ad-spec-${s}`} onPress={() => setField("specialty", s)} style={[styles.specChip, active && styles.specChipActive]}>
                        <Text style={[styles.specChipText, active && { color: "#fff" }]}>{s}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextInput testID="ad-degree" placeholder='Degree (e.g. "MBBS, MD")' placeholderTextColor={colors.muted} value={f.degree} onChangeText={(v) => setField("degree", v)} style={styles.input} />
                <View style={{ flexDirection: "row", gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <TextInput testID="ad-exp" placeholder="Experience (yrs)" placeholderTextColor={colors.muted} value={f.experience_years} onChangeText={(v) => setField("experience_years", v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" style={styles.input} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <TextInput testID="ad-fees" placeholder="Fees ₹*" placeholderTextColor={colors.muted} value={f.fees} onChangeText={(v) => setField("fees", v.replace(/[^0-9]/g, ""))} keyboardType="number-pad" style={styles.input} />
                  </View>
                </View>
                <TextInput testID="ad-clinic" placeholder="Clinic Name*" placeholderTextColor={colors.muted} value={f.clinic_name} onChangeText={(v) => setField("clinic_name", v)} style={styles.input} />
                <TextInput testID="ad-city" placeholder="City*" placeholderTextColor={colors.muted} value={f.city} onChangeText={(v) => setField("city", v)} style={styles.input} />
                <TextInput testID="ad-timings" placeholder='Timings* (e.g. "10 AM - 4 PM")' placeholderTextColor={colors.muted} value={f.timings} onChangeText={(v) => setField("timings", v)} style={styles.input} />
                <TextInput testID="ad-bio" placeholder="Short bio (optional)" placeholderTextColor={colors.muted} value={f.bio} onChangeText={(v) => setField("bio", v)} multiline style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]} />

                <Text style={styles.groupLabel}>Documents</Text>
                <View style={styles.imgRow}>
                  <Pressable testID="pick-photo" onPress={() => pickImage(setPhoto)} style={styles.imgPickBtn}>
                    {photo ? <Image source={{ uri: photo }} style={styles.imgPreview} /> : <><Ionicons name="camera" size={20} color={colors.brandPrimary} /><Text style={styles.imgPickText}>Profile</Text></>}
                  </Pressable>
                  <Pressable testID="pick-id" onPress={() => pickImage(setIdProof)} style={styles.imgPickBtn}>
                    {idProof ? <Image source={{ uri: idProof }} style={styles.imgPreview} /> : <><Ionicons name="card" size={20} color={colors.brandPrimary} /><Text style={styles.imgPickText}>ID Proof</Text></>}
                  </Pressable>
                  <Pressable testID="pick-degree" onPress={() => pickImage(setDegreePhoto)} style={styles.imgPickBtn}>
                    {degreePhoto ? <Image source={{ uri: degreePhoto }} style={styles.imgPreview} /> : <><Ionicons name="document" size={20} color={colors.brandPrimary} /><Text style={styles.imgPickText}>Degree</Text></>}
                  </Pressable>
                </View>

                {error ? <Text style={styles.error}>{error}</Text> : null}

                <Pressable testID="submit-add-doctor" onPress={onSubmit} disabled={submitting} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                  {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryBtnText}>Save Doctor</Text>}
                </Pressable>
                <View style={{ height: spacing.xxl }} />
              </ScrollView>
            </Pressable>
          </KeyboardAvoidingView>
        </Pressable>
      </Modal>

      {/* View Doctor Modal */}
      <Modal transparent visible={!!viewDoc} animationType="slide" onRequestClose={() => setViewDoc(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setViewDoc(null)}>
          <Pressable style={[styles.sheet, { maxHeight: "88%" }]} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            {viewDoc && (
              <ScrollView>
                <View style={{ alignItems: "center", marginBottom: spacing.md }}>
                  {viewDoc.photo ? (
                    <Image source={{ uri: viewDoc.photo }} style={styles.bigPhoto} />
                  ) : (
                    <View style={[styles.bigPhoto, { backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" }]}>
                      <Ionicons name="person" size={44} color={colors.brandPrimary} />
                    </View>
                  )}
                  <Text style={styles.viewName}>{viewDoc.full_name}</Text>
                  <Text style={styles.viewSpec}>{viewDoc.specialty} · {viewDoc.city}</Text>
                </View>
                <DetailRow icon="school" label="Degree" value={viewDoc.degree || "—"} />
                <DetailRow icon="briefcase" label="Experience" value={viewDoc.experience_years ? `${viewDoc.experience_years} years` : "—"} />
                <DetailRow icon="business" label="Clinic" value={viewDoc.clinic_name} />
                <DetailRow icon="cash" label="Fees" value={`₹${viewDoc.fees}`} />
                <DetailRow icon="time" label="Timings" value={viewDoc.timings || "—"} />
                <DetailRow icon="mail" label="Email" value={viewDoc.email || "—"} />
                <DetailRow icon="call" label="Phone" value={viewDoc.phone || "—"} />
                <DetailRow icon="location" label="Address" value={viewDoc.address || "—"} />
                {viewDoc.bio ? <DetailRow icon="document-text" label="Bio" value={viewDoc.bio} /> : null}
                {viewDoc.id_proof_photo ? (
                  <>
                    <Text style={styles.docSubHeader}>ID Proof</Text>
                    <Image source={{ uri: viewDoc.id_proof_photo }} style={styles.docImg} resizeMode="contain" />
                  </>
                ) : null}
                {viewDoc.degree_photo ? (
                  <>
                    <Text style={styles.docSubHeader}>Degree Certificate</Text>
                    <Image source={{ uri: viewDoc.degree_photo }} style={styles.docImg} resizeMode="contain" />
                  </>
                ) : null}
                <View style={{ height: spacing.xxl }} />
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function DetailRow({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Ionicons name={icon} size={16} color={colors.brandPrimary} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={3}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { flexDirection: "row", padding: spacing.lg, alignItems: "center" },
  hello: { fontSize: font.base, color: colors.muted },
  name: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  iconBtn: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  scroll: { padding: spacing.lg, paddingTop: 0, gap: spacing.md, paddingBottom: spacing.xxxl },
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  kpiCard: { flex: 1, minWidth: "47%", backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, gap: 4 },
  kpiValue: { fontSize: font.xxl, fontWeight: "800", color: colors.onSurface, marginTop: 4 },
  kpiLabel: { fontSize: font.sm, color: colors.muted },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.md },
  sectionTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  addBtnSmall: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.brandPrimary, paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill },
  addBtnSmallText: { color: "#fff", fontWeight: "700", fontSize: font.sm },
  docCard: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  docPhoto: { width: 56, height: 56, borderRadius: radius.md },
  docName: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  docSpec: { fontSize: font.sm, color: colors.brandPrimary, marginTop: 2 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  chip: { backgroundColor: colors.surfaceSecondary, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
  chipText: { fontSize: 10, color: colors.onSurfaceSecondary, fontWeight: "600" },
  delBtn: { width: 36, height: 36, borderRadius: radius.pill, backgroundColor: colors.error + "18", alignItems: "center", justifyContent: "center" },
  empty: { alignItems: "center", padding: spacing.xxl, gap: spacing.md },
  emptyText: { color: colors.muted, fontSize: font.base },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  sheetSub: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  groupLabel: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary, marginTop: spacing.md, marginBottom: spacing.xs, letterSpacing: 0.5 },
  subLabel: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: 4, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 12, fontSize: font.base, color: colors.onSurface, backgroundColor: colors.surface, marginTop: 6 },
  specWrap: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
  specChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  specChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  specChipText: { fontSize: font.sm, color: colors.onSurface, fontWeight: "500" },
  imgRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  imgPickBtn: { flex: 1, aspectRatio: 1, borderWidth: 1.5, borderColor: colors.border, borderStyle: "dashed", borderRadius: radius.md, alignItems: "center", justifyContent: "center", overflow: "hidden", backgroundColor: colors.surfaceSecondary },
  imgPickText: { fontSize: 11, color: colors.brandPrimary, fontWeight: "600", marginTop: 4 },
  imgPreview: { width: "100%", height: "100%" },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.sm, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
  bigPhoto: { width: 88, height: 88, borderRadius: radius.pill },
  viewName: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface, marginTop: spacing.md },
  viewSpec: { fontSize: font.base, color: colors.brandPrimary, marginTop: 2 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.divider },
  detailLabel: { fontSize: font.sm, color: colors.muted, width: 90 },
  detailValue: { flex: 1, fontSize: font.base, color: colors.onSurface, fontWeight: "500" },
  docSubHeader: { fontSize: font.sm, fontWeight: "700", color: colors.brandPrimary, marginTop: spacing.md, marginBottom: 6 },
  docImg: { width: "100%", height: 200, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary },
  toast: { position: "absolute", bottom: 24, left: 20, right: 20, backgroundColor: colors.success, padding: spacing.md, borderRadius: radius.md, flexDirection: "row", alignItems: "center", gap: spacing.sm, elevation: 5 },
  toastText: { color: "#fff", fontWeight: "600", flex: 1 },
});
