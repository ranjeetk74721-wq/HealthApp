import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

const roles = [
  { key: "patient", label: "Patient", icon: "person" as const, desc: "Book appointments" },
  { key: "doctor", label: "Doctor", icon: "medkit" as const, desc: "Manage schedule" },
  { key: "receptionist", label: "Receptionist", icon: "briefcase" as const, desc: "Front desk" },
];

export default function Signup() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [role, setRole] = useState<"patient" | "doctor" | "receptionist">("patient");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onSignup = async () => {
    setError(null);
    if (!name || !email || !password) {
      setError("Please fill all required fields");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/signup", {
        email: email.trim().toLowerCase(),
        password,
        full_name: name,
        role,
        phone,
      });
      await signIn(res.access_token, res.user);
      router.replace(role === "patient" ? "/patient/home" : role === "doctor" ? "/doctor/dashboard" : "/receptionist/dashboard");
    } catch (e: any) {
      setError(e.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()} testID="signup-back" style={styles.back}>
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            <Text style={styles.backText}>Back</Text>
          </Pressable>

          <Text style={styles.title}>Create account</Text>
          <Text style={styles.subtitle}>Choose your role to get started</Text>

          <View style={styles.roleRow}>
            {roles.map((r) => (
              <Pressable
                key={r.key}
                testID={`role-${r.key}`}
                onPress={() => setRole(r.key as any)}
                style={[styles.roleCard, role === r.key && styles.roleCardActive]}
              >
                <Ionicons name={r.icon} size={22} color={role === r.key ? colors.onBrandPrimary : colors.brand} />
                <Text style={[styles.roleLabel, role === r.key && { color: colors.onBrandPrimary }]}>{r.label}</Text>
                <Text style={[styles.roleDesc, role === r.key && { color: colors.onBrandPrimary }]}>{r.desc}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Full name</Text>
            <TextInput testID="signup-name-input" placeholder="Your name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} style={styles.input} />

            <Text style={styles.label}>Email</Text>
            <TextInput testID="signup-email-input" placeholder="you@example.com" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" style={styles.input} />

            <Text style={styles.label}>Phone (optional)</Text>
            <TextInput testID="signup-phone-input" placeholder="+91 98765 43210" placeholderTextColor={colors.muted} value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={styles.input} />

            <Text style={styles.label}>Password</Text>
            <TextInput testID="signup-password-input" placeholder="At least 6 chars" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />

            {error ? <Text testID="signup-error" style={styles.error}>{error}</Text> : null}

            <Pressable testID="signup-submit-button" onPress={onSignup} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
              {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Create Account</Text>}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxxl },
  back: { flexDirection: "row", alignItems: "center", marginBottom: spacing.sm },
  backText: { fontSize: font.lg, color: colors.onSurface, marginLeft: 2 },
  title: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  roleRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.md },
  roleCard: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, alignItems: "center", borderWidth: 1, borderColor: colors.border, gap: 4 },
  roleCardActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  roleLabel: { fontSize: font.base, fontWeight: "600", color: colors.onSurface, marginTop: spacing.xs },
  roleDesc: { fontSize: 10, color: colors.muted, textAlign: "center" },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.xs, borderWidth: 1, borderColor: colors.border },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: font.lg, color: colors.onSurface, backgroundColor: colors.surface },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.base },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
});
