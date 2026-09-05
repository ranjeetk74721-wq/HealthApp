import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export default function HospitalId() {
  const router = useRouter();
  const [hospitalId, setHospitalId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onValidate = async () => {
    setError(null);
    if (!hospitalId.trim()) {
      setError("Please enter a Hospital ID");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post("/hospital/validate-id", { hospital_id: hospitalId.trim() });
      if (res.isAdmin) {
        router.push("/admin/login");
      } else {
        router.push({
          pathname: "/select-role",
          params: { hospitalId: res.hospital_id || hospitalId.trim().toUpperCase(), hospitalName: res.name }
        });
      }
    } catch (e: any) {
      setError(e.message || "Invalid Hospital ID");
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

        <View style={styles.logoWrap}>
          <Image source={require("../assets/images/icon.png")} style={styles.logoImg} resizeMode="contain" />
          <Text style={styles.title}>Hospital Login</Text>
          <Text style={styles.subtitle}>Enter your assigned Hospital ID to continue</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.label}>Hospital ID</Text>
          <TextInput
            placeholder="e.g. MH001"
            placeholderTextColor={colors.muted}
            value={hospitalId}
            onChangeText={setHospitalId}
            autoCapitalize="characters"
            style={styles.input}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable onPress={onValidate} disabled={loading} style={({ pressed }) => [styles.primaryBtn, pressed && { opacity: 0.8 }]}>
            {loading ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.primaryBtnText}>Continue</Text>}
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
  logoWrap: { alignItems: "center", marginBottom: spacing.xxl },
  logoImg: { width: 64, height: 64, marginBottom: spacing.md, borderRadius: radius.md },
  title: { fontSize: font.xl, fontWeight: "bold", color: colors.onSurface, marginBottom: spacing.xs },
  subtitle: { fontSize: font.sm, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.xl },
  card: { backgroundColor: colors.surface, padding: spacing.xl, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, elevation: 2 },
  label: { fontSize: font.sm, fontWeight: "600", color: colors.onSurface, marginBottom: spacing.sm },
  input: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.md, fontSize: font.base, color: colors.onSurface, marginBottom: spacing.lg },
  error: { color: colors.error, fontSize: font.sm, marginBottom: spacing.md, textAlign: "center" },
  primaryBtn: { backgroundColor: colors.brandPrimary, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: "center" },
  primaryBtnText: { color: colors.onBrandPrimary, fontSize: font.base, fontWeight: "600" },
});
