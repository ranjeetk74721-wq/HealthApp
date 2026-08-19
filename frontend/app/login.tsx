import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Image } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

type Tab = "patient" | "staff";

export default function Login() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [tab, setTab] = useState<Tab>("patient");

  // Patient tab (mobile OTP)
  const [mobile, setMobile] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);

  // Staff tab (email + password)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const onSendOtp = async () => {
    setError(null);
    const clean = mobile.replace(/[^0-9]/g, "");
    if (clean.length < 10) {
      setError("Please enter a valid 10-digit mobile number");
      return;
    }
    setSendingOtp(true);
    try {
      const res = await api.post("/auth/send-otp", { mobile: clean });
      router.push({ pathname: "/otp", params: { mobile: res.mobile, is_registered: res.is_registered ? "1" : "0", dev_otp: res.dev_otp || "" } } as any);
    } catch (e: any) {
      setError(e.message || "Failed to send OTP");
    } finally {
      setSendingOtp(false);
    }
  };

  const onStaffLogin = async () => {
    setError(null);
    if (!email || !password) {
      setError("Please enter email and password");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/auth/login", { email: email.trim().toLowerCase(), password });
      if (res.user.role === "patient") {
        setError("Patients must login using mobile OTP. Please switch tabs.");
        setLoading(false);
        return;
      }
      await signIn(res.access_token, res.user);
      const role = res.user.role;
      router.replace(
        role === "doctor" ? "/doctor/dashboard"
        : role === "owner" ? "/owner/dashboard"
        : "/receptionist/dashboard"
      );
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
            <Image source={require("../assets/images/icon.png")} style={styles.logoImg} resizeMode="contain" />
            <Text style={styles.brandName}>Meribaari</Text>
            <Text style={styles.tagline}>Meri baari — skip the wait.</Text>
          </View>

          <View style={styles.tabsRow}>
            <Pressable
              testID="tab-patient"
              onPress={() => { setTab("patient"); setError(null); }}
              style={[styles.tab, tab === "patient" && styles.tabActive]}
            >
              <Ionicons name="person" size={16} color={tab === "patient" ? colors.onBrandPrimary : colors.muted} />
              <Text style={[styles.tabText, tab === "patient" && styles.tabTextActive]}>Patient</Text>
            </Pressable>
            <Pressable
              testID="tab-staff"
              onPress={() => { setTab("staff"); setError(null); }}
              style={[styles.tab, tab === "staff" && styles.tabActive]}
            >
              <Ionicons name="briefcase" size={16} color={tab === "staff" ? colors.onBrandPrimary : colors.muted} />
              <Text style={[styles.tabText, tab === "staff" && styles.tabTextActive]}>Doctor / Reception</Text>
            </Pressable>
          </View>

          {tab === "patient" ? (
            <View style={styles.card}>
              <Text style={styles.title}>Login with Mobile</Text>
              <Text style={styles.subtitle}>We&apos;ll send an OTP to verify your number</Text>

              <Text style={styles.label}>Mobile Number</Text>
              <View style={styles.mobileWrap}>
                <View style={styles.ccBadge}><Text style={styles.ccText}>+91</Text></View>
                <TextInput
                  testID="login-mobile-input"
                  placeholder="98765 43210"
                  placeholderTextColor={colors.muted}
                  value={mobile}
                  onChangeText={(t) => setMobile(t.replace(/[^0-9]/g, "").slice(0, 10))}
                  keyboardType="phone-pad"
                  style={styles.mobileInput}
                  maxLength={10}
                />
              </View>

              {error ? <Text testID="login-error" style={styles.error}>{error}</Text> : null}

              <Pressable testID="send-otp-btn" onPress={onSendOtp} disabled={sendingOtp} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                {sendingOtp ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Send OTP</Text>}
              </Pressable>

              <View style={styles.hintBox}>
                <Ionicons name="information-circle" size={16} color={colors.brandPrimary} />
                <Text style={styles.hintText}>New here? Just enter your mobile — we&apos;ll set up your profile after OTP.</Text>
              </View>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.title}>Staff Login</Text>
              <Text style={styles.subtitle}>For doctors and receptionists</Text>

              <Text style={styles.label}>Email</Text>
              <TextInput
                testID="login-email-input"
                placeholder="you@clinic.com"
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

              {error ? <Text testID="login-error" style={styles.error}>{error}</Text> : null}

              <Pressable testID="login-submit-button" onPress={onStaffLogin} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Sign In</Text>}
              </Pressable>
            </View>
          )}

          <View style={styles.demoBox} testID="demo-credentials">
            <Text style={styles.demoTitle}>Demo accounts</Text>
            {tab === "staff" ? (
              <>
                <Text style={styles.demoText}>Owner: owner@meribaari.com / owner123</Text>
                <Text style={styles.demoText}>Doctor: drrajeshkumar@clinic.com / doctor123</Text>
                <Text style={styles.demoText}>Reception: reception@clinic.com / reception123</Text>
              </>
            ) : (
              <>
                <Text style={styles.demoText}>Enter any 10-digit mobile</Text>
                <Text style={styles.demoText}>Use OTP: 123456 (dev mode)</Text>
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
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  logoWrap: { alignItems: "center", marginTop: spacing.lg, marginBottom: spacing.md },
  logoImg: { width: 96, height: 96, borderRadius: 20, marginBottom: spacing.md },
  logoCircle: { width: 84, height: 84, borderRadius: radius.pill, backgroundColor: colors.brandPrimary, alignItems: "center", justifyContent: "center", marginBottom: spacing.md },
  brandName: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  tagline: { fontSize: font.base, color: colors.muted, marginTop: spacing.xs },
  tabsRow: { flexDirection: "row", backgroundColor: colors.surface, borderRadius: radius.pill, padding: 4, borderWidth: 1, borderColor: colors.border, gap: 4 },
  tab: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 6, paddingVertical: 10, borderRadius: radius.pill },
  tabActive: { backgroundColor: colors.brandPrimary },
  tabText: { fontSize: font.sm, fontWeight: "600", color: colors.muted },
  tabTextActive: { color: colors.onBrandPrimary },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: spacing.xs, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: font.lg, color: colors.onSurface, backgroundColor: colors.surface },
  mobileWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surface, overflow: "hidden" },
  ccBadge: { paddingHorizontal: spacing.md, paddingVertical: 14, backgroundColor: colors.surfaceSecondary, borderRightWidth: 1, borderRightColor: colors.border },
  ccText: { fontSize: font.lg, color: colors.onSurface, fontWeight: "600" },
  mobileInput: { flex: 1, paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: font.lg, color: colors.onSurface, letterSpacing: 1 },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.base },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
  hintBox: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginTop: spacing.md, padding: spacing.md, backgroundColor: colors.brandSecondary, borderRadius: radius.md },
  hintText: { flex: 1, fontSize: font.sm, color: colors.onBrandSecondary, lineHeight: 18 },
  demoBox: { backgroundColor: colors.brandSecondary, padding: spacing.md, borderRadius: radius.md, gap: 4 },
  demoTitle: { color: colors.onBrandSecondary, fontWeight: "700", fontSize: font.base, marginBottom: spacing.xs },
  demoText: { color: colors.onBrandSecondary, fontSize: font.sm },
});
