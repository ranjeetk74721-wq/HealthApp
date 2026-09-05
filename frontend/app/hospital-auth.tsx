import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function HospitalAuth() {
  const router = useRouter();
  const params = useLocalSearchParams<{ hospitalId?: string; hospitalName?: string }>();
  const hospitalId = (params.hospitalId || "").trim().toUpperCase();
  const hospitalName = params.hospitalName || "Hospital Verification";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onVerify = async () => {
    setError(null);
    if (!email.trim() || !password.trim()) {
      setError("Hospital Email and Password are required");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/hospital/login", {
        hospital_id: hospitalId,
        email: email.trim().toLowerCase(),
        password: password
      });
      
      if (res.token) {
        await AsyncStorage.setItem("hospital_token", res.token);
        await AsyncStorage.setItem("hospital_id", hospitalId);
      }

      router.push({
        pathname: "/select-role",
        params: {
          hospitalId: hospitalId,
          hospitalName: res.hospital_name || hospitalName
        }
      });
    } catch (e: any) {
      setError(e.message || "Invalid Hospital Email or Password");
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
          <View style={styles.badge}>
            <Ionicons name="business" size={16} color={colors.brandPrimary} style={{ marginRight: 6 }} />
            <Text style={styles.badgeText}>{hospitalId}</Text>
          </View>
          <Text style={styles.title}>{hospitalName}</Text>
          <Text style={styles.subtitle}>Enter the Hospital verification credentials set by Admin</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Hospital Email</Text>
          <TextInput
            placeholder="e.g. admin@mh001.com"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            style={styles.input}
          />

          <Text style={styles.label}>Hospital Password</Text>
          <TextInput
            placeholder="••••••••"
            placeholderTextColor={colors.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={onVerify} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
            {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Verify & Continue</Text>}
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  container: { flex: 1, padding: spacing.xl },
  backWrap: { marginBottom: spacing.md },
  backBtn: { padding: spacing.xs },
  headerWrap: { alignItems: "center", marginBottom: spacing.xl },
  badge: { flexDirection: "row", alignItems: "center", backgroundColor: colors.brandSecondary + "40", paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill, marginBottom: spacing.sm },
  badgeText: { fontSize: font.sm, fontWeight: "800", color: colors.brandPrimary },
  title: { fontSize: font.xl, fontWeight: "bold", color: colors.onSurface, marginBottom: spacing.xs, textAlign: "center" },
  subtitle: { fontSize: font.sm, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.lg },
  card: { backgroundColor: colors.surface, padding: spacing.xl, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, elevation: 2 },
  label: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface, marginBottom: spacing.xs },
  input: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, marginBottom: spacing.lg },
  error: { color: colors.error, fontSize: font.sm, marginBottom: spacing.md, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.base, fontWeight: "600" },
});
