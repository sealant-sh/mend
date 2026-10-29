// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "@/app/(tabs)/settings";
import PairScreen from "@/app/pair";
import { AskDialog, useAsk } from "@/components/ask";
import type { Ask, AskButton } from "@/data/ask";
import { clearConfig } from "@/data/live";
import { PairingBoundary } from "@/data/pairing-scope";

interface OsAlert {
  readonly title: string;
  readonly message: string | undefined;
  readonly buttons: ReadonlyArray<AskButton>;
}

const phone = vi.hoisted(() => ({
  os: "ios",
  /** Alerts the OS shows in its own window: only a press on one of its buttons closes one. */
  alerts: new Array<OsAlert>(),
  /** Notifications delivered and still in the OS tray. */
  tray: new Array<{ readonly id: string; readonly title: string }>(),
}));

vi.mock("react-native", async (importActual) => {
  const actual = await importActual<typeof import("react-native")>();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      get OS() {
        return phone.os;
      },
    },
    Alert: {
      alert: (title: string, message?: string, buttons?: ReadonlyArray<AskButton>) => {
        phone.alerts.push({ title, message, buttons: buttons ?? [] });
      },
    },
  };
});
vi.mock("expo-notifications", () => ({
  requestPermissionsAsync: async () => ({ granted: true }),
  getPermissionsAsync: async () => ({ granted: true }),
  getExpoPushTokenAsync: async () => ({ data: "ExponentPushToken[this-phone]" }),
  dismissAllNotificationsAsync: async () => {
    phone.tray = [];
  },
  setBadgeCountAsync: async () => true,
}));
vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));
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

const { route } = await import("@/test/fake-router");

const PHONE_TOKEN = "ExponentPushToken[this-phone]";
const OWNER_CODE = "ABCD2345";
const A_SESSION_TITLE = "rotate the payroll keys";
const A_PROCESSES = "terminal payroll-export\nservice payroll-db";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Each machine's push devices: the tokens it pushes its sessions' titles to. */
const pushDevices = new Map<string, Set<string>>();
const pushDevicesOf = (machine: string): ReadonlyArray<string> => [
  ...(pushDevices.get(machine) ?? []),
];

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  if (url.pathname === "/api/pair") {
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
  const bearer = new Headers(init?.headers).get("authorization") ?? "";
  if (!bearer.startsWith(`Bearer token-${url.host}-`)) {
    return json({ _tag: "Unauthorized", message: "unknown token" }, 401);
  }
  const devices = pushDevices.get(url.host) ?? new Set<string>();
  pushDevices.set(url.host, devices);
  if (method === "POST" && url.pathname === "/api/devices") {
    const body: unknown = JSON.parse(String(init?.body));
    const token =
      typeof body === "object" && body !== null && "token" in body ? String(body.token) : "";
    devices.add(token);
    return json({ token, platform: phone.os });
  }
  const unregister = /^\/api\/devices\/(.+)$/.exec(url.pathname);
  if (method === "DELETE" && unregister?.[1] !== undefined) {
    devices.delete(decodeURIComponent(unregister[1]));
    return new Response(null, { status: 204 });
  }
  return json({ _tag: "NotFound", message: "not found" }, 404);
};

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const show = (node: ReactNode) => act(() => root.render(<PairingBoundary>{node}</PairingBoundary>));
const text = () => document.body.textContent ?? "";
const press = (label: string) => {
  const target = [...document.body.querySelectorAll<HTMLElement>("*")].find(
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

/** The pair screen as a scanned `mend://pair` link opens it: claim, then register for push. */
const pairByLink = async (machine: string) => {
  route.params = { u: `https://${machine}`, c: OWNER_CODE };
  act(() => root.render(null));
  show(<PairScreen />);
  await settle();
  expect(text()).toContain(`paired · https://${machine}`);
};

const pairedToAWithItsPushInTheTray = async () => {
  await pairByLink("a.example");
  expect(pushDevicesOf("a.example")).toEqual([PHONE_TOKEN]);
  phone.tray = [{ id: "push-a-1", title: A_SESSION_TITLE }];
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  Reflect.set(globalThis, "__DEV__", false);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  phone.os = "ios";
  phone.alerts = [];
  phone.tray = [];
  pushDevices.clear();
  route.params = {};
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

describe("push on a phone whose pairing ends", () => {
  it("stops at Unpair: the machine drops the phone and its notifications leave the tray", async () => {
    await pairedToAWithItsPushInTheTray();

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Unpair");
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(phone.tray).toEqual([]);
  });

  it("moves at a re-pair: the last machine drops the phone, the next one has it", async () => {
    await pairedToAWithItsPushInTheTray();

    await pairByLink("b.example");

    expect(pushDevicesOf("b.example")).toEqual([PHONE_TOKEN]);
    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(phone.tray).toEqual([]);
  });

  it("stops when Settings saves a connection to another machine", async () => {
    await pairedToAWithItsPushInTheTray();

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Advanced");
    type("https://mend.example.com", "https://b.example");
    type("token", "token-b.example-typed");
    press("Save");
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(phone.tray).toEqual([]);
  });
});

let askOfPairing: Ask | null = null;
const Questions = () => {
  askOfPairing = useAsk();
  return <AskDialog />;
};
const askNow = (): Ask => {
  if (askOfPairing === null) throw new Error("no pairing has asked yet");
  return askOfPairing;
};
const askToReplace = (onReplace: () => void) =>
  act(() =>
    askNow()("Replace this workspace now?", A_PROCESSES, [
      { text: "Cancel", style: "cancel" },
      { text: "Replace this workspace now", style: "destructive", onPress: onReplace },
    ]),
  );

describe.each(["ios", "android"])("a question with Platform.OS %s, on react-native-web", (os) => {
  beforeEach(() => {
    phone.os = os;
  });

  it("waits in the pairing's dialog, not an OS alert, and its button acts once", async () => {
    await pairByLink("a.example");
    show(<Questions />);
    const replace = vi.fn();
    askToReplace(replace);

    expect(text()).toContain(A_PROCESSES);
    press("Replace this workspace now");
    expect(replace).toHaveBeenCalledOnce();
    expect(text()).not.toContain(A_PROCESSES);
  });

  it("closes with the pairing's queue at a re-pair, and never acts", async () => {
    await pairByLink("a.example");
    show(<Questions />);
    const replace = vi.fn();
    askToReplace(replace);

    await pairByLink("b.example");
    show(<Questions />);

    expect(phone.alerts.map(({ message }) => message)).not.toContain(A_PROCESSES);
    expect(text()).not.toContain(A_PROCESSES);
    expect(replace).not.toHaveBeenCalled();
  });
});
