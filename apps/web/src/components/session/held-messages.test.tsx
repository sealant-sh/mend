// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { holdUntilStarted, readOutbox } from "#/lib/outbox";
import { TRPCProvider, trpcLinks, useTRPC } from "#/lib/trpc";

import type { AppRouter } from "../../server/routers/index.ts";
import { HeldMessagesCourier } from "./held-messages";

const SESSION = "s-1";
const scope = { userId: "ada", sessionId: SESSION };

/** What the server says of the session now: starting with no agent, or running its opening turn. */
type Stage = "starting" | "running";

const detailAt = (stage: Stage) => ({
  session: {
    id: SESSION,
    status: stage,
    harness: "codex",
    importedConversationWaiting: false,
  },
  currentAgent:
    stage === "starting"
      ? null
      : { kind: "agent-protocol", status: "running", exitedAt: null, protocolOptions: null },
  control: { steer: true },
});

const openingTurn = {
  id: "t-1",
  sessionId: SESSION,
  ordinal: 0,
  origin: "request",
  author: "ada",
  billedUserId: "ada",
  billedAccountName: null,
  steerSender: "ada",
  fromSteer: null,
  clientMessageId: null,
  steers: [],
  input: "Tell me about this repo",
  status: "running",
  error: null,
  createdAt: new Date("2026-11-21T00:00:00Z"),
  startedAt: new Date("2026-11-21T00:00:01Z"),
  endedAt: null,
  unreachable: null,
  selection: null,
};

/** One string field of a request's input, as the server reads it. */
const field = (input: unknown, name: string): string => {
  const value: unknown =
    typeof input === "object" && input !== null ? Reflect.get(input, name) : null;
  return typeof value === "string" ? value : "";
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
beforeEach(() => {
  sessionStorage.clear();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

/** Who is signed in, read as the app reads it before any page draws. */
function SignedIn() {
  const trpc = useTRPC();
  useQuery(trpc.organization.current.queryOptions());
  return null;
}

/**
 * The frame's courier alone, no session page open, against a server whose answers follow
 * `stage`; every message sent is kept, in the order it went.
 */
const mount = () => {
  let stage: Stage = "starting";
  const sent: Array<{ readonly input: string; readonly clientMessageId: string }> = [];
  const asked: Array<string> = [];
  const answer = (procedure: string, input: unknown): unknown => {
    asked.push(procedure);
    switch (procedure) {
      case "organization.current":
        return { userId: "ada" };
      case "sessions.detail":
        return detailAt(stage);
      case "sessions.historyItems":
        return { items: [], next: null, feed: 0 };
      case "sessions.historyTurns":
        return { turns: stage === "starting" ? [] : [openingTurn] };
      case "sessions.historyRequests":
        return { requests: [] };
      case "sessions.sendMessage": {
        sent.push({
          input: field(input, "input"),
          clientMessageId: field(input, "clientMessageId"),
        });
        return {
          _tag: "Steer",
          messageId: `m-${sent.length}`,
          steer: {
            id: `st-${sent.length}`,
            delivery: { _tag: "Accepted", evidence: "provider-acknowledged" },
          },
          explanation: "sent · the agent acknowledged it",
        };
      }
      default:
        return null;
    }
  };
  // A batch names its procedures in the path and carries their inputs by position in the body.
  const fetch = (url: URL | RequestInfo, init?: { readonly body?: unknown }) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const procedures = decodeURIComponent(new URL(href).pathname.replace("/trpc/", ""))
      .split(",")
      .filter((name) => name !== "");
    const body: Record<string, { readonly json?: unknown }> =
      typeof init?.body === "string" && init.body !== "" ? JSON.parse(init.body) : {};
    const results = procedures.map((procedure, index) => ({
      result: { data: serialize(answer(procedure, body[String(index)]?.json)) },
    }));
    return Promise.resolve(
      new Response(JSON.stringify(results), { headers: { "content-type": "application/json" } }),
    );
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  const client = createTRPCClient<AppRouter>({ links: trpcLinks("http://web.test/trpc", fetch) });
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  act(() =>
    mounted.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <SignedIn />
          <HeldMessagesCourier />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  return {
    sent,
    asked,
    /** The session moves on, and the event stream marks its reads stale, as it does for every page. */
    advance: async (next: Stage) => {
      stage = next;
      await act(() => queryClient.invalidateQueries());
    },
  };
};

const settle = () => act(() => vi.waitFor(() => Promise.resolve()));

describe("messages sent while a session started (SLNT-1232)", () => {
  it("go once its agent runs and its opening turn is in, in order, with the session's page closed", async () => {
    holdUntilStarted(scope, "Also the README.", "k-1");
    holdUntilStarted(scope, "And the tests.", "k-2");
    const server = mount();
    // The courier has read the session and its conversation: it is starting, so nothing leaves.
    await vi.waitFor(() =>
      expect(server.asked).toEqual(
        expect.arrayContaining(["sessions.detail", "sessions.historyTurns"]),
      ),
    );
    await settle();
    expect(server.sent).toEqual([]);
    expect(readOutbox(scope).map((message) => message.state._tag)).toEqual(["Waiting", "Waiting"]);

    await server.advance("running");
    await vi.waitFor(() =>
      expect(server.sent).toEqual([
        { input: "Also the README.", clientMessageId: "k-1" },
        { input: "And the tests.", clientMessageId: "k-2" },
      ]),
    );
    // Each answer stays on its message until the conversation holds it: nothing is waiting now.
    await vi.waitFor(() =>
      expect(readOutbox(scope).some((message) => message.state._tag === "Waiting")).toBe(false),
    );
  });
});
