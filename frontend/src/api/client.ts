import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

const configuredBase = process.env.EXPO_PUBLIC_BACKEND_URL || "http://localhost:8000";
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0];

export function getBackendBase() {
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    return process.env.EXPO_PUBLIC_BACKEND_URL;
  }
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const hostname = window.location.hostname;
    if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
      return `http://${hostname}:8000`;
    }
    return "http://localhost:8000";
  }
  const isLocalhost = /localhost|127\.0\.0\.1/.test(configuredBase);
  return Platform.OS !== "web" && isLocalhost && expoHost
    ? `http://${expoHost}:8000`
    : configuredBase;
}

export function getBackendWebSocketBase() {
  return getBackendBase().replace(/^http/, "ws");
}

export function getApiBase() {
  return getBackendBase().replace(/\/$/, "") + "/api";
}

async function getToken() {
  return await AsyncStorage.getItem("cq_token");
}

// ─── Simple in-memory GET cache (30 second TTL) ───────────────────────────
// Prevents duplicate API calls when screens re-focus rapidly.
// Only caches GET requests; mutations always bypass.
interface CacheEntry {
  data: any;
  expiresAt: number;
}
const _cache: Map<string, CacheEntry> = new Map();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCached(key: string): any | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key: string, data: any) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Invalidate all cache entries (called after mutations)
export function invalidateCache(pathPrefix?: string) {
  if (!pathPrefix) {
    _cache.clear();
    return;
  }
  for (const key of Array.from(_cache.keys())) {
    if (key.includes(pathPrefix)) _cache.delete(key);
  }
}

export interface RequestOpts extends RequestInit {
  bypassCache?: boolean;
}

// ─── Core request ───────────────────────────────────────────────────────────
async function request(path: string, opts: RequestOpts = {}) {
  const token = await getToken();
  const headers: any = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = (opts.method || "GET").toUpperCase();
  const apiBase = getApiBase();
  const url = `${apiBase}${path}`;

  // Return cached result for GET requests unless bypassCache is true
  if (method === "GET" && !opts.bypassCache) {
    const cached = getCached(url);
    if (cached !== null) return cached;
  }

  let res: Response;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch {
    throw new Error(
      `Unable to reach the Meribaari API at ${getBackendBase()}. Check your internet connection and try again.`,
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

  // Cache successful GET responses
  if (method === "GET") {
    setCached(url, data);
  } else {
    // Mutation — clear related caches so next GET fetches fresh data
    _cache.clear();
  }

  return data;
}

export const api = {
  get: (p: string, opts?: RequestOpts) => request(p, { method: "GET", ...opts }),
  post: (p: string, body?: any, opts?: RequestOpts) => request(p, { method: "POST", body: body ? JSON.stringify(body) : undefined, ...opts }),
  put: (p: string, body?: any, opts?: RequestOpts) => request(p, { method: "PUT", body: body ? JSON.stringify(body) : undefined, ...opts }),
  del: (p: string, opts?: RequestOpts) => request(p, { method: "DELETE", ...opts }),
  delete: (p: string, opts?: RequestOpts) => request(p, { method: "DELETE", ...opts }),
};

// ─── Render keep-alive ping ──────────────────────────────────────────────────
// Render free tier spins down after 15 minutes of inactivity.
// Pinging /health every 14 minutes keeps the dyno warm.
// Only runs in production (non-localhost) environments.
let _keepAliveStarted = false;
export function startKeepAlive() {
  if (_keepAliveStarted) return;
  const base = getBackendBase();
  if (/localhost|127\.0\.0\.1/.test(base)) return; // Skip in local dev
  _keepAliveStarted = true;
  // Ping immediately on startup to wake a cold backend
  fetch(`${base}/health`).catch(() => {});
  // Then every 14 minutes
  setInterval(() => {
    fetch(`${base}/health`).catch(() => {});
  }, 14 * 60 * 1000);
}
