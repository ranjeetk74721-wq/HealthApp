import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

export default function StaffLogin() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { signIn } = useAuth();
  const insets = useSafeAreaInsets();

  const savedHospitalId = typeof window !== "undefined" ? window.localStorage?.getItem("cq_receptionist_last_hospital") : null;
  const hospitalId = (params.hospitalId as string) || savedHospitalId || "Unknown Hospital";
  const hospitalName = (params.hospitalName as string) || (hospitalId !== "Unknown Hospital" ? `Hospital ${hospitalId}` : "");
  const role = (params.role as string) || "";

  const roleTitle = role === "doctor" ? "Doctor Login" : role === "receptionist" ? "Receptionist Login" : "Staff Login";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    setError(null);
    if (!email.trim() || !password.trim()) {
      setError("Please enter email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { 
        email: email.trim().toLowerCase(), 
        password,
        hospital_id: hospitalId !== "Unknown Hospital" ? hospitalId : undefined,
        role: role || undefined,
      });
      
      // Ensure the logged in user belongs to this hospital ID
      if (hospitalId !== "Unknown Hospital" && res.user.role !== "owner" && res.user.role !== "admin" && res.user.hospital_id && res.user.hospital_id.toUpperCase() !== hospitalId.toUpperCase()) {
        setError(`You are not assigned to ${hospitalId}`);
        setLoading(false);
        return;
      }

      // If user selected a specific role, verify role match
      if (role && res.user.role !== role && res.user.role !== "admin" && res.user.role !== "owner") {
        setError(`This account is registered as a ${res.user.role}, not a ${role}`);
        setLoading(false);
        return;
      }

      await signIn(res.access_token, res.user);
      
      if (res.user.role === "doctor") {
        router.replace("/doctor/dashboard");
      } else if (res.user.role === "receptionist") {
        router.replace("/receptionist/dashboard");
      } else {
        router.replace("/owner/dashboard");
      }
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 24, spacing.xxl) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.backWrap}>
          <Pressable onPress={() => router.back()} style={styles.backBtn} hitSlop={12}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
        </View>

        <View style={styles.headerWrap}>
          <Text style={styles.title}>{roleTitle}</Text>
          <Text style={styles.subtitle}>{hospitalName ? `${hospitalName} (${hospitalId})` : hospitalId}</Text>
          <Pressable onPress={() => router.push("/hospital-id")} style={{ marginTop: 6 }} hitSlop={8}>
            <Text style={{ fontSize: 12, color: colors.brandPrimary, textDecorationLine: "underline" }}>
              Change Hospital ID
            </Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            placeholder="staff@clinic.com"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            style={styles.input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            placeholder="••••••••"
            placeholderTextColor={colors.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={onLogin} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }, loading && { opacity: 0.7 }]}>
            {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Login</Text>}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  scrollContent: { padding: spacing.xl, maxWidth: 480, width: "100%", alignSelf: "center" },
  backWrap: { marginBottom: spacing.lg },
  backBtn: { padding: spacing.xs, alignSelf: "flex-start" },
  headerWrap: { marginBottom: spacing.xl },
  title: { fontSize: font.xl, fontWeight: "bold", color: colors.onSurface, marginBottom: spacing.xs },
  subtitle: { fontSize: font.sm, color: colors.brandPrimary, fontWeight: "500" },
  card: { backgroundColor: colors.surface, padding: spacing.xl, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, elevation: 2 },
  label: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface, marginBottom: spacing.sm },
  input: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, marginBottom: spacing.lg, minHeight: 46 },
  error: { color: colors.error, fontSize: font.sm, marginBottom: spacing.md, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center", minHeight: 48, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.base, fontWeight: "600" },
});
