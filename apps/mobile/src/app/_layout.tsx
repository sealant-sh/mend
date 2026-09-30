import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold } from "@expo-google-fonts/inter";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from "@expo-google-fonts/space-grotesk";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

import {
  configureForegroundPresentation,
  wireNotificationNavigation,
} from "@/data/notification-navigation";
import { fontFamilies, useEvidenceTheme } from "@/theme/evidence";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

// React Native has no window focus: teach React Query that foregrounding IS
// focus, so every stale query refetches the moment the app comes back —
// the polls stop serving data from before the phone went to sleep.
AppState.addEventListener("change", (state) => focusManager.setFocused(state === "active"));

SplashScreen.preventAutoHideAsync();
configureForegroundPresentation();

export default function RootLayout() {
  const { scheme, colors } = useEvidenceTheme();
  const router = useRouter();
  useEffect(
    () =>
      wireNotificationNavigation({
        push: (sessionId) => router.push({ pathname: "/session/[id]", params: { id: sessionId } }),
      }),
    [],
  );
  // The window behind the app shows wherever a screen does not paint — under the gesture bar on
  // Android, it read as a black strip. Keep it the app's own ground, in both schemes.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.bg);
  }, [colors.bg]);
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync();
  }, [fontsLoaded]);
  if (!fontsLoaded) return null;

  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.accent,
      background: colors.bg,
      card: colors.panel,
      text: colors.ink,
      border: colors.softRule,
      notification: colors.accent,
    },
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider value={navTheme}>
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerShadowVisible: false,
                headerTintColor: colors.accent,
                headerTitleStyle: {
                  fontFamily: fontFamilies.sans.semibold,
                  fontSize: 15,
                  color: colors.ink,
                },
              }}
            >
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="pair" options={{ title: "Pair device" }} />
              <Stack.Screen
                name="adopt"
                options={{ title: "Adopt project", presentation: "modal" }}
              />
              <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
              <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
              <Stack.Screen name="review/[id]" options={{ title: "Review" }} />
              <Stack.Screen name="diff/[id]" options={{ title: "Diff" }} />
            </Stack>
          </ThemeProvider>
        </QueryClientProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
