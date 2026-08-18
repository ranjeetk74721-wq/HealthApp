import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { api } from "@/src/api/client";
import { colors, spacing, font, radius } from "@/src/theme";

export default function PrivacyNotice() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/privacy-notice");
        setNotice(r);
      } catch (e: any) {
        setError("Failed to load privacy notice");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surfaceSecondary }}>
      <View style={{ padding: spacing.lg }}>
        <Pressable onPress={() => router.back()} style={{ marginBottom: spacing.md }}>
          <Text style={{ color: colors.brandPrimary }}>Back</Text>
        </Pressable>
        <Text style={{ fontSize: font.xl, fontWeight: "700", marginBottom: spacing.sm }}>Privacy Notice</Text>
        {loading ? (
          <ActivityIndicator />
        ) : error ? (
          <Text style={{ color: colors.error }}>{error}</Text>
        ) : (
          <ScrollView style={{ maxHeight: '80%' }}>
            <Text style={{ fontWeight: "700", marginBottom: spacing.sm }}>{notice.version}</Text>
            {notice.sections && notice.sections.map((s: any, i: number) => (
              <View key={i} style={{ marginBottom: spacing.md }}>
                <Text style={{ fontWeight: "600", marginBottom: spacing.xs }}>{s.title}</Text>
                <Text style={{ color: colors.onSurface }}>{s.body}</Text>
              </View>
            ))}
          </ScrollView>
        )}
      </View>
    </SafeAreaView>
  );
}
