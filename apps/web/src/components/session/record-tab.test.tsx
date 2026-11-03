// @vitest-environment jsdom
import { SessionId } from "@mend/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { deserialize, serialize, type SuperJSONResult } from "superjson";
import { afterEach, describe, expect, it } from "vitest";

import { conversationQuery } from "#/lib/conversation";
import { makeTrpcProxy, TRPCProvider } from "#/lib/trpc";
import type { AppRouter } from "#/server/routers/index";

import { RecordTab } from "./record-tab.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 10, minute));
const turn = (ordinal: number) => ({
  id: `turn-${ordinal}`,
  sessionId: "s-1",
  ordinal,
  origin: "request",
  author: "dana",
  billedUserId: null,
  billedAccountName: null,
  steerSender: null,
  fromSteer: null,
  steers: [],
  input: `turn ${ordinal}`,
  status: "completed",
  error: null,
  createdAt: at(ordinal * 10),
  startedAt: at(ordinal * 10),
  endedAt: at(ordinal * 10 + 5),
});
const item = (ordinal: number, kind: string, words: string) => ({
  id: `item-${ordinal}`,
  seq: ordinal,
  turnId: `turn-${ordinal}`,
  kind,
  status: "completed",
  title: kind === "command-execution" ? words : null,
  text: kind === "assistant-message" ? words : null,
  data: null,
  createdAt: at(ordinal * 10 + 1),
  updatedAt: at(ordinal * 10 + 1),
});

/** Two windows: the newest holds turn 2's words; the one before it, turn 1's old command. */
const WINDOWS: Record<
  string,
  { readonly turn: number; readonly item: object; readonly next: string | null }
> = {
  newest: { turn: 2, item: item(2, "assistant-message", "Newest words."), next: "before-2" },
  "before-2": { turn: 1, item: item(1, "command-execution", "pnpm test --filter old"), next: null },
};

const answer = (path: string, input: Record<string, unknown>): unknown => {
  const window = WINDOWS[typeof input["cursor"] === "string" ? input["cursor"] : "newest"];
  if (window === undefined) throw new Error(`no window ${String(input["cursor"])}`);
  switch (path) {
    case "sessions.historyItems":
      return { items: [window.item], next: window.next, feed: 2 };
    case "sessions.historyTurns":
      return { turns: [turn(window.turn)], next: window.next };
    case "sessions.historyRequests":
      return { requests: [], next: window.next };
    case "screens.log":
      return [];
    default:
      throw new Error(`not read by the Record: ${path}`);
  }
};

/** An earlier window's read fails while this is set. */
let olderFails = false;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  olderFails = false;
  act(() => root?.unmount());
  host?.remove();
});

const render = async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (url, init) => {
          const path = new URL(url.toString()).pathname.split("/").at(-1) ?? "";
          const query = new URL(url.toString()).searchParams.get("input");
          const sent: SuperJSONResult | undefined =
            typeof init?.body === "string"
              ? JSON.parse(init.body)
              : query === null
                ? undefined
                : JSON.parse(query);
          const input =
            sent === undefined ? {} : (deserialize<Record<string, unknown>>(sent) ?? {});
          if (olderFails && input["cursor"] === "before-2")
            return Response.json(
              {
                error: serialize({
                  message: "the server is restarting",
                  code: -32603,
                  data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
                }),
              },
              { status: 500 },
            );
          return Response.json({ result: { data: serialize(answer(path, input)) } });
        },
      }),
    ],
  });
  // The newest window, as the session's loader leaves it.
  await queryClient.fetchInfiniteQuery(
    conversationQuery(makeTrpcProxy(queryClient), client, "s-1"),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={client} queryClient={queryClient}>
          <RecordTab
            facts={{
              agent: "Codex",
              viewer: null,
              nameOf: (userId: string) => userId,
              session: { id: SessionId.make("s-1"), sealantRunId: null },
              detail: { checkpoints: [] },
            }}
          />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
};

const text = () => host?.textContent ?? "";
const button = (name: string) => {
  const found = [...(host?.querySelectorAll("button") ?? [])].find(
    (each) => each.textContent?.trim() === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
};
const until = async (check: () => boolean) => {
  for (let tick = 0; tick < 100 && !check(); tick += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
};

describe("the Record of a long session, read a window at a time", () => {
  it("says it shows part of the history, and finds an old command once it reads the rest", async () => {
    await render();
    expect(text()).toContain("Newest words.");
    expect(text()).toContain("earlier history is not read yet");
    expect(text()).not.toContain("pnpm test --filter old");

    // A filter over what is held says it is so far, not that there is none.
    await act(async () => button("Commands").click());
    expect(text()).toContain("Nothing of this kind in the history read so far.");

    await act(async () => button("Read all of it").click());
    await until(() => text().includes("pnpm test --filter old"));
    expect(text()).toContain("pnpm test --filter old");
    expect(text()).not.toContain("earlier history is not read yet");
  });

  it("keeps what it shows when an earlier window fails, and says why", async () => {
    olderFails = true;
    await render();
    await act(async () => button("Read earlier history").click());
    await until(() => text().includes("Earlier history did not load"));
    expect(text()).toContain("Earlier history did not load: the server is restarting");
    expect(text()).toContain("Newest words.");
    expect(text()).not.toContain("The record did not load");
  });
});
