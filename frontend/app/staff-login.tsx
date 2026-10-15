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

export default function StaffLogin() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    hospitalId?: string;
    hospitalName?: string;
    role?: string;
    redirect?: string;
  }>();
  const { signIn } = useAuth();

  const hospitalId = (params.hospitalId as string) || "Unknown Hospital";
  const hospitalName = (params.hospitalName as string) || "";
  const role = (params.role as string) || "";

  const roleTitle =
    role === "doctor"
      ? "Doctor Login"
      : role === "receptionist"
      ? "Receptionist Login"
      : role === "admin"
      ? "Hospital Administrator Login"
      : "Staff Login";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLogin = async () => {
    setError(null);
    if (!email.trim() || !password.trim()) {
      setError("Please enter your email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", {
        email: email.trim().toLowerCase(),
        password,
        hospital_id: hospitalId,
        role: role || undefined,
      });

      // Ensure the logged in user belongs to this hospital ID (except global admin/owner)
      if (
        res.user.role !== "owner" &&
        res.user.role !== "admin" &&
        res.user.hospital_id &&
        res.user.hospital_id.toUpperCase() !== hospitalId.toUpperCase()
      ) {
        setError(`You are not assigned to Hospital ID ${hospitalId}`);
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

      // Handle redirect if safe and permitted for this role
      const redirect = params.redirect;
      if (redirect) {
        const canAccessDoctor = res.user.role === "doctor" && redirect.startsWith("/doctor");
        const canAccessReception = res.user.role === "receptionist" && redirect.startsWith("/receptionist");
        const canAccessOwner = (res.user.role === "owner" || res.user.role === "admin") && (redirect.startsWith("/owner") || redirect.startsWith("/admin"));
        if (canAccessDoctor || canAccessReception || canAccessOwner) {
          router.replace(redirect as any);
          return;
        }
      }

      // Default role routing
      if (res.user.role === "doctor") {
        router.replace("/doctor/dashboard");
      } else if (res.user.role === "receptionist") {
        router.replace("/receptionist/dashboard");
      } else {
        router.replace("/owner/dashboard");
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.isHtmlResponse) {
          setError("Network or server routing error. Please try again shortly.");
        } else if (e.isServerWarming) {
          setError("Server is starting up. Please wait 15 seconds and try again.");
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
            <Text style={styles.title}>{roleTitle}</Text>
            <Text style={styles.subtitle}>{hospitalName} ({hospitalId})</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Email Address</Text>
            <TextInput
              testID="staff-email-input"
              placeholder="name@hospital.com"
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
              testID="staff-password-input"
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
              testID="staff-login-btn"
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
    color: colors.brandPrimary,
    fontWeight: "600",
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
