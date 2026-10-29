// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "@/app/(tabs)/settings";
import PageScreen from "@/app/page/[id]";
import PairScreen from "@/app/pair";
import { clearConfig } from "@/data/live";
import { claimPairing } from "@/data/pairing";
import { PairingBoundary } from "@/data/pairing-scope";

vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));
vi.mock("expo-notifications", () => ({}));
vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [null, async () => ({ granted: false, canAskAgain: false })],
}));
vi.mock("expo-router", async () => (await import("@/test/fake-router")).fakeExpoRouter);
vi.mock("expo-device", () => ({ deviceName: "Test phone", modelName: null }));
vi.mock("react-native-reanimated", async () => ({
  default: { View: (await import("react-native")).View },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withRepeat: (value: number) => value,
  withSequence: (value: number) => value,
  withTiming: (value: number) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const { route, navigation } = await import("@/test/fake-router");

const SESSION = "session-a";
const PAGE_TITLE = "Payroll by employee, March";
const PAGE_WIRE = {
  id: "page-1",
  sessionId: SESSION,
  title: PAGE_TITLE,
  height: 420,
  publishedAt: "2026-10-29T12:05:00.000Z",
};
const OWNER_CODE = "ABCD2345";
const OWNER_TOKEN = `token-a.example-${OWNER_CODE}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ _tag: "NotFound", message: "session not found" }, 404);

const network = { down: false, pairClaims: 0 };
const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (network.down) throw new TypeError("Network request failed");
  if (url.pathname === "/api/pair") {
    network.pairClaims += 1;
    const body: unknown = JSON.parse(String(init?.body));
    const code =
      typeof body === "object" && body !== null && "code" in body ? String(body.code) : "";
    return json({
      url: `https://${url.host}`,
      token: `token-${url.host}-${code}`,
      device: { name: "Test phone" },
      user: { id: `user-${url.host}`, name: url.host, email: `${url.host}@example.com` },
    });
  }
  const bearer = new Headers(init?.headers).get("authorization");
  if (url.host !== "a.example" || bearer !== `Bearer ${OWNER_TOKEN}`) return notFound();
  if (url.pathname === `/api/sessions/${SESSION}/pages`) return json([PAGE_WIRE]);
  if (url.pathname === "/api/pages/page-1/frame") return json({ url: "/api/page-view?view=a" });
  return notFound();
};

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const show = (node: ReactNode) => act(() => root.render(<PairingBoundary>{node}</PairingBoundary>));
const text = () => host.textContent ?? "";
const pair = async (machine: string, code = OWNER_CODE) => {
  const outcome = await act(() => claimPairing({ url: `https://${machine}`, code }));
  expect(outcome.state).toBe("paired");
};
const press = (label: string) => {
  const target = [...host.querySelectorAll<HTMLElement>("*")].find(
    (element) => element.children.length === 0 && element.textContent === label,
  );
  if (target === undefined) throw new Error(`no ${label} button on screen`);
  act(() => target.click());
};
const type = (placeholder: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`);
  if (input === null) throw new Error(`no ${placeholder} field on screen`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  Object.assign(network, { down: false, pairClaims: 0 });
  route.params = {};
  navigation.replaced = [];
  await clearConfig();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // The pairing's cache outlives an unmount: end the pairing where the boundary sees it.
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a full-screen page", () => {
  it("is shown under the pairing that can read it, and nothing of it under the next", async () => {
    await pair("a.example");
    route.params = { id: "page-1", session: SESSION };
    show(<PageScreen />);
    await settle();
    expect(navigation.title).toBe(PAGE_TITLE);

    await pair("b.example");
    expect(text()).not.toContain(PAGE_TITLE);
    expect(navigation.title).toBe("Page");
    await settle();
    expect(text()).not.toContain(PAGE_TITLE);
    expect(navigation.title).toBe("Page");
  });
});

describe("a pairing link", () => {
  it("is claimed again when it arrives again after a refusal", async () => {
    network.down = true;
    route.params = { u: "https://a.example", c: OWNER_CODE };
    show(<PairScreen />);
    await settle();
    expect(text()).toContain("https://a.example unreachable");

    act(() => root.render(null));
    network.down = false;
    show(<PairScreen />);
    await settle();
    expect(text()).toContain("paired · https://a.example · Test phone");
    expect(new Set(navigation.replaced)).toEqual(new Set(["/"]));
  });

  it("is claimed once, and the screen its pairing remounts says it paired", async () => {
    route.params = { u: "https://a.example", c: OWNER_CODE };
    show(<PairScreen />);
    await settle();
    expect(network.pairClaims).toBe(1);
    expect(text()).toContain("paired · https://a.example · Test phone");
  });

  it("joins a claim of the same code already on its way", async () => {
    const payload = { url: "https://a.example", code: OWNER_CODE };
    const [first, second] = await act(() =>
      Promise.all([claimPairing(payload), claimPairing({ ...payload, url: "https://a.example/" })]),
    );
    expect(network.pairClaims).toBe(1);
    expect(second).toBe(first);
  });

  it("is put to the machine again once the pairing it made has ended", async () => {
    const payload = { url: "https://a.example", code: OWNER_CODE };
    await act(() => claimPairing(payload));
    await act(() => clearConfig());
    await act(() => claimPairing(payload));
    expect(network.pairClaims).toBe(2);
  });
});

describe("the hand-typed connection in Settings", () => {
  it("still shows what was saved after a Save that changes the connection", async () => {
    await pair("a.example");
    show(<SettingsScreen />);
    press("Advanced");
    type("token", "typed-by-hand");
    press("Save");
    await settle();
    expect(text()).toContain("token entered by hand");
    expect(text()).toContain("Saved");
  });
});
