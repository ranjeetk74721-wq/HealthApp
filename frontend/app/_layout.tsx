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
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
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

    // ── Active Background Deployment Auto-Synchronizer ────────────────────────
    // Automatically detects when a new frontend build is deployed while a user has an existing tab open
    let checkTimer: any = null;
    const currentBuildId = (window as any).__MERIBAARI_BUILD_ID__;

    const isSafeToAutoReload = (): boolean => {
      if (typeof document === "undefined") return true;

      // 1. Check if an API mutation (booking, registration, status change, billing) is in flight
      if (typeof (window as any).__MERIBAARI_MUTATION_IN_FLIGHT__ === "function") {
        if ((window as any).__MERIBAARI_MUTATION_IN_FLIGHT__()) {
          return false;
        }
      }

      // 2. Check if user is typing or has focus in an input, textarea, or contentEditable element
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return false;
      }

      // 3. Check for any visible text inputs or textareas containing unsaved user input
      try {
        const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i];
          if (
            (el.type === "text" || el.type === "tel" || el.type === "number" || el.tagName === "TEXTAREA") &&
            el.value &&
            el.value.trim().length > 0 &&
            el.offsetParent !== null
          ) {
            return false;
          }
        }
      } catch {}

      // 4. Check for active consultation or unsaved form explicit flags
      if (
        (window as any).__MERIBAARI_ACTIVE_CONSULTATION__ ||
        (window as any).__MERIBAARI_UNSAVED_FORM__
      ) {
        return false;
      }

      // 5. Check if a modal dialog is open
      const modal = document.querySelector('[role="dialog"], [aria-modal="true"], .modal, .modal-open');
      if (modal) return false;

      return true;
    };

    const showUpdateBanner = (applyUpdateFn: () => void) => {
      if (typeof document === "undefined" || document.getElementById("mb-update-banner")) return;
      const banner = document.createElement("div");
      banner.id = "mb-update-banner";
      banner.style.position = "fixed";
      banner.style.bottom = "24px";
      banner.style.right = "24px";
      banner.style.zIndex = "999999";
      banner.style.backgroundColor = "#0F172A";
      banner.style.color = "#FFFFFF";
      banner.style.padding = "14px 18px";
      banner.style.borderRadius = "12px";
      banner.style.boxShadow = "0 10px 25px -5px rgba(0, 0, 0, 0.4)";
      banner.style.display = "flex";
      banner.style.alignItems = "center";
      banner.style.gap = "14px";
      banner.style.fontFamily = "system-ui, -apple-system, sans-serif";
      banner.style.fontSize = "13px";
      banner.style.maxWidth = "400px";

      banner.innerHTML = `
        <div style="flex: 1;">
          <div style="font-weight: 600; font-size: 13px; margin-bottom: 2px;">⚡ Update Ready</div>
          <div style="font-size: 12px; color: #94A3B8;">A new version is available. Update when convenient.</div>
        </div>
        <button id="mb-update-btn" style="background-color: #0284C7; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer;">
          Update Now
        </button>
        <button id="mb-dismiss-btn" style="background: transparent; color: #94A3B8; border: none; font-size: 15px; cursor: pointer; padding: 0 4px;">
          ✕
        </button>
      `;

      document.body.appendChild(banner);

      document.getElementById("mb-update-btn")?.addEventListener("click", applyUpdateFn);
      document.getElementById("mb-dismiss-btn")?.addEventListener("click", () => banner.remove());
    };

    const applyUpdate = async () => {
      const now = Date.now();
      safeSessionStorageSet("mb_version_reload_ts", now.toString());
      if ("caches" in window) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        } catch {}
      }
      window.location.reload();
    };

    const verifyReleaseReady = async (serverBuildId: string): Promise<boolean> => {
      try {
        const res = await fetch(`/version.json?_t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return false;
        const manifest = await res.json();
        if (manifest.buildId !== serverBuildId || manifest.healthStatus !== "healthy") {
          return false;
        }
        const headRes = await fetch("/", { method: "HEAD", cache: "no-store" });
        return headRes.ok;
      } catch {
        return false;
      }
    };

    // Coordinate updates across tabs
    const broadcastChannel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel("meribaari_release_channel")
        : null;

    if (broadcastChannel) {
      broadcastChannel.onmessage = async (event) => {
        const data = event.data || {};
        if (data.type === "NEW_VERSION_AVAILABLE" && data.serverBuildId && data.serverBuildId !== currentBuildId) {
          const lastReload = safeSessionStorageGet("mb_version_reload_ts");
          const now = Date.now();
          if (!lastReload || now - parseInt(lastReload, 10) > 30000) {
            if (isSafeToAutoReload()) {
              await applyUpdate();
            } else {
              showUpdateBanner(applyUpdate);
            }
          }
        }
      };
    }

    const checkForUpdates = async () => {
      try {
        // Prevent excessive network traffic across multiple tabs
        const lastCheck = safeSessionStorageGet("mb_last_check_ts");
        const now = Date.now();
        if (lastCheck && now - parseInt(lastCheck, 10) < 45000) {
          return;
        }
        safeSessionStorageSet("mb_last_check_ts", now.toString());

        const res = await fetch(`/version.json?_t=${now}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache", "Pragma": "no-cache" },
        });
        if (!res.ok) return;
        const info = await res.json();
        const serverBuildId = info?.buildId;
        if (serverBuildId && currentBuildId && serverBuildId !== currentBuildId) {
          const isReady = await verifyReleaseReady(serverBuildId);
          if (!isReady) return;

          const lastReload = safeSessionStorageGet("mb_version_reload_ts");
          if (!lastReload || now - parseInt(lastReload, 10) > 30000) {
            if (broadcastChannel) {
              try {
                broadcastChannel.postMessage({ type: "NEW_VERSION_AVAILABLE", serverBuildId });
              } catch {}
            }

            if (isSafeToAutoReload()) {
              await applyUpdate();
            } else {
              showUpdateBanner(applyUpdate);
            }
          }
        }
      } catch {
        // Network unavailable or offline, ignore gracefully
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        checkForUpdates();
      }
    };

    window.addEventListener("focus", checkForUpdates);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    checkTimer = setInterval(checkForUpdates, 60000);
    const initialTimer = setTimeout(checkForUpdates, 5000);

    return () => {
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      if (checkTimer) clearInterval(checkTimer);
      clearTimeout(initialTimer);
      window.removeEventListener("focus", checkForUpdates);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (broadcastChannel) broadcastChannel.close();
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

  // Render minimal system-font fallback while fonts load (avoids blank screen on web/mobile)
  if (!loaded && !error && !fontTimeout) {
    return (
      <View style={{ flex: 1, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color="#0369A1" />
      </View>
    );
  }

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
