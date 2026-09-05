// Firebase is only used for the optional /auth/firebase-login flow.
// No screen currently imports firebase directly — this file is kept for
// future use. Initialization is lazy (only happens when getFirebaseAuth()
// is called) so it does NOT slow down app startup.

import { initializeApp, getApps, getApp } from "firebase/app";

const firebaseConfig = {
  apiKey:            process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// Returns the Firebase Auth instance — lazily initialises on first call.
// Returns null if Firebase env vars are not configured.
export function getFirebaseAuth() {
  if (!firebaseConfig.apiKey) return null;
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig as any);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuth } = require("firebase/auth");
    return getAuth(app);
  } catch {
    return null;
  }
}

export default null; // Prevents accidental default import of app instance
