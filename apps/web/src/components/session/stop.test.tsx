// @vitest-environment jsdom
import { RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionDetailDto } from "#/lib/api";
import { inboxRow, launchFixture, runningDetail, session } from "#/test-fixtures/session-launch";

vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "EventSource",
    class extends EventTarget {
      readyState = 1;
      constructor() {
        super();
        Reflect.set(window, "stopFixtureEvents", this);
      }
      close() {}
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

let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof launchFixture>;
let serverDetail = runningDetail("agent-protocol");
let stopOutcome: "running" | "stopping" | "stopped" | "idle";
let detailReads: number;
let stopCalls: number;
let unreadable: boolean;
let detailGate: Promise<void> | null;

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const clickStop = async () => {
  const stop = [...host.querySelectorAll("button")].find((node) => node.textContent === "Stop");
  if (stop === undefined) throw new Error("Missing Stop button");
  await act(async () => stop.click());
  await settle();
};

const stoppedDetail = (status: "stopped" | "idle"): SessionDetailDto => ({
  ...serverDetail,
  session: { ...serverDetail.session, status },
  currentAgent:
    serverDetail.currentAgent === null
      ? null
      : {
          ...serverDetail.currentAgent,
          status: "stopped",
          exitedAt: new Date(),
        },
});

beforeEach(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sessionStorage.clear();
  serverDetail = runningDetail("agent-protocol");
  stopOutcome = "stopped";
  detailReads = 0;
  stopCalls = 0;
  unreadable = false;
  detailGate = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      window.location.origin,
    );
    const paths = url.pathname.split("/trpc/")[1]?.split(",") ?? [];
    if (paths.includes("sessions.stop")) {
      stopCalls += 1;
      serverDetail =
        stopOutcome === "stopped" || stopOutcome === "idle"
          ? stoppedDetail(stopOutcome)
          : {
              ...serverDetail,
              session: { ...serverDetail.session, status: stopOutcome },
            };
      throw new TypeError("Failed to fetch");
    }
    if (paths.includes("sessions.detail")) {
      detailReads += 1;
      await detailGate;
      if (unreadable) throw new TypeError("Failed to fetch");
    }
    return Response.json(
      paths.map((path) => {
        const data =
          path === "executor.calls"
            ? { calls: [], olderCursor: null }
            : path === "sessions.detail"
              ? serverDetail
              : path === "sessions.inboxRow"
                ? inboxRow(serverDetail)
                : path === "sessions.historyTurns"
                  ? { turns: [] }
                  : path === "sessions.historyItems"
                    ? { items: [], next: null, feed: 0 }
                    : path === "sessions.historyRequests"
                      ? { requests: [] }
                      : path === "sessions.transcript"
                        ? { events: [] }
                        : path === "sessions.pendingFollowUp"
                          ? null
                          : [];
        return { result: { data: serialize(data) } };
      }),
    );
  });
  window.history.replaceState(null, "", `/sessions/${session.id}`);
  router = launchFixture();
  router.options.context.queryClient.setQueryData(
    router.options.context.trpc.sessions.detail.queryKey({ id: session.id }),
    serverDetail,
  );
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

describe("Stop when its response is lost", () => {
  it.each<"stopping" | "stopped" | "idle">(["stopping", "stopped", "idle"])(
    "reads the real %s outcome before reporting a failure",
    async (status) => {
      stopOutcome = status;
      const readsBeforeStop = detailReads;
      await clickStop();
      expect(stopCalls).toBe(1);
      expect(detailReads).toBeGreaterThan(readsBeforeStop);
      expect(host.querySelector("main h1")?.textContent).toContain(status);
      expect(host.textContent).not.toContain("Stop did not go through");
      expect(host.textContent).not.toContain("Failed to fetch");
      expect([...host.querySelectorAll("button")].some((node) => node.textContent === "Stop")).toBe(
        false,
      );
      if (status === "stopping") {
        expect(host.querySelector<HTMLButtonElement>("button:disabled")?.textContent).toBe(
          "Stopping…",
        );
      }
    },
  );

  it("keeps Stop pending while it re-reads, rather than reporting the lost response as failure", async () => {
    let release: (() => void) | undefined;
    detailGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await clickStop();
    expect(host.textContent).not.toContain("Failed to fetch");
    expect(host.textContent).toContain("Stopping…");
    await act(async () => release?.());
    await settle();
    expect(host.querySelector("main h1")?.textContent).toContain("stopped");
    expect(host.textContent).not.toContain("Failed to fetch");
  });

  it("reports uncertainty if the fresh read still shows a running agent, without resending Stop", async () => {
    stopOutcome = "running";
    await clickStop();
    expect(host.textContent).toContain("Mend could not confirm the stop. Failed to fetch");
    expect(host.textContent).not.toContain("Stop did not go through");
    expect(host.querySelector("main h1")?.textContent).toContain("running");
    expect(stopCalls).toBe(1);
  });

  it("reports uncertainty if the session cannot be re-read", async () => {
    unreadable = true;
    await clickStop();
    expect(host.textContent).toContain("Mend could not confirm the stop. Failed to fetch");
    expect(host.textContent).not.toContain("Stop did not go through");
    expect(stopCalls).toBe(1);
  });

  it("removes uncertainty when a later session event confirms Stop", async () => {
    stopOutcome = "running";
    await clickStop();
    expect(host.textContent).toContain("Mend could not confirm the stop");
    serverDetail = stoppedDetail("stopped");
    const events: unknown = Reflect.get(window, "stopFixtureEvents");
    if (!(events instanceof EventTarget)) throw new Error("Missing event stream");
    await act(async () =>
      events.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "session",
            sessionId: session.id,
            projectId: session.projectId,
          }),
        }),
      ),
    );
    await settle();
    expect(host.querySelector("main h1")?.textContent).toContain("stopped");
    expect(host.textContent).not.toContain("Mend could not confirm the stop");
    expect(host.textContent).not.toContain("Failed to fetch");
  });
});
