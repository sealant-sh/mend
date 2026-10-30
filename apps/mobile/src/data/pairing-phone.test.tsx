// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "@/app/(tabs)/settings";
import PairScreen from "@/app/pair";
import { AskDialog, useAsk } from "@/components/ask";
import type { Ask, AskButton } from "@/data/ask";
import { clearConfig, loadConfig, saveConfig } from "@/data/live";
import { PairingBoundary } from "@/data/pairing-scope";

interface OsAlert {
  readonly title: string;
  readonly message: string | undefined;
  readonly buttons: ReadonlyArray<AskButton>;
}

const phone = vi.hoisted(() => ({
  os: "ios",
  notificationsAllowed: true,
  /** Alerts the OS shows in its own window: only a press on one of its buttons closes one. */
  alerts: new Array<OsAlert>(),
  /** Notifications delivered and still in the OS tray. */
  tray: new Array<{ readonly id: string; readonly title: string }>(),
  permissionPrompts: 0,
  slowTokenLookups: new Array<Promise<{ readonly data: string }>>(),
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
  requestPermissionsAsync: async () => {
    if (!phone.notificationsAllowed) phone.permissionPrompts += 1;
    return { granted: phone.notificationsAllowed };
  },
  getPermissionsAsync: async () => ({ granted: phone.notificationsAllowed }),
  getExpoPushTokenAsync: () =>
    phone.slowTokenLookups.shift() ?? Promise.resolve({ data: "ExponentPushToken[this-phone]" }),
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

let requests = new Array<{ readonly machine: string; readonly call: string }>();
const callsTo = (machine: string): ReadonlyArray<string> =>
  requests.filter((entry) => entry.machine === machine).map(({ call }) => call);
const deviceCallsTo = (machine: string) =>
  callsTo(machine).filter((call) => call.includes(" /api/devices"));
const unregistersOf = (machine: string) =>
  callsTo(machine).filter((call) => call.startsWith("DELETE /api/devices/"));
const unregisterFailures = new Map<string, "unreachable" | "silent">();
const registrationAnswers = new Array<
  { readonly after: Promise<void>; readonly answer: "accepted" | "lost" } | "never"
>();
const holdNextRegistration = (answer: "accepted" | "lost" = "accepted") => {
  const release = Promise.withResolvers<void>();
  registrationAnswers.push({ after: release.promise, answer });
  return release;
};
const silence = (init: RequestInit | undefined): Promise<Response> =>
  new Promise((_, reject) =>
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
  );

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  requests.push({ machine: url.host, call: `${method} ${url.pathname}` });
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
    const held = registrationAnswers.shift();
    if (held === "never") return silence(init);
    if (held !== undefined) await held.after;
    const body: unknown = JSON.parse(String(init?.body));
    const token =
      typeof body === "object" && body !== null && "token" in body ? String(body.token) : "";
    devices.add(token);
    if (held?.answer === "lost") throw new TypeError("Network request failed");
    return json({ token, platform: phone.os });
  }
  const unregister = /^\/api\/devices\/(.+)$/.exec(url.pathname);
  if (method === "DELETE" && unregister?.[1] !== undefined) {
    if (unregisterFailures.get(url.host) === "unreachable")
      throw new TypeError("Network request failed");
    if (unregisterFailures.get(url.host) === "silent") return silence(init);
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
const pairByLink = async (machine: string, code = OWNER_CODE) => {
  route.params = { u: `https://${machine}`, c: code };
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
  phone.notificationsAllowed = true;
  phone.alerts = [];
  phone.tray = [];
  phone.permissionPrompts = 0;
  phone.slowTokenLookups = [];
  pushDevices.clear();
  requests = [];
  unregisterFailures.clear();
  registrationAnswers.length = 0;
  route.params = {};
  await clearConfig();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // The pairing's cache outlives an unmount: end the pairing where the boundary sees it, with no
  // pair screen left to claim its link again.
  show(null);
  await act(() => clearConfig());
  await settle();
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

  it("moves to a new token Settings saves for the same machine, without asking to notify", async () => {
    await pairedToAWithItsPushInTheTray();

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Advanced");
    type("token", "token-a.example-rotated");
    press("Save");
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([PHONE_TOKEN]);
    expect(deviceCallsTo("a.example").slice(-2)).toEqual([
      `DELETE /api/devices/${encodeURIComponent(PHONE_TOKEN)}`,
      "POST /api/devices",
    ]);
    expect((await loadConfig()).pushToken).toBe(PHONE_TOKEN);
    expect(phone.permissionPrompts).toBe(0);
  });

  it("never asks to notify when Settings saves a new token on a phone that has not allowed it", async () => {
    await pairedToAWithItsPushInTheTray();
    phone.notificationsAllowed = false;

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Advanced");
    type("token", "token-a.example-rotated");
    press("Save");
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(deviceCallsTo("a.example").at(-1)).toBe(
      `DELETE /api/devices/${encodeURIComponent(PHONE_TOKEN)}`,
    );
    expect(phone.permissionPrompts).toBe(0);
  });

  it("keeps the phone and the token the machine accepted through a Save of the same pairing", async () => {
    await pairedToAWithItsPushInTheTray();
    show(null);

    const saved = await loadConfig();
    await act(() => saveConfig({ ...saved, deviceName: null, pairedAt: null }));
    await settle();

    expect(unregistersOf("a.example")).toEqual([]);
    expect(pushDevicesOf("a.example")).toEqual([PHONE_TOKEN]);
    expect(phone.tray).toHaveLength(1);

    phone.notificationsAllowed = false;
    await act(() => clearConfig());
    await settle();
    expect(pushDevicesOf("a.example")).toEqual([]);
  });

  it("asks the machine once when Unpair runs twice", async () => {
    await pairedToAWithItsPushInTheTray();
    show(null);

    await act(() => clearConfig());
    await act(() => clearConfig());
    await settle();

    expect(unregistersOf("a.example")).toHaveLength(1);
    expect(pushDevicesOf("a.example")).toEqual([]);
  });

  it("clears the tray and unpairs when the machine cannot be reached", async () => {
    await pairedToAWithItsPushInTheTray();
    unregisterFailures.set("a.example", "unreachable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Unpair");
    await settle();

    expect(phone.tray).toEqual([]);
    expect(text()).toContain("Not paired");
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("DELETE /api/devices");
    expect(logged).not.toContain(PHONE_TOKEN);
    expect(logged).not.toContain("token-a.example");
  });

  it("gives up on a machine that never answers, and the next one still gets the phone", async () => {
    await pairedToAWithItsPushInTheTray();
    unregisterFailures.set("a.example", "silent");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await pairByLink("b.example");
    expect(phone.tray).toEqual([]);
    expect(pushDevicesOf("b.example")).toEqual([]);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pushDevicesOf("b.example")).toEqual([PHONE_TOKEN]);
  });

  it("unregisters a registration the machine accepts after Unpair, and keeps nothing of it", async () => {
    const registration = holdNextRegistration();
    await pairByLink("a.example");
    show(null);

    await act(() => clearConfig());
    await settle();
    registration.resolve();
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(await loadConfig()).toMatchObject({ url: "", token: "", pushToken: null });
  });

  it("unregisters a registration whose answer was lost, once Unpair runs", async () => {
    const registration = holdNextRegistration("lost");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pairByLink("a.example");
    show(null);

    await act(() => clearConfig());
    await settle();
    registration.resolve();
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([]);
    expect(await loadConfig()).toMatchObject({ url: "", token: "", pushToken: null });
  });

  it("keeps the next pairing's registration when the last one's lands after a re-pair on the same machine", async () => {
    const registration = holdNextRegistration();
    await pairByLink("a.example");

    await pairByLink("a.example", "EFGH6789");
    registration.resolve();
    await settle();
    await settle();

    expect(pushDevicesOf("a.example")).toEqual([PHONE_TOKEN]);
    expect((await loadConfig()).pushToken).toBe(PHONE_TOKEN);
  });

  it("gives up on a token lookup after Unpair that never ends, and sends nothing for it once it does", async () => {
    phone.notificationsAllowed = false;
    await act(() =>
      saveConfig({
        url: "https://a.example",
        token: "token-a.example-typed",
        deviceName: null,
        pairedAt: null,
      }),
    );
    phone.notificationsAllowed = true;
    const lookup = Promise.withResolvers<{ readonly data: string }>();
    phone.slowTokenLookups.push(lookup.promise);
    await act(() => clearConfig());
    await settle();

    await pairByLink("b.example");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(pushDevicesOf("b.example")).toEqual([PHONE_TOKEN]);

    lookup.resolve({ data: PHONE_TOKEN });
    await settle();
    expect(unregistersOf("a.example")).toEqual([]);
  });

  it("gives up on a registration the machine never answers, and the next machine still gets the phone", async () => {
    registrationAnswers.push("never");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pairByLink("a.example");

    await pairByLink("b.example");
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    expect(pushDevicesOf("b.example")).toEqual([PHONE_TOKEN]);
    expect(pushDevicesOf("a.example")).toEqual([]);
  });

  it("re-pairing on the same machine unregisters the last pairing before registering the next", async () => {
    await pairedToAWithItsPushInTheTray();

    await pairByLink("a.example", "EFGH6789");

    expect(pushDevicesOf("a.example")).toEqual([PHONE_TOKEN]);
    expect(callsTo("a.example")).toEqual([
      "POST /api/pair",
      "POST /api/devices",
      "POST /api/pair",
      `DELETE /api/devices/${encodeURIComponent(PHONE_TOKEN)}`,
      "POST /api/devices",
    ]);
  });

  it("registers once when Enable notifications is pressed again while it runs", async () => {
    await pairedToAWithItsPushInTheTray();
    const registration = holdNextRegistration();

    act(() => root.render(null));
    show(<SettingsScreen />);
    press("Enable notifications");
    press("Registering…");
    registration.resolve();
    await settle();

    expect(callsTo("a.example").filter((call) => call === "POST /api/devices")).toHaveLength(2);
    expect(text()).toContain("registered");
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
