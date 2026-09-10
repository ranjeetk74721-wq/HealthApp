import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, spacing, radius, font } from "@/src/theme";
import { formatExpectedTimeRange } from "@/src/utils/timeFormat";

interface AppointmentSmsPreviewProps {
  hospitalName?: string;
  doctorName?: string;
  tokenNumber?: number | string;
  expectedTime?: string;
  liveQueueLink?: string;
}

/**
 * In-app preview of the appointment confirmation message.
 * Adheres to medium/intermediate emphasis on the Hindi instruction line.
 */
export function AppointmentSmsPreview({
  hospitalName = "Hospital",
  doctorName = "Doctor",
  tokenNumber = "1",
  expectedTime = "2:00 PM – 2:30 PM",
  liveQueueLink = "https://meribaari.com/queue/track/sample",
}: AppointmentSmsPreviewProps) {
  const formattedTime = formatExpectedTimeRange(expectedTime);

  return (
    <View style={styles.container}>
      <Text style={styles.hospitalName}>{hospitalName}</Text>
      
      {/* Hindi instruction with medium / intermediate emphasis */}
      <Text style={styles.hindiInstruction}>
        आपका नंबर कब आएगा देखने के लिए लिंक पर क्लिक करें:
      </Text>
      
      <Text style={styles.linkText} numberOfLines={1}>
        {liveQueueLink}
      </Text>
      
      <Text style={styles.doctorName}>Dr. {doctorName}</Text>
      
      <Text style={styles.tokenMeta}>
        Token: #{tokenNumber} | Time: {formattedTime}
      </Text>
      
      <Text style={styles.closing}>Thank you</Text>
      <Text style={styles.branding}>-MeriBaari</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: "#F8FAFC",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: "#E2E8F0",
    padding: spacing.md,
    gap: 6,
  },
  hospitalName: {
    fontSize: font.base,
    fontWeight: "700",
    color: colors.onSurface,
  },
  // Medium / intermediate emphasis rule (font-weight: 500/600, clear & balanced)
  hindiInstruction: {
    fontSize: font.sm,
    fontWeight: "600",
    color: "#0F172A",
    lineHeight: 20,
  },
  linkText: {
    fontSize: font.sm,
    color: colors.brandPrimary,
    textDecorationLine: "underline",
  },
  doctorName: {
    fontSize: font.sm,
    fontWeight: "600",
    color: colors.onSurface,
    marginTop: 2,
  },
  tokenMeta: {
    fontSize: font.sm,
    fontWeight: "500",
    color: colors.onSurfaceSecondary,
  },
  closing: {
    fontSize: font.xs,
    color: colors.muted,
    marginTop: 4,
  },
  branding: {
    fontSize: font.xs,
    fontWeight: "600",
    color: colors.muted,
  },
});
