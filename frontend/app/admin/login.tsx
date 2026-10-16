import { useState, useEffect } from "react";
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
  const { signIn, user, loading: authLoading } = useAuth();

  // Two-step flow: secret_code -> credentials -> authenticated Admin Panel
  const [step, setStep] = useState<"secret_code" | "credentials">("secret_code");
  const [secretCode, setSecretCode] = useState("");
  const [verifiedAdminCode, setVerifiedAdminCode] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const releaseFocus = () => {
    if (Platform.OS === "web" && typeof document !== "undefined") {
      (document.activeElement as HTMLElement)?.blur();
    }
  };

  // If already authenticated as admin/owner, redirect straight to the Admin Panel
  useEffect(() => {
    if (!authLoading && user && (user.role === "admin" || user.role === "owner")) {
      releaseFocus();
      if (params.redirect && (params.redirect.startsWith("/owner") || params.redirect.startsWith("/admin"))) {
        router.replace(params.redirect as any);
      } else {
        router.replace("/owner/dashboard");
      }
    }
  }, [authLoading, user, params.redirect, router]);

  // Step 1: Server-side verification of admin secret code
  const onVerifySecretCode = async () => {
    setError(null);
    const code = secretCode.trim();
    if (!code) {
      setError("Please enter the secret code");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/hospital/validate-id", {
        hospital_id: code,
      });

      if (res && res.valid && res.isAdmin) {
        setVerifiedAdminCode(res.hospital_id || code.toUpperCase());
        setStep("credentials");
        setError(null);
      } else {
        setError("Invalid secret code. Access denied.");
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.isHtmlResponse) {
          setError("Network or routing error. Please try again shortly.");
        } else if (e.isServerWarming) {
          setError("Backend server is warming up. Please wait 15 seconds and retry.");
        } else if (e.status === 404 || e.status === 401) {
          setError("Invalid secret code. Please verify and try again.");
        } else {
          setError(e.message || "Secret code verification failed");
        }
      } else {
        setError(e?.message || "Invalid secret code. Please verify and try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  // Step 2: Email and password login for verified admin code
  const onLogin = async () => {
    setError(null);
    if (!verifiedAdminCode) {
      setError("Session expired. Please verify secret code first.");
      setStep("secret_code");
      return;
    }
    if (!email.trim() || !password.trim()) {
      setError("Please enter email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", {
        hospital_code: verifiedAdminCode,
        email: email.trim().toLowerCase(),
        password,
      });

      if (res.user.role !== "admin" && res.user.role !== "owner") {
        setError("Unauthorized access. Admin privileges required.");
        return;
      }

      await signIn(res.access_token, res.user);
      releaseFocus();

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
        } else if (e.status === 401) {
          setError("Invalid email or password");
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

  const handleBack = () => {
    releaseFocus();
    if (step === "credentials") {
      setStep("secret_code");
      setVerifiedAdminCode(null);
      setEmail("");
      setPassword("");
      setError(null);
    } else {
      router.back();
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
            <Pressable
              onPress={handleBack}
              style={styles.backBtn}
              accessibilityLabel="Back"
              hitSlop={10}
            >
              <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
            </Pressable>
          </View>

          <View style={styles.headerWrap}>
            <Text style={styles.title}>System Admin</Text>
            <Text style={styles.subtitle}>
              {step === "secret_code"
                ? "Enter your secret access code to verify authorization"
                : "Sign in with your administrator email and password"}
            </Text>
          </View>

          <View style={styles.card}>
            {step === "secret_code" ? (
              <>
                <Text style={styles.label}>Admin Secret Code</Text>
                <TextInput
                  testID="admin-secret-code-input"
                  placeholder="Enter secret code"
                  placeholderTextColor={colors.muted}
                  value={secretCode}
                  onChangeText={(t) => {
                    setSecretCode(t);
                    if (error) setError(null);
                  }}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  secureTextEntry
                  returnKeyType="go"
                  onSubmitEditing={onVerifySecretCode}
                  style={styles.input}
                />

                {error ? (
                  <View style={styles.errorBox}>
                    <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}

                <Pressable
                  testID="admin-verify-code-btn"
                  onPress={onVerifySecretCode}
                  disabled={loading}
                  style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}
                >
                  {loading ? (
                    <ActivityIndicator color={colors.onBrandPrimary} />
                  ) : (
                    <Text style={styles.primaryBtnText}>Verify Secret Code</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.label}>Admin Email</Text>
                <TextInput
                  testID="admin-email-input"
                  placeholder="Enter email"
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
                  placeholder="Enter password"
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
              </>
            )}
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
