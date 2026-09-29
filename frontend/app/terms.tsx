import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BUSINESS_CONFIG } from "@/src/config/business";
import PublicFooter from "@/src/components/PublicFooter";
import { colors, spacing, radius, font } from "@/src/theme";

export default function TermsConditionsPage() {
  const router = useRouter();

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
            <Ionicons name="document-text-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.badgeText}>User Agreement</Text>
          </View>
          <Text style={styles.pageTitle}>Terms & Conditions</Text>
          <Text style={styles.leadText}>
            Please review these Terms & Conditions governing the use of the Meribaari queue tracking and appointment platform, operated by {BUSINESS_CONFIG.legalBusinessName}.
          </Text>
          <Text style={styles.metaText}>
            Last updated: February 2026 • Platform Terms of Service
          </Text>
        </View>

        {/* Draft Notice for Review */}
        <View style={styles.reviewBanner}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
          <Text style={styles.reviewText}>
            Draft for Owner Review: This draft outlines operational terms based on implemented platform capabilities. Please review with legal counsel before final publication.
          </Text>
        </View>

        {/* Section 1: Platform Role & Nature of Service */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>1. Platform Role & Limitations</Text>
          <Text style={styles.paragraph}>
            Meribaari is a digital technology platform that facilitates appointment scheduling and live queue tracking between patients and independent clinics or medical practitioners.
          </Text>
          <View style={styles.criticalNotice}>
            <Ionicons name="warning" size={18} color={colors.error} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.criticalTitle}>Not an Emergency Service</Text>
              <Text style={styles.criticalText}>
                Meribaari is strictly an appointment and queue management tool. It does NOT provide emergency medical response, clinical diagnosis, or medical treatment. In the event of a medical emergency, immediately contact local emergency services or proceed to the nearest hospital emergency room.
              </Text>
            </View>
          </View>
        </View>

        {/* Section 2: Clinic-Controlled Availability & Queue Timings */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>2. Clinic Availability & Queue Estimates</Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Clinic Control: </Text>
              All schedules, doctor consultation hours, token allocations, and daily availability are configured and managed directly by participating clinics and healthcare providers.
            </Text>
          </View>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Estimated Queue Timings: </Text>
              Waiting times and queue progression estimates displayed on the platform or sent via notifications are indicative estimations based on average consultation durations. Pacing may vary based on clinical complexity, emergencies, or doctor schedule adjustments.
            </Text>
          </View>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Token Order & Delays: </Text>
              Clinics retain full discretion to attend to critical emergencies or adjust patient calling sequence as medically required.
            </Text>
          </View>
        </View>

        {/* Section 3: User Responsibilities */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>3. User Responsibilities</Text>
          <Text style={styles.paragraph}>
            As a user of the Meribaari platform, you agree to:
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Provide accurate and truthful personal details (name, valid 10-digit mobile number) when booking appointments.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Arrive at the clinic premises in advance of your estimated token call time to ensure timely consultation.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Keep verification OTPs confidential and not share one-time authentication codes with third parties.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Treat clinic staff, receptionists, and healthcare professionals with courtesy and respect.</Text>
          </View>
        </View>

        {/* Section 4: Fees, Payments & Cancellations */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>4. Payments, Fees & Cancellations</Text>
          <Text style={styles.paragraph}>
            Platform payment and cancellation terms:
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Consultation Fees: </Text>
              Consultation charges, investigation fees, and medicine costs are determined directly by the respective healthcare provider or clinic, and are typically settled directly with the clinic.
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>No Platform Processing Fees: </Text>
              Meribaari does not directly process payment cards or levy platform convenience fees for booking appointments unless expressly stated.
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Cancellations: </Text>
              Patients unable to attend their booked consultation should notify the clinic or cancel via the app so tokens can be re-allocated to waiting patients.
            </Text>
          </View>
        </View>

        {/* Section 5: Operator Information & Contact */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>5. Operator Information</Text>
          <Text style={styles.paragraph}>
            For inquiries regarding these Terms & Conditions, please contact the operator:
          </Text>
          <View style={styles.operatorBox}>
            <Text style={styles.operatorTitle}>{BUSINESS_CONFIG.legalBusinessName}</Text>
            <Text style={styles.operatorText}>Brand: {BUSINESS_CONFIG.brandName}</Text>
            <Text style={styles.operatorText}>Address: {BUSINESS_CONFIG.address}</Text>
            <Text style={styles.operatorText}>Email: {BUSINESS_CONFIG.supportEmail}</Text>
            <Text style={styles.operatorText}>Phone: {BUSINESS_CONFIG.businessPhone}</Text>
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
  metaText: {
    fontSize: font.xs,
    color: colors.muted,
    marginTop: spacing.xs,
  },
  reviewBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.warning + "15",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warning + "40",
  },
  reviewText: {
    flex: 1,
    fontSize: font.xs,
    color: colors.warning,
    lineHeight: 18,
    fontWeight: "500",
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  sectionTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
    marginBottom: spacing.xs,
  },
  paragraph: {
    fontSize: font.sm,
    color: colors.onSurfaceSecondary,
    lineHeight: 20,
  },
  boldText: {
    fontWeight: "700",
    color: colors.onSurface,
  },
  bulletItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    paddingLeft: spacing.xs,
    paddingVertical: 2,
  },
  bulletPoint: {
    color: colors.brandPrimary,
    fontSize: font.sm,
    fontWeight: "700",
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    fontSize: font.sm,
    color: colors.onSurfaceSecondary,
    lineHeight: 20,
  },
  criticalNotice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.error + "10",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.error + "30",
    marginTop: spacing.xs,
  },
  criticalTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.error,
  },
  criticalText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
  operatorBox: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
    marginTop: spacing.xs,
  },
  operatorTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
  },
  operatorText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
});
