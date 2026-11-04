// @vitest-environment jsdom
import { RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ConversationPage } from "#/lib/conversation";
import { forgetPendingLaunches } from "#/lib/pending-launches";
import {
  launchFixture,
  pageWithTurn,
  session,
  detail,
  runningDetail,
  inboxRow,
} from "#/test-fixtures/session-launch";

vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      static CLOSED = 2;
      readyState = 1;
      constructor() {
        super();
        Reflect.set(window, "fixtureEvents", this);
      }
      close() {
        this.readyState = 2;
      }
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

let root: Root;
let host: HTMLDivElement;
let answer: (response: Response) => void;
let creations: number;
let page: ConversationPage;
let serverDetail = detail;
let transcript: ReadonlyArray<{
  kind: string;
  text: string;
  name: null;
  command: null;
  output: null;
}>;
let transcriptReads: number;
let router: ReturnType<typeof launchFixture>;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const opening = "Keep my opening message visible";
const button = (words: string) => {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent === words);
  if (found === undefined) throw new Error(`Missing button: ${words}`);
  return found;
};
const textarea = () => {
  const node = host.querySelector("textarea");
  if (node === null) throw new Error("Missing composer");
  return node;
};
const enter = async () => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea(),
      opening,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  await settle();
};
const answerCreate = async (success: boolean) => {
  await act(async () =>
    answer(
      Response.json([
        success
          ? { result: { data: serialize(session) } }
          : {
              error: serialize({
                message: "The worktree could not be created",
                code: -32603,
                data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
              }),
            },
      ]),
    ),
  );
  await settle();
};

const serverSays = async (type: string) => {
  const events: unknown = Reflect.get(window, "fixtureEvents");
  if (!(events instanceof EventTarget)) throw new Error("No event stream");
  await act(async () =>
    events.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ type, sessionId: session.id, projectId: session.projectId }),
      }),
    ),
  );
  await settle();
};

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  forgetPendingLaunches();
  localStorage.clear();
  sessionStorage.clear();
  creations = 0;
  page = { turns: [], items: [], requests: [], next: null, feed: 0 };
  serverDetail = detail;
  transcript = [];
  transcriptReads = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(
      input instanceof Request ? input : new URL(String(input), window.location.origin),
      init,
    );
    const url = request.url;
    if (url.includes("sessions.create") || url.includes("worktrees.createSession")) {
      creations += 1;
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    }
    const paths = new URL(url).pathname.split("/trpc/")[1]?.split(",") ?? [];
    return Response.json(
      paths.map((path) => {
        const wireTurns = page.turns.map((turn) => ({
          ...turn,
          createdAt: new Date(turn.createdAt),
          startedAt: turn.startedAt === null ? null : new Date(turn.startedAt),
        }));
        if (path === "sessions.transcript") transcriptReads += 1;
        const data =
          path === "sessions.launch"
            ? session
            : path === "sessions.detail"
              ? serverDetail
              : path === "sessions.items"
                ? page.items.map((item) => ({
                    ...item,
                    createdAt: new Date(item.createdAt),
                    updatedAt: new Date(item.updatedAt),
                  }))
                : path === "sessions.historyTurns"
                  ? { turns: wireTurns }
                  : path === "sessions.historyItems"
                    ? { items: page.items, next: null, feed: 0 }
                    : path === "sessions.historyRequests"
                      ? { requests: [] }
                      : path === "sessions.transcript"
                        ? { events: transcript }
                        : path === "sessions.inbox" ||
                            path === "sessions.inboxMarks" ||
                            path === "sessions.listActive"
                          ? []
                          : path === "sessions.inboxRow"
                            ? inboxRow(serverDetail)
                            : undefined;
        return data === undefined
          ? {
              error: serialize({
                message: "Fixture read unavailable",
                code: -32603,
                data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
              }),
            }
          : { result: { data: serialize(data) } };
      }),
    );
  });
  window.history.replaceState(null, "", "/");
  router = launchFixture();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
});

afterEach(() => {
  act(() => root.unmount());
  router.options.context.queryClient.clear();
  host.remove();
});

const STARTING = /Starting (the workspace|Claude|Codex)/;

describe("instant session start", () => {
  it("shows the page, opening bubble and inbox row before creation answers, then replaces the URL", async () => {
    await enter();
    const draftUrl = router.state.location.pathname;
    expect(draftUrl).toMatch(/^\/starting\//);
    expect(host.querySelector("main")?.textContent).toContain(opening);
    expect(host.querySelector("main")?.textContent).toContain("Creating the worktree");
    expect(host.querySelector('aside[aria-label="Sessions"]')?.textContent).toContain(opening);
    expect(creations).toBe(1);
    await answerCreate(true);
    expect(router.state.location.pathname).toBe(`/sessions/${session.id}`);
    expect(host.querySelector("main")?.textContent).toContain(opening);
    expect(host.querySelector("main")?.textContent).not.toContain("Nothing said yet");
    page = pageWithTurn(opening);
    serverDetail = runningDetail("agent-protocol");
    await serverSays("session");
    await vi.waitFor(() => expect(host.querySelector("main")?.textContent).not.toMatch(STARTING));
    expect(host.querySelector("main")?.textContent).toContain("running");
    expect(host.querySelector("main")?.textContent?.split(opening)).toHaveLength(2);
    expect(host.querySelector("main")?.textContent).not.toMatch(STARTING);
    expect(host.querySelector('aside[aria-label="Sessions"] a[href^="/starting/"]')).toBeNull();
    expect(
      host.querySelector(`aside[aria-label="Sessions"] a[href="/sessions/${session.id}"]`),
    ).not.toBeNull();
    const at = new Date().toISOString();
    page = {
      ...page,
      items: [
        {
          id: "reply",
          turnId: "turn-opening",
          seq: 1,
          kind: "assistant-message",
          status: "running",
          title: null,
          text: "The reply is streaming",
          data: null,
          createdAt: at,
          updatedAt: at,
        },
      ],
    };
    await serverSays("agent-conversation");
    await vi.waitFor(() =>
      expect(host.querySelector("main")?.textContent).toContain("The reply is streaming"),
    );
    page = {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        seq: 2,
        text: "The reply is streaming more words",
      })),
    };
    await serverSays("agent-conversation");
    await vi.waitFor(() =>
      expect(host.querySelector("main")?.textContent).toContain("streaming more words"),
    );
  });

  it("offers retry on the same draft, then Edit restores the opening words", async () => {
    await enter();
    const draftUrl = router.state.location.pathname;
    await answerCreate(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "worktree could not be created",
    );
    expect(button("Edit")).toBeDefined();
    await act(async () => button("Try again").click());
    await settle();
    expect(router.state.location.pathname).toBe(draftUrl);
    expect(creations).toBe(2);
    await answerCreate(false);
    await act(async () => button("Edit").click());
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(textarea().value).toBe(opening);
  });

  it("keeps a terminal launch bubble until a recorded user line arrives, then follows the live record", async () => {
    await enter();
    await answerCreate(true);
    serverDetail = runningDetail("agent-pty");
    await serverSays("session");
    expect(host.querySelector("main")?.textContent).toContain(opening);
    expect(host.querySelector("main")?.textContent).toMatch(STARTING);
    const before = transcriptReads;
    transcript = [{ kind: "reasoning", text: "Thinking", name: null, command: null, output: null }];
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_150)));
    expect(host.querySelector("main")?.textContent).toContain(opening);
    expect(host.querySelector("main")?.textContent).not.toContain("No conversation recorded");
    transcript = [
      { kind: "user", text: opening, name: null, command: null, output: null },
      { kind: "assistant", text: "The first live reply", name: null, command: null, output: null },
    ];
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_150)));
    expect(transcriptReads).toBeGreaterThan(before);
    expect(host.querySelector("main")?.textContent).toContain("The first live reply");
    expect(host.querySelector("main")?.textContent?.split(opening)).toHaveLength(2);
    expect(host.querySelector("main")?.textContent).not.toMatch(STARTING);
  });

  it("returns an unknown draft URL to the home composer", async () => {
    await act(async () =>
      router.navigate({ to: "/starting/$draftId", params: { draftId: "lost-on-reload" } }),
    );
    await settle();
    expect(router.state.location.pathname).toBe("/");
    expect(textarea()).toBeDefined();
  });
});
