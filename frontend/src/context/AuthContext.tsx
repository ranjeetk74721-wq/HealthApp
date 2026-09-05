import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { getBackendBase } from "@/src/api/client";

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

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ token: null, user: null, loading: true });

  useEffect(() => {
    (async () => {
      try {
        // Read token and user in parallel — faster than sequential reads
        const [t, u] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(USER_KEY),
        ]);
        const parsedUser = u ? JSON.parse(u) : null;
        setState({ token: t, user: parsedUser, loading: false });
        // Register push non-blockingly — does not delay auth resolution
        if (parsedUser?.id) {
          registerForPush(parsedUser.id).catch(() => {});
        }
      } catch {
        setState({ token: null, user: null, loading: false });
      }
    })();
  }, []);

  const signIn = useCallback(async (token: string, user: AuthUser) => {
    // Persist token and user in parallel
    await Promise.all([
      AsyncStorage.setItem(TOKEN_KEY, token),
      AsyncStorage.setItem(USER_KEY, JSON.stringify(user)),
    ]);
    setState({ token, user, loading: false });
    if (user.id) {
      registerForPush(user.id).catch(() => {});
    }
  }, []);

  const signOut = useCallback(async () => {
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
