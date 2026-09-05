import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

export default function AdminLogin() {
  const router = useRouter();
  const { signIn } = useAuth();

  const [hospitalCode, setHospitalCode] = useState("H00001");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    setError(null);
    if (!email.trim() || !password.trim() || !hospitalCode.trim()) {
      setError("Please enter hospital code, email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", {
        hospital_code: hospitalCode.trim().toUpperCase(),
        email: email.trim().toLowerCase(),
        password
      });
      if (res.user.role !== "admin" && res.user.role !== "owner") {
        setError("Unauthorized access. Admin only.");
        return;
      }
      await signIn(res.access_token, res.user);
      router.replace("/owner/dashboard");
    } catch (e: any) {
      setError(e.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <View style={styles.backWrap}>
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
          </Pressable>
        </View>

        <View style={styles.headerWrap}>
          <Text style={styles.title}>System Admin</Text>
          <Text style={styles.subtitle}>Sign in to manage Meribaari</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Hospital Code</Text>
          <TextInput
            placeholder="H00001"
            placeholderTextColor={colors.muted}
            value={hospitalCode}
            onChangeText={setHospitalCode}
            autoCapitalize="characters"
            style={styles.input}
          />

          <Text style={styles.label}>Admin Email</Text>
          <TextInput
            placeholder="Enter your Gmail ID:"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.input}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            placeholder="••••••••"
            placeholderTextColor={colors.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={onLogin} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
            {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Login</Text>}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: { flex: 1, padding: spacing.xl },
  backWrap: { marginBottom: spacing.xl },
  backBtn: { padding: spacing.xs },
  headerWrap: { marginBottom: spacing.xxl },
  title: { fontSize: font.xl, fontWeight: "bold", color: colors.onSurface, marginBottom: spacing.xs },
  subtitle: { fontSize: font.sm, color: colors.muted },
  card: { backgroundColor: colors.surface, padding: spacing.xl, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, elevation: 2 },
  label: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface, marginBottom: spacing.sm },
  input: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, marginBottom: spacing.lg },
  error: { color: colors.error, fontSize: font.sm, marginBottom: spacing.md, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.base, fontWeight: "600" },
});
