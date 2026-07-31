import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl, Pressable, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

const statusColor: Record<string, string> = {
  booked: colors.info,
  arrived: colors.warning,
  in_consultation: colors.brandPrimary,
  completed: colors.success,
  cancelled: colors.error,
  skipped: colors.muted,
};

export default function History() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/appointments/me");
      setItems(res);
    } catch (e) { console.log(e); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  if (loading) return <SafeAreaView style={styles.safe}><ActivityIndicator style={{ marginTop: 60 }} color={colors.brand} /></SafeAreaView>;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}><Text style={styles.title}>Appointment History</Text></View>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}>
        {items.length === 0 ? (
          <View style={styles.empty}><Ionicons name="document-text-outline" size={48} color={colors.muted} /><Text style={styles.emptyText}>No appointments yet</Text></View>
        ) : (
          items.map((a) => (
            <Pressable key={a.id} testID={`appt-${a.id}`} onPress={() => setSelected(a)} style={styles.card}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.docName}>{a.doctor_name}</Text>
                <Text style={styles.meta}>{a.date} · {a.slot} · Token #{a.token_number}</Text>
                <View style={styles.statusRow}>
                  <View style={[styles.statusPill, { backgroundColor: (statusColor[a.status] || colors.muted) + "22" }]}>
                    <Text style={[styles.statusText, { color: statusColor[a.status] || colors.muted }]}>{a.status.replace("_", " ").toUpperCase()}</Text>
                  </View>
                  {a.prescription && <View style={[styles.statusPill, { backgroundColor: colors.brandSecondary }]}><Text style={[styles.statusText, { color: colors.onBrandSecondary }]}>PRESCRIPTION</Text></View>}
                </View>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          ))
        )}
      </ScrollView>

      <Modal transparent visible={!!selected} animationType="slide" onRequestClose={() => setSelected(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setSelected(null)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            {selected && (
              <>
                <Text style={styles.sheetTitle}>{selected.doctor_name}</Text>
                <Text style={styles.sheetMeta}>{selected.date} · {selected.slot}</Text>
                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>Status</Text>
                  <Text style={styles.detailVal}>{selected.status.replace("_", " ")}</Text>
                </View>
                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>Payment</Text>
                  <Text style={styles.detailVal}>{selected.payment_method} · {selected.payment_status}</Text>
                </View>
                <View style={styles.detailBlock}>
                  <Text style={styles.detailLabel}>Token</Text>
                  <Text style={styles.detailVal}>#{selected.token_number}</Text>
                </View>
                {selected.prescription ? (
                  <View style={styles.detailBlock}>
                    <Text style={styles.detailLabel}>Prescription</Text>
                    <Text style={[styles.detailVal, { fontSize: font.base }]}>{selected.prescription}</Text>
                  </View>
                ) : null}
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceSecondary },
  header: { padding: spacing.lg, paddingBottom: spacing.sm },
  title: { fontSize: font.xl, fontWeight: "700", color: colors.onSurface },
  scroll: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxxl },
  card: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.surface, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  docName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  meta: { fontSize: font.sm, color: colors.muted },
  statusRow: { flexDirection: "row", gap: 6, marginTop: 6 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill },
  statusText: { fontSize: 10, fontWeight: "700" },
  empty: { alignItems: "center", padding: spacing.xxl, gap: spacing.md },
  emptyText: { color: colors.muted, fontSize: font.base },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.surface, padding: spacing.lg, borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: spacing.sm, paddingBottom: spacing.xxl },
  sheetHandle: { width: 40, height: 4, backgroundColor: colors.borderStrong, borderRadius: 2, alignSelf: "center", marginBottom: spacing.md },
  sheetTitle: { fontSize: font.xxl, fontWeight: "700", color: colors.onSurface },
  sheetMeta: { fontSize: font.base, color: colors.muted, marginBottom: spacing.md },
  detailBlock: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  detailLabel: { fontSize: font.sm, color: colors.muted },
  detailVal: { fontSize: font.lg, color: colors.onSurface, fontWeight: "600", marginTop: 2, textTransform: "capitalize" },
});
