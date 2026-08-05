import { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { colors } from "@/src/theme";

export default function Index() {
  const { loading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login");
    } else if (user.role === "patient") {
      router.replace("/patient/home");
    } else if (user.role === "doctor") {
      router.replace("/doctor/dashboard");
    } else if (user.role === "receptionist") {
      router.replace("/receptionist/dashboard");
    } else if (user.role === "owner") {
      router.replace("/owner/dashboard");
    }
  }, [loading, user]);

  return (
    <View style={styles.container} testID="splash-loader">
      <ActivityIndicator size="large" color={colors.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
});
