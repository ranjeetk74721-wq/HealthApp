import { View, Text, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { colors, spacing, radius, font } from "@/src/theme";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export default function SelectRole() {
  const router = useRouter();
  const params = useLocalSearchParams<{ hospitalId?: string; hospitalName?: string }>();
  const hospitalId = (params.hospitalId || "").trim().toUpperCase();
  const hospitalName = params.hospitalName || "Hospital Portal";

  const onSelect = (role: "doctor" | "receptionist") => {
    router.push({
      pathname: "/staff-login",
      params: {
        role,
        hospitalId,
        hospitalName
      }
    });
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
            <Ionicons name="checkmark-circle" size={16} color={colors.success} style={{ marginRight: 6 }} />
            <Text style={styles.badgeText}>Verified: {hospitalId}</Text>
          </View>
          <Text style={styles.title}>{hospitalName}</Text>
          <Text style={styles.subtitle}>Select your staff role to proceed with login</Text>
        </View>

        <View style={styles.cardsWrap}>
          {/* Doctor Role Card */}
          <Pressable
            onPress={() => onSelect("doctor")}
            style={({ pressed }) => [styles.roleCard, pressed && { transform: [{ scale: 0.98 }] }]}
          >
            <View style={[styles.iconWrap, { backgroundColor: colors.brandPrimary + "15" }]}>
              <Ionicons name="medkit" size={32} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.roleTitle}>Doctor</Text>
              <Text style={styles.roleDesc}>Access your patient queue, medical records, and manage reception staff.</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.muted} />
          </Pressable>

          {/* Receptionist Role Card */}
          <Pressable
            onPress={() => onSelect("receptionist")}
            style={({ pressed }) => [styles.roleCard, pressed && { transform: [{ scale: 0.98 }] }]}
          >
            <View style={[styles.iconWrap, { backgroundColor: colors.info + "15" }]}>
              <Ionicons name="clipboard" size={32} color={colors.info} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.roleTitle}>Receptionist</Text>
              <Text style={styles.roleDesc}>Handle patient check-ins, issue tokens, and manage doctor queue schedules.</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.muted} />
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
  headerWrap: { alignItems: "center", marginBottom: spacing.xxl },
  badge: { flexDirection: "row", alignItems: "center", backgroundColor: colors.success + "20", paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radius.pill, marginBottom: spacing.sm },
  badgeText: { fontSize: font.sm, fontWeight: "700", color: colors.success },
  title: { fontSize: font.xl, fontWeight: "bold", color: colors.onSurface, marginBottom: spacing.xs, textAlign: "center" },
  subtitle: { fontSize: font.sm, color: colors.muted, textAlign: "center", paddingHorizontal: spacing.lg },
  cardsWrap: { gap: spacing.lg },
  roleCard: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surface, padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, elevation: 2, gap: spacing.md },
  iconWrap: { width: 56, height: 56, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  roleTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface, marginBottom: 4 },
  roleDesc: { fontSize: font.sm, color: colors.muted, lineHeight: 18 },
});
