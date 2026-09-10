import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator, Image } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";
import { isFirebaseConfigured, sendFirebasePhoneOtp } from "@/src/firebase";

export default function Login() {
  const router = useRouter();
  const params = useLocalSearchParams<{ redirect?: string }>();

  const [mobile, setMobile] = useState("");
  const [sendingOtp, setSendingOtp] = useState(false);
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
      const fullNumber = `+91${clean}`;
      const otpParams: any = {
        mobile: fullNumber,
        is_registered: "0",
        use_firebase: "1",
      };
      if (params.redirect) {
        otpParams.redirect = params.redirect;
      }

      if (isFirebaseConfigured()) {
        await sendFirebasePhoneOtp(fullNumber);
        router.push({ pathname: "/otp", params: otpParams } as any);
      } else {
        const res = await api.post("/auth/send-otp", { mobile: clean });
        otpParams.mobile = res.mobile;
        otpParams.is_registered = res.is_registered ? "1" : "0";
        otpParams.use_firebase = "0";
        router.push({ pathname: "/otp", params: otpParams } as any);
      }
    } catch (e: any) {
      setError(e.message || "Failed to send OTP");
    } finally {
      setSendingOtp(false);
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

          <Pressable onPress={() => router.push('/hospital-id')} style={styles.staffBtn}>
            <Ionicons name="briefcase-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.staffBtnText}>Hospital Staff Login</Text>
          </Pressable>

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
  brandName: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  tagline: { fontSize: font.base, color: colors.muted, marginTop: spacing.xs },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  subtitle: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: spacing.xs, fontWeight: "500" },
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
  staffBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: spacing.xl, padding: spacing.md, backgroundColor: colors.brandPrimary + "15", borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandPrimary + "30" },
  staffBtnText: { color: colors.brandPrimary, fontWeight: "600", fontSize: font.base, marginLeft: spacing.sm },
});
