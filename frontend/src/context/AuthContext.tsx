import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getBackendBase, invalidateCache } from "@/src/api/client";

export type Role = "patient" | "doctor" | "receptionist" | "owner";

export interface AuthUser {
  id: string;
  email?: string | null;
  full_name: string;
  role: Role;
  phone?: string;
  mobile?: string | null;
  age?: number | null;
  gender?: string | null;
  address?: string | null;
  hospital_id?: string | null;
  hospital_name?: string | null;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
}

interface AuthContextType extends AuthState {
  signIn: (token: string, user: AuthUser) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = "cq_token";
const USER_KEY = "cq_user";
// Key to cache the last registered push token so we skip re-registration when unchanged
const PUSH_TOKEN_KEY = "cq_push_token";
const SESSION_TOKEN_KEY = "cq_session_token";
const SESSION_USER_KEY = "cq_session_user";
export const RECEPTIONIST_LAST_HOSPITAL_KEY = "cq_receptionist_last_hospital";
const MIGRATION_KEY = "mb_receptionist_migrated_v1";
const LOGOUT_BROADCAST_KEY = "cq_auth_logout_broadcast";

async function registerForPush(user_id: string) {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    const { status, canAskAgain } = await Notifications.getPermissionsAsync();
    let finalStatus = status;
    if (status !== "granted" && canAskAgain) {
      const req = await Notifications.requestPermissionsAsync();
      finalStatus = req.status;
    }
    if (finalStatus !== "granted") return;

    const tokenResp = await Notifications.getDevicePushTokenAsync();
    if (!tokenResp?.data) return;
    const newToken = String(tokenResp.data);

    // Only call backend if the push token changed — avoids network call on every launch
    const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (cachedToken === newToken) return;

    const base = getBackendBase();
    await fetch(`${base}/api/register-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, platform: Platform.OS, device_token: newToken }),
    });

    // Cache the token after successful registration
    await AsyncStorage.setItem(PUSH_TOKEN_KEY, newToken);
  } catch {
    // Non-fatal — push may not be available in Expo Go
  }
}

import {
  safeLocalStorageGet,
  safeLocalStorageSet,
  safeLocalStorageRemove,
  safeSessionStorageGet,
  safeSessionStorageSet,
  safeSessionStorageRemove,
} from "@/src/utils/safeStorage";

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ token: null, user: null, loading: true });

  useEffect(() => {
    (async () => {
      try {
        // 1. One-time legacy migration for receptionist persisted sessions on web
        if (Platform.OS === "web") {
          try {
            const hasMigrated = safeLocalStorageGet(MIGRATION_KEY);
            if (!hasMigrated) {
              const legacyUserStr = safeLocalStorageGet(USER_KEY);
              if (legacyUserStr) {
                try {
                  const parsed = JSON.parse(legacyUserStr);
                  if (parsed?.role === "receptionist") {
                    if (parsed.hospital_id) {
                      safeLocalStorageSet(RECEPTIONIST_LAST_HOSPITAL_KEY, parsed.hospital_id);
                    }
                    safeLocalStorageRemove(TOKEN_KEY);
                    safeLocalStorageRemove(USER_KEY);
                    await AsyncStorage.removeItem(TOKEN_KEY);
                    await AsyncStorage.removeItem(USER_KEY);
                  }
                } catch {}
              }
              safeLocalStorageSet(MIGRATION_KEY, "done");
            }
          } catch {}
        }

        // 2. Check tab-scoped sessionStorage on Web for active receptionist session
        if (Platform.OS === "web") {
          try {
            const sessToken = safeSessionStorageGet(SESSION_TOKEN_KEY);
            const sessUserStr = safeSessionStorageGet(SESSION_USER_KEY);
            if (sessToken && sessUserStr) {
              let parsedSessUser: any = null;
              try { parsedSessUser = JSON.parse(sessUserStr); } catch {}
              if (parsedSessUser?.role === "receptionist") {
                setState({ token: sessToken, user: parsedSessUser, loading: false });
                if (parsedSessUser?.id) {
                  registerForPush(parsedSessUser.id).catch(() => {});
                }
                return;
              }
            }
          } catch {}
        }

        // 3. Persistent AsyncStorage check for doctor/patient/owner/admin
        const [t, u] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(USER_KEY),
        ]);
        let parsedUser: any = null;
        if (u) {
          try { parsedUser = JSON.parse(u); } catch {}
        }

        // If a receptionist was found in long-lived storage, clean it out and require fresh login
        if (parsedUser?.role === "receptionist") {
          if (Platform.OS === "web" && parsedUser.hospital_id) {
            safeLocalStorageSet(RECEPTIONIST_LAST_HOSPITAL_KEY, parsedUser.hospital_id);
          }
          await Promise.all([
            AsyncStorage.removeItem(TOKEN_KEY),
            AsyncStorage.removeItem(USER_KEY),
          ]);
          setState({ token: null, user: null, loading: false });
          return;
        }

        setState({ token: t, user: parsedUser, loading: false });
        if (parsedUser?.id) {
          registerForPush(parsedUser.id).catch(() => {});
        }
      } catch {
        setState({ token: null, user: null, loading: false });
      }
    })();
  }, []);

  // Cross-tab synchronization for explicit logout across same-origin tabs
  useEffect(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const handleStorage = (e: StorageEvent) => {
        if (e.key === LOGOUT_BROADCAST_KEY) {
          try {
            window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
            window.sessionStorage.removeItem(SESSION_USER_KEY);
          } catch {}
          setState({ token: null, user: null, loading: false });
        }
      };
      window.addEventListener("storage", handleStorage);
      return () => {
        window.removeEventListener("storage", handleStorage);
      };
    }
  }, []);

  const signIn = useCallback(async (token: string, user: AuthUser) => {
    // Clear API cache on login to prevent cross-account stale data
    invalidateCache();

    if (user.role === "receptionist" && Platform.OS === "web") {
      // Receptionist on web: keep strictly in tab-scoped sessionStorage
      safeSessionStorageSet(SESSION_TOKEN_KEY, token);
      safeSessionStorageSet(SESSION_USER_KEY, JSON.stringify(user));
      if ((user as any).hospital_id) {
        safeLocalStorageSet(RECEPTIONIST_LAST_HOSPITAL_KEY, (user as any).hospital_id);
      }
      // Clear any persistent keys
      await Promise.all([
        AsyncStorage.removeItem(TOKEN_KEY),
        AsyncStorage.removeItem(USER_KEY),
      ]);
    } else {
      // Non-receptionist roles (doctor, patient, owner, admin) retain persistent storage
      if (Platform.OS === "web") {
        safeSessionStorageRemove(SESSION_TOKEN_KEY);
        safeSessionStorageRemove(SESSION_USER_KEY);
      }
      await Promise.all([
        AsyncStorage.setItem(TOKEN_KEY, token),
        AsyncStorage.setItem(USER_KEY, JSON.stringify(user)),
      ]);
    }

    setState({ token, user, loading: false });
    if (user.id) {
      registerForPush(user.id).catch(() => {});

      // On web, if notifications were previously granted, link the device token to the new user
      let isNotifGranted = false;
      try {
        isNotifGranted =
          Platform.OS === "web" &&
          typeof window !== "undefined" &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted";
      } catch {}

      if (isNotifGranted) {
        AsyncStorage.getItem(PUSH_TOKEN_KEY).then((cached) => {
          if (cached) {
            const base = getBackendBase();
            fetch(`${base}/api/push/subscribe`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                token: cached,
                platform: "web",
                user_agent: typeof navigator !== "undefined" ? navigator.userAgent : "web",
              }),
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    // Clear API cache immediately on logout
    invalidateCache();
    try {
      const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
      if (cachedToken) {
        const base = getBackendBase();
        // Deactivate push subscription on backend for this device
        await fetch(`${base}/api/push/unsubscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: cachedToken }),
        }).catch(() => {});

        // On Web, delete FCM token on the device to stop previous account's notifications
        if (Platform.OS === "web") {
          try {
            const { getFirebaseApp } = await import("@/src/firebase");
            const app = await getFirebaseApp();
            if (app) {
              const { getMessaging, deleteToken } = await import("firebase/messaging");
              const messaging = getMessaging(app);
              await deleteToken(messaging).catch(() => {});
            }
          } catch {
            // Non-fatal
          }
        }
      }
    } catch {
      // Non-fatal
    }

    // Clean up web session storage and trigger cross-tab logout sync
    if (Platform.OS === "web") {
      safeSessionStorageRemove(SESSION_TOKEN_KEY);
      safeSessionStorageRemove(SESSION_USER_KEY);
      safeLocalStorageSet(LOGOUT_BROADCAST_KEY, Date.now().toString());
    }

    await Promise.all([
      AsyncStorage.removeItem(TOKEN_KEY),
      AsyncStorage.removeItem(USER_KEY),
      AsyncStorage.removeItem(PUSH_TOKEN_KEY),
    ]);
    setState({ token: null, user: null, loading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
};
