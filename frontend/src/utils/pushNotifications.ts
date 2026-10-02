import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getFirebaseApp, getFirebaseConfig } from "@/src/firebase";
import { getBackendBase, api } from "@/src/api/client";

export const PUSH_TOKEN_KEY = "cq_push_token";

export type PushPermissionStatus =
  | "unsupported"
  | "ios_home_screen_required"
  | "default"
  | "granted"
  | "denied";

/**
 * Checks whether the current browser supports Web Push and Notifications API.
 */
export function isWebPushSupported(): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return false;
  }
  return (
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Detects whether the current device is an iPhone, iPad, or iPod touch.
 */
export function isIosDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent || "";
  const isIos = /iPad|iPhone|iPod/.test(ua);
  const isIpadOs = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return isIos || isIpadOs;
}

/**
 * On iOS (Safari 16.4+), Web Push is ONLY supported when the web app has been
 * added to the Home Screen and launched in standalone mode.
 */
export function isIosStandaloneRequired(): boolean {
  if (!isIosDevice()) return false;
  if (typeof window === "undefined") return false;

  const isStandalone =
    ("standalone" in window.navigator && (window.navigator as any).standalone) ||
    window.matchMedia("(display-mode: standalone)").matches;

  return !isStandalone;
}

/**
 * Gets the current notification permission state for the device.
 */
export function getNotificationPermissionState(): PushPermissionStatus {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return "unsupported";
  }

  if (isIosStandaloneRequired()) {
    return "ios_home_screen_required";
  }

  if (!isWebPushSupported()) {
    return "unsupported";
  }

  const permission = Notification.permission;
  if (permission === "granted") return "granted";
  if (permission === "denied") return "denied";
  return "default";
}

/**
 * Registers the background service worker with Firebase config passed in query params.
 */
async function registerMessagingServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    const config = getFirebaseConfig();
    const query = new URLSearchParams({
      apiKey: config.apiKey || "",
      authDomain: config.authDomain || "",
      projectId: config.projectId || "",
      storageBucket: config.storageBucket || "",
      messagingSenderId: config.messagingSenderId || "",
      appId: config.appId || "",
    }).toString();

    const swUrl = `/firebase-messaging-sw.js?${query}`;
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope: "/",
    });

    // Wait until service worker is active
    if (registration.installing) {
      await new Promise<void>((resolve) => {
        registration.installing?.addEventListener("statechange", (e: any) => {
          if (e.target?.state === "activated") resolve();
        });
        setTimeout(resolve, 2000);
      });
    }

    return registration;
  } catch (err) {
    console.warn("[Push] Failed to register service worker:", err);
    return null;
  }
}

/**
 * Requests notification permission from user and subscribes to FCM Web Push.
 * Sends the token to the backend and saves it locally.
 */
export async function subscribeToPushNotifications(options?: {
  appointmentId?: string;
  appointmentToken?: string;
}): Promise<{ ok: boolean; status: PushPermissionStatus; token?: string; error?: string }> {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return { ok: false, status: "unsupported", error: "Web push is only available on web." };
  }

  if (isIosStandaloneRequired()) {
    return {
      ok: false,
      status: "ios_home_screen_required",
      error: "Please add MeriBaari to Home Screen first to enable push notifications on iPhone.",
    };
  }

  if (!isWebPushSupported()) {
    return { ok: false, status: "unsupported", error: "Browser does not support notifications." };
  }

  try {
    // 1. Request browser permission only on user action
    const currentPermission = Notification.permission;
    let permission = currentPermission;

    if (permission === "default") {
      permission = await Notification.requestPermission();
    }

    if (permission !== "granted") {
      return {
        ok: false,
        status: permission === "denied" ? "denied" : "default",
        error: "Notification permission was not granted.",
      };
    }

    // 2. Register Service Worker
    const swRegistration = await registerMessagingServiceWorker();
    if (!swRegistration) {
      return { ok: false, status: "granted", error: "Service Worker registration failed." };
    }

    // 3. Initialize Firebase Messaging
    const app = getFirebaseApp();
    if (!app) {
      return { ok: false, status: "granted", error: "Firebase app is not configured." };
    }

    const { getMessaging, getToken } = await import("firebase/messaging");
    const messaging = getMessaging(app);

    const vapidKey =
      process.env.EXPO_PUBLIC_FIREBASE_VAPID_KEY ||
      // Fallback: If VAPID key is not set, FCM uses default project key
      undefined;

    const token = await getToken(messaging, {
      serviceWorkerRegistration: swRegistration,
      vapidKey: vapidKey || undefined,
    });

    if (!token) {
      return { ok: false, status: "granted", error: "Failed to obtain FCM registration token." };
    }

    // 4. Send token to backend
    try {
      await api.post("/push/subscribe", {
        token: token,
        platform: "web",
        user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "web",
        appointment_id: options?.appointmentId,
        appointment_token: options?.appointmentToken,
      });
    } catch (apiErr) {
      console.warn("[Push] Backend subscription registration warning:", apiErr);
      // Soft-fail fallback so client token is still cached
    }

    // 5. Cache locally
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);

    return { ok: true, status: "granted", token };
  } catch (err: any) {
    console.error("[Push] Subscription error:", err);
    return { ok: false, status: getNotificationPermissionState(), error: err?.message || "Unknown error" };
  }
}

/**
 * Unsubscribes from push notifications and informs the backend to deactivate the token.
 */
export async function unsubscribeFromPushNotifications(): Promise<boolean> {
  try {
    const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);

    if (cachedToken) {
      try {
        await api.post("/push/unsubscribe", { token: cachedToken });
      } catch (err) {
        console.warn("[Push] Backend unsubscribe warning:", err);
      }
    }

    if (Platform.OS === "web" && typeof window !== "undefined") {
      try {
        const app = getFirebaseApp();
        if (app) {
          const { getMessaging, deleteToken } = await import("firebase/messaging");
          const messaging = getMessaging(app);
          await deleteToken(messaging);
        }
      } catch (e) {
        console.warn("[Push] FCM deleteToken warning:", e);
      }
    }

    await AsyncStorage.removeItem(PUSH_TOKEN_KEY);
    return true;
  } catch (err) {
    console.warn("[Push] Error during unsubscribe:", err);
    return false;
  }
}

/**
 * Listens for incoming push messages when the app is active in the foreground.
 */
export function setupForegroundNotificationListener(
  onReceive: (payload: any) => void
): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined" || !isWebPushSupported()) {
    return () => {};
  }

  let unsubscribe: (() => void) | null = null;

  (async () => {
    try {
      const app = getFirebaseApp();
      if (!app) return;
      const { getMessaging, onMessage } = await import("firebase/messaging");
      const messaging = getMessaging(app);

      unsubscribe = onMessage(messaging, (payload) => {
        onReceive(payload);

        // Also display native browser notification if granted and in background tab
        if (Notification.permission === "granted" && document.hidden) {
          const title = payload.notification?.title || payload.data?.title || "MeriBaari Queue Update";
          const body = payload.notification?.body || payload.data?.body || "";
          new Notification(title, {
            body,
            icon: "/assets/images/icon.png",
            badge: "/assets/images/favicon.png",
            data: payload.data,
          });
        }
      });
    } catch {
      // Non-fatal if messaging is not initialized
    }
  })();

  return () => {
    if (unsubscribe) {
      unsubscribe();
    }
  };
}
