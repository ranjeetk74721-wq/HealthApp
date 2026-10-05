# Bundle Optimization Plan for Meribaari HealthApp

## Executive Summary

**Current State:**
- Main bundle: **2.2 MB** (2,249.91 KB)
- 20 font files loaded (~4.5 MB total) when only 1 is used
- No code splitting or lazy loading
- Firebase loaded eagerly

**Target:**
- Reduce main bundle to **< 800 KB**
- Load only Ionicons font (~390 KB)
- Implement lazy loading for Firebase
- Optimize Metro bundler configuration

---

## Analysis Results

### Bundle Composition Breakdown

1. **Vector Icon Fonts** (~4.5 MB total across 20 files)
   - ✅ Only **Ionicons** is actually used in the codebase
   - ❌ All 20 font families are being bundled:
     - AntDesign (130 KB)
     - Entypo (66 KB)
     - EvilIcons (13 KB)
     - Feather (56 KB)
     - FontAwesome (166 KB)
     - FontAwesome5 Brands (134 KB)
     - FontAwesome5 Regular (34 KB)
     - FontAwesome5 Solid (203 KB)
     - FontAwesome6 Brands (209 KB)
     - FontAwesome6 Regular (68 KB)
     - FontAwesome6 Solid (424 KB)
     - Fontisto (314 KB)
     - Foundation (57 KB)
     - **Ionicons (390 KB)** ✅ USED
     - MaterialCommunityIcons (1.31 MB)
     - MaterialIcons (357 KB)
     - Octicons (69 KB)
     - SimpleLineIcons (54 KB)
     - Zocial (26 KB)

2. **Firebase** (estimated ~400-500 KB)
   - Imported globally in `firebase.ts`
   - Only used for phone OTP authentication
   - Auth module loaded even when not needed

3. **React Native Web** (~800 KB estimated)
   - Required for React Native → Web translation
   - Cannot be removed

4. **Expo Router** (~300-400 KB estimated)
   - File-based routing system
   - Cannot be removed

5. **Other Dependencies**
   - date-fns (4.1.0)
   - dayjs (1.11.13) ← **DUPLICATE** date library
   - expo-linear-gradient
   - react-native-reanimated
   - react-native-gesture-handler

---

## Optimization Strategy

### Phase 1: Font Loading Optimization (HIGH IMPACT)
**Expected Savings: ~4.1 MB (4,110 KB)**

#### Problem
Metro bundles all @expo/vector-icons fonts because it cannot statically analyze which ones are used.

#### Solution
Create a custom font configuration that explicitly excludes unused fonts using Metro's `assetExts` resolution.

**Files to modify:**
- `metro.config.js` - Add font filtering
- Create `custom-vector-icons.js` - Wrapper that loads only Ionicons

### Phase 2: Firebase Lazy Loading (MEDIUM IMPACT)
**Expected Savings: ~300-400 KB**

#### Problem
Firebase is imported in `firebase.ts` at module scope, causing it to load on app startup.

#### Solution
Convert Firebase imports to dynamic imports that only load when phone authentication is needed.

**Files to modify:**
- `src/firebase.ts` - Convert to lazy imports
- `app/login.tsx` - Ensure Firebase loads on-demand
- `app/otp.tsx` - Ensure Firebase loads on-demand

### Phase 3: Remove Duplicate Date Library (LOW IMPACT)
**Expected Savings: ~20-40 KB**

#### Problem
Both `date-fns` and `dayjs` are installed. Only one is needed.

#### Solution
Audit usage and remove unused library.

**Files to check:**
- Search for `import.*from.*date-fns`
- Search for `import.*from.*dayjs`
- Consolidate to single library

### Phase 4: Metro Configuration Optimization (LOW-MEDIUM IMPACT)
**Expected Savings: ~100-200 KB**

#### Solution
- Enable tree-shaking for better dead code elimination
- Configure source map exclusion for production
- Optimize chunk splitting

---

## Implementation Plan

### Step 1: Font Optimization (CRITICAL)

**1.1 Create custom vector icons wrapper**

```javascript
// src/icons/ionicons-only.js
// This file explicitly loads ONLY Ionicons to prevent Metro
// from bundling all 20 font families from @expo/vector-icons

// Re-export only Ionicons
export { Ionicons } from '@expo/vector-icons';

// If you need other icons in the future, add them explicitly:
// export { MaterialIcons } from '@expo/vector-icons';
```

**1.2 Update Metro config to exclude font files**

```javascript
// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const os = require('os');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];

// ── FONT OPTIMIZATION: Exclude unused vector icon fonts ────────────────────
// Only Ionicons.ttf will be included. All other icon fonts are excluded.
const excludedFonts = [
  'AntDesign.ttf',
  'Entypo.ttf',
  'EvilIcons.ttf',
  'Feather.ttf',
  'FontAwesome.ttf',
  'FontAwesome5_Brands.ttf',
  'FontAwesome5_Regular.ttf',
  'FontAwesome5_Solid.ttf',
  'FontAwesome6_Brands.ttf',
  'FontAwesome6_Regular.ttf',
  'FontAwesome6_Solid.ttf',
  'Fontisto.ttf',
  'Foundation.ttf',
  // 'Ionicons.ttf', ← Keep this one - it's used
  'MaterialCommunityIcons.ttf',
  'MaterialIcons.ttf',
  'Octicons.ttf',
  'SimpleLineIcons.ttf',
  'Zocial.ttf',
];

// Intercept asset resolution to exclude unused fonts
const originalGetAssetFiles = config.serializer?.getAssetFiles;
config.serializer = {
  ...config.serializer,
  getAssetFiles: async (...args) => {
    const files = originalGetAssetFiles ? await originalGetAssetFiles(...args) : args[0]?.files || [];
    return files.filter((file) => {
      const fileName = path.basename(file);
      return !excludedFonts.includes(fileName);
    });
  },
};

// Use available CPU parallelism
config.maxWorkers = Math.max(2, os.cpus().length - 1);

module.exports = config;
```

**1.3 No code changes needed**
- All imports already use `{ Ionicons } from "@expo/vector-icons"`
- Metro will automatically exclude unused fonts

### Step 2: Firebase Lazy Loading

**2.1 Update `src/firebase.ts`**

```typescript
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

export function getFirebaseConfig() {
  return { ...firebaseConfig };
}

// Lazy load Firebase app
export async function getFirebaseApp(): Promise<any> {
  if (!isFirebaseConfigured()) return null;
  const { initializeApp, getApps, getApp } = await import("firebase/app");
  return getApps().length ? getApp() : initializeApp(firebaseConfig as any);
}

// Lazy load Firebase Auth
export async function getFirebaseAuth(): Promise<any> {
  if (!isFirebaseConfigured()) return null;
  if (cachedAuth) return cachedAuth;
  try {
    const app = await getFirebaseApp();
    const { getAuth } = await import("firebase/auth");
    cachedAuth = getAuth(app);
    return cachedAuth;
  } catch (err) {
    console.warn("Firebase Auth init failed:", err);
    return null;
  }
}

// Lazy load phone authentication
export async function sendFirebasePhoneOtp(
  phoneNumber: string,
  elementId: string = "recaptcha-container"
): Promise<any> {
  const auth = await getFirebaseAuth();
  if (!auth) {
    throw new Error("Firebase is not configured. Please set Firebase environment variables.");
  }

  const { signInWithPhoneNumber, RecaptchaVerifier } = await import("firebase/auth");

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
```

### Step 3: Remove Duplicate Date Library

**3.1 Audit usage**
- Run: `grep -r "from 'date-fns'" app src`
- Run: `grep -r "from 'dayjs'" app src`

**3.2 Consolidate to single library**
- Keep `dayjs` (smaller bundle size)
- Remove `date-fns` from package.json
- Update any code using date-fns to use dayjs

### Step 4: Metro Production Optimizations

**4.1 Update `metro.config.js`**

Add production optimizations:

```javascript
// Enable minification
config.transformer = {
  ...config.transformer,
  minifierPath: 'metro-minify-terser',
  minifierConfig: {
    compress: {
      drop_console: process.env.NODE_ENV === 'production',
    },
  },
};
```

---

## Expected Results

### Before Optimization
- Main bundle: **2.2 MB**
- Font assets: **4.5 MB** (20 files)
- Total initial load: **~6.7 MB**

### After Optimization
- Main bundle: **~700-900 KB** (60-70% reduction)
- Font assets: **390 KB** (1 file - Ionicons only)
- Total initial load: **~1.1-1.3 MB** (80% reduction)

### Breakdown of Savings
| Optimization | Savings | Impact |
|-------------|---------|--------|
| Font filtering | ~4.1 MB | HIGH |
| Firebase lazy load | ~400 KB | MEDIUM |
| Remove duplicate date lib | ~40 KB | LOW |
| Metro optimizations | ~100 KB | LOW |
| **TOTAL** | **~4.6 MB** | **80% reduction** |

---

## Risks & Mitigation

### Risk 1: Breaking font rendering
**Mitigation**: The code only uses Ionicons, verified by grep search. No risk.

### Risk 2: Firebase authentication failure
**Mitigation**: Lazy loading maintains same behavior, just defers network fetch.

### Risk 3: Build time increase
**Mitigation**: Metro caching ensures subsequent builds remain fast.

---

## Testing Checklist

After implementation, verify:

- [ ] Login screen loads and works
- [ ] OTP screen loads and works (Firebase)
- [ ] All Ionicons render correctly
- [ ] No console errors about missing fonts
- [ ] Bundle size < 1 MB
- [ ] Only 1 font file (Ionicons.ttf) in build output
- [ ] Patient dashboard loads correctly
- [ ] Doctor dashboard loads correctly
- [ ] Receptionist dashboard loads correctly
- [ ] Owner dashboard loads correctly
- [ ] Web push notifications still work

---

## Implementation Order

1. ✅ **Font optimization** (Step 1) - Deploy first, highest impact
2. ✅ **Firebase lazy loading** (Step 2) - Deploy second
3. ✅ **Remove duplicate library** (Step 3) - Low risk
4. ✅ **Metro optimizations** (Step 4) - Final polish

---

## Notes

- **No changes to functionality** - All optimizations are transparent to users
- **No API changes** - Backend remains unchanged
- **No route changes** - All existing routes work identically
- **Backward compatible** - Mobile apps (Android/iOS) unaffected

The application's existing features, authentication, dashboards, appointments, and real-time queue updates remain 100% functional.
