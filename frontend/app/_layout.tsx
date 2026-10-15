import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { LogBox, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import * as Linking from "expo-linking";

import { useIconFonts } from "@/src/hooks/use-icon-fonts";
import { AuthProvider } from "@/src/context/AuthContext";
import { startKeepAlive } from "@/src/api/client";

LogBox.ignoreAllLogs(true);

SplashScreen.preventAutoHideAsync();

// ── Push notification handler (module scope) ────────────────────────────────
if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

if (Platform.OS === "android") {
  Notifications.setNotificationChannelAsync("default", {
    name: "Meribaari Alerts",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
  });
}

import { safeSessionStorageGet, safeSessionStorageSet } from "@/src/utils/safeStorage";
import React, { Component, ReactNode, ErrorInfo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[RootErrorBoundary]:", error, errorInfo);
    if (typeof window !== "undefined") {
      const msg = error?.message || "";
      const isChunkError =
        msg.includes("Loading chunk") ||
        msg.includes("Failed to fetch dynamically imported module") ||
        msg.includes("Unexpected token '<'") ||
        msg.includes("ChunkLoadError") ||
        msg.includes("importing a module script failed");

      if (isChunkError) {
        const lastReload = safeSessionStorageGet("mb_chunk_reload_ts");
        const now = Date.now();
        if (!lastReload || now - parseInt(lastReload, 10) > 15000) {
          safeSessionStorageSet("mb_chunk_reload_ts", now.toString());
          window.location.reload();
          return;
        }
      }
    }
  }

  handleReload = () => {
    if (typeof window !== "undefined") {
      window.location.reload();
    } else {
      this.setState({ hasError: false, error: null });
    }
  };

  handleGoHome = () => {
    if (typeof window !== "undefined") {
      window.location.href = "/";
    } else {
      this.setState({ hasError: false, error: null });
    }
  };

  render() {
    if (this.state.hasError) {
      const msg = this.state.error?.message || "";
      const isChunk =
        msg.includes("Loading chunk") ||
        msg.includes("Unexpected token '<'") ||
        msg.includes("dynamically imported module") ||
        msg.includes("ChunkLoadError");

      return (
        <View style={ebStyles.container}>
          <View style={ebStyles.card}>
            <View style={ebStyles.iconWrap}>
              <Ionicons name="alert-circle-outline" size={44} color="#0369A1" />
            </View>
            <Text style={ebStyles.title}>
              {isChunk ? "App Update Available" : "Unable to Display Page"}
            </Text>
            <Text style={ebStyles.subtitle}>
              {isChunk
                ? "A new update of MeriBaari is available. Tap Reload to update now."
                : "A temporary loading glitch occurred. Please tap Reload to continue."}
            </Text>
            <Pressable onPress={this.handleReload} style={ebStyles.primaryBtn}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={ebStyles.primaryBtnText}>Reload Dashboard</Text>
            </Pressable>
            <Pressable onPress={this.handleGoHome} style={ebStyles.secondaryBtn}>
              <Text style={ebStyles.secondaryBtnText}>Return to Home</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return this.props.children;
  }
}

const ebStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8FAFC",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    padding: 28,
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E2E8F0",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  iconWrap: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "#E0F2FE",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "700",
    color: "#0F172A",
    textAlign: "center",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: "#64748B",
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
  },
  primaryBtn: {
    backgroundColor: "#0369A1",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
    width: "100%",
    marginBottom: 12,
  },
  primaryBtnText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
  },
  secondaryBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  secondaryBtnText: {
    color: "#0369A1",
    fontSize: 14,
    fontWeight: "500",
  },
});

export default function RootLayout() {
  const [loaded, error] = useIconFonts();
  const [fontTimeout, setFontTimeout] = useState(false);
  const router = useRouter();

  // Safety fallback: never allow font loading to stall the render for more than 1.5s
  useEffect(() => {
    const t = setTimeout(() => setFontTimeout(true), 1500);
    return () => clearTimeout(t);
  }, []);

  // Hide splash screen as soon as fonts are ready (or errored or timed out)
  useEffect(() => {
    if (loaded || error || fontTimeout) {
      SplashScreen.hideAsync();
    }
  }, [loaded, error, fontTimeout]);

  // Start Render keep-alive ping once on app open
  useEffect(() => {
    startKeepAlive();
  }, []);

  // Web Global Error and Unhandled Rejection Listeners for Stale Chunk Auto-Recovery
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;

    const isStaleChunkError = (msg: string) => {
      const lower = msg.toLowerCase();
      return (
        lower.includes("loading chunk") ||
        lower.includes("failed to fetch dynamically imported module") ||
        lower.includes("unexpected token '<'") ||
        lower.includes("chunkloaderror") ||
        lower.includes("importing a module script failed")
      );
    };

    const handleWindowError = (e: ErrorEvent) => {
      const msg = e?.message || "";
      if (isStaleChunkError(msg)) {
        const lastReload = safeSessionStorageGet("mb_chunk_reload_ts");
        const now = Date.now();
        if (!lastReload || now - parseInt(lastReload, 10) > 15000) {
          safeSessionStorageSet("mb_chunk_reload_ts", now.toString());
          window.location.reload();
        }
      }
    };

    const handleUnhandledRejection = (e: PromiseRejectionEvent) => {
      const reason = e?.reason;
      const msg = (typeof reason === "object" && reason?.message) ? reason.message : String(reason || "");
      if (isStaleChunkError(msg)) {
        const lastReload = safeSessionStorageGet("mb_chunk_reload_ts");
        const now = Date.now();
        if (!lastReload || now - parseInt(lastReload, 10) > 15000) {
          safeSessionStorageSet("mb_chunk_reload_ts", now.toString());
          window.location.reload();
        }
      }
    };

    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  // Deep-link handler for notification taps
  useEffect(() => {
    if (Platform.OS === "web") return;

    const tapSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data: any = response.notification.request.content.data || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (typeof url === "string" && url.startsWith("http")) {
        Linking.openURL(url);
      } else if (typeof url === "string") {
        router.push(url as any);
      }
    });

    // Handle cold-start notification tap
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data: any = response.notification.request.content.data || {};
      const url = data.deeplink || data.action_url;
      if (!url) return;
      if (typeof url === "string" && url.startsWith("http")) {
        Linking.openURL(url);
      } else if (typeof url === "string") {
        router.push(url as any);
      }
    });

    return () => {
      tapSub.remove();
    };
  }, [router]);

  // Never return null indefinitely if font loading is delayed
  if (!loaded && !error && !fontTimeout) return null;

  return (
    <SafeAreaProvider>
      <RootErrorBoundary>
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#FFFFFF" } }} />
        </AuthProvider>
      </RootErrorBoundary>
    </SafeAreaProvider>
  );
}
