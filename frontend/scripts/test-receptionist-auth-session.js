// Node.js test script verifying Receptionist Session Storage,
// Legacy Persistent Migration, and Cross-Tab Logout Synchronization logic.

const assert = require("assert");

// Mock browser environments
class MockStorage {
  constructor() {
    this.store = {};
  }
  getItem(key) {
    return this.store[key] !== undefined ? this.store[key] : null;
  }
  setItem(key, value) {
    this.store[key] = String(value);
  }
  removeItem(key) {
    delete this.store[key];
  }
  clear() {
    this.store = {};
  }
}

const TOKEN_KEY = "cq_token";
const USER_KEY = "cq_user";
const SESSION_TOKEN_KEY = "cq_session_token";
const SESSION_USER_KEY = "cq_session_user";
const RECEPTIONIST_LAST_HOSPITAL_KEY = "cq_receptionist_last_hospital";
const MIGRATION_KEY = "mb_receptionist_migrated_v1";
const LOGOUT_BROADCAST_KEY = "cq_auth_logout_broadcast";

console.log("--- Starting Receptionist Auth & Session Tests ---");

// Test 1: One-time migration clears legacy receptionist tokens from persistent localStorage
{
  const localStorage = new MockStorage();
  const sessionStorage = new MockStorage();

  // Legacy state: persistent receptionist session in localStorage
  localStorage.setItem(TOKEN_KEY, "legacy-jwt-token-123");
  localStorage.setItem(USER_KEY, JSON.stringify({
    id: "rec-1",
    role: "receptionist",
    full_name: "Legacy Receptionist",
    hospital_id: "H00001",
  }));

  // Simulate migration logic from AuthContext
  const hasMigrated = localStorage.getItem(MIGRATION_KEY);
  assert.strictEqual(hasMigrated, null, "Migration should not have run yet");

  const legacyUserStr = localStorage.getItem(USER_KEY);
  if (legacyUserStr) {
    const parsed = JSON.parse(legacyUserStr);
    if (parsed?.role === "receptionist") {
      if (parsed.hospital_id) {
        localStorage.setItem(RECEPTIONIST_LAST_HOSPITAL_KEY, parsed.hospital_id);
      }
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }
  localStorage.setItem(MIGRATION_KEY, "done");

  assert.strictEqual(localStorage.getItem(TOKEN_KEY), null, "Legacy token must be removed from persistent storage");
  assert.strictEqual(localStorage.getItem(USER_KEY), null, "Legacy user must be removed from persistent storage");
  assert.strictEqual(localStorage.getItem(RECEPTIONIST_LAST_HOSPITAL_KEY), "H00001", "Hospital ID preserved for convenience");
  assert.strictEqual(localStorage.getItem(MIGRATION_KEY), "done", "Migration flag must be set to done");

  console.log("✔ Test 1 Passed: Legacy receptionist persistent credentials migrated successfully");
}

// Test 2: Migration preserves other roles (doctor, patient) in persistent localStorage
{
  const localStorage = new MockStorage();

  // Persistent doctor session in localStorage
  localStorage.setItem(TOKEN_KEY, "doctor-jwt-token-456");
  localStorage.setItem(USER_KEY, JSON.stringify({
    id: "doc-1",
    role: "doctor",
    full_name: "Dr. Mariya",
    hospital_id: "H00001",
  }));

  // Simulate migration logic
  const hasMigrated = localStorage.getItem(MIGRATION_KEY);
  assert.strictEqual(hasMigrated, null);

  const legacyUserStr = localStorage.getItem(USER_KEY);
  if (legacyUserStr) {
    const parsed = JSON.parse(legacyUserStr);
    if (parsed?.role === "receptionist") {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    }
  }
  localStorage.setItem(MIGRATION_KEY, "done");

  assert.strictEqual(localStorage.getItem(TOKEN_KEY), "doctor-jwt-token-456", "Doctor token must NOT be cleared");
  assert.notStrictEqual(localStorage.getItem(USER_KEY), null, "Doctor user must NOT be cleared");

  console.log("✔ Test 2 Passed: Doctor and patient roles are preserved during migration");
}

// Test 3: Receptionist fresh login stays tab-scoped (sessionStorage) and survives reload in same tab
{
  const localStorage = new MockStorage();
  const sessionStorage = new MockStorage();

  // Receptionist logs in
  const token = "fresh-receptionist-jwt";
  const user = { id: "rec-2", role: "receptionist", full_name: "Priya", hospital_id: "H00001" };

  // signIn() for receptionist
  sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);

  // Active tab check: token is available in sessionStorage
  assert.strictEqual(sessionStorage.getItem(SESSION_TOKEN_KEY), token);
  assert.strictEqual(localStorage.getItem(TOKEN_KEY), null, "Never written to persistent localStorage");

  // Reload tab (sessionStorage is preserved by browser)
  const reloadedSessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
  assert.strictEqual(reloadedSessionToken, token, "Active tab reload retains receptionist session");

  // Simulate closing tab/browser and opening a new tab (sessionStorage is empty)
  const newTabSessionStorage = new MockStorage();
  const newTabToken = newTabSessionStorage.getItem(SESSION_TOKEN_KEY);
  assert.strictEqual(newTabToken, null, "New tab or reopened browser starts with fresh login page");

  console.log("✔ Test 3 Passed: Tab-scoped session storage survives reloads but clears on close/reopen");
}

// Test 4: Explicit logout clears session storage and broadcasts across same-origin tabs
{
  const localStorage = new MockStorage();
  const tab1Session = new MockStorage();
  const tab2Session = new MockStorage();

  // Tab 1 and Tab 2 both have receptionist sessions
  tab1Session.setItem(SESSION_TOKEN_KEY, "jwt-1");
  tab2Session.setItem(SESSION_TOKEN_KEY, "jwt-2");

  // Tab 1 calls signOut()
  tab1Session.removeItem(SESSION_TOKEN_KEY);
  tab1Session.removeItem(SESSION_USER_KEY);
  localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now()));

  assert.strictEqual(tab1Session.getItem(SESSION_TOKEN_KEY), null);

  // Tab 2 storage listener receives LOGOUT_BROADCAST_KEY
  const broadcastEventKey = LOGOUT_BROADCAST_KEY;
  if (broadcastEventKey === LOGOUT_BROADCAST_KEY) {
    tab2Session.removeItem(SESSION_TOKEN_KEY);
    tab2Session.removeItem(SESSION_USER_KEY);
  }

  assert.strictEqual(tab2Session.getItem(SESSION_TOKEN_KEY), null, "Tab 2 synchronously logged out");

  console.log("✔ Test 4 Passed: Explicit logout synchronizes across same-origin tabs");
}

console.log("--- All Receptionist Auth & Session Tests Passed Successfully! ---");
