import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api, ApiError } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

export default function AdminLogin() {
  const router = useRouter();
  const params = useLocalSearchParams<{ redirect?: string }>();
  const { signIn } = useAuth();

  const [hospitalCode, setHospitalCode] = useState("H00001");
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
        hospital_code: hospitalCode.trim() ? hospitalCode.trim().toUpperCase() : "H00001",
        email: email.trim().toLowerCase(),
        password,
      });
      if (res.user.role !== "admin" && res.user.role !== "owner") {
        setError("Unauthorized access. Admin privileges required.");
        return;
      }
      await signIn(res.access_token, res.user);

      if (params.redirect && (params.redirect.startsWith("/owner") || params.redirect.startsWith("/admin"))) {
        router.replace(params.redirect as any);
      } else {
        router.replace("/owner/dashboard");
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.isHtmlResponse) {
          setError("Network or routing error. Please try again shortly.");
        } else if (e.isServerWarming) {
          setError("Backend server is warming up. Please wait 15 seconds and retry.");
        } else {
          setError(e.message || "Login failed");
        }
      } else {
        setError(e?.message || "Login failed. Check your internet connection.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.backWrap}>
            <Pressable onPress={() => router.back()} style={styles.backBtn} accessibilityLabel="Back" hitSlop={10}>
              <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
            </Pressable>
          </View>

          <View style={styles.headerWrap}>
            <Text style={styles.title}>System Admin</Text>
            <Text style={styles.subtitle}>Sign in to manage Meribaari platform & hospitals</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Hospital Code (Optional for Platform Admin)</Text>
            <TextInput
              testID="admin-hospital-code-input"
              placeholder="e.g. H00001 or ADMIN-000"
              placeholderTextColor={colors.muted}
              value={hospitalCode}
              onChangeText={(t) => {
                setHospitalCode(t);
                if (error) setError(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              style={styles.input}
            />

            <Text style={styles.label}>Admin Email</Text>
            <TextInput
              testID="admin-email-input"
              placeholder="admin@example.com"
              placeholderTextColor={colors.muted}
              value={email}
              onChangeText={(t) => {
                setEmail(t);
                if (error) setError(null);
              }}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />

            <Text style={styles.label}>Password</Text>
            <TextInput
              testID="admin-password-input"
              placeholder="••••••••"
              placeholderTextColor={colors.muted}
              value={password}
              onChangeText={(t) => {
                setPassword(t);
                if (error) setError(null);
              }}
              secureTextEntry
              returnKeyType="go"
              onSubmitEditing={onLogin}
              style={styles.input}
            />

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              testID="admin-login-btn"
              onPress={onLogin}
              disabled={loading}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}
            >
              {loading ? (
                <ActivityIndicator color={colors.onBrandPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Login</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: {
    flexGrow: 1,
    padding: spacing.xl,
    justifyContent: "center",
  },
  backWrap: {
    alignSelf: "flex-start",
    marginBottom: spacing.lg,
  },
  backBtn: {
    padding: spacing.xs,
  },
  headerWrap: {
    marginBottom: spacing.xl,
  },
  title: {
    fontSize: font.xl,
    fontWeight: "bold",
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: font.sm,
    color: colors.muted,
  },
  card: {
    backgroundColor: colors.surface,
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
  },
  label: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 16,
    color: colors.onSurface,
    marginBottom: spacing.md,
    minHeight: 48,
  },
  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.error + "15",
    padding: spacing.sm,
    borderRadius: radius.sm,
    marginBottom: spacing.md,
  },
  errorText: {
    flex: 1,
    color: colors.error,
    fontSize: font.sm,
  },
  primaryBtn: {
    backgroundColor: colors.brandPrimary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
    marginTop: spacing.xs,
  },
  primaryBtnText: {
    color: colors.onBrandPrimary,
    fontSize: font.base,
    fontWeight: "600",
  },
});
