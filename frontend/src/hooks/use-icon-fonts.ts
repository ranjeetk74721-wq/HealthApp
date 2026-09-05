// Icon font loader for Expo apps.
// Only loads Ionicons (the sole icon family used in this app).
// In production/EAS builds: useFonts returns [true, null] immediately
// because fonts are bundled natively via @expo/vector-icons autolinking.
// In Expo Go (StoreClient): loads ONLY Ionicons.ttf from CDN — down from 17 files to 1.
// This eliminates the primary startup delay on Expo Go.

import Constants, { ExecutionEnvironment } from "expo-constants";
import { useFonts } from "expo-font";

const ICON_VECTOR_VERSION = "15.1.1";

const cdnUrl = (file: string): string =>
  `https://cdn.jsdelivr.net/npm/@expo/vector-icons@${ICON_VECTOR_VERSION}/build/vendor/react-native-vector-icons/Fonts/${file}.ttf`;

export const useIconFonts = (): readonly [boolean, Error | null] =>
  useFonts(
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient
      ? { ionicons: cdnUrl("Ionicons") }  // Only load what is actually used
      : {},
  );
