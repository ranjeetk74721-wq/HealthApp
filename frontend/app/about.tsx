import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BUSINESS_CONFIG } from "@/src/config/business";
import PublicFooter from "@/src/components/PublicFooter";
import { colors, spacing, radius, font } from "@/src/theme";

export default function AboutPage() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scrollContainer} keyboardShouldPersistTaps="handled">
        {/* Header / Nav */}
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
            <Ionicons name="medical" size={14} color={colors.brandPrimary} />
            <Text style={styles.badgeText}>About the Platform</Text>
          </View>
          <Text style={styles.pageTitle}>About Meribaari</Text>
          <Text style={styles.leadText}>
            {BUSINESS_CONFIG.aboutSummary}
          </Text>
        </View>

        {/* Mission / Purpose Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="compass-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.cardTitle}>Our Purpose</Text>
          </View>
          <Text style={styles.cardBody}>
            Healthcare queues should not require hours of physical waiting in crowded clinics. Meribaari provides transparency and real-time status tracking so patients can arrive just in time for their consultation, while clinics maintain smooth, organized patient flow.
          </Text>
        </View>

        {/* Implemented Features */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="layers-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.cardTitle}>Implemented Platform Features</Text>
          </View>

          <View style={styles.featureItem}>
            <View style={styles.bulletDot} />
            <View style={styles.featureContent}>
              <Text style={styles.featureTitle}>Patient Appointment Booking</Text>
              <Text style={styles.featureDescription}>
                Simple mobile-based booking with verified phone authentication, selecting doctor schedules and allocated time slots.
              </Text>
            </View>
          </View>

          <View style={styles.featureItem}>
            <View style={styles.bulletDot} />
            <View style={styles.featureContent}>
              <Text style={styles.featureTitle}>Live Queue & Token Tracking</Text>
              <Text style={styles.featureDescription}>
                Patients receive unique token numbers and live links to follow queue progress, showing their current position, estimated time to consultation, and status updates (Booked, Arrived, In Consultation, Completed).
              </Text>
            </View>
          </View>

          <View style={styles.featureItem}>
            <View style={styles.bulletDot} />
            <View style={styles.featureContent}>
              <Text style={styles.featureTitle}>Clinic & Staff Workflow Management</Text>
              <Text style={styles.featureDescription}>
                Dedicated portals for hospital receptionists and doctors to mark arrivals, call next tokens, manage temporary breaks, handle emergencies, and record consultation completions.
              </Text>
            </View>
          </View>

          <View style={styles.featureItem}>
            <View style={styles.bulletDot} />
            <View style={styles.featureContent}>
              <Text style={styles.featureTitle}>Multi-Channel Alerts</Text>
              <Text style={styles.featureDescription}>
                Real-time appointment confirmations and queue progress notifications dispatched via SMS, WhatsApp, and push alerts.
              </Text>
            </View>
          </View>
        </View>

        {/* Intended Users */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Ionicons name="people-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.cardTitle}>Who Uses Meribaari?</Text>
          </View>

          <View style={styles.userRoleRow}>
            <Text style={styles.userRoleLabel}>Patients & Guardians:</Text>
            <Text style={styles.userRoleDesc}>
              Individuals booking appointments and monitoring live tokens to plan their clinic visit effectively.
            </Text>
          </View>

          <View style={styles.userRoleRow}>
            <Text style={styles.userRoleLabel}>Doctors & Specialists:</Text>
            <Text style={styles.userRoleDesc}>
              Healthcare professionals managing consultation queues, patient arrival rosters, and daily clinic schedules.
            </Text>
          </View>

          <View style={styles.userRoleRow}>
            <Text style={styles.userRoleLabel}>Receptionists & Staff:</Text>
            <Text style={styles.userRoleDesc}>
              Front-desk clinic personnel coordinating walk-ins, check-ins, and token calling.
            </Text>
          </View>

          <View style={styles.userRoleRow}>
            <Text style={styles.userRoleLabel}>Clinic Administrators:</Text>
            <Text style={styles.userRoleDesc}>
              Owners and managers overseeing hospital identifiers, operational queues, and clinic performance.
            </Text>
          </View>
        </View>

        {/* Legal Operator Notice */}
        <View style={[styles.card, styles.operatorCard]}>
          <View style={styles.cardHeader}>
            <Ionicons name="business-outline" size={20} color={colors.brandPrimary} />
            <Text style={styles.cardTitle}>Legal Operator</Text>
          </View>
          <Text style={styles.cardBody}>
            The Meribaari platform and associated services are owned and operated by{" "}
            <Text style={styles.boldText}>{BUSINESS_CONFIG.legalBusinessName}</Text>.
          </Text>
          <Text style={[styles.cardBody, { marginTop: spacing.xs }]}>
            Registered Address: {BUSINESS_CONFIG.address}
          </Text>
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
  operatorCard: {
    backgroundColor: colors.surfaceSecondary,
    borderColor: colors.brandTertiary,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  cardTitle: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  cardBody: {
    fontSize: font.sm,
    color: colors.onSurfaceSecondary,
    lineHeight: 20,
  },
  boldText: {
    fontWeight: "700",
    color: colors.onSurface,
  },
  featureItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.brandPrimary,
    marginTop: 8,
  },
  featureContent: {
    flex: 1,
    gap: 2,
  },
  featureTitle: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  featureDescription: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
  userRoleRow: {
    paddingVertical: spacing.xs,
    gap: 2,
  },
  userRoleLabel: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
  },
  userRoleDesc: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
});
