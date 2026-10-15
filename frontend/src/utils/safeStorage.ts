// Safe wrapper around Web storage (localStorage, sessionStorage)
// Gracefully handles SecurityError (third-party cookie blocking, private mode, storage disabled)
// and QuotaExceededError with an in-memory fallback.

const memoryStorage = new Map<string, string>();

export function safeLocalStorageGet(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(key);
    }
  } catch {}
  return memoryStorage.get(`local:${key}`) ?? null;
}

export function safeLocalStorageSet(key: string, value: string): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {}
  memoryStorage.set(`local:${key}`, value);
}

export function safeLocalStorageRemove(key: string): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(key);
    }
  } catch {}
  memoryStorage.delete(`local:${key}`);
}

export function safeSessionStorageGet(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      return window.sessionStorage.getItem(key);
    }
  } catch {}
  return memoryStorage.get(`session:${key}`) ?? null;
}

export function safeSessionStorageSet(key: string, value: string): void {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.setItem(key, value);
      return;
    }
  } catch {}
  memoryStorage.set(`session:${key}`, value);
}

export function safeSessionStorageRemove(key: string): void {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      window.sessionStorage.removeItem(key);
    }
  } catch {}
  memoryStorage.delete(`session:${key}`);
}
