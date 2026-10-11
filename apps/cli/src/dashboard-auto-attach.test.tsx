/**
 * A session started or resumed from the dashboard attaches once it runs, while the person still
 * waits on it: the real dashboard on OpenTUI's test renderer, against a fake server whose
 * workbench the tests move on the way the event stream would.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeyInput, TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKBENCH_KEY,
  type ProjectDetailDto,
  type ProjectDto,
  type SessionDto,
} from "./dashboard-model.ts";
import { App, HANDOVER_MS, type DashboardContext } from "./dashboard.tsx";
import type { AttachOutcome } from "./shared.ts";
import { COUNTDOWN_STEP_MS } from "./snake-play.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const LATER = "2026-10-10T12:05:00.000Z";
const PROJECT: ProjectDto = {
  id: "p1",
  name: "mend",
  originUrl: null,
  storePath: "/store/mend",
  defaultBranch: "main",
};
const session = (
  id: string,
  status: string,
  createdAt: string,
  harness = "claude",
): SessionDto => ({
  id,
  worktreeId: "w1",
  harness,
  label: id,
  branch: "mend/game",
  baseSha: "abc1234",
  baseRef: "main",
  status,
  summary: null,
  createdAt,
});
const BOOTING = session("booting", "starting", NOW);
const EARLIER = session("earlier", "stopped", "2026-10-01T12:00:00.000Z");
const detail = (...sessions: ReadonlyArray<SessionDto>): ProjectDetailDto => ({
  project: PROJECT,
  sessions,
  annotations: [],
  worktrees: [
    {
      id: "w1",
      name: "game",
      directory: "/work/game",
      branch: "mend/game",
      baseSha: "abc1234",
      baseRef: "main",
      createdAt: NOW,
    },
  ],
});

/** An answer, or a function computing one when the request arrives (and moving the server on). */
type Answer = unknown;

const KEY_INPUT: Readonly<Record<string, KeyInput>> = {
  return: "RETURN",
  escape: "ESCAPE",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  left: "ARROW_LEFT",
  right: "ARROW_RIGHT",
};

interface Dashboard {
  readonly setup: TestRendererSetup;
  readonly attachTty: ReturnType<typeof vi.fn>;
  /** The server's sessions in p1, newest first; the next workbench read answers with them. */
  readonly serve: (...sessions: ReadonlyArray<SessionDto>) => void;
  /** The event stream's part: re-read the workbench, as a status change on the server makes it. */
  readonly pushed: () => Promise<string>;
  readonly wait: (ms: number) => Promise<string>;
  readonly press: (key: string) => Promise<string>;
}

const openDashboard = async (
  options: {
    readonly routes?: Readonly<Record<string, Answer>>;
    readonly autoAttach?: boolean;
  } = {},
): Promise<Dashboard> => {
  const routes: Record<string, Answer> = {
    "GET /projects": [PROJECT],
    "GET /projects/p1": detail(BOOTING, EARLIER),
    "GET /services": [],
    ...options.routes,
  };
  const attachTty = vi.fn(
    async (_sessionId: string, _harness: string): Promise<AttachOutcome> => "detached",
  );
  const queryClient = new QueryClient();
  const ctx: DashboardContext = {
    config: { url: "http://mend.test", token: null },
    cwd: mkdtempSync(join(tmpdir(), "mend-auto-attach-")),
    cwdBranch: null,
    api: async <T,>(method: string, route: string): Promise<T> => {
      const answer = routes[`${method} ${route}`];
      if (answer === undefined) throw new Error(`no fake for ${method} ${route}`);
      const value: unknown = typeof answer === "function" ? await answer() : answer;
      // The fake answers with the DTOs typed above; the dashboard's api is generic over them.
      return value as T;
    },
    attachTty,
    agentShare: null,
    gitAccessMode: null,
    tunnels: null,
    ...(options.autoAttach === undefined ? {} : { autoAttach: options.autoAttach }),
  };
  const setup = await testRender(
    <QueryClientProvider client={queryClient}>
      <App ctx={ctx} onQuit={() => {}} />
    </QueryClientProvider>,
    { width: 120, height: 36 },
  );
  const wait = async (ms: number): Promise<string> => {
    for (let left = ms; left > 0; left -= 10) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(Math.min(10, left));
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const press = async (key: string): Promise<string> => {
    await act(async () => {
      setup.mockInput.pressKey(KEY_INPUT[key] ?? key);
    });
    return wait(key === "escape" ? 60 : 0);
  };
  const serve = (...sessions: ReadonlyArray<SessionDto>): void => {
    routes["GET /projects/p1"] = detail(...sessions);
  };
  const pushed = async (): Promise<string> => {
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: WORKBENCH_KEY });
    });
    return wait(0);
  };
  await wait(50);
  return { setup, attachTty, serve, pushed, wait, press };
};

/** A new session in worktree w1, answered as still starting; the server lists it from then on. */
const startRoutes = (
  id: string,
  serve: () => void,
  harness = "claude",
): Record<string, Answer> => ({
  "POST /worktrees/w1/sessions": session(id, "starting", LATER, harness),
  [`POST /sessions/${id}/launch`]: () => {
    serve();
    return session(id, "starting", LATER, harness);
  },
});

/** The status line: the row above the footer. */
const statusLine = (frame: string): string => frame.trimEnd().split("\n").at(-2)!.trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.spyOn(Math, "random").mockReturnValue(0.37);
  // The attach prints its banner to the real stdout once the renderer is suspended.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("auto-attach after a start from the dashboard", () => {
  it("attaches once the session runs while the person waits on it", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    let frame = await press("return");
    frame = await wait(0);
    expect(statusLine(frame)).toBe("still starting · fresh · attaches once it runs");
    expect(attachTty).not.toHaveBeenCalled();

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    frame = await pushed();
    // Only counted down, never played: the beat names no score.
    expect(statusLine(frame)).toBe("ready · fresh · attaching");
    // The beat holds the keyboard: nothing the person presses lands before the terminal is theirs.
    await press("down");
    expect(attachTty).not.toHaveBeenCalled();
    frame = await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledTimes(1);
    expect(attachTty).toHaveBeenCalledWith("fresh", "claude");
    // Back from the detach, the session is still the one selected, as after `a`.
    expect(statusLine(frame)).toBe("detached · fresh keeps running");
    expect(frame).toContain("▌ fresh");
    // A detach is final: the session moving on again never takes the terminal by itself.
    serve({ ...fresh, status: "waiting" }, BOOTING, EARLIER);
    await pushed();
    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    await pushed();
    await wait(HANDOVER_MS * 2);
    expect(attachTty).toHaveBeenCalledTimes(1);
    setup.renderer.destroy();
  });

  it("attaches a start whose call answers already running", async () => {
    let dashboard: Dashboard | null = null;
    const running = session("fresh", "running", LATER);
    dashboard = await openDashboard({
      routes: {
        "POST /worktrees/w1/sessions": session("fresh", "starting", LATER),
        "POST /sessions/fresh/launch": () => {
          dashboard?.serve(running, BOOTING, EARLIER);
          return running;
        },
      },
    });
    const { setup, attachTty, wait, press } = dashboard;
    await press("n");
    await press("return");
    const frame = await wait(0);
    expect(statusLine(frame)).toBe("ready · fresh · attaching");
    await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledTimes(1);
    expect(attachTty).toHaveBeenCalledWith("fresh", "claude");
    setup.renderer.destroy();
  });

  it("does not take the terminal once the person moved to another session", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");
    // Leave the game, then walk to the session below.
    await press("escape");
    let frame = await press("down");
    expect(frame).toContain("▌ booting");

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    frame = await pushed();
    expect(statusLine(frame)).toBe("started · fresh · a attaches");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    setup.renderer.destroy();
  });

  it("does not take the terminal once the person moved to another column", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");
    await press("escape");
    await press("2");

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    const frame = await pushed();
    expect(statusLine(frame)).toBe("started · fresh · a attaches");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    setup.renderer.destroy();
  });

  it("still attaches after the person left the game but stayed on the session", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");
    await press("escape");

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    await pushed();
    await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledWith("fresh", "claude");
    setup.renderer.destroy();
  });

  it("leaves it to `a` when a dialog is open as the session starts running", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");
    await press("escape");
    let frame = await press("?");
    expect(frame).toContain("esc closes");

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    await pushed();
    frame = await press("escape");
    expect(statusLine(frame)).toBe("started · fresh · a attaches");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    setup.renderer.destroy();
  });

  it("attaches only the start the person waits on when two are in flight", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    const resumed = { ...EARLIER, status: "starting" };
    dashboard = await openDashboard({
      routes: {
        ...startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
        "POST /sessions/earlier/resume": () => {
          dashboard?.serve(fresh, BOOTING, resumed);
          return resumed;
        },
      },
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    // The first start, then a resume of the stopped session at the bottom of the list.
    await press("n");
    await press("return");
    await press("escape");
    await press("down");
    let frame = await press("down");
    expect(frame).toContain("▌ earlier");
    await press("r");
    frame = await press("return");
    frame = await wait(0);
    expect(statusLine(frame)).toBe("still resuming · earlier · attaches once it runs");

    // The first start runs first: it says so and waits for `a`.
    serve({ ...fresh, status: "running" }, BOOTING, resumed);
    frame = await pushed();
    expect(statusLine(frame)).toBe("started · fresh · a attaches");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();

    // The resume the person waits on runs: that one attaches.
    serve({ ...fresh, status: "running" }, BOOTING, { ...resumed, status: "running" });
    await pushed();
    await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledTimes(1);
    expect(attachTty).toHaveBeenCalledWith("earlier", "claude");
    setup.renderer.destroy();
  });

  it("ends the game and attaches when the session runs mid-game", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");
    // The game has the keyboard: it counts down, then the snake runs.
    let frame = await wait(4 * COUNTDOWN_STEP_MS + 300);
    expect(frame).toContain("◆");
    expect(frame.trimEnd().split("\n").at(-1)).toContain("steer");

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    frame = await pushed();
    expect(statusLine(frame)).toMatch(/^ready · fresh · attaching · snake score \d+$/u);
    expect(frame).not.toContain("play snake while you wait");
    await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledWith("fresh", "claude");
    setup.renderer.destroy();
  });

  it("attaches a shell session the same way", async () => {
    let dashboard: Dashboard | null = null;
    const shell = session("plain", "starting", LATER, "shell");
    dashboard = await openDashboard({
      routes: startRoutes("plain", () => dashboard?.serve(shell, BOOTING, EARLIER), "shell"),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    for (let step = 0; step < 4; step += 1) await press("down");
    let frame = await press("return");
    expect(frame).not.toContain("pick a harness");

    serve({ ...shell, status: "running" }, BOOTING, EARLIER);
    await pushed();
    frame = await wait(HANDOVER_MS);
    expect(attachTty).toHaveBeenCalledWith("plain", "shell");
    setup.renderer.destroy();
  });

  it("shows a refused start and attaches nothing", async () => {
    const { setup, attachTty, pushed, wait, press } = await openDashboard({
      routes: {
        "POST /worktrees/w1/sessions": session("fresh", "starting", LATER),
        "POST /sessions/fresh/launch": () => Promise.reject(new Error("launch refused")),
      },
    });
    await press("n");
    await press("return");
    let frame = await wait(0);
    expect(statusLine(frame)).toBe("launch refused");
    frame = await pushed();
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    setup.renderer.destroy();
  });

  it("says a session that failed while it started never ran, and attaches nothing", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    await press("return");

    serve({ ...fresh, status: "failed" }, BOOTING, EARLIER);
    const frame = await pushed();
    expect(statusLine(frame)).toBe("failed · fresh · it did not reach running");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    setup.renderer.destroy();
  });

  it("leaves every attach to `a` with auto-attach off", async () => {
    let dashboard: Dashboard | null = null;
    const fresh = session("fresh", "starting", LATER);
    dashboard = await openDashboard({
      autoAttach: false,
      routes: startRoutes("fresh", () => dashboard?.serve(fresh, BOOTING, EARLIER)),
    });
    const { setup, attachTty, serve, pushed, wait, press } = dashboard;
    await press("n");
    let frame = await press("return");
    frame = await wait(0);
    expect(statusLine(frame)).toBe(
      "still starting · fresh · a attaches once the row reads running",
    );

    serve({ ...fresh, status: "running" }, BOOTING, EARLIER);
    frame = await pushed();
    expect(statusLine(frame)).toBe("started · fresh · a attaches");
    await wait(HANDOVER_MS * 2);
    expect(attachTty).not.toHaveBeenCalled();
    // `a` still attaches it.
    await press("a");
    await wait(0);
    expect(attachTty).toHaveBeenCalledWith("fresh", "claude");
    setup.renderer.destroy();
  });
});
