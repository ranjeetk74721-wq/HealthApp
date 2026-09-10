import { initializeApp, getApps, getApp } from "firebase/app";
import { Platform } from "react-native";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

let cachedAuth: any = null;
let currentConfirmationResult: any = null;
let recaptchaVerifier: any = null;

export function isFirebaseConfigured(): boolean {
  return !!(firebaseConfig.apiKey && firebaseConfig.projectId);
}

export function getFirebaseAuth(): any {
  if (!isFirebaseConfigured()) return null;
  if (cachedAuth) return cachedAuth;
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig as any);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getAuth } = require("firebase/auth");
    cachedAuth = getAuth(app);
    return cachedAuth;
  } catch (err) {
    console.warn("Firebase Auth init failed:", err);
    return null;
  }
}

/**
 * Sends an SMS OTP to the given full phone number (e.g. +919876543210) via Firebase Phone Auth.
 */
export async function sendFirebasePhoneOtp(
  phoneNumber: string,
  elementId: string = "recaptcha-container"
): Promise<any> {
  const auth = getFirebaseAuth();
  if (!auth) {
    throw new Error("Firebase is not configured. Please set Firebase environment variables.");
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { signInWithPhoneNumber, RecaptchaVerifier } = require("firebase/auth");

  // Set up reCAPTCHA verifier on Web
  if (Platform.OS === "web") {
    if (typeof window !== "undefined") {
      let container = document.getElementById(elementId);
      if (!container) {
        container = document.createElement("div");
        container.id = elementId;
        document.body.appendChild(container);
      }
      if (!recaptchaVerifier) {
        recaptchaVerifier = new RecaptchaVerifier(auth, elementId, {
          size: "invisible",
        });
      }
    }
  }

  const verifier = recaptchaVerifier || (undefined as any);
  const confirmation = await signInWithPhoneNumber(auth, phoneNumber, verifier);
  currentConfirmationResult = confirmation;
  return confirmation;
}

/**
 * Confirms the OTP entered by user, returns the Firebase user ID Token.
 */
export async function confirmFirebasePhoneOtp(otpCode: string): Promise<string> {
  if (!currentConfirmationResult) {
    throw new Error("No active OTP request found. Please request an OTP first.");
  }
  const userCredential = await currentConfirmationResult.confirm(otpCode);
  const idToken = await userCredential.user.getIdToken();
  return idToken;
}

export function clearFirebaseConfirmation() {
  currentConfirmationResult = null;
  if (recaptchaVerifier) {
    try {
      recaptchaVerifier.clear();
    } catch {
      // ignore
    }
    recaptchaVerifier = null;
  }
}

export default null;
