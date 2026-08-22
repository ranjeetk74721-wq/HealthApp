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
    const base = getBackendBase();
    if (!tokenResp?.data) return;
    await fetch(`${base}/api/register-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, platform: Platform.OS, device_token: String(tokenResp.data) }),
    });
  } catch (e) {
    // Non-fatal - push may not be available in Expo Go
  }
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<AuthState>({ token: null, user: null, loading: true });

  useEffect(() => {
    (async () => {
      try {
        const t = await AsyncStorage.getItem(TOKEN_KEY);
        const u = await AsyncStorage.getItem(USER_KEY);
        const parsedUser = u ? JSON.parse(u) : null;
        setState({ token: t, user: parsedUser, loading: false });
        // Re-register push on app open
        if (parsedUser?.id) registerForPush(parsedUser.id);
      } catch {
        setState({ token: null, user: null, loading: false });
      }
    })();
  }, []);

  const signIn = useCallback(async (token: string, user: AuthUser) => {
    await AsyncStorage.setItem(TOKEN_KEY, token);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
    setState({ token, user, loading: false });
    // Register for push (only meaningful for patients typically, but harmless for all)
    if (user.id) registerForPush(user.id);
  }, []);

  const signOut = useCallback(async () => {
    await AsyncStorage.removeItem(TOKEN_KEY);
    await AsyncStorage.removeItem(USER_KEY);
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
