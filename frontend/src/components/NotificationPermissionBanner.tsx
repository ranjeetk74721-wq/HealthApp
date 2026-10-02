import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font } from "@/src/theme";
import {
  getNotificationPermissionState,
  subscribeToPushNotifications,
  unsubscribeFromPushNotifications,
  PushPermissionStatus,
  PUSH_TOKEN_KEY,
} from "@/src/utils/pushNotifications";
import AsyncStorage from "@react-native-async-storage/async-storage";

const PUSH_DISMISSED_KEY = "cq_push_dismissed";

interface Props {
  appointmentId?: string;
  appointmentToken?: string;
  compact?: boolean;
  onSubscribed?: (token: string) => void;
}

export default function NotificationPermissionBanner({
  appointmentId,
  appointmentToken,
  compact = false,
  onSubscribed,
}: Props) {
  const [status, setStatus] = useState<PushPermissionStatus>("default");
  const [loading, setLoading] = useState(false);
  const [infoMsg, setInfoMsg] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkStatus = useCallback(async () => {
    if (Platform.OS !== "web" || typeof window === "undefined") {
      setStatus("unsupported");
      return;
    }
    const isDismissed = await AsyncStorage.getItem(PUSH_DISMISSED_KEY);
    if (isDismissed === "true") {
      setDismissed(true);
    }
    const perm = getNotificationPermissionState();
    const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);

    // If browser granted and token is cached, status is granted
    if (perm === "granted" && cachedToken) {
      setStatus("granted");
    } else if (perm === "granted" && !cachedToken) {
      // Permission granted in browser but not registered in this app session yet
      setStatus("default");
    } else {
      setStatus(perm);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleDismiss = async () => {
    setDismissed(true);
    try {
      await AsyncStorage.setItem(PUSH_DISMISSED_KEY, "true");
    } catch {
      // ignore
    }
  };

  const handleEnableNotifications = async () => {
    setLoading(true);
    setInfoMsg(null);
    try {
      const res = await subscribeToPushNotifications({
        appointmentId,
        appointmentToken,
      });

      if (res.ok && res.token) {
        setStatus("granted");
        setInfoMsg("✓ नोटिफिकेशन सक्रिय हो गए हैं! (Notifications enabled)");
        if (onSubscribed) onSubscribed(res.token);
      } else {
        setStatus(res.status);
        if (res.error) setInfoMsg(res.error);
      }
    } catch (err: any) {
      setInfoMsg(err?.message || "Failed to enable notifications");
    } finally {
      setLoading(false);
    }
  };

  const handleDisableNotifications = async () => {
    setLoading(true);
    try {
      await unsubscribeFromPushNotifications();
      setStatus("default");
      setInfoMsg("नोटिफिकेशन बंद कर दिए गए हैं (Notifications disabled)");
    } catch (err: any) {
      setInfoMsg(err?.message || "Failed to disable notifications");
    } finally {
      setLoading(false);
    }
  };

  if (status === "unsupported") {
    return null; // Gracefully omit on completely unsupported environments
  }

  // State: Granted / Active
  if (status === "granted") {
    return (
      <View style={[styles.card, styles.cardGranted, compact && styles.cardCompact]}>
        <View style={styles.headerRow}>
          <View style={styles.iconCircleSuccess}>
            <Ionicons name="notifications" size={18} color="#059669" />
          </View>
          <View style={styles.headerTextWrap}>
            <Text style={styles.titleSuccess}>
              लाइव कतार नोटिफिकेशन सक्रिय हैं
            </Text>
            <Text style={styles.subSuccess}>
              Queue notifications are active. You will receive live turn alerts.
            </Text>
          </View>
        </View>

        {!compact && (
          <View style={styles.grantedFooter}>
            <Text style={styles.grantedNote}>
              जब ५ और २ मरीज आगे होंगे, या बारी आएगी, तुरंत अलर्ट मिलेगा।
            </Text>
            <Pressable
              onPress={handleDisableNotifications}
              disabled={loading}
              style={styles.unsubscribeBtn}
            >
              {loading ? (
                <ActivityIndicator size="small" color={colors.muted} />
              ) : (
                <Text style={styles.unsubscribeText}>Disable / बंद करें</Text>
              )}
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  // State: Denied / Blocked by browser settings
  if (status === "denied") {
    return (
      <View style={[styles.card, styles.cardDenied, compact && styles.cardCompact]}>
        <View style={styles.headerRow}>
          <View style={styles.iconCircleDenied}>
            <Ionicons name="notifications-off" size={18} color="#DC2626" />
          </View>
          <View style={styles.headerTextWrap}>
            <Text style={styles.titleDenied}>
              नोटिफिकेशन ब्लॉक हैं (Notifications Blocked)
            </Text>
            <Text style={styles.subDenied}>
              ब्राउज़र में नोटिफिकेशन की अनुमति बंद है। आपकी बुकिंग व लाइव कतार सामान्य रूप से काम करती रहेगी।
            </Text>
          </View>
        </View>

        <View style={styles.helpBox}>
          <Text style={styles.helpTitle}>चालू करने का आसान तरीका / How to enable:</Text>
          <Text style={styles.helpStep}>
            1. ब्राउज़र के एड्रेस बार (URL) के पास ताला 🔒 या सेटिंग्स आइकन पर टैप करें।
          </Text>
          <Text style={styles.helpStep}>
            2. "Permissions" या "Notifications" को <Text style={{ fontWeight: "700" }}>Allow (अनुमति दें)</Text> करें।
          </Text>
          <Text style={styles.helpStep}>
            3. इसके बाद पेज को रीफ़्रेश (Refresh) करें।
          </Text>
        </View>
      </View>
    );
  }

  // State: iOS Home Screen required for Safari Web Push (iOS 16.4+)
  if (status === "ios_home_screen_required") {
    return (
      <View style={[styles.card, styles.cardIos, compact && styles.cardCompact]}>
        <View style={styles.headerRow}>
          <View style={styles.iconCircleIos}>
            <Ionicons name="share-outline" size={18} color="#2563EB" />
          </View>
          <View style={styles.headerTextWrap}>
            <Text style={styles.titleIos}>
              iPhone पर नोटिफिकेशन के लिए (On iPhone):
            </Text>
            <Text style={styles.subIos}>
              Apple iOS पर नोटिफिकेशन पाने के लिए ऐप को होम स्क्रीन में जोड़ें:
            </Text>
          </View>
        </View>

        <View style={styles.helpBox}>
          <Text style={styles.helpStep}>
            1. Safari के नीचे शेयर बटन <Text style={{ fontWeight: "700" }}>Share ⎋</Text> दबाएं।
          </Text>
          <Text style={styles.helpStep}>
            2. नीचे स्क्रॉल करके <Text style={{ fontWeight: "700" }}>'Add to Home Screen' (होम स्क्रीन में जोड़ें)</Text> चुनें।
          </Text>
          <Text style={styles.helpStep}>
            3. होम स्क्रीन पर बने MeriBaari आइकन से खोलें और कतार नोटिफिकेशन चालू करें।
          </Text>
        </View>
      </View>
    );
  }

  // If user tapped Not Now previously and not forced compact, don't nag
  if (dismissed && !compact) {
    return null;
  }

  // State: Default / Not enabled yet (Request Permission CTA)
  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.headerRow}>
        <View style={styles.iconCirclePrimary}>
          <Ionicons name="notifications-outline" size={20} color={colors.brand} />
        </View>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>
            🔔 लाइव कतार और टोकन अलर्ट पाएं
          </Text>
          <Text style={styles.subTitle}>
            Get live queue alerts & turn reminders on your screen
          </Text>
        </View>
      </View>

      {!compact && (
        <View style={styles.featuresList}>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={16} color="#059669" />
            <Text style={styles.featureText}>
              टोकन नंबर, कितने मरीज आगे हैं, और अनुमानित समय के लाइव अलर्ट।
            </Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="checkmark-circle" size={16} color="#059669" />
            <Text style={styles.featureText}>
              जब आपकी बारी आने वाली होगी (५ और २ मरीज पहले) तुरंत सूचना।
            </Text>
          </View>
          <View style={styles.featureItem}>
            <Ionicons name="shield-checkmark" size={16} color="#0284C7" />
            <Text style={[styles.featureText, { color: "#0369A1", fontSize: 11 }]}>
              यह अनुमति केवल कतार अपडेट भेजने के लिए है; यह आपके फोन के नोटिफिकेशन पढ़ने का अधिकार नहीं देती। (Only sends queue updates; cannot read your notification panel).
            </Text>
          </View>
        </View>
      )}

      {infoMsg ? (
        <Text style={styles.feedbackMsg}>{infoMsg}</Text>
      ) : null}

      <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: 6 }}>
        <Pressable
          testID="not-now-push-notifications-btn"
          onPress={handleDismiss}
          style={styles.notNowBtn}
        >
          <Text style={styles.notNowBtnText}>Not Now / अभी नहीं</Text>
        </Pressable>

        <Pressable
          testID="enable-push-notifications-btn"
          onPress={handleEnableNotifications}
          disabled={loading}
          style={styles.enableBtn}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="notifications" size={16} color="#fff" />
              <Text style={styles.enableBtnText}>
                Enable Notifications
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#F0F9FF",
    borderWidth: 1,
    borderColor: "#BAE6FD",
    borderRadius: radius.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
    shadowColor: "#0284C7",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
  },
  cardCompact: {
    padding: spacing.sm,
  },
  cardGranted: {
    backgroundColor: "#F0FDF4",
    borderColor: "#BBF7D0",
  },
  cardDenied: {
    backgroundColor: "#FEF2F2",
    borderColor: "#FECACA",
  },
  cardIos: {
    backgroundColor: "#EFF6FF",
    borderColor: "#BFDBFE",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  iconCirclePrimary: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#E0F2FE",
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleSuccess: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#DCFCE7",
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleDenied: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#FEE2E2",
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleIos: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#DBEAFE",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTextWrap: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0369A1",
    marginBottom: 2,
  },
  subTitle: {
    fontSize: 12,
    color: "#0284C7",
    lineHeight: 16,
  },
  titleSuccess: {
    fontSize: 14,
    fontWeight: "700",
    color: "#065F46",
  },
  subSuccess: {
    fontSize: 12,
    color: "#047857",
    marginTop: 2,
  },
  titleDenied: {
    fontSize: 14,
    fontWeight: "700",
    color: "#991B1B",
  },
  subDenied: {
    fontSize: 12,
    color: "#B91C1C",
    marginTop: 2,
  },
  titleIos: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1E40AF",
  },
  subIos: {
    fontSize: 12,
    color: "#2563EB",
    marginTop: 2,
  },
  featuresList: {
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    gap: 4,
  },
  featureItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  featureText: {
    fontSize: 12,
    color: "#0369A1",
    flex: 1,
  },
  notNowBtn: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: "#BAE6FD",
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  notNowBtnText: {
    color: "#0369A1",
    fontSize: 12,
    fontWeight: "600",
  },
  enableBtn: {
    flex: 1,
    backgroundColor: colors.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radius.sm,
  },
  enableBtnText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  grantedFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#DCFCE7",
  },
  grantedNote: {
    fontSize: 11,
    color: "#047857",
    flex: 1,
    marginRight: 8,
  },
  unsubscribeBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  unsubscribeText: {
    fontSize: 11,
    color: colors.muted,
    textDecorationLine: "underline",
  },
  helpBox: {
    backgroundColor: "#fff",
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    gap: 3,
  },
  helpTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#374151",
    marginBottom: 2,
  },
  helpStep: {
    fontSize: 11,
    color: "#4B5563",
    lineHeight: 16,
  },
  feedbackMsg: {
    fontSize: 12,
    color: "#0369A1",
    marginVertical: 4,
  },
});
