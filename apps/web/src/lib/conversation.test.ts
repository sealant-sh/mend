// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { deserialize, serialize, type SuperJSONResult } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeConversationPatcher, skipsTurns, withChanges } from "./conversation-live.ts";
import { conversationQuery, heldConversation } from "./conversation.ts";
import { browserTrpcClient, makeTrpcProxy } from "./trpc.ts";

const trpcClient = browserTrpcClient();

const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 10, minute));

const turn = (ordinal: number) => ({
  id: `turn-${ordinal}`,
  sessionId: "s",
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
  endedAt: at(ordinal * 10 + 1),
});

const item = (ordinal: number, n: number) => ({
  id: `item-${ordinal}-${n}`,
  seq: ordinal * 10 + n,
  turnId: `turn-${ordinal}`,
  kind: "assistant-message",
  status: "completed",
  title: null,
  text: `item ${ordinal}.${n}`,
  data: null,
  createdAt: at(ordinal * 10 + n),
  updatedAt: at(ordinal * 10 + n),
});

/** Five turns of two items each; windows of three items, newest first, as the API answers. */
const turns = [1, 2, 3, 4, 5].map(turn);
const items = turns.flatMap((row) => [item(row.ordinal, 1), item(row.ordinal, 2)]);
const LIMIT = 3;

let calls: Array<{ readonly path: string; readonly input: Record<string, unknown> }>;

const ordinalOf = (id: string) => Number(id.split("-")[1]);

/** The API's window: the newest `limit` items before the cursor, and the turn range they cover. */
const windowOf = (cursor: string | null) => {
  const ordered = items.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const start = cursor === null ? 0 : ordered.findIndex((row) => row.id === cursor) + 1;
  const held = ordered.slice(start, start + LIMIT);
  const from = Math.min(...held.map((row) => ordinalOf(row.turnId)));
  const to = cursor === null ? Infinity : ordinalOf(ordered[start - 1]?.turnId ?? "turn-0");
  const oldest = held.at(-1);
  const next = oldest !== undefined && start + LIMIT < ordered.length ? oldest.id : null;
  return { held: held.toReversed(), from, to, next };
};

const answer = (path: string, input: Record<string, unknown>): unknown => {
  const cursor = typeof input["cursor"] === "string" ? input["cursor"] : null;
  const window = windowOf(cursor);
  switch (path) {
    case "sessions.historyItems":
      return { items: window.held, next: window.next, feed: 52 };
    case "sessions.historyTurns":
      return {
        turns: turns.filter((row) => row.ordinal >= window.from && row.ordinal <= window.to),
        next: window.next,
      };
    case "sessions.historyRequests":
      return { requests: [], next: window.next };
    case "sessions.items": {
      // What changed after the feed cursor, oldest first, as the event stream's reads ask.
      const after = typeof input["after"] === "number" ? input["after"] : 0;
      const limit = typeof input["limit"] === "number" ? input["limit"] : 100;
      return items
        .filter((row) => row.seq > after)
        .toSorted((a, b) => a.seq - b.seq)
        .slice(0, limit);
    }
    default:
      throw new Error(`no read of the whole history, or anything else: ${path}`);
  }
};

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { readonly body?: unknown }) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://web.test");
    const paths = url.pathname.replace("/trpc/", "").split(",");
    const body: Record<string, SuperJSONResult> =
      typeof init?.body === "string" ? JSON.parse(init.body) : {};
    return Response.json(
      paths.map((path, index) => {
        const sent = body[String(index)];
        const decoded =
          sent === undefined ? {} : (deserialize<Record<string, unknown>>(sent) ?? {});
        calls.push({ path, input: decoded });
        return { result: { data: serialize(answer(path, decoded)) } };
      }),
    );
  });
});

afterEach(() => vi.unstubAllGlobals());

const world = () => {
  const queryClient = new QueryClient();
  const trpc = makeTrpcProxy(queryClient);
  const options = conversationQuery(trpc, trpcClient, "s", () => undefined, LIMIT);
  return { queryClient, options };
};

const texts = (view: { readonly items: ReadonlyArray<{ readonly text: string | null }> }) =>
  view.items.map((row) => row.text).toSorted();

describe("a conversation read newest first, a window at a time", () => {
  it("reads only the newest window at first: its items, its turns and their requests, in one request", async () => {
    const { queryClient, options } = world();
    const data = await queryClient.fetchInfiniteQuery(options);
    const view = heldConversation(data.pages);
    expect(texts(view)).toEqual(["item 4.2", "item 5.1", "item 5.2"]);
    expect(view.turns.map((row) => row.ordinal)).toEqual([4, 5]);
    expect(calls.map((call) => call.path).toSorted()).toEqual([
      "sessions.historyItems",
      "sessions.historyRequests",
      "sessions.historyTurns",
    ]);
    expect(calls.every((call) => call.input["cursor"] === null)).toBe(true);
  });

  it("reads older windows by the cursor the newer one answered, until the start", async () => {
    const { queryClient, options } = world();
    // Ten items, three a window: the fourth window reaches the start.
    const data = await queryClient.fetchInfiniteQuery({ ...options, pages: 10, staleTime: 0 });
    expect(data.pages).toHaveLength(4);
    expect(data.pages.at(-1)?.next).toBeNull();
    expect(
      calls
        .filter((call) => call.path === "sessions.historyItems")
        .map((call) => call.input["cursor"]),
    ).toEqual([null, ...data.pages.slice(0, -1).map((page) => page.next)]);
    const view = heldConversation(data.pages);
    expect(texts(view)).toHaveLength(10);
    expect(view.turns.map((row) => row.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes the event stream's changes into the pages that hold their turns", async () => {
    const { queryClient, options } = world();
    const data = await queryClient.fetchInfiniteQuery(options);
    const grown = { ...item(5, 3), seq: 60 };
    const older = { ...item(1, 1), seq: 61, text: "changed" };
    const changed = { ...item(5, 1), seq: 62, text: "edited" };
    const patched = withChanges(data, {
      items: [grown, older, changed].map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      turns: [],
      requests: [],
    });
    const view = heldConversation(patched.pages);
    // Turn 1 is not held: its item waits for that turn's window.
    expect(texts(view)).toEqual(["edited", "item 4.2", "item 5.2", "item 5.3"]);
    expect(patched.pages[0]?.feed).toBe(62);
  });
});

describe("a held conversation after the tab slept", () => {
  it("reads the newest window again when changes skip a turn no page holds, and pages back to it", async () => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    // The page's own key; the fake API answers windows of three items whatever is asked.
    const options = conversationQuery(trpc, trpcClient, "s");
    await queryClient.fetchInfiniteQuery(options);
    // Meanwhile another device's follow-ups ran turns 6 and 7; the newest window holds 7 alone.
    const added = [turn(6), turn(7)];
    const addedItems = [item(6, 1), item(6, 2), item(7, 1), item(7, 2), item(7, 3)];
    turns.push(...added);
    items.push(...addedItems);
    try {
      makeConversationPatcher(queryClient, trpc, trpcClient).all();
      for (let tick = 0; tick < 50; tick += 1) {
        const held = queryClient.getQueryData(options.queryKey);
        if (held?.pages[0]?.turns.some((row) => row.ordinal === 7)) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const replaced = queryClient.getQueryData(options.queryKey);
      // One window, the newest, in place of the ones held: nothing moved the feed past turn 6.
      expect(replaced?.pages).toHaveLength(1);
      expect(texts(heldConversation(replaced?.pages ?? []))).toEqual([
        "item 7.1",
        "item 7.2",
        "item 7.3",
      ]);
      const all = await queryClient.fetchInfiniteQuery({ ...options, pages: 10, staleTime: 0 });
      const view = heldConversation(all.pages);
      expect(view.turns.map((row) => row.ordinal)).toContain(6);
      expect(texts(view)).toEqual(expect.arrayContaining(["item 6.1", "item 6.2"]));
    } finally {
      turns.splice(turns.length - added.length);
      items.splice(items.length - addedItems.length);
    }
  });

  it("patches as before when only an older turn's item changed (a request answered late)", async () => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    const data = await queryClient.fetchInfiniteQuery(
      conversationQuery(trpc, trpcClient, "s", () => undefined, LIMIT),
    );
    const late = { ...item(1, 1), seq: 60, text: "answered late" };
    expect(
      skipsTurns(data, {
        items: [late].map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        turns: [],
        requests: [],
      }),
    ).toBe(false);
  });
});
