import { useEffect, useRef, useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "@/src/context/AuthContext";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";

const GENDERS = ["Male", "Female", "Other"];

export default function OtpScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ mobile: string; is_registered: string; dev_otp: string }>();
  const { signIn } = useAuth();
  const mobile = params.mobile as string;
  const isRegistered = params.is_registered === "1";

  const [otp, setOtp] = useState<string[]>(["", "", "", "", "", ""]);
  const inputs = useRef<Array<TextInput | null>>([]);
  const [step, setStep] = useState<"otp" | "profile">("otp");
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [gender, setGender] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCount, setResendCount] = useState(30);
  const [devOtp, setDevOtp] = useState<string>((params.dev_otp as string) || "");

  useEffect(() => {
    if (resendCount <= 0) return;
    const t = setTimeout(() => setResendCount((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCount]);

  const handleChange = (idx: number, val: string) => {
    const cleaned = val.replace(/[^0-9]/g, "").slice(-1);
    const next = [...otp];
    next[idx] = cleaned;
    setOtp(next);
    if (cleaned && idx < 5) inputs.current[idx + 1]?.focus();
  };

  const handleBackspace = (idx: number, key: string) => {
    if (key === "Backspace" && !otp[idx] && idx > 0) inputs.current[idx - 1]?.focus();
  };

  const otpString = otp.join("");

  const autofillDevOtp = () => {
    const code = devOtp || "123456";
    setOtp(code.split(""));
    setTimeout(() => inputs.current[5]?.focus(), 50);
  };

  const onVerify = async () => {
    setError(null);
    if (otpString.length !== 6) {
      setError("Please enter the full 6-digit OTP");
      return;
    }
    // If new user, need to collect profile first
    if (!isRegistered && step === "otp") {
      setStep("profile");
      return;
    }
    setLoading(true);
    try {
      const body: any = { mobile, otp: otpString };
      if (!isRegistered) {
        if (!name.trim()) throw new Error("Full name is required");
        body.full_name = name.trim();
        body.age = age ? parseInt(age, 10) : undefined;
        body.gender = gender;
        body.address = address || undefined;
      }
      const res = await api.post("/auth/verify-otp", body);
      await signIn(res.access_token, res.user);
      router.replace("/patient/home");
    } catch (e: any) {
      setError(e.message || "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const onResend = async () => {
    setError(null);
    setResendCount(30);
    try {
      const res = await api.post("/auth/send-otp", { mobile });
      setDevOtp(res.dev_otp || "");
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()} testID="otp-back" style={styles.back}>
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
          </Pressable>

          {step === "otp" ? (
            <>
              <View style={styles.iconWrap}>
                <View style={styles.iconCircle}>
                  <Ionicons name="chatbubble-ellipses" size={36} color={colors.brandPrimary} />
                </View>
              </View>
              <Text style={styles.title}>Verify OTP</Text>
              <Text style={styles.subtitle}>Sent to {mobile}</Text>

              <View style={styles.otpRow}>
                {otp.map((v, i) => (
                  <TextInput
                    key={i}
                    ref={(el) => { inputs.current[i] = el; }}
                    testID={`otp-input-${i}`}
                    value={v}
                    onChangeText={(t) => handleChange(i, t)}
                    onKeyPress={(e) => handleBackspace(i, e.nativeEvent.key)}
                    keyboardType="number-pad"
                    maxLength={1}
                    style={[styles.otpBox, v && styles.otpBoxFilled]}
                  />
                ))}
              </View>

              {devOtp ? (
                <Pressable testID="autofill-otp" onPress={autofillDevOtp} style={styles.devHint}>
                  <Ionicons name="flash" size={14} color={colors.warning} />
                  <Text style={styles.devHintText}>Dev OTP: {devOtp} (tap to autofill)</Text>
                </Pressable>
              ) : null}

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable testID="verify-otp-btn" onPress={onVerify} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : (
                  <Text style={styles.primaryBtnText}>{isRegistered ? "Verify & Sign In" : "Verify & Continue"}</Text>
                )}
              </Pressable>

              <View style={styles.resendRow}>
                {resendCount > 0 ? (
                  <Text style={styles.resendText}>Resend OTP in {resendCount}s</Text>
                ) : (
                  <Pressable testID="resend-otp-btn" onPress={onResend}>
                    <Text style={styles.resendLink}>Resend OTP</Text>
                  </Pressable>
                )}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.title}>Complete Your Profile</Text>
              <Text style={styles.subtitle}>Tell us a bit about you</Text>

              <Text style={styles.label}>Full Name*</Text>
              <TextInput testID="profile-name-input" placeholder="Your name" placeholderTextColor={colors.muted} value={name} onChangeText={setName} style={styles.input} />

              <Text style={styles.label}>Age</Text>
              <TextInput testID="profile-age-input" placeholder="e.g. 32" placeholderTextColor={colors.muted} value={age} onChangeText={(t) => setAge(t.replace(/[^0-9]/g, "").slice(0, 3))} keyboardType="number-pad" style={styles.input} />

              <Text style={styles.label}>Gender</Text>
              <View style={styles.genderRow}>
                {GENDERS.map((g) => (
                  <Pressable
                    key={g}
                    testID={`gender-${g}`}
                    onPress={() => setGender(g)}
                    style={[styles.genderChip, gender === g && styles.genderChipActive]}
                  >
                    <Text style={[styles.genderText, gender === g && { color: colors.onBrandPrimary }]}>{g}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.label}>Address</Text>
              <TextInput
                testID="profile-address-input"
                placeholder="City, area..."
                placeholderTextColor={colors.muted}
                value={address}
                onChangeText={setAddress}
                multiline
                style={[styles.input, { minHeight: 60, textAlignVertical: "top" }]}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <Pressable testID="complete-signup-btn" onPress={onVerify} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
                {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Create Account</Text>}
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxxl },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -8 },
  iconWrap: { alignItems: "center", marginTop: spacing.md, marginBottom: spacing.md },
  iconCircle: { width: 80, height: 80, borderRadius: radius.pill, backgroundColor: colors.brandSecondary, alignItems: "center", justifyContent: "center" },
  title: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface, textAlign: "center" },
  subtitle: { fontSize: font.base, color: colors.muted, textAlign: "center", marginBottom: spacing.md },
  otpRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm, marginVertical: spacing.md, paddingHorizontal: spacing.md },
  otpBox: { flex: 1, aspectRatio: 1, maxWidth: 50, borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md, textAlign: "center", fontSize: font.xxl, fontWeight: "700", color: colors.onSurface, backgroundColor: colors.surface },
  otpBoxFilled: { borderColor: colors.brandPrimary, backgroundColor: colors.brandSecondary },
  devHint: { flexDirection: "row", alignItems: "center", gap: 6, justifyContent: "center", padding: spacing.sm, backgroundColor: colors.warning + "22", borderRadius: radius.md },
  devHintText: { fontSize: font.sm, color: colors.warning, fontWeight: "600" },
  error: { color: colors.error, marginTop: spacing.sm, fontSize: font.base, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, borderRadius: radius.md, padding: spacing.lg, alignItems: "center", marginTop: spacing.lg, minHeight: 52, justifyContent: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.lg, fontWeight: "600" },
  resendRow: { alignItems: "center", marginTop: spacing.md, padding: spacing.sm },
  resendText: { color: colors.muted, fontSize: font.base },
  resendLink: { color: colors.brandPrimary, fontSize: font.base, fontWeight: "600" },
  label: { fontSize: font.sm, color: colors.onSurfaceSecondary, marginTop: spacing.sm, marginBottom: spacing.xs, fontWeight: "500" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: 14, fontSize: font.lg, color: colors.onSurface, backgroundColor: colors.surface },
  genderRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  genderChip: { flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  genderChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  genderText: { fontSize: font.base, color: colors.onSurface, fontWeight: "500" },
});
