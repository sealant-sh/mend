// @vitest-environment jsdom
import { ITEM_PAGE_SIZE } from "@mend/agent-conversation";
import { onlineManager } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalPane } from "@/components/terminal-pane";
import { useAgentConversation, useTurnSender, type TurnSender } from "@/data/agent-conversation";
import { NO_ANSWER } from "@/data/failure-words";
import { useComposerAttachments, type ComposerAttachments } from "@/data/image-attach";
import { useAdoptProject, useSessionActions } from "@/data/live";
import { PairingEnded, type Machine } from "@/data/machine";
import { HttpPairingClient, type PairingDevice } from "@/data/pairing-client";
import { clearConfig, saveConfig } from "@/data/pairing-config";
import { PairingBoundary, usePairing } from "@/data/pairing-scope";
import { useUnreachable } from "@/data/reachability";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));
vi.mock("expo", () => ({
  requireNativeView: () => {
    throw new Error("no native terminal in this binary");
  },
}));
vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: ({ children }: { readonly children: ReactNode }) => children,
  useKeyboardState: () => ({ height: 0, isVisible: false }),
}));
vi.mock("expo-clipboard", () => ({}));
vi.mock("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
}));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg" },
  ImageManipulator: {
    manipulate: (source: string | { readonly uri?: string }) => {
      const uri = typeof source === "string" ? source : (source.uri ?? "");
      return {
        resize: () => undefined,
        release: () => undefined,
        renderAsync: async () => ({
          uri,
          width: 1200,
          height: 900,
          release: () => undefined,
          saveAsync: async () => ({ base64: btoa(`bytes of ${uri}`) }),
        }),
      };
    },
  },
}));

const SESSION = "session-a";
const OWNER_CODE = "ABCD2345";
const FIRST_WORDS = "rotate the payroll keys";
const SECOND_WORDS = "and mail March's payroll export to the auditors";
const A_PHOTO = "file:///photos/payroll-march.jpg";
const A_SECOND_PHOTO = "file:///photos/payroll-april.jpg";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const at = "2026-10-30T12:00:00.000Z";
const turn = (id: string, input: string) => ({
  id,
  ordinal: 1,
  input,
  status: "queued",
  error: null,
  createdAt: at,
});
const item = (seq: number) => ({
  id: `item-a-${seq}`,
  seq,
  turnId: "turn-a",
  kind: "agent_message",
  status: "completed",
  title: null,
  text: `line ${seq}`,
  data: null,
  createdAt: at,
  updatedAt: at,
});

const bearerOf = (machine: string, authorization: string | null): string =>
  authorization === `Bearer token-a.example-${OWNER_CODE}`
    ? "A's bearer"
    : authorization === `Bearer token-b.example-${OWNER_CODE}`
      ? "B's bearer"
      : `another bearer (${machine})`;

let received: Array<{ readonly machine: string; readonly line: string }> = [];
const isPushFarewell = (line: string) => line.startsWith("DELETE /api/devices ");
const workReceivedBy = (machine: string): ReadonlyArray<string> =>
  received
    .filter((entry) => entry.machine === machine && !isPushFarewell(entry.line))
    .map(({ line }) => line);

type Outcome = "answer" | "drop";
const holds = new Map<string, Array<(outcome: Outcome) => void>>();
const hold = (call: string) => holds.set(call, []);
const release = (call: string, outcome: Outcome = "answer") => {
  const waiting = holds.get(call) ?? [];
  holds.delete(call);
  for (const settle of waiting) settle(outcome);
};
const droppedCalls = new Set<string>();
const abortedCalls: Array<string> = [];
const offlineHosts = new Set<string>();

const answerA = (method: string, url: URL, body: unknown): Response => {
  if (method === "POST" && url.pathname === `/api/sessions/${SESSION}/turns`) {
    const input =
      typeof body === "object" && body !== null && "input" in body ? String(body.input) : "";
    return json(turn(`turn-${input.length}`, input));
  }
  if (method === "POST" && url.pathname === "/api/projects/project-a/sessions") {
    return json({ id: SESSION, projectId: "project-a", status: "created" });
  }
  if (url.pathname === "/api/upgrade-tickets") return json({ _tag: "NotFound" }, 404);
  if (url.pathname === "/api/organization/members") return json([]);
  if (url.pathname === "/api/projects") return json([]);
  if (url.pathname === `/api/sessions/${SESSION}/turns`) return json([]);
  if (url.pathname === `/api/sessions/${SESSION}/requests`) return json([]);
  if (url.pathname === `/api/sessions/${SESSION}/items`) {
    const after = Number(url.searchParams.get("after"));
    return json(
      after === 0 ? Array.from({ length: ITEM_PAGE_SIZE }, (_, index) => item(index + 1)) : [],
    );
  }
  return json({}, 200);
};

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const call = `${method} ${url.pathname}`;
  if (url.pathname === "/api/pair") {
    const claim: unknown = JSON.parse(String(init?.body));
    const code =
      typeof claim === "object" && claim !== null && "code" in claim ? String(claim.code) : "";
    return json({
      url: `https://${url.host}`,
      token: `token-${url.host}-${code}`,
      device: { name: "Test phone" },
      user: { id: `user-${url.host}`, name: url.host, email: `${url.host}@example.com` },
    });
  }
  const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  const bearer = bearerOf(url.host, new Headers(init?.headers).get("authorization"));
  received.push({
    machine: url.host,
    line: `${call}${url.search} with ${bearer}${body === undefined ? "" : ` ${JSON.stringify(body)}`}`,
  });
  if (offlineHosts.has(url.host)) throw new TypeError("Network request failed");
  if (url.host !== "a.example") return json({ _tag: "NotFound", message: "not found" }, 404);
  if (droppedCalls.has(call)) throw new TypeError("Network request failed");
  const waiting = holds.get(call);
  if (waiting === undefined) return answerA(method, url, body);
  return new Promise((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      abortedCalls.push(call);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
    waiting.push((outcome) => {
      if (outcome === "drop") reject(new TypeError("Network request failed"));
      else resolve(answerA(method, url, body));
    });
  });
};

const heldUploads: Array<() => void> = [];
const abortedUploads: Array<string> = [];
class FakeXhr {
  status = 0;
  responseText = "";
  timeout = 0;
  readonly upload = { addEventListener: () => undefined };
  #method = "";
  #url = "";
  #headers = new Map<string, string>();
  #listeners = new Map<string, () => void>();
  #aborted = false;
  open(method: string, url: string) {
    this.#method = method;
    this.#url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.#headers.set(name.toLowerCase(), value);
  }
  addEventListener(name: string, listener: () => void) {
    this.#listeners.set(name, listener);
  }
  abort() {
    if (this.#aborted) return;
    this.#aborted = true;
    abortedUploads.push(`${this.#method} ${new URL(this.#url).pathname}`);
    this.#listeners.get("abort")?.();
  }
  send(raw: string) {
    const url = new URL(this.#url);
    const body: unknown = JSON.parse(raw);
    const contents =
      typeof body === "object" && body !== null && "contentsBase64" in body
        ? atob(String(body.contentsBase64))
        : "";
    received.push({
      machine: url.host,
      line: `${this.#method} ${url.pathname} with ${bearerOf(url.host, this.#headers.get("authorization") ?? null)} [${contents}]`,
    });
    if (offlineHosts.has(url.host)) {
      this.#listeners.get("error")?.();
      return;
    }
    const answer = () => {
      if (this.#aborted) return;
      this.status = url.host === "a.example" ? 200 : 404;
      this.responseText = JSON.stringify(
        url.host === "a.example"
          ? {
              path: `/workspace/.mend/images/${heldUploads.length}.jpg`,
              mediaType: "image/jpeg",
              bytes: 3,
            }
          : { _tag: "NotFound", message: "not found" },
      );
      this.#listeners.get("load")?.();
    };
    if (url.host === "a.example") heldUploads.push(answer);
    else answer();
  }
}

const device: PairingDevice = { name: "Test phone", platform: "web" };
const pairing = new HttpPairingClient({ saveConfig });
const pair = async (host: string) => {
  const outcome = await act(() =>
    pairing.claim({ url: `https://${host}`, code: OWNER_CODE }, device),
  );
  expect(outcome.state).toBe("paired");
};

let root: Root;
let host: HTMLDivElement;

const settle = (ms = 10) => act(() => vi.advanceTimersByTimeAsync(ms));
const mount = (node: ReactNode) =>
  act(() => root.render(<PairingBoundary>{node}</PairingBoundary>));

let latest: {
  sender?: TurnSender;
  images?: ComposerAttachments;
  adopt?: ReturnType<typeof useAdoptProject>;
  actions?: ReturnType<typeof useSessionActions>;
  unreachable?: boolean;
  machine?: Machine;
} = {};
const Composer = () => {
  latest.sender = useTurnSender(SESSION);
  latest.images = useComposerAttachments(SESSION);
  return null;
};
const Adopter = () => {
  latest.adopt = useAdoptProject();
  return null;
};
const Starter = () => {
  latest.actions = useSessionActions();
  return null;
};
const Reader = () => {
  useAgentConversation(SESSION, true, false);
  return null;
};
const Reachability = () => {
  latest.unreachable = useUnreachable(usePairing().machine.key);
  return null;
};
const Grab = () => {
  latest.machine = usePairing().machine;
  return null;
};
const OnlyUnderA = ({ children }: { readonly children: ReactElement }) =>
  usePairing().config.url === "https://a.example" ? children : null;
const the = <K extends keyof typeof latest>(key: K): NonNullable<(typeof latest)[K]> => {
  const value = latest[key];
  if (value === undefined) throw new Error(`no ${key} mounted`);
  return value;
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  received = [];
  holds.clear();
  droppedCalls.clear();
  abortedCalls.length = 0;
  offlineHosts.clear();
  heldUploads.length = 0;
  abortedUploads.length = 0;
  latest = {};
  await clearConfig();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(() => clearConfig());
  act(() => root.unmount());
  host.remove();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("work pairing A started, after the phone pairs to B", () => {
  it("sends A's queued second message to A with A's bearer, and nothing to B", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Composer />
      </OnlyUnderA>,
    );
    hold(`POST /api/sessions/${SESSION}/turns`);
    act(() => {
      the("sender").send(FIRST_WORDS, []);
      the("sender").send(SECOND_WORDS, []);
    });
    await settle();
    expect(workReceivedBy("a.example")).toEqual([
      `POST /api/sessions/${SESSION}/turns with A's bearer {"input":"${FIRST_WORDS}"}`,
    ]);

    await pair("b.example");
    release(`POST /api/sessions/${SESSION}/turns`);
    await settle();

    expect(workReceivedBy("a.example")).toEqual([
      `POST /api/sessions/${SESSION}/turns with A's bearer {"input":"${FIRST_WORDS}"}`,
      `POST /api/sessions/${SESSION}/turns with A's bearer {"input":"${SECOND_WORDS}"}`,
    ]);
    expect(workReceivedBy("b.example")).toEqual([]);
  });

  it("stops watching for the project a dropped clone under A was adopting", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Adopter />
      </OnlyUnderA>,
    );
    droppedCalls.add("POST /api/projects");
    act(() => the("adopt").mutate({ name: "payroll", source: "git@example.com:acme/payroll" }));
    await settle(3_010);
    const beforeTheEnd = [
      'POST /api/projects with A\'s bearer {"name":"payroll","source":"git@example.com:acme/payroll"}',
      "GET /api/projects with A's bearer",
    ];
    expect(workReceivedBy("a.example")).toEqual(beforeTheEnd);

    await pair("b.example");
    await settle(9_000);

    expect(workReceivedBy("a.example")).toEqual(beforeTheEnd);
    expect(workReceivedBy("b.example")).toEqual([]);
  });

  it("uploads none of A's queued photos once A ends", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Composer />
      </OnlyUnderA>,
    );
    act(() =>
      the("images").attach([
        { uri: A_PHOTO, name: "march.jpg" },
        { uri: A_SECOND_PHOTO, name: "april.jpg" },
      ]),
    );
    await settle();
    const beforeTheEnd = [
      `POST /api/sessions/${SESSION}/images with A's bearer [bytes of ${A_PHOTO}]`,
    ];
    expect(workReceivedBy("a.example")).toEqual(beforeTheEnd);

    await pair("b.example");
    act(() => heldUploads.shift()?.());
    await settle();

    expect(workReceivedBy("a.example")).toEqual(beforeTheEnd);
    expect(workReceivedBy("b.example")).toEqual([]);
  });

  it("launches A's new session on A with A's bearer, and sends B nothing", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Starter />
      </OnlyUnderA>,
    );
    hold("POST /api/projects/project-a/sessions");
    act(() => the("actions").start.mutate({ projectId: "project-a", harness: "codex" }));
    await settle();

    await pair("b.example");
    release("POST /api/projects/project-a/sessions");
    await settle();

    expect(workReceivedBy("a.example")).toEqual([
      'POST /api/projects/project-a/sessions with A\'s bearer {"harness":"codex","mode":"protocol","label":null,"name":null,"base":null}',
      `POST /api/sessions/${SESSION}/launch with A's bearer {"mode":"protocol"}`,
    ]);
    expect(workReceivedBy("b.example")).toEqual([]);
  });

  it("reads no next page of A's conversation once A ends", async () => {
    await pair("a.example");
    hold(`GET /api/sessions/${SESSION}/items`);
    mount(
      <OnlyUnderA>
        <Reader />
      </OnlyUnderA>,
    );
    await settle();

    await pair("b.example");
    release(`GET /api/sessions/${SESSION}/items`);
    await settle();

    expect(received.filter(({ line }) => line.includes(`after=${ITEM_PAGE_SIZE}`))).toEqual([]);
    expect(workReceivedBy("b.example")).toEqual([]);
  });

  it("leaves B's out-of-reach mark alone when A's send fails late", async () => {
    await pair("a.example");
    mount(
      <>
        <Composer />
        <Reachability />
      </>,
    );
    hold(`POST /api/sessions/${SESSION}/turns`);
    act(() => void the("sender").send(FIRST_WORDS, []));
    await settle();

    offlineHosts.add("b.example");
    await pair("b.example");
    act(() => void the("sender").send(SECOND_WORDS, []));
    await settle();
    expect(the("unreachable")).toBe(true);

    release(`POST /api/sessions/${SESSION}/turns`, "drop");
    await settle();

    expect(the("unreachable")).toBe(true);
  });

  it("never asks B what A's refused terminal ticket means", async () => {
    await pair("a.example");
    hold("POST /api/upgrade-tickets");
    mount(
      <OnlyUnderA>
        <TerminalPane sessionId={SESSION} />
      </OnlyUnderA>,
    );
    await settle();
    expect(workReceivedBy("a.example")).toContain(
      `POST /api/upgrade-tickets with A's bearer {"target":"tty-embed","session":"${SESSION}"}`,
    );

    await pair("b.example");
    release("POST /api/upgrade-tickets");
    await settle();

    expect(workReceivedBy("b.example")).toEqual([]);
  });
});

describe("work pairing A started, when its screens unmount before the phone pairs to B", () => {
  it("calls off A's read, refuses A's next read, and leaves B's mark alone", async () => {
    await pair("a.example");
    hold(`GET /api/sessions/${SESSION}/items`);
    mount(
      <>
        <Reader />
        <Grab />
      </>,
    );
    await settle();
    const machineOfA = the("machine");
    act(() => root.render(null));

    offlineHosts.add("b.example");
    await pair("b.example");
    mount(
      <>
        <Reader />
        <Reachability />
      </>,
    );
    await settle();
    expect(the("unreachable")).toBe(true);
    expect(abortedCalls).toEqual([`GET /api/sessions/${SESSION}/items`]);

    release(`GET /api/sessions/${SESSION}/items`, "drop");
    let late = "pending";
    act(
      () =>
        void machineOfA.read("/projects").then(
          () => (late = "answered"),
          (error: unknown) => (late = error instanceof PairingEnded ? "refused" : String(error)),
        ),
    );
    await settle();

    expect(late).toBe("refused");
    expect(
      workReceivedBy("a.example").filter((line) => line.startsWith("GET /api/projects")),
    ).toEqual([]);
    expect(the("unreachable")).toBe(true);
  });
});

describe("an upload under pairing A", () => {
  it("marks A out of reach when it gets no answer, and in reach once one lands", async () => {
    await pair("a.example");
    mount(
      <>
        <Composer />
        <Reachability />
      </>,
    );
    offlineHosts.add("a.example");
    act(() => the("images").attach([{ uri: A_PHOTO, name: "march.jpg" }]));
    await settle();
    expect(the("unreachable")).toBe(true);

    offlineHosts.delete("a.example");
    act(() => the("images").attach([{ uri: A_SECOND_PHOTO, name: "april.jpg" }]));
    await settle();
    act(() => heldUploads.shift()?.());
    await settle();
    expect(the("unreachable")).toBe(false);
  });
});

describe("work pairing A started, after the phone unpairs", () => {
  it("settles a Stop asked for while offline, instead of dropping it", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Starter />
      </OnlyUnderA>,
    );
    offlineHosts.add("a.example");
    act(() => onlineManager.setOnline(false));
    let stopped = "pending";
    act(
      () =>
        void the("actions")
          .stop.mutateAsync(SESSION)
          .then(
            () => (stopped = "stopped"),
            (error: unknown) => (stopped = error instanceof Error ? error.message : String(error)),
          ),
    );
    await settle();

    await act(() => clearConfig());
    offlineHosts.delete("a.example");
    act(() => onlineManager.setOnline(true));
    await settle();

    expect(stopped).toBe(NO_ANSWER);
    expect(workReceivedBy("a.example")).toEqual([
      `POST /api/sessions/${SESSION}/stop with A's bearer {}`,
    ]);
  });

  it("calls off A's photo upload in flight", async () => {
    await pair("a.example");
    mount(
      <OnlyUnderA>
        <Composer />
      </OnlyUnderA>,
    );
    act(() => the("images").attach([{ uri: A_PHOTO, name: "march.jpg" }]));
    await settle();
    expect(workReceivedBy("a.example")).toEqual([
      `POST /api/sessions/${SESSION}/images with A's bearer [bytes of ${A_PHOTO}]`,
    ]);

    await act(() => clearConfig());
    await settle();

    expect(abortedUploads).toEqual([`POST /api/sessions/${SESSION}/images`]);
  });
});

describe("work pairing A started, after a Save that keeps the same machine", () => {
  it("reads A's next page from A with A's bearer", async () => {
    await pair("a.example");
    hold(`GET /api/sessions/${SESSION}/items`);
    mount(<Reader />);
    await settle();

    await act(() =>
      saveConfig({
        url: "https://a.example/",
        token: `token-a.example-${OWNER_CODE}`,
        deviceName: "Renamed phone",
        pairedAt: null,
      }),
    );
    release(`GET /api/sessions/${SESSION}/items`);
    await settle();

    expect(
      workReceivedBy("a.example").filter((line) => line.includes(`after=${ITEM_PAGE_SIZE}`)),
    ).toEqual([
      `GET /api/sessions/${SESSION}/items?after=${ITEM_PAGE_SIZE}&limit=${ITEM_PAGE_SIZE} with A's bearer`,
    ]);
  });
});
