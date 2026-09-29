import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, Linking } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BUSINESS_CONFIG } from "@/src/config/business";
import PublicFooter from "@/src/components/PublicFooter";
import { colors, spacing, radius, font } from "@/src/theme";

export default function ContactPage() {
  const router = useRouter();

  const handleOpenEmail = () => {
    if (BUSINESS_CONFIG.supportEmail && !BUSINESS_CONFIG.supportEmail.startsWith("[")) {
      Linking.openURL(BUSINESS_CONFIG.mailtoLink).catch(() => {});
    }
  };

  const handleOpenPhone = () => {
    if (BUSINESS_CONFIG.businessPhone && !BUSINESS_CONFIG.businessPhone.startsWith("[")) {
      Linking.openURL(BUSINESS_CONFIG.telLink).catch(() => {});
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled">
        {/* Navigation */}
        <View style={styles.topNav}>
          <Pressable
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/login" as any))}
            style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={20} color={colors.brandPrimary} />
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
          <Pressable
            onPress={() => router.replace("/login" as any)}
            style={({ pressed }) => [styles.loginNavBtn, pressed && { opacity: 0.8 }]}
            accessibilityRole="link"
            accessibilityLabel="Go to Login"
          >
            <Ionicons name="log-in-outline" size={18} color={colors.brandPrimary} />
            <Text style={styles.loginNavBtnText}>Login</Text>
          </Pressable>
        </View>

        {/* Hero Section */}
        <View style={styles.heroSection}>
          <View style={styles.badge}>
            <Ionicons name="headset-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.badgeText}>Support & Inquiries</Text>
          </View>
          <Text style={styles.pageTitle}>Contact Us</Text>
          <Text style={styles.leadText}>
            Get in touch with the Meribaari support team for assistance with appointments, clinic onboarding, or technical questions.
          </Text>
        </View>

        {/* Contact Cards */}
        <View style={styles.cardsContainer}>
          {/* Email Support Card */}
          <View style={styles.contactCard}>
            <View style={styles.iconCircle}>
              <Ionicons name="mail" size={24} color={colors.brandPrimary} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardLabel}>Support Email</Text>
              <Text style={styles.cardDetail}>For general inquiries, technical support, and account assistance</Text>
              <Pressable
                onPress={handleOpenEmail}
                style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.8 }]}
                accessibilityRole="link"
                accessibilityLabel={`Send email to ${BUSINESS_CONFIG.supportEmail}`}
              >
                <Ionicons name="mail-outline" size={16} color={colors.onBrandPrimary} />
                <Text style={styles.actionButtonText}>{BUSINESS_CONFIG.supportEmail}</Text>
              </Pressable>
            </View>
          </View>

          {/* Phone Support Card */}
          <View style={styles.contactCard}>
            <View style={styles.iconCircle}>
              <Ionicons name="call" size={24} color={colors.brandPrimary} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardLabel}>Phone Helpline</Text>
              <Text style={styles.cardDetail}>Speak directly with our support desk</Text>
              <Pressable
                onPress={handleOpenPhone}
                style={({ pressed }) => [styles.actionButton, pressed && { opacity: 0.8 }]}
                accessibilityRole="link"
                accessibilityLabel={`Call ${BUSINESS_CONFIG.businessPhone}`}
              >
                <Ionicons name="call-outline" size={16} color={colors.onBrandPrimary} />
                <Text style={styles.actionButtonText}>{BUSINESS_CONFIG.businessPhone}</Text>
              </Pressable>
            </View>
          </View>

          {/* Postal / Office Address Card */}
          <View style={styles.contactCard}>
            <View style={styles.iconCircle}>
              <Ionicons name="business" size={24} color={colors.brandPrimary} />
            </View>
            <View style={styles.cardContent}>
              <Text style={styles.cardLabel}>Office & Registered Address</Text>
              <Text style={styles.cardDetail}>Operated by {BUSINESS_CONFIG.legalBusinessName}</Text>
              <View style={styles.addressBox}>
                <Ionicons name="location" size={16} color={colors.brandPrimary} style={{ marginTop: 2 }} />
                <Text style={styles.addressText}>{BUSINESS_CONFIG.address}</Text>
              </View>
            </View>
          </View>

          {/* Response Expectations */}
          <View style={styles.infoBox}>
            <Ionicons name="information-circle-outline" size={20} color={colors.brandPrimary} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.infoTitle}>Response Times</Text>
              <Text style={styles.infoText}>
                Support inquiries via email are typically addressed within 1–2 business days. For urgent queue discrepancies at a clinic, please notify the clinic reception desk directly.
              </Text>
            </View>
          </View>
        </View>

        {/* Public Business Footer */}
        <PublicFooter showBorderTop={true} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
  },
  scrollContainer: {
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  topNav: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radius.sm,
  },
  backBtnText: {
    color: colors.brandPrimary,
    fontSize: font.base,
    fontWeight: "600",
  },
  loginNavBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.brandSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.brandTertiary,
  },
  loginNavBtnText: {
    color: colors.brandPrimary,
    fontSize: font.sm,
    fontWeight: "600",
  },
  heroSection: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.brandSecondary,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  badgeText: {
    fontSize: font.xs,
    color: colors.brandPrimary,
    fontWeight: "600",
  },
  pageTitle: {
    fontSize: font.xxl,
    fontWeight: "800",
    color: colors.onSurface,
    marginTop: spacing.xs,
  },
  leadText: {
    fontSize: font.base,
    color: colors.onSurfaceSecondary,
    lineHeight: 22,
    marginTop: spacing.xs,
  },
  cardsContainer: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    gap: spacing.md,
  },
  contactCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brandSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  cardContent: {
    flex: 1,
    gap: spacing.xs,
  },
  cardLabel: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  cardDetail: {
    fontSize: font.xs,
    color: colors.muted,
    lineHeight: 16,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    backgroundColor: colors.brandPrimary,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    marginTop: spacing.xs,
  },
  actionButtonText: {
    color: colors.onBrandPrimary,
    fontSize: font.sm,
    fontWeight: "600",
  },
  addressBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 6,
    marginTop: spacing.xs,
    padding: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
  },
  addressText: {
    flex: 1,
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
  infoBox: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.brandSecondary + "40",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.brandTertiary,
  },
  infoTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.brandPrimary,
  },
  infoText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
});
