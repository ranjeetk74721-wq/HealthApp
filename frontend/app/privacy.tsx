import React from "react";
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { BUSINESS_CONFIG } from "@/src/config/business";
import PublicFooter from "@/src/components/PublicFooter";
import { colors, spacing, radius, font } from "@/src/theme";

export default function PrivacyPolicyPage() {
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
            <Ionicons name="shield-checkmark-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.badgeText}>Data Protection & Privacy</Text>
          </View>
          <Text style={styles.pageTitle}>Privacy Policy</Text>
          <Text style={styles.leadText}>
            This Privacy Policy describes how Meribaari, operated by {BUSINESS_CONFIG.legalBusinessName}, collects, uses, and manages information when you use our doctor appointment booking and queue tracking platform.
          </Text>
          <Text style={styles.metaText}>
            Last updated: February 2026 • Operates under Digital Personal Data Protection (DPDP) Act 2023 guidelines
          </Text>
        </View>

        {/* Draft Notice for Review */}
        <View style={styles.reviewBanner}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.warning} />
          <Text style={styles.reviewText}>
            Draft for Owner Review: This document reflects current technical features and integrations implemented in the Meribaari codebase. It does not constitute a legal certification.
          </Text>
        </View>

        {/* Section 1: Information We Collect */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>1. Information We Collect</Text>
          <Text style={styles.paragraph}>
            We collect personal information necessary to deliver appointment scheduling, queue management, and healthcare coordination:
          </Text>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Patient Profiles: </Text>
              Full name, mobile number (+91), age, gender, and residential address provided during registration or booking.
            </Text>
          </View>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Appointment & Queue Data: </Text>
              Selected doctor or clinic, appointment date/time, allocated queue token numbers, consultation status transitions (booked, arrived, in consultation, completed, skipped), and brief symptoms noted during appointment requests.
            </Text>
          </View>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Healthcare Providers: </Text>
              Doctor name, mobile number, professional degrees, specialization, clinic timings, and hospital affiliation identifiers.
            </Text>
          </View>

          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Financial Information: </Text>
              Payment card numbers, CVVs, and banking passwords are <Text style={styles.boldText}>NOT collected or stored</Text> on our servers.
            </Text>
          </View>
        </View>

        {/* Section 2: How We Use Your Information */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>2. Purpose of Processing</Text>
          <Text style={styles.paragraph}>
            Your data is processed strictly for legitimate operational purposes:
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Verifying patient identities through one-time password (OTP) verification.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Scheduling clinic visits and calculating real-time estimated queue times.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Sending booking confirmations, queue status updates, and reminder notifications.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Enabling clinic staff and doctors to prepare for consultations.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>We do not sell personal data to third parties or use medical information for advertising.</Text>
          </View>
        </View>

        {/* Section 3: Third-Party Service Providers */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>3. Third-Party Integrations</Text>
          <Text style={styles.paragraph}>
            To operate reliably, Meribaari interfaces with technical infrastructure providers:
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Push Notifications: </Text>
              Routed via Emergent Push (SuprSend) to Google Firebase Cloud Messaging (FCM) and Apple Push Notification service (APNs). Push payloads contain appointment alerts and user identifiers, without transmitting comprehensive clinical records.
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>SMS & WhatsApp Communications: </Text>
              Transactional OTPs and appointment updates are delivered via telecommunication partners (such as AiSensy for WhatsApp, LiveAir, Renflair, or Brevo).
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Hosting & Database: </Text>
              Application servers and database instances are securely hosted on cloud infrastructure with encrypted connections.
            </Text>
          </View>
        </View>

        {/* Section 4: Data Security & Access Controls */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>4. Technical Data Security</Text>
          <Text style={styles.paragraph}>
            We implement standard technical safeguards to protect personal data:
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>All communications between clients and the server occur over HTTPS/TLS encryption.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Account authentication tokens are securely encrypted and passwords/PINs are hashed using bcrypt.</Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>Role-based access controls ensure that appointment data is accessible only to the patient, consulting doctor, clinic receptionist, and clinic administrator.</Text>
          </View>
          <Text style={[styles.paragraph, styles.disclaimerNote]}>
            Note: While we apply strict security controls, no internet-based transmission is completely invulnerable; users are encouraged to maintain confidentiality of their login devices.
          </Text>
        </View>

        {/* Section 5: User Rights & DPDP Act 2023 */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>5. Your Rights & Data Controls</Text>
          <Text style={styles.paragraph}>
            In accordance with the Digital Personal Data Protection Act, 2023 (DPDP):
          </Text>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Right to Access & Portability: </Text>
              Patients can review their account profile and request a JSON export of their stored personal and appointment history via in-app data export controls.
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Right to Correction & Erasure: </Text>
              Users may update incorrect profile details or request account deletion. Upon deletion, personally identifying information is erased or anonymised, subject to statutory healthcare record retention rules.
            </Text>
          </View>
          <View style={styles.bulletItem}>
            <Text style={styles.bulletPoint}>•</Text>
            <Text style={styles.bulletText}>
              <Text style={styles.boldText}>Minors: </Text>
              Direct self-registration by minors without guardian oversight is restricted. Guardians may schedule appointments on behalf of family members.
            </Text>
          </View>
        </View>

        {/* Section 6: Grievance Officer & Contact */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>6. Grievance Redressal</Text>
          <Text style={styles.paragraph}>
            For questions, concerns, or grievances regarding this privacy policy or your personal data, contact:
          </Text>
          <View style={styles.grievanceBox}>
            <Text style={styles.grievanceTitle}>Grievance Officer</Text>
            <Text style={styles.grievanceText}>Meribaari / {BUSINESS_CONFIG.legalBusinessName}</Text>
            <Text style={styles.grievanceText}>Email: {BUSINESS_CONFIG.supportEmail}</Text>
            <Text style={styles.grievanceText}>Address: {BUSINESS_CONFIG.address}</Text>
            <Text style={styles.grievanceText}>Phone: {BUSINESS_CONFIG.businessPhone}</Text>
            <Text style={[styles.grievanceText, { marginTop: spacing.xs, color: colors.muted }]}>
              Response SLA: Inquiries are acknowledged and addressed within 30 days as stipulated under DPDP Act provisions.
            </Text>
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
  disclaimerNote: {
    fontStyle: "italic",
    color: colors.muted,
    marginTop: spacing.xs,
  },
  grievanceBox: {
    backgroundColor: colors.surfaceSecondary,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
    marginTop: spacing.xs,
  },
  grievanceTitle: {
    fontSize: font.sm,
    fontWeight: "700",
    color: colors.onSurface,
  },
  grievanceText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 18,
  },
});
