import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

export default function Login() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onLogin = async () => {
    setError(null);
    if (!email || !password) {
      setError("Please enter email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { email: email.trim().toLowerCase(), password });
      await signIn(res.access_token, res.user);
      const role = res.user.role;
      router.replace(role === "patient" ? "/patient/home" : role === "doctor" ? "/doctor/dashboard" : "/receptionist/dashboard");
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <View style={styles.logoWrap}>
            <View style={styles.logoCircle}>
              <Ionicons name="medkit" size={44} color={colors.onBrandPrimary} />
            </View>
            <Text style={styles.brandName}>ClinicQueue</Text>
            <Text style={styles.tagline}>Skip the wait. Book smart.</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.title}>Welcome back</Text>
            <Text style={styles.subtitle}>Sign in to your account</Text>

            <Text style={styles.label}>Email</Text>
            <TextInput
              testID="login-email-input"
              placeholder="you@example.com"
              placeholderTextColor={colors.muted}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              style={styles.input}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="login-password-input"
              placeholder="••••••••"
              placeholderTextColor={colors.muted}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              style={styles.input}
            />

            {error ? (
              <Text testID="login-error" style={styles.error}>
                {error}
              </Text>
            ) : null}

            <Pressable testID="login-submit-button" onPress={onLogin} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
              {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Sign In</Text>}
            </Pressable>

            <Pressable testID="go-to-signup" onPress={() => router.push("/signup")} style={styles.linkBtn}>
              <Text style={styles.linkText}>
                New user? <Text style={{ color: colors.brand, fontWeight: "600" }}>Create account</Text>
              </Text>
            </Pressable>
          </View>

          <View style={styles.demoBox} testID="demo-credentials">
            <Text style={styles.demoTitle}>Demo accounts</Text>
            <Text style={styles.demoText}>Doctor: drrajeshkumar@clinic.com / doctor123</Text>
            <Text style={styles.demoText}>Receptionist: reception@clinic.com / reception123</Text>
            <Text style={styles.demoText}>Patient: create your own via Sign Up</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: { padding: spacing.lg, gap: spacing.lg },
  logoWrap: { alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.lg },
  logoCircle: { width: 84, height: 84, borderRadius: radius.pill, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginBottom: spacing.md },
  brandName: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  tagline: { fontSize: font.base, color: colors.muted, marginTop: spacing.xs },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: spacing.xs, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: font.lg, color: colors.onSurface, backgroundColor: colors.surface },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.base },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
  linkBtn: { alignItems: "center", marginTop: spacing.md, padding: spacing.sm },
  linkText: { color: colors.muted, fontSize: font.base },
  demoBox: { backgroundColor: colors.brandSecondary, padding: spacing.md, borderRadius: radius.md, gap: 4 },
  demoTitle: { color: colors.onBrandSecondary, fontWeight: "700", fontSize: font.base, marginBottom: spacing.xs },
  demoText: { color: colors.onBrandSecondary, fontSize: font.sm },
});
