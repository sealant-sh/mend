import { buildAgentConversation, type AgentItemDto } from "@mend/agent-conversation";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  pageCallFailureOf,
  pageFrameQuery,
  pageOf,
  pageOfItem,
  pageOfRoute,
  pageRouteParams,
  resolvePageUrl,
  transcriptPageOf,
  withPagesInPlace,
} from "./pages";
import { pairingKeyOf } from "./pairing-key";

const PAGE_WIRE = {
  id: "page-1",
  sessionId: "session-1",
  title: "Latency by route",
  height: 420,
  publishedAt: "2026-10-29T12:05:00.000Z",
};

const item = (
  id: string,
  createdAt: string,
  kind: string,
  data?: unknown,
  status = "completed",
): AgentItemDto => ({
  id,
  seq: 1,
  turnId: "turn-1",
  kind,
  status,
  title: kind,
  text: null,
  ...(data === undefined ? {} : { data }),
  createdAt,
  updatedAt: createdAt,
});

describe("pages in the protocol conversation", () => {
  const conversation = {
    turns: [
      {
        id: "turn-1",
        ordinal: 1,
        input: "chart it",
        status: "completed",
        error: null,
        createdAt: "2026-10-29T12:00:00.000Z",
      },
    ],
    items: [
      item("reply", "2026-10-29T12:06:00.000Z", "assistant-message"),
      item("page", "2026-10-29T12:05:00.000Z", "page", PAGE_WIRE),
      item("call", "2026-10-29T12:04:00.000Z", "tool-call", {
        mendPageCall: { attachmentId: "page-1", failure: null },
      }),
      item(
        "failed-call",
        "2026-10-29T12:03:00.000Z",
        "tool-call",
        { mendPageCall: { attachmentId: null, failure: { code: "too-tall", message: "100vh" } } },
        "failed",
      ),
    ],
    requests: [],
  };

  it("shows the page where it was published, without the call it replaces, and keeps a failed call", () => {
    const rows = withPagesInPlace(buildAgentConversation(conversation));
    expect(rows.map((row) => row.key)).toEqual([
      "turn:turn-1",
      "item:failed-call",
      "item:page",
      "item:reply",
    ]);
    const pageRow = rows[2];
    if (pageRow?.kind !== "item") throw new Error("no page row");
    expect(pageOfItem(pageRow.item)).toMatchObject({
      id: "page-1",
      title: "Latency by route",
      height: 420,
    });
  });

  it("keeps a call that failed after it named its page, with Mend's refusal as its line", () => {
    const failedAfterPublishing = item(
      "late-failure",
      "2026-10-29T12:04:30.000Z",
      "tool-call",
      { mendPageCall: { attachmentId: "page-1", failure: null } },
      "failed",
    );
    const rows = withPagesInPlace(
      buildAgentConversation({
        ...conversation,
        items: [...conversation.items, failedAfterPublishing],
      }),
    );
    expect(rows.map((row) => row.key)).toContain("item:late-failure");
    expect(rows.map((row) => row.key)).not.toContain("item:call");

    const failed = conversation.items.find((entry) => entry.id === "failed-call");
    if (failed === undefined) throw new Error("no failed call");
    expect(pageCallFailureOf(failed)).toBe("page not shown · 100vh");
    expect(pageCallFailureOf(failedAfterPublishing)).toBeNull();
    expect(pageCallFailureOf(item("x", "2026-10-29T12:00:00.000Z", "tool-call"))).toBeNull();
  });

  it("reads a page only from a page item with a whole ref", () => {
    expect(pageOfItem(item("x", "2026-10-29T12:05:00.000Z", "tool-call", PAGE_WIRE))).toBeNull();
    expect(
      pageOfItem(item("x", "2026-10-29T12:05:00.000Z", "page", { ...PAGE_WIRE, height: "420" })),
    ).toBeNull();
    expect(pageOf({ ...PAGE_WIRE, publishedAt: "yesterday" })).toBeNull();
    expect(pageOf(PAGE_WIRE)?.publishedAt.toISOString()).toBe(PAGE_WIRE.publishedAt);
  });
});

describe("pages in the terminal transcript", () => {
  it("reads the page a page event carries, and nothing from any other event", () => {
    expect(transcriptPageOf({ kind: "page", page: PAGE_WIRE })?.id).toBe("page-1");
    expect(transcriptPageOf({ kind: "tool", page: PAGE_WIRE })).toBeNull();
    expect(transcriptPageOf({ kind: "page" })).toBeNull();
  });
});

describe("the full-screen route", () => {
  const pairedA = pairingKeyOf({ url: "https://a.example", token: "token-a" });

  it("carries the whole ref and gives it back", () => {
    const page = pageOf(PAGE_WIRE);
    if (page === null) throw new Error("no page");
    expect(pageOfRoute(pageRouteParams(page, pairedA), pairedA)).toEqual(page);
  });

  it("opens nothing from a route missing a field or holding a repeated one", () => {
    const page = pageOf(PAGE_WIRE);
    if (page === null) throw new Error("no page");
    const { title: _title, ...untitled } = pageRouteParams(page, pairedA);
    expect(pageOfRoute(untitled, pairedA)).toBeNull();
    const { pairing: _pairing, ...unstamped } = pageRouteParams(page, pairedA);
    expect(pageOfRoute(unstamped, pairedA)).toBeNull();
    expect(pageOfRoute({ ...pageRouteParams(page, pairedA), id: ["a", "b"] }, pairedA)).toBeNull();
    expect(pageOfRoute({ ...pageRouteParams(page, pairedA), height: "tall" }, pairedA)).toBeNull();
  });

  it("shows nothing of a page opened under another pairing, not even its title", () => {
    const page = pageOf(PAGE_WIRE);
    if (page === null) throw new Error("no page");
    const params = pageRouteParams(page, pairedA);
    expect(
      pageOfRoute(params, pairingKeyOf({ url: "https://b.example", token: "token-b" })),
    ).toBeNull();
    expect(
      pageOfRoute(params, pairingKeyOf({ url: "https://a.example", token: "token-c" })),
    ).toBeNull();
  });
});

describe("the frame URL", () => {
  it("reaches the server's path at the paired URL, as the API calls do", () => {
    expect(resolvePageUrl("https://mend.example.com", "/api/page-view?view=t")).toBe(
      "https://mend.example.com/api/page-view?view=t",
    );
    expect(resolvePageUrl("http://10.0.0.40:3105/", "/api/page-view?view=t")).toBe(
      "http://10.0.0.40:3105/api/page-view?view=t",
    );
    expect(resolvePageUrl("https://mend.example.com", "https://pages.example.com/v?view=t")).toBe(
      "https://pages.example.com/v?view=t",
    );
  });

  it("writes the paired machine's address as WebKit and Chromium report it", () => {
    expect(resolvePageUrl("HTTPS://Mend.Example.COM:443", "/api/page-view?view=T")).toBe(
      "https://mend.example.com/api/page-view?view=T",
    );
    expect(resolvePageUrl("http://Box:80/", "/api/page-view?view=t")).toBe(
      "http://box/api/page-view?view=t",
    );
    expect(resolvePageUrl("http://box:8080", "/api/page-view?view=t")).toBe(
      "http://box:8080/api/page-view?view=t",
    );
    expect(resolvePageUrl("https://box:4430", "/api/page-view?view=t")).toBe(
      "https://box:4430/api/page-view?view=t",
    );
    expect(resolvePageUrl("https://box", "HTTPS://Pages.Example.com:443/V?view=T")).toBe(
      "https://pages.example.com/V?view=T",
    );
  });

  it("opens nothing that is not a path or an http(s) URL", () => {
    for (const url of ["javascript:alert(1)", "//evil.example.com/x", "api/page-view", ""]) {
      expect(resolvePageUrl("https://mend.example.com", url)).toBeNull();
    }
  });
});

const minter = () => {
  const minted: string[] = [];
  const mint = (label: string) => async () => {
    minted.push(label);
    return `https://mend.example.com/api/page-view?view=${label}-${minted.length}`;
  };
  return { minted, mint };
};

describe("the frame URL query", () => {
  const T0 = Date.parse("2026-10-29T12:00:00.000Z");
  const home = { url: "https://mend.example.com", token: "token-a" };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never hands one pairing's URL to another, on another machine or another account", async () => {
    const client = new QueryClient();
    const { minted, mint } = minter();
    const first = await client.fetchQuery(pageFrameQuery(home, "page-1", mint("home")));
    expect(await client.fetchQuery(pageFrameQuery(home, "page-1", mint("home")))).toBe(first);
    const otherAccount = await client.fetchQuery(
      pageFrameQuery({ ...home, token: "token-b" }, "page-1", mint("account")),
    );
    const otherMachine = await client.fetchQuery(
      pageFrameQuery({ ...home, url: "http://10.0.0.40:3105" }, "page-1", mint("machine")),
    );
    expect(minted).toEqual(["home", "account", "machine"]);
    expect(new Set([first, otherAccount, otherMachine]).size).toBe(3);
  });

  it("reuses a URL while more than five minutes of its life are left by the phone's clock", async () => {
    vi.useFakeTimers({ now: T0, toFake: ["Date"] });
    const client = new QueryClient();
    const { minted, mint } = minter();
    await client.fetchQuery(pageFrameQuery(home, "page-1", mint("home")));
    vi.setSystemTime(T0 + 24 * 60_000);
    await client.fetchQuery(pageFrameQuery(home, "page-1", mint("home")));
    expect(minted).toHaveLength(1);
    vi.setSystemTime(T0 + 25 * 60_000 + 1);
    await client.fetchQuery(pageFrameQuery(home, "page-1", mint("home")));
    expect(minted).toHaveLength(2);
  });
});
