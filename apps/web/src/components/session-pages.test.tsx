// @vitest-environment jsdom
import { PageId, SessionId } from "@mend/domain";
import { PageRef } from "@mend/domain/workbench";
import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
} from "@mend/t3-contracts/html-render";
import { pageThemes } from "@mend/ui/page-theme";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import * as fc from "fast-check";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import superjson, { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TranscriptEventDto } from "#/lib/api";
import { setThemePreference } from "#/lib/theme";
import { TRPCProvider } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";
import type { AppRouter } from "#/server/routers/index";

import { PageDialog, PageFrame } from "./page-frame.tsx";
import { SessionPages } from "./session-pages.tsx";
import { TranscriptPane } from "./session-transcript.tsx";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => Object.assign(new EventTarget(), { matches: false, media }),
  });
});

type Intersection = (entries: ReadonlyArray<{ readonly isIntersecting: boolean }>) => void;
let inView: boolean;
const watched = new Set<Intersection>();
class FakeIntersectionObserver {
  constructor(private readonly callback: Intersection) {}
  observe() {
    watched.add(this.callback);
    if (inView) this.callback([{ isIntersecting: true }]);
  }
  disconnect() {
    watched.delete(this.callback);
  }
}
const scrollIntoView = async () => {
  inView = true;
  act(() => {
    for (const callback of watched) callback([{ isIntersecting: true }]);
  });
  await settle();
};

const sources: Array<FakeEventSource> = [];
class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    sources.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
const serverSays = async (event: unknown) => {
  act(() => {
    sources.at(-1)?.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  });
  await settle();
};

const page = new PageRef({
  id: PageId.make("page-1"),
  sessionId: SessionId.make("session-1"),
  title: "Request path",
  height: 400,
  publishedAt: new Date("2026-10-29T12:00:00Z"),
});
const message = (kind: string, params: unknown) => ({
  jsonrpc: "2.0",
  method: `ui/${kind}`,
  params,
});
const event = (kind: string, text: string | null): TranscriptEventDto => ({
  kind,
  text,
  name: null,
  command: null,
  output: null,
});
const pageCall = (output: string): TranscriptEventDto => ({
  ...event("tool", null),
  name: "mcp__mend__html_render",
  output,
});
let transcript: { readonly sourceHarness: string; readonly events: TranscriptEventDto[] };

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;
let refused: boolean;
let serverClockOffset: number;
let listed: ReadonlyArray<PageRef>;
let requests: Array<{ readonly path: string; readonly input: string | null }>;

const makeHarness = () => {
  const client = createTRPCClient<AppRouter>({
    links: [
      httpLink({
        url: "http://mend.test/trpc",
        transformer: superjson,
        fetch: async (input) => {
          const url = new URL(input.toString());
          const path = url.pathname.split("/").at(-1) ?? "";
          requests.push({ path, input: url.searchParams.get("input") });
          if (refused)
            return Response.json(
              {
                error: serialize({
                  message: "Not found",
                  code: -32004,
                  data: { code: "NOT_FOUND", httpStatus: 404 },
                }),
              },
              { status: 404 },
            );
          const data =
            path === "pages.frame"
              ? {
                  url: `/api/page-view?view=fake-${requests.length}`,
                  expiresAt: new Date(Date.now() + serverClockOffset + 30 * 60_000),
                }
              : path === "sessions.pages"
                ? listed
                : transcript;
          return Response.json({ result: { data: serialize(structuredClone(data)) } });
        },
      }),
    ],
  });
  const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
  const render = async (children: ReactNode) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={client} queryClient={queryClient}>
            {children}
          </TRPCProvider>
        </QueryClientProvider>,
      ),
    );
    await settle();
    await settle();
  };
  return { trpc, render };
};

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });
};
const frame = () => {
  const found = document.querySelector("iframe");
  if (found === null) throw new Error("No page frame");
  return found;
};
const post = (data: unknown, source: MessageEventSource | null = frame().contentWindow) => {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, source, origin: "null" })));
};
const size = (height: unknown, source?: MessageEventSource | null) =>
  post(message("notifications/size-changed", { height }), source);
const click = async (button: HTMLElement) => {
  await act(async () => button.click());
  await settle();
};
const button = (name: string) => {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent === name,
  );
  if (found === undefined) throw new Error(`No ${name} action`);
  return found;
};
const retry = () => click(button("Try again"));
const mints = () => requests.filter((request) => request.path === "pages.frame").length;
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};
const escapeShortcut = htmlRenderShortcutsMessage(
  [{ key: "escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }],
  [],
);
const keyDown = (key: string) => ({
  jsonrpc: "2.0",
  method: "t3/notifications/keydown",
  params: { key, code: key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
});
const dialog = () => {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (found === null) throw new Error("No dialog");
  return found;
};

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
  setThemePreference("light");
  Reflect.set(window, "IntersectionObserver", FakeIntersectionObserver);
  Reflect.set(window, "EventSource", FakeEventSource);
  inView = true;
  refused = false;
  serverClockOffset = 0;
  listed = [page];
  transcript = {
    sourceHarness: "claude",
    events: [
      event("user", "Show the request path."),
      { ...event("page", null), page },
      event("assistant", "The API checks the signed URL."),
    ],
  };
  requests = [];
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pages in the Record", () => {
  it("renders the page at its conversation position in an opaque-origin frame", async () => {
    await makeHarness().render(<TranscriptPane sessionId={page.sessionId} />);
    const iframe = frame();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.title).toBe(page.title);
    expect(host.textContent).toBe(
      "Show the request path.Request pathOpenThe API checks the signed URL.",
    );
    expect(iframe.getAttribute("src")).toMatch(/^\/api\/page-view\?view=fake-\d+#t3-theme=/);
    expect(requests.find((request) => request.path === "pages.frame")?.input).toContain(
      '"appearance":"light"',
    );
  });

  it("shows the page the record placed, and a failed call's row", async () => {
    transcript = {
      sourceHarness: "claude",
      events: [
        { ...event("page", null), page },
        pageCall("Page too large: 2.1 MB, the limit is 2 MB."),
        event("assistant", "Done."),
      ],
    };
    await makeHarness().render(<TranscriptPane sessionId={page.sessionId} />);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.textContent).toBe(
      "Request pathOpen⚙ mcp__mend__html_renderPage too large: 2.1 MB, the limit is 2 MB.Done.",
    );
  });

  it("opens a page from the Record in a dialog and leaves the inline page where it was", async () => {
    await makeHarness().render(<TranscriptPane sessionId={page.sessionId} />);
    const inline = frame();
    await click(button("Open"));
    expect(dialog().getAttribute("aria-label")).toBe(page.title);
    expect(dialog().querySelector("iframe")?.getAttribute("sandbox")).toBe(
      "allow-scripts allow-forms",
    );
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    await click(button("Close"));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(frame()).toBe(inline);
  });

  it("asks for no URL until the frame nears the viewport", async () => {
    inView = false;
    await makeHarness().render(<PageFrame page={page} />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(mints()).toBe(0);
    await scrollIntoView();
    expect(mints()).toBe(1);
    expect(frame().title).toBe(page.title);
  });

  it("ignores another window's size and malformed messages, and clamps its own height", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    size(900, window);
    post(message("notifications/size-changed", { height: 900 }), null);
    for (const invalid of [-1, Infinity, NaN, "500", null]) size(invalid);
    expect(frame().style.height).toBe("400px");
    size(512.2);
    expect(frame().style.height).toBe("513px");
    size(1);
    expect(frame().style.height).toBe(`${HTML_RENDER_MIN_HEIGHT}px`);
    size(Number.MAX_VALUE);
    expect(frame().style.height).toBe(`${HTML_RENDER_MAX_FIT_HEIGHT}px`);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), (height) => {
        size(height);
        const fitted = Number.parseFloat(frame().style.height);
        expect(fitted).toBeGreaterThanOrEqual(HTML_RENDER_MIN_HEIGHT);
        expect(fitted).toBeLessThanOrEqual(HTML_RENDER_MAX_FIT_HEIGHT);
        expect(Number.isInteger(fitted)).toBe(true);
      }),
    );
  });

  it("takes a page that reports height 0 as loaded, at the least height", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    const iframe = frame();
    act(() => iframe.dispatchEvent(new Event("load")));
    size(0);
    expect(iframe.style.height).toBe(`${HTML_RENDER_MIN_HEIGHT}px`);
    await advance(2 * 15_010);
    expect(frame()).toBe(iframe);
    expect(mints()).toBe(1);
    expect(host.textContent).not.toContain("This page could not be loaded.");
  });

  it("opens only its own focused frame's http(s) links with no opener or referrer", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    const iframe = frame();
    const request = (url: string) => ({ ...message("open-link", { url }), id: "link-1" });
    post(request("https://example.com"));
    expect(opened).not.toHaveBeenCalled();
    iframe.focus();
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "file:///etc/passwd",
      "//example.com",
      "/settings",
      "https://[",
      "https://",
    ])
      post(request(url));
    post(request("https://example.com"), window);
    expect(opened).not.toHaveBeenCalled();
    const target = iframe.contentWindow;
    if (target === null) throw new Error("No frame window");
    const replies = vi.spyOn(target, "postMessage");
    post(request("https://example.com/docs"));
    post(request("http://example.com/docs"));
    post(request("https://mend_server.example.com/docs"));
    post(request("http://localhost:5173/report?q=1"));
    post(request("HTTPS://Example.COM:8443"));
    expect(opened.mock.calls).toEqual([
      ["https://example.com/docs", "_blank", "noopener,noreferrer"],
      ["http://example.com/docs", "_blank", "noopener,noreferrer"],
      ["https://mend_server.example.com/docs", "_blank", "noopener,noreferrer"],
      ["http://localhost:5173/report?q=1", "_blank", "noopener,noreferrer"],
      ["https://example.com:8443/", "_blank", "noopener,noreferrer"],
    ]);
    expect(replies).toHaveBeenCalledWith({ jsonrpc: "2.0", id: "link-1", result: {} }, "*");
  });

  it("posts Mend's palette on load and theme changes without reloading or re-minting", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    const iframe = frame();
    const target = iframe.contentWindow;
    if (target === null) throw new Error("No frame window");
    const posted = vi.spyOn(target, "postMessage");
    const src = iframe.src;
    act(() => iframe.dispatchEvent(new Event("load")));
    size(400);
    expect(posted).toHaveBeenCalledWith(htmlRenderThemeMessage(pageThemes.light), "*");
    await act(async () => setThemePreference("dark"));
    await settle();
    expect(posted).toHaveBeenCalledWith(htmlRenderThemeMessage(pageThemes.dark), "*");
    expect(frame()).toBe(iframe);
    expect(iframe.src).toBe(src);
    expect(iframe.style.colorScheme).toBe("dark");
    expect(mints()).toBe(1);
  });

  it("themes a frame mounted after a theme change by its fragment, reusing the URL", async () => {
    const harness = makeHarness();
    await harness.render(<PageFrame page={page} />);
    size(400);
    await act(async () => setThemePreference("dark"));
    await harness.render(<PageDialog page={page} onClose={() => undefined} />);
    expect(mints()).toBe(1);
    expect(frame().getAttribute("src")).toBe(
      `/api/page-view?view=fake-1${htmlRenderThemeFragment(pageThemes.dark)}`,
    );
  });

  it("mints once for a page shown inline and in its dialog, and never renews a loaded one", async () => {
    await makeHarness().render(<TranscriptPane sessionId={page.sessionId} />);
    size(400);
    await click(button("Open"));
    const [inline, opened] = document.querySelectorAll("iframe");
    expect(opened?.getAttribute("src")).toBe(inline?.getAttribute("src"));
    size(400, opened?.contentWindow);
    await advance(60 * 60_000);
    expect(mints()).toBe(1);
    expect(document.querySelectorAll("iframe")[0]).toBe(inline);
  });

  it("judges a URL's life by the client clock alone", async () => {
    serverClockOffset = -2 * 60 * 60_000;
    const harness = makeHarness();
    await harness.render(<PageFrame page={page} />);
    const iframe = frame();
    size(400);
    await advance(10 * 60_000);
    expect(mints()).toBe(1);
    expect(frame()).toBe(iframe);
    await harness.render(null);
    await harness.render(<PageFrame page={page} />);
    expect(mints()).toBe(1);
  });

  it("reuses a URL minted under 25 minutes ago and mints afresh after that", async () => {
    const harness = makeHarness();
    const cache = (updatedAt: number) =>
      queryClient.setQueryData(
        harness.trpc.pages.frame.queryKey({ id: page.id }),
        { url: "/api/page-view?view=cached", expiresAt: new Date(updatedAt + 30 * 60_000) },
        { updatedAt },
      );
    cache(Date.now() - 24 * 60_000);
    await harness.render(<PageFrame page={page} />);
    expect(mints()).toBe(0);
    expect(frame().getAttribute("src")).toContain("view=cached");
    await harness.render(null);
    cache(Date.now() - 26 * 60_000);
    await harness.render(<PageFrame page={page} />);
    expect(mints()).toBe(1);
    expect(frame().getAttribute("src")).not.toContain("view=cached");
  });

  it("keeps a loaded page and what it holds when a later mint fails", async () => {
    const harness = makeHarness();
    await harness.render(<PageFrame page={page} />);
    const iframe = frame();
    const src = iframe.src;
    size(400);
    refused = true;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await settle();
    expect(mints()).toBe(2);
    expect(frame()).toBe(iframe);
    expect(iframe.src).toBe(src);
    expect(host.textContent).not.toContain("This page could not be loaded.");
  });

  it("cancels load detection and stops accepting messages on unmount", async () => {
    const harness = makeHarness();
    await harness.render(<PageFrame page={page} />);
    const iframe = frame();
    const source = iframe.contentWindow;
    const opened = vi.spyOn(window, "open").mockReturnValue(null);
    act(() => iframe.dispatchEvent(new Event("load")));
    await harness.render(null);
    post({ ...message("open-link", { url: "https://example.com" }), id: "link" }, source);
    await advance(15_010);
    expect(opened).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });

  it("re-mints once for a document that never answers the bootstrap, then offers a retry", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    const first = frame().getAttribute("src");
    act(() => frame().dispatchEvent(new Event("load")));
    await advance(15_010);
    expect(mints()).toBe(2);
    expect(frame().getAttribute("src")).not.toBe(first);
    act(() => frame().dispatchEvent(new Event("load")));
    await advance(15_010);
    expect(host.textContent).toContain("This page could not be loaded.");
    expect(document.querySelector("iframe")).toBeNull();
    await retry();
    expect(mints()).toBe(3);
    expect(frame()).toBeDefined();
  });

  it("re-mints, then offers a retry, for a frame whose request never completes", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    await advance(15_010);
    expect(mints()).toBe(2);
    await advance(15_010);
    expect(host.textContent).toContain("This page could not be loaded.");
    await retry();
    expect(mints()).toBe(3);
    expect(frame()).toBeDefined();
  });

  it("shows a refused frame request without embedding a document and can retry", async () => {
    refused = true;
    await makeHarness().render(<PageFrame page={page} />);
    expect(host.textContent).toContain("This page could not be loaded.");
    expect(document.querySelector("iframe")).toBeNull();
    refused = false;
    await retry();
    expect(frame()).toBeDefined();
  });
});

describe("a page in its dialog", () => {
  it("closes on Escape passed on by its own page, and from no other window", async () => {
    const closed = vi.fn();
    await makeHarness().render(<PageDialog page={page} onClose={closed} />);
    const iframe = frame();
    const target = iframe.contentWindow;
    if (target === null) throw new Error("No frame window");
    const posted = vi.spyOn(target, "postMessage");
    act(() => iframe.dispatchEvent(new Event("load")));
    expect(posted).toHaveBeenCalledWith(escapeShortcut, "*");
    post(keyDown("Escape"), window);
    post(keyDown("Enter"));
    expect(closed).not.toHaveBeenCalled();
    post(keyDown("Escape"));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("is the only frame that asks its page for Escape", async () => {
    await makeHarness().render(<PageFrame page={page} />);
    const target = frame().contentWindow;
    if (target === null) throw new Error("No frame window");
    const posted = vi.spyOn(target, "postMessage");
    act(() => frame().dispatchEvent(new Event("load")));
    expect(posted).not.toHaveBeenCalledWith(escapeShortcut, "*");
  });
});

function LivePages() {
  useWorkbenchEvents();
  return <SessionPages sessionId={page.sessionId} listed />;
}

describe("Pages beside the terminal", () => {
  it("lists pages without loading them, opens a dialog, and returns focus on close", async () => {
    await makeHarness().render(<SessionPages sessionId={page.sessionId} listed />);
    expect(document.querySelector("iframe")).toBeNull();
    expect(requests.map((request) => request.path)).toEqual(["sessions.pages"]);
    const trigger = host.querySelector("button");
    if (trigger === null) throw new Error("No page trigger");
    expect(trigger.textContent).toContain(page.title);
    trigger.focus();
    await click(trigger);
    expect(dialog().getAttribute("aria-label")).toBe(page.title);
    expect(dialog().style.maxWidth).toBe("1120px");
    expect(frame().title).toBe(page.title);
    await click(button("Close"));
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows a page published while it is open, on the session event alone", async () => {
    listed = [];
    await makeHarness().render(<LivePages />);
    expect(host.textContent).toBe("Pagesnone yet");
    listed = [page];
    await serverSays({ type: "session", sessionId: page.sessionId, projectId: "p-1" });
    expect(host.textContent).toContain(page.title);
  });

  it("keeps an open page open when the list goes because the session settled", async () => {
    const harness = makeHarness();
    await harness.render(<SessionPages sessionId={page.sessionId} listed />);
    await click(button(`01${page.title}`));
    await harness.render(<SessionPages sessionId={page.sessionId} listed={false} />);
    expect(document.querySelector('[aria-label="Pages"]')).toBeNull();
    expect(dialog().getAttribute("aria-label")).toBe(page.title);
    expect(frame().title).toBe(page.title);
  });

  it("reports a list failure with a retry", async () => {
    refused = true;
    await makeHarness().render(<SessionPages sessionId={page.sessionId} listed />);
    expect(host.textContent).toContain("The pages list could not be read.");
    refused = false;
    await retry();
    expect(host.textContent).toContain(page.title);
  });
});
