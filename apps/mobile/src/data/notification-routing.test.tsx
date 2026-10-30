// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const storedConfig = vi.hoisted(() => Promise.withResolvers<string | null>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: () => storedConfig.promise,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-router", async () => (await import("@/test/fake-router")).fakeExpoRouter);
vi.mock("expo-notifications", () => ({
  setNotificationHandler: () => undefined,
  addNotificationResponseReceivedListener: () => ({ remove: () => undefined }),
  getLastNotificationResponseAsync: async () => ({
    notification: { request: { identifier: "launch", content: { data: { sessionId: "s-1" } } } },
  }),
  clearLastNotificationResponseAsync: async () => undefined,
}));
vi.mock("expo-font", () => ({ useFonts: () => [true] }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: async () => undefined,
  hideAsync: async () => undefined,
}));
vi.mock("expo-system-ui", () => ({ setBackgroundColorAsync: async () => undefined }));
vi.mock("expo-status-bar", () => ({ StatusBar: () => null }));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { readonly children: unknown }) => children,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { readonly children: unknown }) => children,
}));
vi.mock("@expo-google-fonts/inter", () => ({
  Inter_400Regular: 0,
  Inter_500Medium: 0,
  Inter_600SemiBold: 0,
}));
vi.mock("@expo-google-fonts/jetbrains-mono", () => ({
  JetBrainsMono_400Regular: 0,
  JetBrainsMono_500Medium: 0,
}));
vi.mock("@expo-google-fonts/space-grotesk", () => ({
  SpaceGrotesk_500Medium: 0,
  SpaceGrotesk_600SemiBold: 0,
  SpaceGrotesk_700Bold: 0,
}));

const { default: RootLayout } = await import("@/app/_layout");
const { navigation } = await import("@/test/fake-router");

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

it("routes the tap that launched the app once the pairing is read and the navigator is up", async () => {
  await act(async () => root.render(<RootLayout />));
  await act(async () => storedConfig.resolve(null));
  expect(navigation.pushed).toEqual([
    { href: { pathname: "/session/[id]", params: { id: "s-1" } }, navigatorMounted: true },
  ]);
});
