import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { safeSessionStorageGet } from "@/src/utils/safeStorage";

export const PRODUCTION_BACKEND_URL =
  process.env.EXPO_PUBLIC_PRODUCTION_BACKEND_URL || "https://healthapp-b4mo.onrender.com";
const configuredBase = process.env.EXPO_PUBLIC_BACKEND_URL;
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0];

/**
 * Checks whether a hostname belongs to a private local development network.
 * Restricts local development fallback strictly to valid private IPv4 blocks,
 * localhost, and .local mDNS names.
 */
export function isPrivateDevHost(hostname: string): boolean {
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  const parts = hostname.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    // 10.0.0.0 - 10.255.255.255
    if (parts[0] === 10) return true;
    // 172.16.0.0 - 172.31.255.255
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.168.0.0 - 192.168.255.255
    if (parts[0] === 192 && parts[1] === 168) return true;
  }
  return false;
}

export function getBackendBase(): string {
  // 1. Explicitly configured backend URL
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    const raw = process.env.EXPO_PUBLIC_BACKEND_URL.trim();
    if (raw) {
      const cleaned = raw.replace(/\/+$/, "").replace(/\/api$/, "");
      // Never send HTTPS production web users to an HTTP backend (mixed content failure)
      if (
        Platform.OS === "web" &&
        typeof window !== "undefined" &&
        window.location.protocol === "https:" &&
        cleaned.startsWith("http://")
      ) {
        return "";
      }
      if (!cleaned.includes("localhost") && !cleaned.includes("127.0.0.1")) {
        return cleaned;
      }
    }
  }

  // 2. Web browser resolution
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const { hostname, protocol } = window.location;
    // Local / LAN development web: resolve backend to laptop host on port 8000
    if (protocol === "http:" && isPrivateDevHost(hostname)) {
      return `http://${hostname}:8000`;
    }
    // Deployed web (e.g. Vercel at https://www.meribaariapp.in) -> use relative path
    // because vercel.json proxies /api to Render backend
    return "";
  }

  // 3. Native Expo resolution
  const isLocalhost = !configuredBase || /localhost|127\.0\.0\.1/.test(configuredBase);
  if (Platform.OS !== "web" && isLocalhost && expoHost) {
    return `http://${expoHost}:8000`;
  }

  return configuredBase
    ? configuredBase.replace(/\/+$/, "").replace(/\/api$/, "")
    : PRODUCTION_BACKEND_URL;
}

export function getBackendWebSocketBase(): string {
  // 1. If explicit EXPO_PUBLIC_BACKEND_URL is given
  if (process.env.EXPO_PUBLIC_BACKEND_URL) {
    const raw = process.env.EXPO_PUBLIC_BACKEND_URL.trim();
    if (raw && !raw.includes("localhost") && !raw.includes("127.0.0.1")) {
      const cleaned = raw.replace(/\/+$/, "").replace(/\/api$/, "");
      return cleaned.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
    }
  }

  // 2. Web browser resolution
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const { hostname, protocol } = window.location;
    // Local development web (localhost or LAN IP over HTTP)
    if (protocol === "http:" && isPrivateDevHost(hostname)) {
      return `ws://${hostname}:8000`;
    }
    // Production web (e.g. Vercel):
    // Vercel serverless HTTP rewrites DO NOT support persistent WebSockets.
    // Therefore, web clients in production MUST connect directly to Render's WSS endpoint.
    return PRODUCTION_BACKEND_URL.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
  }

  // 3. Native Expo resolution
  const isLocalhost = !configuredBase || /localhost|127\.0\.0\.1/.test(configuredBase);
  if (Platform.OS !== "web" && isLocalhost && expoHost) {
    return `ws://${expoHost}:8000`;
  }

  const base = configuredBase
    ? configuredBase.replace(/\/+$/, "").replace(/\/api$/, "")
    : PRODUCTION_BACKEND_URL;
  return base.replace(/^https:\/\//i, "wss://").replace(/^http:\/\//i, "ws://");
}

export function getApiBase(): string {
  const base = getBackendBase();
  return base ? `${base}/api` : "/api";
}

async function getToken(): Promise<string | null> {
  if (Platform.OS === "web") {
    const sessToken = safeSessionStorageGet("cq_session_token");
    if (sessToken) return sessToken;
  }
  return await AsyncStorage.getItem("cq_token");
}

// ─── Simple in-memory GET cache with role/token isolation and in-flight deduplication ───
// Prevents duplicate API calls when screens re-focus rapidly.
// Only caches GET requests; mutations always bypass and invalidate.
interface CacheEntry {
  data: any;
  expiresAt: number;
}
const _cache: Map<string, CacheEntry> = new Map();
const _inFlight: Map<string, Promise<any>> = new Map();

// Active in-flight mutation tracker: prevents automatic reloads during submissions
let _activeMutationsCount = 0;
export function isMutationInFlight(): boolean {
  return _activeMutationsCount > 0;
}
if (typeof window !== "undefined") {
  (window as any).__MERIBAARI_MUTATION_IN_FLIGHT__ = () => _activeMutationsCount > 0;
}

// 30 seconds for static metadata (specialties, clinic profiles)
const STATIC_CACHE_TTL_MS = 30_000;
// 2 seconds for real-time operational queues & appointments to eliminate duplicate parallel fetches while guaranteeing fresh data
const OPERATIONAL_CACHE_TTL_MS = 2_000;

export function isOperationalEndpoint(cleanPath: string): boolean {
  return (
    cleanPath.startsWith("/reception/queue") ||
    cleanPath.startsWith("/doctor/appointments") ||
    cleanPath.startsWith("/doctor/dashboard") ||
    cleanPath.includes("/session") ||
    cleanPath.startsWith("/appointments") ||
    cleanPath.startsWith("/patient/queue")
  );
}

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

function setCached(key: string, data: any, cleanPath: string) {
  const ttl = isOperationalEndpoint(cleanPath) ? OPERATIONAL_CACHE_TTL_MS : STATIC_CACHE_TTL_MS;
  _cache.set(key, { data, expiresAt: Date.now() + ttl });
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeKeyPath(key: string): string {
  // Strip token prefix if present: "tokenHash:path"
  const colonIdx = key.indexOf(":");
  let keyPath = colonIdx !== -1 && !key.startsWith("http") ? key.slice(colonIdx + 1) : key;
  const apiBase = getApiBase();
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
    _inFlight.clear();
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
    cleanPath === "/reception/correct_status" ||
    cleanPath === "/api/reception/correct_status" ||
    /^\/appointments\/[^/]+\/(?:cancel|patient-details|reschedule|refer|correct-status)$/.test(cleanPath) ||
    /^\/reception\/(?:mark_arrived|arrive|start_consultation|complete|skip|rejoin|unskip|cancel|call|no-show|correct_status)$/.test(cleanPath) ||
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

export class ApiError extends Error {
  status: number;
  data: any;
  isHtmlResponse: boolean;
  isServerWarming: boolean;
  isAuthError: boolean;
  isForbidden: boolean;
  isNetworkError: boolean;

  constructor(message: string, status: number = 0, data: any = null, isHtml: boolean = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.isHtmlResponse = isHtml;
    this.isNetworkError = status === 0;
    this.isAuthError = status === 401;
    this.isForbidden = status === 403;
    this.isServerWarming = status === 502 || status === 503 || status === 504;
  }
}

export class TimeoutError extends ApiError {
  isTimeout = true;
  constructor(message?: string) {
    super(message || "Request timed out", 0, null, false);
    this.name = "TimeoutError";
  }
}

export function isConfirmedAuthError(err: any): boolean {
  if (!err) return false;
  if (err instanceof ApiError) return err.isAuthError;
  if (err?.status === 401) return true;
  return false;
}

export interface RequestOpts extends RequestInit {
  bypassCache?: boolean;
  invalidatePrefixes?: string[];
  timeoutMs?: number;
}

// ─── Core request ───────────────────────────────────────────────────────────
async function request(path: string, opts: RequestOpts = {}, retryCount = 0): Promise<any> {
  const reqSeq = ++_requestSeq;
  const token = await getToken();
  const headers: any = { ...(opts.headers || {}) };
  if (opts.body !== undefined && opts.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = (opts.method || "GET").toUpperCase();

  // Normalize path to prevent duplicate or missing /api
  let cleanPath = path.trim();
  if (cleanPath.startsWith("/api/")) {
    cleanPath = cleanPath.slice(4);
  } else if (cleanPath === "/api") {
    cleanPath = "";
  }
  if (!cleanPath.startsWith("/")) {
    cleanPath = `/${cleanPath}`;
  }

  const apiBase = getApiBase();
  const url = `${apiBase}${cleanPath}`;
  const tokenHash = token ? token.slice(-16) : "anon";
  const cacheKey = `${tokenHash}:${url}`;

  // Return cached result for GET requests unless bypassCache is true
  if (method === "GET" && !opts.bypassCache) {
    const cached = getCached(cacheKey);
    if (cached !== null) return cached;

    const inFlight = _inFlight.get(cacheKey);
    if (inFlight) return inFlight;
  }

  const exec = async (): Promise<any> => {
    let res: Response;
    let timeoutId: any = null;
    let didTimeout = false;
    let signal = opts.signal;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const controller = new AbortController();
      if (opts.signal) {
        if (opts.signal.aborted) {
          controller.abort();
        } else {
          opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
        }
      }
      signal = controller.signal;
      timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, opts.timeoutMs);
    }

    try {
      res = await fetch(url, { ...opts, headers, signal });
    } catch (err: any) {
      if (didTimeout) {
        // Safe transient retry for idempotent GET requests on timeout (e.g. Render spin-up or mobile network switch)
        if (method === "GET" && retryCount < 1) {
          await new Promise((r) => setTimeout(r, 1000));
          return request(path, opts, retryCount + 1);
        }
        throw new TimeoutError(
          `Request to ${cleanPath} timed out after ${opts.timeoutMs}ms. Please check your connection.`,
        );
      }

      if (err?.name === "AbortError") {
        // Caller cancelled request (e.g. doctor or date changed)
        throw err;
      }

      // Safe transient retry for idempotent GET requests (handles mobile network switch or Render cold-start)
      if (method === "GET" && retryCount < 1) {
        await new Promise((r) => setTimeout(r, 1500));
        return request(path, opts, retryCount + 1);
      }

      const hostDisplay = typeof window !== "undefined" ? (getBackendBase() || window.location.origin) : getBackendBase();
      throw new ApiError(
        `Unable to reach the Meribaari API at ${hostDisplay}. Check your internet connection and try again.`,
        0,
        null,
        false,
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    const contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    const isHtml =
      contentType.includes("text/html") ||
      text.trim().startsWith("<!DOCTYPE") ||
      text.trim().startsWith("<html");

    if (isHtml) {
      // API route returned HTML (e.g. gateway timeout, proxy error, or unexpected HTML page)
      throw new ApiError(
        `The server returned an unexpected response (HTTP ${res.status}). Please try again later.`,
        res.status,
        null,
        true,
      );
    }

    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      // Retry once for GET on 502/503 during Render cold start
      if (method === "GET" && (res.status === 502 || res.status === 503) && retryCount < 1) {
        await new Promise((r) => setTimeout(r, 2000));
        return request(path, opts, retryCount + 1);
      }

      let msg = `HTTP ${res.status}`;
      if (data && typeof data === "object" && data.detail) {
        msg = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
      } else if (typeof data === "string" && data.length < 200) {
        msg = data;
      }
      throw new ApiError(msg, res.status, data, false);
    }

    // Cache successful GET responses only if not stale from a concurrent invalidation
    if (method === "GET") {
      const isStale = isResponseStale(url, reqSeq);
      if (!isStale && !opts.bypassCache) {
        setCached(cacheKey, data, cleanPath);
      }
    } else {
      // Mutation — invalidate targeted caches so affected resources fetch fresh data
      const explicitPrefixes = opts.invalidatePrefixes;
      if (explicitPrefixes !== undefined) {
        invalidateCache(explicitPrefixes);
      } else {
        const targeted = getTargetedInvalidationPrefixes(cleanPath, method);
        if (targeted !== null) {
          invalidateCache(targeted);
        } else {
          // Fallback for unestablished mutations / auth boundaries: full cache clear
          invalidateCache();
        }
      }
    }

    return data;
  };

  if (method === "GET") {
    const fetchPromise = exec();
    _inFlight.set(cacheKey, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      _inFlight.delete(cacheKey);
    }
  }

  _activeMutationsCount++;
  try {
    return await exec();
  } finally {
    _activeMutationsCount = Math.max(0, _activeMutationsCount - 1);
  }
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
