/**
 * The snake in the real dashboard, on OpenTUI's test renderer: who has the keyboard, the
 * countdown as drawn, and where the keys go. The server is a fake answering the workbench reads.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KeyInput, TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectDetailDto, ProjectDto, SessionDto } from "./dashboard-model.ts";
import { App, type DashboardContext } from "./dashboard.tsx";
import { COUNTDOWN_STEP_MS } from "./snake-play.ts";
import { ACCENT, RULE } from "./tui-theme.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const PROJECT: ProjectDto = {
  id: "p1",
  name: "mend",
  originUrl: null,
  storePath: "/store/mend",
  defaultBranch: "main",
};
const session = (id: string, status: string, createdAt: string): SessionDto => ({
  id,
  worktreeId: "w1",
  harness: "claude",
  label: id,
  branch: "mend/game",
  baseSha: "abc1234",
  baseRef: "main",
  status,
  summary: null,
  createdAt,
});
const DETAIL: ProjectDetailDto = {
  project: PROJECT,
  // Newest first: the starting session is the one selected when the dashboard opens.
  sessions: [
    session("booting", "starting", NOW),
    session("earlier", "stopped", "2026-10-01T12:00:00.000Z"),
  ],
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
};
const ROUTES: Readonly<Record<string, unknown>> = {
  "GET /projects": [PROJECT],
  "GET /projects/p1": DETAIL,
  "GET /services": [],
};

/** A directory that is a git repository with an origin the store has never met. */
const unadoptedRepository = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "mend-snake-repo-"));
  spawnSync("git", ["init", "-q"], { cwd: directory });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    cwd: directory,
  });
  return directory;
};

/** The test renderer's names for the keys the dashboard reads by name. */
const KEY_INPUT: Readonly<Record<string, KeyInput>> = {
  return: "RETURN",
  escape: "ESCAPE",
  up: "ARROW_UP",
  down: "ARROW_DOWN",
  left: "ARROW_LEFT",
  right: "ARROW_RIGHT",
  space: " ",
};

interface Dashboard {
  readonly setup: TestRendererSetup;
  readonly onQuit: ReturnType<typeof vi.fn>;
  /** Let `ms` pass, then draw a frame. */
  readonly wait: (ms: number) => Promise<string>;
  readonly press: (key: string) => Promise<string>;
}

const openDashboard = async (
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly openSnake?: boolean;
    readonly cwd?: string;
    /** Answers beyond the workbench reads; a pending promise holds a request open. */
    readonly routes?: Readonly<Record<string, unknown>>;
  } = {},
): Promise<Dashboard> => {
  const onQuit = vi.fn();
  const ctx: DashboardContext = {
    config: { url: "http://mend.test", token: null },
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), "mend-snake-")),
    cwdBranch: null,
    api: async <T,>(method: string, route: string): Promise<T> => {
      const answer = { ...ROUTES, ...options.routes }[`${method} ${route}`];
      if (answer === undefined) throw new Error(`no fake for ${method} ${route}`);
      // The fake answers with the DTOs typed above; the dashboard's api is generic over them.
      return answer as T;
    },
    attachTty: async () => {
      throw new Error("no terminal to attach in a test");
    },
    agentShare: null,
    tunnels: null,
    ...(options.openSnake === true ? { openSnake: true } : {}),
  };
  const setup = await testRender(
    <QueryClientProvider client={new QueryClient()}>
      <App ctx={ctx} onQuit={onQuit} />
    </QueryClientProvider>,
    { width: options.width ?? 120, height: options.height ?? 36 },
  );
  const wait = async (ms: number): Promise<string> => {
    // In small steps, each its own act: React commits between them, so a timer that a commit
    // schedules (the next countdown step, the ticks) runs within the same wait.
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
    // A lone escape is told apart from a sequence by a short wait in the input parser.
    return wait(key === "escape" ? 60 : 0);
  };
  await wait(50);
  return { setup, onQuit, wait, press };
};

/** The board's cells, inside its frame, from a drawn dashboard. */
const board = (frame: string): string[] => {
  const lines = frame.split("\n");
  const top = lines.findIndex((line) => line.includes("╭─ snake"));
  const left = lines[top]!.indexOf("╭─ snake");
  const bottom = lines.findIndex((line, index) => index > top && line[left] === "╰");
  const right = lines[top]!.indexOf("╮", left);
  return lines.slice(top + 1, bottom).map((line) => line.slice(left + 1, right).trimEnd());
};
/** Where the snake's head is on the board. */
const headOf = (frame: string): { readonly x: number; readonly y: number } => {
  const rows = board(frame);
  const y = rows.findIndex((row) => row.includes("◆"));
  return { x: rows[y]!.indexOf("◆"), y };
};
const footer = (frame: string): string => frame.trimEnd().split("\n").at(-1)!.trim();
/** More block cells than the snake's body: the countdown is drawn. */
const hasDigits = (frame: string): boolean =>
  board(frame)
    .join("")
    .replace(/[^█▀▄]/g, "").length > 4;

/** The colour of the board's frame, as #rrggbb. */
const boardBorderColor = (setup: TestRendererSetup): string => {
  for (const line of setup.captureSpans().lines) {
    const corner = line.spans.find((span) => span.text.startsWith("╭─ snake"));
    if (corner === undefined) continue;
    const [r, g, b] = corner.fg.toInts();
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }
  throw new Error("no snake board on screen");
};

const SNAKE_KEYS = "←↑↓→/hjkl steer · space/p pause · esc/q leave";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  // The food lands in the same cell every run, so the drawn frames can be snapshotted.
  vi.spyOn(Math, "random").mockReturnValue(0.37);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("snake in the session pane", () => {
  it("waits on the board while the list has the keyboard: nothing moves, the arrows walk the list", async () => {
    const { setup, wait, press } = await openDashboard();
    let frame = await wait(0);
    expect(frame).toContain("play snake while you wait");
    expect(frame).toContain("enter plays");
    expect(footer(frame)).toContain("↑↓ move");
    expect(boardBorderColor(setup)).toBe(RULE);
    const start = headOf(frame);
    frame = await wait(5000);
    expect(headOf(frame)).toEqual(start);
    expect(hasDigits(frame)).toBe(false);
    // The arrows are the list's: down selects the older session, whose pane has no game.
    frame = await press("down");
    expect(frame).not.toContain("play snake while you wait");
    frame = await press("up");
    expect(headOf(frame)).toEqual(start);
    setup.renderer.destroy();
  });

  it("counts down 3, 2, 1, go once it has the keyboard, and the snake waits for go", async () => {
    const { setup, wait, press } = await openDashboard();
    const start = headOf(await wait(0));
    const frames = [await press("return")];
    for (let step = 0; step < 3; step += 1) frames.push(await wait(COUNTDOWN_STEP_MS));
    expect(frames.map((frame) => board(frame).join("\n")).join("\n\n")).toMatchSnapshot();
    for (const frame of frames) {
      expect(hasDigits(frame)).toBe(true);
      expect(headOf(frame)).toEqual(start);
      expect(footer(frame)).toBe(SNAKE_KEYS);
    }
    expect(boardBorderColor(setup)).toBe(ACCENT);
    // Go is over: the digits go and the snake moves.
    const running = await wait(COUNTDOWN_STEP_MS);
    expect(hasDigits(running)).toBe(false);
    const moved = await wait(500);
    expect(headOf(moved).y).toBe(start.y);
    expect(headOf(moved).x).toBeGreaterThan(start.x);
    setup.renderer.destroy();
  });

  it("sends the arrows and h j k l to the snake while it has the keyboard, never to the list", async () => {
    const { setup, wait, press } = await openDashboard();
    const start = headOf(await wait(0));
    await press("l"); // into the pane is into the game
    // A turn during the countdown: the list does not move, the snake turns at go.
    let frame = await press("down");
    expect(frame).toContain("▌ booting");
    expect(frame).toContain("play snake while you wait");
    frame = await press("j");
    expect(frame).toContain("play snake while you wait");
    frame = await wait(4 * COUNTDOWN_STEP_MS + 300);
    expect(headOf(frame).x).toBe(start.x);
    expect(headOf(frame).y).toBeGreaterThan(start.y);
    // Keys the game has no use for are swallowed, not handed to the dashboard behind it.
    frame = await press("n");
    expect(frame).not.toContain("pick a harness");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    setup.renderer.destroy();
  });

  it("hands the keyboard back to the list on esc or q, and pauses where it was", async () => {
    const { setup, onQuit, wait, press } = await openDashboard();
    await press("return");
    await wait(4 * COUNTDOWN_STEP_MS + 500);
    let frame = await press("escape");
    expect(footer(frame)).toContain("↑↓ move");
    expect(frame).toContain("enter plays");
    expect(frame).toContain("· paused");
    expect(boardBorderColor(setup)).toBe(RULE);
    const paused = headOf(frame);
    frame = await wait(3000);
    expect(headOf(frame)).toEqual(paused);
    // Back in the game it counts down again before the snake moves.
    frame = await press("return");
    expect(hasDigits(frame)).toBe(true);
    expect(headOf(await wait(3 * COUNTDOWN_STEP_MS))).toEqual(paused);
    // q leaves the game, not the dashboard.
    frame = await press("q");
    expect(onQuit).not.toHaveBeenCalled();
    expect(footer(frame)).toContain("↑↓ move");
    // And the arrows are the list's again.
    frame = await press("down");
    expect(frame).not.toContain("play snake while you wait");
    setup.renderer.destroy();
  });

  it("pauses on space or p and counts down again to resume", async () => {
    const { setup, wait, press } = await openDashboard();
    await press("return");
    await wait(4 * COUNTDOWN_STEP_MS + 300);
    let frame = await press("space");
    expect(frame).toContain("· paused");
    expect(footer(frame)).toBe("enter/space resume · esc/q leave");
    const at = headOf(frame);
    expect(headOf(await wait(2000))).toEqual(at);
    frame = await press("p");
    expect(hasDigits(frame)).toBe(true);
    expect(headOf(await wait(3 * COUNTDOWN_STEP_MS + 500))).toEqual(at);
    expect(headOf(await wait(COUNTDOWN_STEP_MS + 300))).not.toEqual(at);
    setup.renderer.destroy();
  });

  it("keeps counting through a resize, with digits sized to the new board", async () => {
    const { setup, wait, press } = await openDashboard();
    await press("return");
    let frame = await wait(COUNTDOWN_STEP_MS);
    const before = board(frame).length;
    await act(async () => setup.resize(100, 24));
    frame = await wait(0);
    expect(board(frame).length).toBeLessThan(before);
    expect(hasDigits(frame)).toBe(true);
    const start = headOf(frame);
    // Two steps were left of three; the snake moves after them and go.
    frame = await wait(2 * COUNTDOWN_STEP_MS + 300);
    expect(headOf(frame)).toEqual(start);
    frame = await wait(COUNTDOWN_STEP_MS);
    expect(hasDigits(frame)).toBe(false);
    setup.renderer.destroy();
  });

  it("hands the keyboard back to the column a start came from", async () => {
    // A start held open: its session shows as starting, and its game takes the keyboard.
    const { setup, press } = await openDashboard({
      routes: { "POST /worktrees/w1/sessions": new Promise(() => {}) },
    });
    let frame = await press("h");
    const worktreeKeys = footer(frame);
    // Only the worktree column says "stop all"; the footer keeps `? keys` at its end, so the
    // hints after it drop first at this width.
    expect(worktreeKeys).toContain("⇧K stop all");
    await press("n");
    frame = await press("return");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    frame = await press("escape");
    expect(footer(frame)).toBe(worktreeKeys);
    setup.renderer.destroy();
  });

  it("keeps the game's keyboard when another session's start fails", async () => {
    const start = Promise.withResolvers<never>();
    const { setup, wait, press } = await openDashboard({
      routes: { "POST /worktrees/w1/sessions": start.promise },
    });
    // Start a session (its game takes the keyboard), leave that game, then play the one in
    // the session that was already starting.
    await press("n");
    let frame = await press("return");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    await press("escape");
    frame = await press("down");
    expect(frame).toContain("booting · claude");
    frame = await press("return");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    await wait(4 * COUNTDOWN_STEP_MS + 300);
    // The first start fails: that is not this game's request, so it keeps the keyboard.
    await act(async () => start.reject(new Error("start refused")));
    frame = await wait(0);
    expect(frame).toContain("start refused");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    setup.renderer.destroy();
  });

  it("says the terminal is too short instead of playing a game it cannot show whole", async () => {
    const { setup, wait, press } = await openDashboard({ width: 100, height: 12 });
    let frame = await wait(0);
    expect(frame).toContain("make the terminal taller to play snake");
    expect(frame).not.toContain("╭─ snake");
    // Enter goes into the pane, but the keyboard stays the dashboard's: no game, no countdown.
    frame = await press("return");
    expect(footer(frame)).not.toBe(SNAKE_KEYS);
    expect(frame).toContain("make the terminal taller to play snake");
    // Grown tall enough, the board shows, and Enter plays.
    await act(async () => setup.resize(100, 30));
    frame = await press("left");
    frame = await press("return");
    expect(footer(frame)).toBe(SNAKE_KEYS);
    expect(hasDigits(frame)).toBe(true);
    setup.renderer.destroy();
  });

  it("gives way to the board in a short terminal: the whole board shows, and the facts make room", async () => {
    for (const height of [22, 18, 16, 14]) {
      const { setup, press } = await openDashboard({ width: 100, height });
      const frame = await press("return");
      expect(footer(frame), `${height} rows`).toBe(SNAKE_KEYS);
      expect(frame, `${height} rows`).toContain("◆");
      expect(board(frame).length, `${height} rows`).toBeGreaterThanOrEqual(4);
      expect(frame, `${height} rows`).toMatch(/╰─{8,}╯/);
      setup.renderer.destroy();
    }
  });

  it("falls back to small digits in a short terminal", async () => {
    const { setup, press } = await openDashboard({ width: 100, height: 22 });
    const frame = await press("return");
    const rows = board(frame);
    expect(rows.length).toBeLessThanOrEqual(6);
    expect(hasDigits(frame)).toBe(true);
    expect(rows.join("\n")).toMatchSnapshot();
    setup.renderer.destroy();
  });
});

describe("mend snake", () => {
  it("waits for a dialog open at the start, then counts down with the keyboard", async () => {
    // A repository the store has never met: the dashboard opens with the adopt dialog over the
    // game. The dialog has the keyboard; the game waits under it without counting.
    const { setup, wait, press } = await openDashboard({
      openSnake: true,
      cwd: unadoptedRepository(),
    });
    let frame = await wait(3000);
    expect(frame).toContain("adopt this repository URL?");
    expect(frame).toContain("the countdown starts when this dialog closes");
    expect(frame).not.toContain("· paused");
    expect(footer(frame)).toBe("enter adopt · ←→ auth mode · esc not now");
    // Esc is the dialog's: it closes the dialog, not the game, which now counts down.
    frame = await press("escape");
    expect(frame).not.toContain("adopt this repository URL?");
    expect(hasDigits(frame)).toBe(true);
    expect(footer(frame)).toBe(SNAKE_KEYS);
    const start = headOf(frame);
    frame = await wait(3 * COUNTDOWN_STEP_MS + 500);
    expect(headOf(frame)).toEqual(start);
    frame = await wait(COUNTDOWN_STEP_MS + 300);
    expect(headOf(frame)).not.toEqual(start);
    // The next esc is the game's: it closes, and the list has the keyboard again. The starting
    // session's own game waits in its pane without taking it.
    frame = await press("escape");
    expect(footer(frame)).toContain("↑↓ move");
    expect(frame).toContain("enter plays");
    expect(boardBorderColor(setup)).toBe(RULE);
    setup.renderer.destroy();
  });
});
