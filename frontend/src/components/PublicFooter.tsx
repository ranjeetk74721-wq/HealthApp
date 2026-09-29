import React from "react";
import { View, Text, StyleSheet, Pressable, Linking } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { BUSINESS_CONFIG } from "@/src/config/business";
import { colors, spacing, radius, font } from "@/src/theme";

interface PublicFooterProps {
  showBorderTop?: boolean;
}

export default function PublicFooter({ showBorderTop = true }: PublicFooterProps) {
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
    <View style={[styles.container, showBorderTop && styles.topBorder]}>
      {/* Brand & Operator */}
      <View style={styles.brandSection}>
        <View style={styles.brandRow}>
          <Ionicons name="medical" size={18} color={colors.brandPrimary} />
          <Text style={styles.brandName}>{BUSINESS_CONFIG.brandName}</Text>
        </View>
        <Text style={styles.operatorText}>
          Meribaari is operated by{" "}
          <Text style={styles.legalNameHighlight}>{BUSINESS_CONFIG.legalBusinessName}</Text>.
        </Text>
      </View>

      {/* Address & Contact Info */}
      <View style={styles.contactSection}>
        <View style={styles.contactItem}>
          <Ionicons name="location-outline" size={15} color={colors.muted} style={styles.icon} />
          <Text style={styles.contactText}>{BUSINESS_CONFIG.address}</Text>
        </View>

        <View style={styles.contactRow}>
          <Pressable
            onPress={handleOpenEmail}
            style={({ pressed }) => [styles.contactLinkBadge, pressed && { opacity: 0.7 }]}
            accessibilityRole="link"
            accessibilityLabel={`Email support at ${BUSINESS_CONFIG.supportEmail}`}
          >
            <Ionicons name="mail-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.contactLinkText}>{BUSINESS_CONFIG.supportEmail}</Text>
          </Pressable>

          <Pressable
            onPress={handleOpenPhone}
            style={({ pressed }) => [styles.contactLinkBadge, pressed && { opacity: 0.7 }]}
            accessibilityRole="link"
            accessibilityLabel={`Call support at ${BUSINESS_CONFIG.businessPhone}`}
          >
            <Ionicons name="call-outline" size={14} color={colors.brandPrimary} />
            <Text style={styles.contactLinkText}>{BUSINESS_CONFIG.businessPhone}</Text>
          </Pressable>
        </View>
      </View>

      {/* Navigation Links */}
      <View style={styles.navRow}>
        <Pressable onPress={() => router.push("/about" as any)} style={styles.navLink}>
          <Text style={styles.navLinkText}>About Us</Text>
        </Pressable>
        <Text style={styles.navDivider}>•</Text>
        <Pressable onPress={() => router.push("/contact" as any)} style={styles.navLink}>
          <Text style={styles.navLinkText}>Contact Us</Text>
        </Pressable>
        <Text style={styles.navDivider}>•</Text>
        <Pressable onPress={() => router.push("/privacy" as any)} style={styles.navLink}>
          <Text style={styles.navLinkText}>Privacy Policy</Text>
        </Pressable>
        <Text style={styles.navDivider}>•</Text>
        <Pressable onPress={() => router.push("/terms" as any)} style={styles.navLink}>
          <Text style={styles.navLinkText}>Terms & Conditions</Text>
        </Pressable>
      </View>

      {/* Copyright */}
      <View style={styles.copyrightSection}>
        <Text style={styles.copyrightText}>
          © {BUSINESS_CONFIG.copyrightYear} {BUSINESS_CONFIG.legalBusinessName}. All rights reserved.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surface,
    gap: spacing.md,
    marginTop: spacing.xl,
  },
  topBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  brandSection: {
    gap: spacing.xs,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  brandName: {
    fontSize: font.lg,
    fontWeight: "700",
    color: colors.onSurface,
  },
  operatorText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    lineHeight: 16,
  },
  legalNameHighlight: {
    fontWeight: "600",
    color: colors.onSurface,
  },
  contactSection: {
    gap: spacing.sm,
  },
  contactItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
  },
  icon: {
    marginTop: 2,
  },
  contactText: {
    fontSize: font.xs,
    color: colors.onSurfaceSecondary,
    flex: 1,
    lineHeight: 16,
  },
  contactRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  contactLinkBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  contactLinkText: {
    fontSize: font.xs,
    color: colors.brandPrimary,
    fontWeight: "500",
  },
  navRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  navLink: {
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  navLinkText: {
    fontSize: font.xs,
    color: colors.brandPrimary,
    fontWeight: "600",
  },
  navDivider: {
    color: colors.muted,
    fontSize: font.xs,
    paddingHorizontal: 2,
  },
  copyrightSection: {
    paddingTop: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  copyrightText: {
    fontSize: font.xs,
    color: colors.muted,
    lineHeight: 16,
  },
});
