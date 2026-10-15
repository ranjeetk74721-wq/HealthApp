import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export default function HospitalId() {
  const router = useRouter();
  const params = useLocalSearchParams<{ redirect?: string }>();
  const insets = useSafeAreaInsets();
  const [hospitalId, setHospitalId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onValidate = async () => {
    setError(null);
    const cleanId = hospitalId.trim();
    if (!cleanId) {
      setError("Please enter a Hospital ID");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/hospital/validate-id", { hospital_id: cleanId });

      if (res.isAdmin) {
        router.push({
          pathname: "/admin/login",
          params: params.redirect ? { redirect: params.redirect } : undefined,
        });
      } else {
        router.push({
          pathname: "/select-role",
          params: {
            hospitalId: res.hospital_id || cleanId.toUpperCase(),
            hospitalName: res.name || "Hospital Portal",
            ...(params.redirect ? { redirect: params.redirect } : {}),
          },
        });
      }
    } catch (e: any) {
      if (e instanceof ApiError) {
        if (e.isHtmlResponse) {
          setError("Network or routing error. The backend service may be temporarily unavailable.");
        } else if (e.isServerWarming) {
          setError("Backend server is starting up. Please wait 15 seconds and try again.");
        } else if (e.status === 404) {
          setError("Invalid Hospital ID. Please check the code assigned to your clinic or hospital.");
        } else {
          setError(e.message || "Failed to validate Hospital ID");
        }
      } else {
        setError(e?.message || "Unable to reach server. Please check your internet connection.");
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
          contentContainerStyle={[
            styles.scrollContent,
            { paddingBottom: Math.max(insets.bottom + 24, spacing.xxl) },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.backWrap}>
            <Pressable
              onPress={() => router.back()}
              style={styles.backBtn}
              accessibilityLabel="Go back"
              hitSlop={10}
            >
              <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
            </Pressable>
          </View>

          <View style={styles.logoWrap}>
            <Image
              source={require("../assets/images/icon.png")}
              style={styles.logoImg}
              resizeMode="contain"
            />
            <Text style={styles.title}>Hospital Portal</Text>
            <Text style={styles.subtitle}>Enter your assigned Hospital ID to continue</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Hospital ID</Text>
            <TextInput
              placeholder="e.g. MH001 or H00001"
              placeholderTextColor={colors.muted}
              value={hospitalId}
              onChangeText={(t) => {
                setHospitalId(t);
                if (error) setError(null);
              }}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={onValidate}
              style={styles.input}
            />

            {error ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle-outline" size={16} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={onValidate}
              disabled={loading}
              style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }, loading && { opacity: 0.7 }]}
            >
              {loading ? (
                <ActivityIndicator color={colors.onBrandPrimary} />
              ) : (
                <Text style={styles.primaryBtnText}>Continue to Roles</Text>
              )}
            </Pressable>
          </View>

          {/* Direct link for Platform Owner / System Admins */}
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/admin/login",
                params: params.redirect ? { redirect: params.redirect } : undefined,
              })
            }
            style={styles.adminLink}
            hitSlop={8}
          >
            <Ionicons name="shield-checkmark-outline" size={16} color={colors.brandPrimary} />
            <Text style={styles.adminLinkText}>System / Platform Admin Login</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  scrollContent: {
    padding: spacing.xl,
    maxWidth: 480,
    width: "100%",
    alignSelf: "center",
    flexGrow: 1,
    justifyContent: "center",
  },
  backWrap: {
    alignSelf: "flex-start",
    marginBottom: spacing.lg,
  },
  backBtn: {
    padding: spacing.xs,
    borderRadius: radius.sm,
  },
  logoWrap: {
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  logoImg: {
    width: 64,
    height: 64,
    marginBottom: spacing.md,
    borderRadius: radius.md,
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
    textAlign: "center",
    paddingHorizontal: spacing.lg,
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
  },
  primaryBtnText: {
    color: colors.onBrandPrimary,
    fontSize: font.base,
    fontWeight: "600",
  },
  adminLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: spacing.xl,
    paddingVertical: spacing.sm,
  },
  adminLinkText: {
    color: colors.brandPrimary,
    fontSize: font.sm,
    fontWeight: "600",
  },
});
