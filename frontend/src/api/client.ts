import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

const configuredBase = process.env.EXPO_PUBLIC_BACKEND_URL || "http://localhost:8000";
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0];

export function getBackendBase() {
  const isLocalhost = /localhost|127\.0\.0\.1/.test(configuredBase);
  return Platform.OS !== "web" && isLocalhost && expoHost
    ? `http://${expoHost}:8000`
    : configuredBase;
}

export function getBackendWebSocketBase() {
  return getBackendBase().replace(/^http/, "ws");
}

const backendBase = getBackendBase();
const BASE = backendBase.replace(/\/$/, "") + "/api";

async function getToken() {
  return await AsyncStorage.getItem("cq_token");
}

async function request(path: string, opts: RequestInit = {}) {
  const token = await getToken();
  const headers: any = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...opts, headers });
  } catch {
    throw new Error(
      `Unable to reach the ClinicQueue API at ${backendBase}. Start MongoDB and the FastAPI server on port 8000, then try again.`,
    );
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && data.detail) || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

export const api = {
  get: (p: string) => request(p),
  post: (p: string, body?: any) => request(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  del: (p: string) => request(p, { method: "DELETE" }),
};
