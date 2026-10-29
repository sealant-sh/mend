// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentConversation } from "@/data/agent-conversation";
import { saveConfig, useSession } from "@/data/live";
import { HttpPairingClient, type PairingDevice } from "@/data/pairing-client";

vi.mock("@react-native-async-storage/async-storage", async () => ({
  default: (await import("@/test/memory-storage")).storage,
}));
vi.mock("expo-secure-store", async () => (await import("@/test/memory-storage")).secureStore);

const SESSION = "session-a";
const A_HEADER = "rotate the payroll keys";
const A_PROMPT = "print the payroll export for March";
const A_REPLY = "Here is the March payroll export";

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
const replyA = {
  id: "item-a",
  seq: 1,
  turnId: "turn-a",
  kind: "agent_message",
  status: "completed",
  title: null,
  text: A_REPLY,
  data: null,
  createdAt: at,
  updatedAt: at,
};

const pairedAs = (host: string) => ({
  url: `https://${host}`,
  token: `token-${host}`,
  device: { name: "Test phone" },
  user: { id: `user-${host}`, name: host, email: `${host}@example.com` },
});

// Two machines, one account each. Only machine A's account owns the session.
const serve = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  if (url.pathname === "/api/pair") return json(pairedAs(url.host));
  const bearer = new Headers(init?.headers).get("authorization");
  if (url.host !== "a.example" || bearer !== "Bearer token-a.example") return notFound();
  if (url.pathname === `/api/sessions/${SESSION}`) return json(accountA);
  if (url.pathname === `/api/sessions/${SESSION}/turns`) return json([turnA]);
  if (url.pathname === `/api/sessions/${SESSION}/items`) {
    return json(url.searchParams.get("after") === "0" ? [replyA] : []);
  }
  if (url.pathname === `/api/sessions/${SESSION}/requests`) return json([]);
  return notFound();
};

/** What the session screen reads for one session: its header and its conversation. */
const SessionReader = ({ sessionId }: { readonly sessionId: string }) => {
  const detail = useSession(sessionId);
  const conversation = useAgentConversation(sessionId, true, false);
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
const pair = (host: string) =>
  act(() => pairing.claim({ url: `https://${host}`, code: "ABCD2345" }, device));

let root: Root;
let host: HTMLDivElement;
// One client for the app's whole life, as `app/_layout.tsx` holds it.
let client: QueryClient;

const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const show = (node: ReactNode) =>
  act(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
const text = () => host.textContent ?? "";

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(serve));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a conversation under a pairing", () => {
  it("is not readable once the phone is paired to another account", async () => {
    const first = await pair("a.example");
    expect(first.state).toBe("paired");
    show(<SessionReader sessionId={SESSION} />);
    await settle();
    expect(text()).toContain(A_HEADER);
    expect(text()).toContain(A_PROMPT);
    expect(text()).toContain(A_REPLY);

    show(null);
    const second = await pair("b.example");
    expect(second.state).toBe("paired");
    show(<SessionReader sessionId={SESSION} />);
    await settle();

    expect(text()).not.toContain(A_HEADER);
    expect(text()).not.toContain(A_PROMPT);
    expect(text()).not.toContain(A_REPLY);
  });
});
