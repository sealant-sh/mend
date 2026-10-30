// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => Reflect.set(globalThis, "__DEV__", false));

/**
 * The phone's storage, outliving a restart (`restart`). Anything but the pairing waits on
 * `reads`/`writes` while they are held, and a write fails while `failing`.
 */
const device = vi.hoisted(() => {
  const values = new Map<string, string>();
  const gates = { reads: Promise.resolve(), writes: Promise.resolve(), failing: false };
  const PAIRING = "mend-config";
  const read = async (key: string | null) => {
    if (key !== PAIRING) await gates.reads;
  };
  const write = async (key: string | null) => {
    if (key === PAIRING) return;
    await gates.writes;
    if (gates.failing) throw new Error("storage full");
  };
  const storage = {
    getItem: async (key: string) => {
      await read(key);
      return values.get(key) ?? null;
    },
    setItem: async (key: string, value: string) => {
      await write(key);
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      await write(key);
      values.delete(key);
    },
    getAllKeys: async () => {
      await read(null);
      return [...values.keys()];
    },
    getMany: async (keys: ReadonlyArray<string>) => {
      await read(null);
      return Object.fromEntries(keys.map((key) => [key, values.get(key) ?? null]));
    },
    removeMany: async (keys: ReadonlyArray<string>) => {
      await write(null);
      for (const key of keys) values.delete(key);
    },
  };
  return { values, gates, storage };
});
vi.mock("@react-native-async-storage/async-storage", () => ({ default: device.storage }));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));
vi.mock("expo-constants", () => ({ default: { expoConfig: null } }));
vi.mock("expo-device", () => ({ deviceName: "Test phone", modelName: null }));
vi.mock("expo-router", async () => (await import("@/test/fake-router")).fakeExpoRouter);
vi.mock("react-native-webview", () => import("@/test/fake-webview"));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardStickyView: ({ children }: { readonly children: ReactNode }) => children,
  useKeyboardState: () => ({ height: 0, isVisible: false }),
}));
vi.mock("@legendapp/list/react-native", async () => {
  const { View } = await import("react-native");
  return {
    LegendList: <T,>({
      data,
      renderItem,
      ListFooterComponent,
      ListEmptyComponent,
    }: {
      readonly data: ReadonlyArray<T>;
      readonly renderItem: (row: { readonly item: T }) => ReactNode;
      readonly ListFooterComponent?: ReactNode;
      readonly ListEmptyComponent?: ReactNode;
    }) => (
      <View>
        {data.length === 0 ? ListEmptyComponent : data.map((item) => renderItem({ item }))}
        {ListFooterComponent}
      </View>
    ),
  };
});
vi.mock("@/components/markdown", () => ({
  MendMarkdown: ({ children }: { readonly children: string }) => children,
}));
vi.mock("react-native-reanimated", async () => ({
  default: { View: (await import("react-native")).View },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: () => ({}),
  withRepeat: (value: number) => value,
  withSequence: (value: number) => value,
  withTiming: (value: number) => value,
}));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("lucide-react-native", () => ({
  GitMerge: () => null,
  GitPullRequest: () => null,
  GitPullRequestClosed: () => null,
  ImagePlus: () => null,
  Maximize2: () => null,
  X: () => null,
}));
vi.mock("expo-clipboard", () => ({ hasImageAsync: async () => false }));
vi.mock("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async () => ({
    canceled: false,
    assets: [{ uri: "file:///shot.jpg", fileName: "shot.jpg" }],
  }),
}));
vi.mock("expo-image-manipulator", () => {
  const rendered = {
    width: 100,
    height: 100,
    release: () => undefined,
    saveAsync: async () => ({ base64: "aGVsbG8=" }),
  };
  const context = {
    resize: () => undefined,
    renderAsync: async () => rendered,
    release: () => undefined,
  };
  return { ImageManipulator: { manipulate: () => context }, SaveFormat: { JPEG: "jpeg" } };
});

const WORDS = "rotate the payroll keys before the auditors log in";
const MORE = " and tell me which ones changed";
const UNCONFIRMED = "Message outcome not confirmed · check the session before sending again";
const NOT_LOADED = "your saved message could not be loaded yet · trying again";
const failedRead = () => new Error("temporary storage read failure");
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const at = "2026-10-30T12:00:00.000Z";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const turnWire = (id: string, status: string, startedAt: string | null) => ({
  id,
  sessionId: "s",
  processId: "p",
  ordinal: 1,
  author: "user-a.example",
  origin: "request",
  input: "earlier words",
  status,
  providerTurnId: null,
  error: null,
  createdAt: at,
  startedAt,
  endedAt: null,
});

const steerWire = (id: string, author: string, input: string, delivery: unknown) => ({
  id,
  sessionId: "s",
  processId: "p",
  turnId: "turn-running",
  author,
  ordinal: 1,
  input,
  delivery,
  queuedTurnId: null,
  clientSteerId: null,
  createdAt: at,
  updatedAt: at,
});

const steerReceipt = (delivery: unknown, explanation: string) => ({
  _tag: "Steer",
  messageId: "message-1",
  steer: steerWire("steer-1", "user-a.example", WORDS, delivery),
  explanation,
});

type Reply =
  | { readonly status: number; readonly body: unknown }
  | "drop"
  | "edge page"
  | "no such route";

const server = {
  replies: [] as Array<Reply>,
  posted: [] as Array<unknown>,
  turns: [] as Array<unknown>,
  members: [] as Array<{ readonly userId: string; readonly name: string }>,
  hold: false,
  release: null as null | (() => void),
  /** Sends the phone called off while they were held. */
  abandoned: 0,
  /** Conversation reads from here on never answer: what shows came with the receipt. */
  silent: false,
};

const answerMessage = async (body: unknown, signal: AbortSignal | null): Promise<Response> => {
  server.posted.push(body);
  if (server.hold) {
    await new Promise<void>((resolve, reject) => {
      server.release = resolve;
      signal?.addEventListener("abort", () => {
        server.abandoned += 1;
        reject(new DOMException("The request was aborted.", "AbortError"));
      });
    });
  }
  const reply = server.replies.shift() ?? {
    status: 200,
    body: steerReceipt({ _tag: "Accepted", evidence: "provider-acknowledged" }, "sent"),
  };
  if (reply === "drop") throw new TypeError("Network request failed");
  if (reply === "edge page") {
    return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 });
  }
  if (reply === "no such route") return new Response(null, { status: 404 });
  return json(reply.body, reply.status);
};

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
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
  if (method === "POST" && url.pathname.endsWith("/messages")) {
    return answerMessage(JSON.parse(String(init?.body)), init?.signal ?? null);
  }
  if (method === "POST") return json({ _tag: "NotFound", message: "not here" }, 404);
  if (url.pathname.endsWith("/turns")) {
    return server.silent ? new Promise<Response>(() => undefined) : json(server.turns);
  }
  if (url.pathname.endsWith("/items") || url.pathname.endsWith("/requests")) return json([]);
  if (url.pathname === "/api/organization/members") return json(server.members);
  if (url.pathname === "/api/organization") return json({ userId: "user-a.example" });
  return json({ _tag: "NotFound", message: "not here" }, 404);
};

const loadApp = async () => ({
  ...(await import("@/components/ask")),
  ...(await import("@/components/protocol-conversation")),
  ...(await import("@/data/pairing")),
  ...(await import("@/data/pairing-config")),
  ...(await import("@/data/pairing-scope")),
});
let app: Awaited<ReturnType<typeof loadApp>>;

let root: Root;
let host: HTMLDivElement;
let sessionCount = 0;
let session = "";
let logged: Array<string> = [];

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const show = (sessionId = session) =>
  act(() =>
    root.render(
      <app.PairingBoundary>
        <app.ProtocolConversation sessionId={sessionId} active summary={null} />
        <app.AskDialog />
      </app.PairingBoundary>,
    ),
  );
const hide = () => act(() => root.render(<app.PairingBoundary>{null}</app.PairingBoundary>));
/** The app is killed and opened again: only what reached the phone's storage is left. */
const restart = async () => {
  act(() => root.unmount());
  vi.resetModules();
  app = await loadApp();
  root = createRoot(host);
  await settle();
};
/** Holds the phone's storage until the returned function lets it go. */
const holds: Array<() => void> = [];
const holdStorage = (gate: "reads" | "writes"): (() => void) => {
  const held = Promise.withResolvers<void>();
  device.gates[gate] = held.promise;
  const letGo = () => {
    device.gates[gate] = Promise.resolve();
    held.resolve();
  };
  holds.push(letGo);
  return () => act(letGo);
};
const text = () => host.textContent ?? "";
const field = (): HTMLTextAreaElement => {
  const element = host.querySelector<HTMLTextAreaElement>(
    'textarea[placeholder="Message the session…"]',
  );
  if (element === null) throw new Error("no message field on screen");
  return element;
};
const type = (value: string) => {
  const element = field();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = (label: string) => {
  const target = [...document.body.querySelectorAll<HTMLElement>("*")].find(
    (element) => element.children.length === 0 && element.textContent === label,
  );
  if (target === undefined) throw new Error(`no ${label} button on screen`);
  act(() => target.click());
};
const send = async () => {
  press("Send");
  await settle();
};
const keyOf = (index: number): unknown => {
  const body = server.posted[index];
  return typeof body === "object" && body !== null && "clientMessageId" in body
    ? body.clientMessageId
    : undefined;
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  sessionCount += 1;
  session = `session-${sessionCount}`;
  Object.assign(server, {
    replies: [],
    posted: [],
    turns: [],
    members: [],
    hold: false,
    release: null,
    abandoned: 0,
    silent: false,
  });
  logged = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...parts: Array<unknown>) => {
      logged.push(parts.map(String).join(" "));
    });
  }
  Object.assign(device.gates, {
    reads: Promise.resolve(),
    writes: Promise.resolve(),
    failing: false,
  });
  app ??= await loadApp();
  await app.clearConfig();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() => app.claimPairing({ url: "https://a.example", code: "ABCD2345" }));
});

afterEach(async () => {
  for (const letGo of holds.splice(0)) letGo();
  device.gates.failing = false;
  await act(() => app.clearConfig());
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Send in a live conversation", () => {
  it("posts exactly the words and a UUID v4 key to the messages route", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(7),
    });
    show();
    await settle();
    type(WORDS);
    await send();
    expect(server.posted).toHaveLength(1);
    expect(Object.keys(server.posted[0] ?? {}).toSorted()).toEqual(["clientMessageId", "input"]);
    expect(server.posted[0]).toMatchObject({ input: WORDS });
    expect(keyOf(0)).toMatch(UUID_V4);
  });

  it("shows Mend's sentence as it came, and clears the draft", async () => {
    const explanation = "sent · the agent acknowledged it";
    server.replies.push({
      status: 200,
      body: steerReceipt({ _tag: "Accepted", evidence: "provider-acknowledged" }, explanation),
    });
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain(explanation);
    expect(field().value).toBe("");
  });

  it("can send while a turn runs, and waits only for Mend's answer", async () => {
    server.turns = [turnWire("turn-running", "running", at)];
    server.hold = true;
    show();
    await settle();
    expect(text()).toContain("Stop");
    type(WORDS);
    await send();
    expect(text()).toContain("Sending…");
    press("Sending…");
    await settle();
    expect(server.posted).toHaveLength(1);

    server.hold = false;
    act(() => server.release?.());
    await settle();
    type(WORDS);
    await send();
    expect(server.posted).toHaveLength(2);
  });

  it.each([
    [
      "a 409 MessageTargetAmbiguous",
      409,
      {
        _tag: "MessageTargetAmbiguous",
        sessionId: "s",
        message: "Mend could not tell which turn is yours · send it again",
      },
    ],
    [
      "a 403 SessionNotSteerable",
      403,
      {
        _tag: "SessionNotSteerable",
        sessionId: "s",
        message: "Only the owner steers this session.",
      },
    ],
  ])("keeps the draft and shows the server's words on %s", async (_, status, body) => {
    server.replies.push({ status, body });
    show();
    await settle();
    type(WORDS);
    await send();
    expect(field().value).toBe(WORDS);
    expect(text()).toContain(body.message);
    expect(logged.join("\n")).not.toContain(WORDS);
  });

  it.each([
    ["no answer", "drop"],
    ["an edge's page", "edge page"],
    ["an untagged 500", { status: 500, body: { error: "boom" } }],
  ] as const)(
    "says the outcome is not confirmed on %s, and sends again under the same key",
    async (_, reply) => {
      server.replies.push(reply);
      show();
      await settle();
      type(WORDS);
      await send();
      expect(text()).toContain(UNCONFIRMED);
      expect(field().value).toBe(WORDS);
      expect(logged.join("\n")).not.toContain(WORDS);

      await send();
      expect(server.posted).toHaveLength(2);
      expect(keyOf(1)).toBe(keyOf(0));
    },
  );

  it("says the server needs an update when it has no route for messages", async () => {
    server.replies.push("no such route");
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain("not sent · this Mend server is older than the app");
    expect(text()).not.toContain(UNCONFIRMED);
    expect(field().value).toBe(WORDS);
  });

  it("calls a send that never answers not confirmed, keeps its key, and frees the composer", async () => {
    server.hold = true;
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain("Sending…");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(text()).toContain(UNCONFIRMED);
    expect(field().readOnly).toBe(false);

    server.hold = false;
    await send();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("calls off a send in flight when the pairing ends", async () => {
    server.hold = true;
    show();
    await settle();
    type(WORDS);
    await send();
    hide();
    await act(() => app.clearConfig());
    await settle();
    expect(server.abandoned).toBe(1);
  });

  it("keeps the key when the words change after a lost answer", async () => {
    server.replies.push("drop");
    show();
    await settle();
    type(WORDS);
    await send();
    type(WORDS + MORE);
    await send();
    expect(server.posted[1]).toMatchObject({ input: WORDS + MORE });
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("makes a fresh key for the next message after Mend took one", async () => {
    show();
    await settle();
    type(WORDS);
    await send();
    type(MORE.trim());
    await send();
    expect(keyOf(0)).toMatch(UUID_V4);
    expect(keyOf(1)).toMatch(UUID_V4);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("says an earlier attempt was recorded on a key conflict, and keeps the key until the words change", async () => {
    const conflict = {
      status: 409,
      body: {
        _tag: "MessageKeyConflict",
        message: "This message key was already used for another request.",
      },
    };
    server.replies.push("drop", conflict, conflict);
    show();
    await settle();
    type(WORDS);
    await send();
    type(WORDS + MORE);
    await send();
    expect(field().value).toBe(WORDS + MORE);
    expect(text()).toContain(conflict.body.message);
    expect(text()).toContain("an earlier attempt of this message was recorded");

    await send();
    expect(keyOf(2)).toBe(keyOf(0));

    type(`${WORDS + MORE} now`);
    await send();
    expect(server.posted).toHaveLength(4);
    expect(keyOf(3)).toMatch(UUID_V4);
    expect(keyOf(3)).not.toBe(keyOf(0));
  });

  it.each([
    [{ _tag: "Unknown", reason: "uncertain" }, "delivery not confirmed · Mend will not resend"],
    [{ _tag: "Sending" }, "sending"],
  ])("keeps the draft and its key when delivery is %o", async (delivery, explanation) => {
    server.replies.push({ status: 200, body: steerReceipt(delivery, explanation) });
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain(explanation);
    expect(field().value).toBe(WORDS);
    await send();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it.each([
    [
      "a steer Mend could not deliver or queue",
      steerReceipt(
        { _tag: "NotSent", reason: "turn-ended" },
        "not sent · the running turn ended; the session could not take a next turn",
      ),
    ],
    [
      "a turn cancelled before it started",
      {
        _tag: "Turn",
        messageId: "message-1",
        turn: turnWire("turn-new", "cancelled", null),
        explanation: "not sent · the turn was cancelled before it started",
      },
    ],
  ])("keeps the words under a fresh key after %s", async (_, body) => {
    server.replies.push({ status: 200, body });
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain(body.explanation);
    expect(field().value).toBe(WORDS);
    await send();
    expect(keyOf(1)).toMatch(UUID_V4);
    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it("keeps the words and their key when the conversation closes and opens again", async () => {
    server.replies.push("drop");
    show();
    await settle();
    type(WORDS);
    await send();
    hide();
    await settle();
    show();
    await settle();
    expect(field().value).toBe(WORDS);
    await send();
    expect(keyOf(1)).toBe(keyOf(0));
  });
});

describe("Steers in the conversation", () => {
  const ACCEPTED = { _tag: "Accepted", evidence: "provider-acknowledged" };
  const occurrences = (words: string) => text().split(words).length - 1;

  it("shows the words a person steered with inside their turn, from the receipt", async () => {
    server.turns = [turnWire("turn-running", "running", at)];
    show();
    await settle();
    type(WORDS);
    server.silent = true;
    await send();
    expect(field().value).toBe("");
    expect(occurrences(WORDS)).toBe(1);
    expect(text()).toContain("you steered · the agent acknowledged it");
  });

  it("shows a teammate's steer as theirs", async () => {
    server.members = [{ userId: "user-maria", name: "Maria" }];
    server.turns = [
      {
        ...turnWire("turn-running", "running", at),
        steers: [steerWire("steer-9", "user-maria", "use the staging keys", ACCEPTED)],
        fromSteer: null,
      },
    ];
    show();
    await settle();
    expect(text()).toContain("use the staging keys");
    expect(text()).toContain("Maria steered · the agent acknowledged it");
  });

  it("shows a steer carried into the next turn once", async () => {
    const carried = "then rotate the staging keys too";
    server.turns = [
      {
        ...turnWire("turn-running", "completed", at),
        steers: [
          steerWire("steer-9", "user-a.example", carried, {
            _tag: "Queued",
            turnId: "turn-next",
            reason: "turn-ended",
          }),
        ],
        fromSteer: null,
      },
      {
        ...turnWire("turn-next", "running", at),
        ordinal: 2,
        input: carried,
        steers: [],
        fromSteer: "steer-9",
      },
    ];
    show();
    await settle();
    expect(occurrences(carried)).toBe(1);
  });
});

describe("Drafts on the phone", () => {
  const draftIn = async (sessionId: string) => {
    show(sessionId);
    await settle();
    const value = field().value;
    hide();
    return value;
  };
  const write = async (sessionId: string, words: string) => {
    show(sessionId);
    await settle();
    type(words);
    await settle();
    hide();
  };

  it("keeps other sessions' drafts when one opens before the stored drafts are read", async () => {
    await write(`${session}-a`, "draft for A");
    await write(`${session}-b`, "draft for B");

    const letGo = holdStorage("reads");
    await restart();
    show(`${session}-c`);
    await settle();
    expect(field().readOnly).toBe(true);
    type("typed in C before the read");
    await settle();
    letGo();
    await settle();
    hide();
    expect(await draftIn(`${session}-a`)).toBe("draft for A");
    expect(await draftIn(`${session}-b`)).toBe("draft for B");

    await restart();
    expect(await draftIn(`${session}-a`)).toBe("draft for A");
    expect(await draftIn(`${session}-b`)).toBe("draft for B");
  });

  const pairAs = async (code: string) => {
    hide();
    await act(() => app.clearConfig());
    await act(() => app.claimPairing({ url: "https://a.example", code }));
    show();
    await settle();
  };
  const stored = () => [...device.values.values()].join("\n");

  it("never shows, sends or keeps one account's draft under the next", async () => {
    server.replies.push("drop");
    show();
    await settle();
    type(WORDS);
    await send();
    type(WORDS + MORE);
    await settle();

    await pairAs("WXYZ6789");
    expect(field().value).toBe("");
    expect(text()).not.toContain(UNCONFIRMED);
    expect(stored()).not.toContain(WORDS);
    type("check the staging keys");
    await send();
    expect(server.posted[1]).toEqual({
      input: "check the staging keys",
      clientMessageId: expect.not.stringMatching(String(keyOf(0))),
    });

    await restart();
    show();
    await settle();
    expect(field().value).toBe("");
    expect(stored()).not.toContain(WORDS);
  });

  it("keeps a send that answers after the pairing changed out of the next account", async () => {
    const explanation = "delivery not confirmed · Mend will not resend";
    server.replies.push({
      status: 200,
      body: steerReceipt({ _tag: "Unknown", reason: "uncertain" }, explanation),
    });
    server.hold = true;
    show();
    await settle();
    type(WORDS);
    await send();

    await pairAs("WXYZ6789");
    act(() => server.release?.());
    await settle();
    expect(field().value).toBe("");
    expect(text()).not.toContain(explanation);
    expect(text()).not.toContain("Sending…");
    expect(stored()).not.toContain(WORDS);
  });

  it("sends only once the draft and its key are stored, and the same key after a restart", async () => {
    show();
    await settle();
    type(WORDS);
    await settle();
    const letGo = holdStorage("writes");
    await send();
    expect(server.posted).toHaveLength(0);

    server.hold = true;
    letGo();
    await settle();
    expect(server.posted).toHaveLength(1);

    await restart();
    show();
    await settle();
    expect(field().value).toBe(WORDS);
    await send();
    expect(server.posted).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("never takes typing over a draft it could not read, and shows it once a read succeeds", async () => {
    show();
    await settle();
    type(WORDS);
    await settle();

    vi.spyOn(device.storage, "getMany").mockRejectedValueOnce(failedRead());
    await restart();
    show();
    await settle();
    expect(field().readOnly).toBe(true);
    expect(text()).toContain(NOT_LOADED);
    type("new draft after the read failed");
    await settle();
    expect(stored()).toContain(WORDS);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(field().value).toBe(WORDS);
    expect(field().readOnly).toBe(false);
    expect(text()).not.toContain(NOT_LOADED);

    await restart();
    show();
    await settle();
    expect(field().value).toBe(WORDS);
  });

  it("sends an unconfirmed message it could not read at first under its own key", async () => {
    server.replies.push("drop");
    show();
    await settle();
    type(WORDS);
    await send();
    expect(text()).toContain(UNCONFIRMED);

    vi.spyOn(device.storage, "getMany").mockRejectedValueOnce(failedRead());
    await restart();
    show();
    await settle();
    type(WORDS);
    await send();
    expect(server.posted).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(field().value).toBe(WORDS);
    await send();
    expect(server.posted).toHaveLength(2);
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("reads the drafts again when the app comes back to the foreground", async () => {
    show();
    await settle();
    type(WORDS);
    await settle();

    const failing = vi.spyOn(device.storage, "getMany").mockRejectedValue(failedRead());
    await restart();
    show();
    await settle();
    expect(field().readOnly).toBe(true);

    failing.mockRestore();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(field().value).toBe(WORDS);
    expect(text()).not.toContain(NOT_LOADED);
  });

  it("does not send a draft it could not store, and says it was not sent", async () => {
    show();
    await settle();
    type(WORDS);
    await settle();
    device.gates.failing = true;
    await send();
    expect(server.posted).toHaveLength(0);
    expect(field().value).toBe(WORDS);
    expect(text()).toContain("not sent · the phone could not store the message");
  });
});

describe("Images in a message", () => {
  const STORED = "/workspace/.mend/images/1.jpg";
  /** The machine stores every image it is sent. */
  class StoringUpload {
    status = 0;
    responseText = "";
    readonly upload = { addEventListener: () => undefined };
    private readonly listeners = new Map<string, () => void>();
    open() {}
    setRequestHeader() {}
    abort() {}
    addEventListener(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ path: STORED, mediaType: "image/jpeg", bytes: 5 });
      queueMicrotask(() => this.listeners.get("load")?.());
    }
  }
  const attached = () => host.querySelector('[aria-label="Remove shot.jpg"]') !== null;

  it("starts the next message without the images the last one carried", async () => {
    vi.stubGlobal("XMLHttpRequest", StoringUpload);
    show();
    await settle();
    const attach = host.querySelector<HTMLElement>('[aria-label="Attach an image"]');
    act(() => attach?.click());
    await settle();
    press("Photo library");
    await settle();
    expect(attached()).toBe(true);
    type(WORDS);
    server.hold = true;
    await send();
    expect(server.posted[0]).toMatchObject({ input: expect.stringContaining(STORED) });

    hide();
    await settle();
    show();
    await settle();
    act(() => server.release?.());
    await settle();
    expect(attached()).toBe(false);

    type(MORE.trim());
    await send();
    expect(server.posted[1]).toMatchObject({ input: MORE.trim() });
  });
});
