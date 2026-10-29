// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AskDialog, useAsk } from "@/components/ask";
import { useAgentConversation } from "@/data/agent-conversation";
import type { Ask } from "@/data/ask";
import { clearConfig, loadConfig, saveConfig, useSession } from "@/data/live";
import { HttpPairingClient, type PairingDevice } from "@/data/pairing-client";
import { PairingBoundary } from "@/data/pairing-scope";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);
vi.mock("expo-notifications", () => ({}));

const SESSION = "session-a";
const A_HEADER = "rotate the payroll keys";
const A_PROMPT = "print the payroll export for March";
const A_REPLY = "Here is the March payroll export";
const A_LATE = "The April export is attached";

const OWNER_CODE = "ABCD2345";
const OTHER_ACCOUNT_CODE = "EFGH6789";
const OWNER_TOKEN = `token-a.example-${OWNER_CODE}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ _tag: "NotFound", message: "session not found" }, 404);

const at = "2026-10-29T12:00:00.000Z";
const accountA = {
  session: {
    id: SESSION,
    projectId: "project-a",
    harness: "codex",
    label: A_HEADER,
    branch: "mend/payroll",
    baseSha: "0".repeat(40),
    baseRef: "main",
    status: "completed",
    createdAt: at,
  },
  checkpoints: [],
  change: null,
  processes: [],
  currentAgent: null,
};
const turnA = {
  id: "turn-a",
  ordinal: 1,
  input: A_PROMPT,
  status: "completed",
  error: null,
  createdAt: at,
};
const itemA = (seq: number, text: string) => ({
  id: `item-a-${seq}`,
  seq,
  turnId: "turn-a",
  kind: "agent_message",
  status: "completed",
  title: null,
  text,
  data: null,
  createdAt: at,
  updatedAt: at,
});

const pairedAs = (host: string, code: string) => ({
  url: `https://${host}`,
  token: `token-${host}-${code}`,
  device: { name: "Test phone" },
  user: { id: `user-${host}-${code}`, name: host, email: `${host}@example.com` },
});

let requests: Array<{ readonly line: string; readonly bearer: string | null }> = [];
let ownerAnswersHeld: Array<() => void> | null = null;
let ownerItems = [itemA(1, A_REPLY)];

const answerOwner = (url: URL): Response => {
  if (url.pathname === `/api/sessions/${SESSION}`) return json(accountA);
  if (url.pathname === `/api/sessions/${SESSION}/turns`) return json([turnA]);
  if (url.pathname === `/api/sessions/${SESSION}/items`) {
    const after = Number(url.searchParams.get("after"));
    return json(ownerItems.filter((item) => item.seq > after));
  }
  if (url.pathname === `/api/sessions/${SESSION}/requests`) return json([]);
  return notFound();
};

const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const bearer = new Headers(init?.headers).get("authorization");
  requests.push({ line: `${url.host} ${url.pathname}${url.search}`, bearer });
  if (url.pathname === "/api/pair") {
    const body: unknown = JSON.parse(String(init?.body));
    const code =
      typeof body === "object" && body !== null && "code" in body ? String(body.code) : "";
    return json(pairedAs(url.host, code));
  }
  if (url.host !== "a.example" || bearer !== `Bearer ${OWNER_TOKEN}`) return notFound();
  const held = ownerAnswersHeld;
  if (held === null) return answerOwner(url);
  return new Promise((resolve) => held.push(() => resolve(answerOwner(url))));
};

const SessionReader = ({ sessionId }: { readonly sessionId: string }) => {
  const detail = useSession(sessionId);
  const conversation = useAgentConversation(sessionId, true, true);
  return (
    <div>
      <p>{detail.data?.session.label}</p>
      {conversation.data?.turns.map((turn) => (
        <p key={turn.id}>{turn.input}</p>
      ))}
      {conversation.data?.items.map((item) => (
        <p key={item.id}>{item.text}</p>
      ))}
    </div>
  );
};

const device: PairingDevice = { name: "Test phone", platform: "web" };
const pairing = new HttpPairingClient({ saveConfig });
const pair = async (host: string, code = OWNER_CODE) => {
  const outcome = await act(() => pairing.claim({ url: `https://${host}`, code }, device));
  expect(outcome.state).toBe("paired");
};

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const mount = (node: ReactNode) =>
  act(() => root.render(<PairingBoundary>{node}</PairingBoundary>));
const text = () => document.body.textContent ?? "";
const expectNothingOfA = () => {
  expect(text()).not.toContain(A_HEADER);
  expect(text()).not.toContain(A_PROMPT);
  expect(text()).not.toContain(A_REPLY);
  expect(text()).not.toContain(A_LATE);
};
const itemReadsAfter = (hostName: string) =>
  requests
    .filter(({ line }) => line.startsWith(`${hostName} /api/sessions/${SESSION}/items`))
    .map(({ line }) => new URL(`https://${line.split(" ")[1]}`).searchParams.get("after"));

const readAsOwner = async () => {
  await pair("a.example");
  mount(<SessionReader sessionId={SESSION} />);
  await settle();
  expect(text()).toContain(A_HEADER);
  expect(text()).toContain(A_PROMPT);
  expect(text()).toContain(A_REPLY);
  requests = [];
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  requests = [];
  ownerAnswersHeld = null;
  ownerItems = [itemA(1, A_REPLY)];
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

describe("a conversation under a pairing", () => {
  it("is gone the moment the phone pairs to another machine, and stays gone", async () => {
    await readAsOwner();

    await pair("b.example");
    expectNothingOfA();

    await settle();
    expect(requests.some(({ line }) => line.startsWith("b.example /api/sessions/"))).toBe(true);
    expectNothingOfA();
    expect(itemReadsAfter("b.example")).toEqual(["0"]);
  });

  it("is gone after Unpair", async () => {
    await readAsOwner();

    await act(() => clearConfig());
    expectNothingOfA();
    await settle();
    expectNothingOfA();
  });

  it("is gone after pairing to another account on the same machine", async () => {
    await readAsOwner();

    await pair("a.example", OTHER_ACCOUNT_CODE);
    expectNothingOfA();
    await settle();
    expectNothingOfA();
    expect(itemReadsAfter("a.example")).toEqual(["0"]);
  });

  it("never takes an answer A's machine sends after the re-pair", async () => {
    await readAsOwner();
    ownerAnswersHeld = [];
    ownerItems = [itemA(1, A_REPLY), itemA(2, A_LATE)];
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    const held = ownerAnswersHeld;
    expect(held.length).toBeGreaterThan(0);

    await pair("b.example");
    ownerAnswersHeld = null;
    await act(async () => {
      for (const release of held) release();
    });
    await settle();
    expectNothingOfA();
  });

  it("starts empty when the phone pairs back to the first account", async () => {
    await readAsOwner();
    await pair("b.example");
    await settle();

    ownerAnswersHeld = [];
    await pair("a.example");
    expectNothingOfA();
    await settle();
    expectNothingOfA();
    expect(itemReadsAfter("a.example")).toEqual(["0"]);
  });

  it("stays when the same connection is saved again without its trailing slash", async () => {
    await readAsOwner();
    const config = await loadConfig();
    await act(() => saveConfig({ ...config, url: `${config.url}/` }));
    await act(() => saveConfig(config));
    expect(text()).toContain(A_HEADER);
    expect(text()).toContain(A_REPLY);
  });

  it("stays when the screens above the pairing mount afresh", async () => {
    await readAsOwner();
    ownerAnswersHeld = [];
    await act(() =>
      root.render(
        <div key="remounted">
          <PairingBoundary>
            <SessionReader sessionId={SESSION} />
          </PairingBoundary>
        </div>,
      ),
    );
    expect(text()).toContain(A_HEADER);
    expect(text()).toContain(A_PROMPT);
    expect(text()).toContain(A_REPLY);
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
const press = (label: string) => {
  const target = [...document.body.querySelectorAll<HTMLElement>("*")].find(
    (element) => element.children.length === 0 && element.textContent === label,
  );
  if (target === undefined) throw new Error(`no ${label} button on screen`);
  act(() => target.click());
};
const remountQuestions = () =>
  act(() =>
    root.render(
      <div key="remounted">
        <PairingBoundary>
          <Questions />
        </PairingBoundary>
      </div>,
    ),
  );

describe("a question on the web dialog", () => {
  it("is not left on screen once the pairing it was asked under ends", async () => {
    await pair("a.example");
    mount(<Questions />);
    act(() => askNow()("Stop this session?", A_HEADER, [{ text: "Stop session" }]));
    expect(text()).toContain(A_HEADER);

    await pair("b.example");
    expect(text()).not.toContain(A_HEADER);
  });

  it("never shows under the next pairing what the last one's late callback asks", async () => {
    await pair("a.example");
    mount(<Questions />);
    const askUnderA = askNow();

    await pair("b.example");
    act(() => askUnderA("Image not pasted", A_PROMPT));
    expect(text()).not.toContain(A_PROMPT);

    act(() => askNow()("Image not pasted", "nothing on the clipboard"));
    expect(text()).toContain("nothing on the clipboard");
  });

  it("stays, with its buttons working, when the screens above the pairing mount afresh", async () => {
    await pair("a.example");
    mount(<Questions />);
    const stop = vi.fn();
    const later = vi.fn();
    act(() => askNow()("Stop this session?", A_HEADER, [{ text: "Stop session", onPress: stop }]));
    const askBeforeRemount = askNow();
    expect(text()).toContain(A_HEADER);

    remountQuestions();
    expect(text()).toContain(A_HEADER);
    press("Stop session");
    expect(stop).toHaveBeenCalledOnce();
    expect(text()).not.toContain(A_HEADER);

    act(() =>
      askBeforeRemount("Image not pasted", A_PROMPT, [{ text: "Try again", onPress: later }]),
    );
    expect(text()).toContain(A_PROMPT);
    press("Try again");
    expect(later).toHaveBeenCalledOnce();

    act(() => askBeforeRemount("Image not pasted", A_REPLY));
    await pair("b.example");
    expect(text()).not.toContain(A_REPLY);
  });
});
