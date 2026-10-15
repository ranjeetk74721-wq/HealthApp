import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

export const PRODUCTION_BACKEND_URL = "https://healthapp-b4mo.onrender.com";
const configuredBase = process.env.EXPO_PUBLIC_BACKEND_URL;
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0];

export function getBackendBase() {
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    const envUrl = process.env.EXPO_PUBLIC_BACKEND_URL.trim();
    if (envUrl && !envUrl.includes("localhost") && !envUrl.includes("127.0.0.1")) {
      return envUrl;
    }
  }

  if (Platform.OS === "web" && typeof window !== "undefined") {
    const hostname = window.location.hostname;
    // Local development web
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0") {
      return "http://localhost:8000";
    }
    // Deployed web (e.g. Vercel) -> use relative path because vercel.json proxies /api to Render
    return "";
  }

  const isLocalhost = !configuredBase || /localhost|127\.0\.0\.1/.test(configuredBase);
  return Platform.OS !== "web" && isLocalhost && expoHost
    ? `http://${expoHost}:8000`
    : (configuredBase || PRODUCTION_BACKEND_URL);
}

export function getBackendWebSocketBase() {
  const base = getBackendBase();
  if (!base) {
    // On deployed web (e.g. Vercel) where getBackendBase() returns relative "",
    // WebSockets require an absolute wss:// URL directed to the production backend
    return PRODUCTION_BACKEND_URL.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  }
  return base.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

export function getApiBase() {
  return getBackendBase().replace(/\/$/, "") + "/api";
}

async function getToken(): Promise<string | null> {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    try {
      const sessToken = window.sessionStorage.getItem("cq_session_token");
      if (sessToken) return sessToken;
    } catch {}
  }
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

// Monotonic sequence clock for tracking request start and invalidation times
let _requestSeq = 0;
let _lastGlobalInvalidationSeq = 0;
const _prefixInvalidations: Map<string, number> = new Map();

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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeyPath(key: string): string {
  const apiBase = getApiBase();
  let keyPath = key;
  if (apiBase && keyPath.startsWith(apiBase)) {
    keyPath = keyPath.slice(apiBase.length);
  }
  return keyPath;
}

export function keyMatchesPrefix(key: string, prefix: string): boolean {
  if (!prefix) return false;
  const keyPath = normalizeKeyPath(key);
  const cleanKey = keyPath.split("?")[0];
  const normPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const cleanPrefix = normPrefix.split("?")[0];

  // Wildcard support: e.g. "/doctor/*/session"
  if (cleanPrefix.includes("*")) {
    const parts = cleanPrefix.split("*").map(escapeRegex);
    const regex = new RegExp("^" + parts.join("[^/?]+") + "(?:$|[/?])");
    return regex.test(keyPath);
  }

  // Exact match or direct subpath match:
  // e.g. "/appointments" matches "/appointments" or "/appointments/me"
  if (
    cleanKey === cleanPrefix ||
    cleanKey.startsWith(cleanPrefix.endsWith("/") ? cleanPrefix : `${cleanPrefix}/`)
  ) {
    return true;
  }

  return false;
}

function isResponseStale(url: string, reqSeq: number): boolean {
  if (reqSeq <= _lastGlobalInvalidationSeq) {
    return true;
  }
  for (const [prefix, invalSeq] of _prefixInvalidations.entries()) {
    if (reqSeq <= invalSeq && keyMatchesPrefix(url, prefix)) {
      return true;
    }
  }
  return false;
}

// Invalidate cache entries (called after mutations or auth changes)
export function invalidateCache(pathPrefix?: string | string[]) {
  const invalSeq = ++_requestSeq;
  if (!pathPrefix) {
    _lastGlobalInvalidationSeq = invalSeq;
    _prefixInvalidations.clear();
    _cache.clear();
    return;
  }

  const prefixes = Array.isArray(pathPrefix) ? pathPrefix : [pathPrefix];
  for (const prefix of prefixes) {
    if (!prefix) continue;
    _prefixInvalidations.set(prefix, invalSeq);
    for (const key of Array.from(_cache.keys())) {
      if (keyMatchesPrefix(key, prefix)) {
        _cache.delete(key);
      }
    }
  }
}

/**
 * Returns targeted invalidation prefixes for known mutations.
 * Returns null for unrecognized mutations or auth boundaries to trigger conservative full clear.
 */
export function getTargetedInvalidationPrefixes(path: string, _method: string): string[] | null {
  const cleanPath = path.split("?")[0].replace(/\/+$/, "");

  // Read-only POST / non-mutating checks
  if (cleanPath === "/hospital/validate-id" || cleanPath === "/api/hospital/validate-id") {
    return [];
  }

  // Push notifications
  if (
    cleanPath === "/push/subscribe" ||
    cleanPath === "/push/unsubscribe" ||
    cleanPath === "/register-push" ||
    cleanPath === "/api/register-push"
  ) {
    return ["/push/status"];
  }

  // Appointment & Queue lifecycle mutations
  // Affects appointments (me, details, queue, calendar), reception queue, doctor appointments/dashboard, and session counts
  if (
    cleanPath === "/appointments" ||
    cleanPath === "/reception/reschedule" ||
    cleanPath === "/reception/emergency_insert" ||
    cleanPath === "/reception/refer" ||
    cleanPath === "/reception/auto-refer" ||
    cleanPath === "/reception/add-patient" ||
    cleanPath === "/reception/reorder" ||
    /^\/appointments\/[^/]+\/(?:cancel|patient-details|reschedule|refer)$/.test(cleanPath) ||
    /^\/reception\/(?:mark_arrived|arrive|start_consultation|complete|skip|rejoin|unskip|cancel|call|no-show)$/.test(cleanPath) ||
    /^\/reception\/appointments\/[^/]+\/send-link$/.test(cleanPath) ||
    /^\/doctor\/(?:call|complete|no-show|skip|unskip|prescription|auto-refer)$/.test(cleanPath)
  ) {
    return [
      "/appointments",
      "/reception/queue",
      "/doctor/appointments",
      "/doctor/dashboard",
      "/doctor/*/session",
      "/doctor/*/sessions",
      "/doctors/*/sessions",
    ];
  }

  // Doctor session & timing mutations
  // Affects session details/availability, doctor dashboard, reception queue, appointments (ETAs), and doctor status indicator
  if (
    cleanPath === "/doctor/status" ||
    /^\/doctor\/[^/]+\/session\/(?:adjust-timing|pause|resume|end|cabin-presence|start-consultation|availability)$/.test(cleanPath) ||
    /^\/doctor\/[^/]+\/sessions$/.test(cleanPath) ||
    /^\/doctor\/[^/]+\/sessions\/[^/]+$/.test(cleanPath) ||
    /^\/doctor\/[^/]+\/sessions\/[^/]+\/(?:cancel|close|date-override)$/.test(cleanPath)
  ) {
    return [
      "/doctor/*/session",
      "/doctor/*/sessions",
      "/doctors/*/sessions",
      "/doctor/dashboard",
      "/reception/queue",
      "/appointments",
      "/doctors",
      "/reception/doctors",
    ];
  }

  // Specialties
  if (cleanPath === "/specialties" || cleanPath === "/owner/specialties") {
    return ["/specialties"];
  }

  // Hospital management
  if (cleanPath === "/owner/hospitals" || /^\/owner\/hospitals\/[^/]+$/.test(cleanPath)) {
    return ["/hospitals", "/owner/hospitals", "/owner/stats"];
  }

  // Doctor profiles & doctor management
  if (
    cleanPath === "/doctor/update_profile" ||
    cleanPath === "/owner/add-doctor" ||
    cleanPath === "/owner/doctors" ||
    /^\/owner\/doctors\/[^/]+$/.test(cleanPath)
  ) {
    return [
      "/doctors",
      "/reception/doctors",
      "/owner/doctors",
      "/doctor/dashboard",
      "/owner/stats",
    ];
  }

  // Receptionist staff management
  if (
    cleanPath === "/owner/add-receptionist" ||
    cleanPath === "/owner/receptionists" ||
    cleanPath === "/doctor/add-receptionist" ||
    cleanPath === "/doctor/receptionist" ||
    cleanPath === "/doctor/receptionists" ||
    /^\/owner\/receptionists\/[^/]+$/.test(cleanPath) ||
    /^\/doctor\/receptionists?\/[^/]+$/.test(cleanPath)
  ) {
    return [
      "/owner/receptionists",
      "/doctor/receptionists",
      "/owner/stats",
    ];
  }

  // Authentication boundaries & sensitive user account changes -> full cache clear
  if (
    cleanPath.startsWith("/auth/") ||
    cleanPath === "/hospital/login" ||
    cleanPath === "/api/hospital/login" ||
    cleanPath === "/user/withdraw-consent" ||
    cleanPath === "/user/delete-me"
  ) {
    return null; // Signals global invalidation
  }

  // Conservative fallback for any unknown mutation: full clear
  return null;
}

export class TimeoutError extends Error {
  isTimeout = true;
  constructor(message?: string) {
    super(message || "Request timed out");
    this.name = "TimeoutError";
  }
}

export interface RequestOpts extends RequestInit {
  bypassCache?: boolean;
  invalidatePrefixes?: string[];
  timeoutMs?: number;
}

// ─── Core request ───────────────────────────────────────────────────────────
async function request(path: string, opts: RequestOpts = {}) {
  const reqSeq = ++_requestSeq;
  const token = await getToken();
  const headers: any = { ...(opts.headers || {}) };
  if (opts.body !== undefined && opts.body !== null) {
    headers["Content-Type"] = "application/json";
  }
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
  let timeoutId: any = null;
  let didTimeout = false;
  let signal = opts.signal;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const controller = new AbortController();
    signal = controller.signal;
    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, opts.timeoutMs);
  }

  try {
    res = await fetch(url, { ...opts, headers, signal });
  } catch (err: any) {
    if (didTimeout || err?.name === "AbortError") {
      throw new TimeoutError(
        `Request to ${path} timed out after ${opts.timeoutMs}ms. Please check your connection.`,
      );
    }
    throw new Error(
      `Unable to reach the Meribaari API at ${getBackendBase()}. Check your internet connection and try again.`,
    );
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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
    const err: any = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }

  // Cache successful GET responses only if not stale from a concurrent invalidation
  if (method === "GET") {
    const isStale = isResponseStale(url, reqSeq);
    if (!isStale && !opts.bypassCache) {
      setCached(url, data);
    }
  } else {
    // Mutation — invalidate targeted caches so affected resources fetch fresh data
    const explicitPrefixes = opts.invalidatePrefixes;
    if (explicitPrefixes !== undefined) {
      invalidateCache(explicitPrefixes);
    } else {
      const targeted = getTargetedInvalidationPrefixes(path, method);
      if (targeted !== null) {
        invalidateCache(targeted);
      } else {
        // Fallback for unestablished mutations / auth boundaries: full cache clear
        invalidateCache();
      }
    }
  }

  return data;
}

export const api = {
  get: (p: string, opts?: RequestOpts) => request(p, { method: "GET", ...opts }),
  post: (p: string, body?: any, opts?: RequestOpts) => request(p, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined, ...opts }),
  put: (p: string, body?: any, opts?: RequestOpts) => request(p, { method: "PUT", body: body !== undefined ? JSON.stringify(body) : undefined, ...opts }),
  patch: (p: string, body?: any, opts?: RequestOpts) => request(p, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined, ...opts }),
  del: (p: string, opts?: RequestOpts) => request(p, { method: "DELETE", ...opts }),
  delete: (p: string, opts?: RequestOpts) => request(p, { method: "DELETE", ...opts }),
};

// ─── Render keep-alive ping ──────────────────────────────────────────────────
// Note: This in-browser timer only runs while a user has the client open in an active tab.
// It cannot wake a sleeping service when no users are active, nor can client-side pings
// guarantee uptime or prevent cold starts, which are an inherent limitation of the Render
// Free Plan (15-minute inactivity spin-down).
let _keepAliveStarted = false;
export function startKeepAlive() {
  if (_keepAliveStarted) return;
  const base = getBackendBase();
  if (/localhost|127\.0\.0\.1/.test(base)) return; // Skip in local dev
  _keepAliveStarted = true;
  const healthUrl = `${getApiBase()}/health`;
  // Ping on startup to warm/check backend
  fetch(healthUrl).catch(() => {});
  // Periodic in-session ping (14 min) while tab is open
  setInterval(() => {
    fetch(healthUrl).catch(() => {});
  }, 14 * 60 * 1000);
}
