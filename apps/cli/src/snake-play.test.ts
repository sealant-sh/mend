import { describe, expect, it } from "vitest";

import {
  countdownArt,
  countdownLabel,
  newSnakePlay,
  overlayArt,
  reduceSnake,
  snakeHints,
  snakeKey,
  type CountdownStep,
  type SnakeEvent,
  type SnakePlay,
} from "./snake-play.ts";

const zero = () => 0;
const send = (play: SnakePlay, ...events: SnakeEvent[]): SnakePlay =>
  events.reduce((current, event) => reduceSnake(current, event, zero), play);
const head = (play: SnakePlay) => play.game.snake[0];
const frame = (rows: readonly string[]): string => rows.map((row) => `|${row}|`).join("\n");

describe("the countdown's digits", () => {
  const steps: CountdownStep[] = [3, 2, 1, 0];

  it("draws 3, 2, 1, go as half-block digits sized to the session pane's board", () => {
    const frames = steps.map((step) => frame(countdownArt(countdownLabel(step), 40, 14)));
    expect(frames.join("\n\n")).toMatchInlineSnapshot(`
      "|█████████████|
      |           ██|
      |           ██|
      |           ██|
      |           ██|
      |▄▄▄▄▄▄▄▄▄▄▄██|
      |▀▀▀▀▀▀▀▀▀▀▀██|
      |           ██|
      |           ██|
      |           ██|
      |           ██|
      |█████████████|

      |█████████████|
      |           ██|
      |           ██|
      |           ██|
      |           ██|
      |▄▄▄▄▄▄▄▄▄▄▄██|
      |██▀▀▀▀▀▀▀▀▀▀▀|
      |██           |
      |██           |
      |██           |
      |██           |
      |█████████████|

      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|
      |██|

      |█████████████  █████████████|
      |██             ██         ██|
      |██             ██         ██|
      |██             ██         ██|
      |██             ██         ██|
      |██         ▄▄  ██         ██|
      |██         ██  ██         ██|
      |██         ██  ██         ██|
      |██         ██  ██         ██|
      |██         ██  ██         ██|
      |██         ██  ██         ██|
      |█████████████  █████████████|"
    `);
  });

  it("shrinks with the board, down to three-row digits on the smallest one", () => {
    expect(frame(countdownArt("3", 16, 6))).toMatchInlineSnapshot(`
      "|▀▀▀▀▀█|
      |     █|
      |▄▄▄▄▄█|
      |     █|
      |     █|
      |▀▀▀▀▀▀|"
    `);
    expect(frame(countdownArt("3", 8, 4))).toMatchInlineSnapshot(`
      "|▀▀▀█|
      |▄▄▄█|
      |   █|
      |▀▀▀▀|"
    `);
    expect(frame(countdownArt("GO", 8, 4))).toMatchInlineSnapshot(`
      "|█▀▀ █▀█|
      |█ █ █ █|
      |▀▀▀ ▀▀▀|"
    `);
  });

  it("falls back to the label as text when not even the small digits fit", () => {
    expect(countdownArt("3", 2, 2)).toEqual(["3"]);
    expect(countdownArt("GO", 4, 2)).toEqual(["GO"]);
  });

  it("always fits the board it is drawn on", () => {
    for (let cols = 1; cols <= 60; cols += 3) {
      for (let rows = 1; rows <= 20; rows += 1) {
        for (const step of steps) {
          const art = countdownArt(countdownLabel(step), cols, rows);
          expect(art.length).toBeLessThanOrEqual(rows);
          for (const line of art) expect([...line].length).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it("centres over the board and leaves the board's cells where the digits are blank", () => {
    const board = ["········", "··██◆···", "········"];
    const cells = overlayArt(board, ["█ ", " █"]);
    expect(cells[0]![3]).toEqual({ board: "·", art: "█" });
    expect(cells[0]![4]).toEqual({ board: "·", art: null });
    expect(cells[1]![4]).toEqual({ board: "◆", art: "█" });
    expect(cells[2]!.every((cell) => cell.art === null)).toBe(true);
  });
});

describe("playing snake", () => {
  it("waits on the board until it has the keyboard: ticks move nothing", () => {
    const play = newSnakePlay(20, 8, zero);
    expect(play.clock).toEqual({ kind: "ready" });
    expect(send(play, { type: "tick" }, { type: "tick" })).toBe(play);
  });

  it("counts down 3, 2, 1, go when it gets the keyboard, and the snake does not move until go is over", () => {
    let play = send(newSnakePlay(20, 8, zero), { type: "focus" });
    const start = head(play);
    const seen: string[] = [];
    while (play.clock.kind === "countdown") {
      seen.push(countdownLabel(play.clock.step));
      play = send(play, { type: "tick" }, { type: "tick" });
      expect(head(play)).toEqual(start);
      play = send(play, { type: "count" });
    }
    expect(seen).toEqual(["3", "2", "1", "GO"]);
    expect(play.clock).toEqual({ kind: "running" });
    play = send(play, { type: "tick" });
    expect(head(play)).toEqual({ x: start!.x + 1, y: start!.y });
  });

  it("takes a turn during the countdown as the first move", () => {
    let play = send(newSnakePlay(20, 8, zero), { type: "focus" });
    const start = head(play)!;
    play = send(play, { type: "steer", direction: "up" });
    expect(head(play)).toEqual(start);
    play = send(play, { type: "count" }, { type: "count" }, { type: "count" }, { type: "count" });
    play = send(play, { type: "tick" });
    expect(head(play)).toEqual({ x: start.x, y: start.y - 1 });
  });

  it("pauses when it loses the keyboard, and counts down again when it gets it back", () => {
    let play = send(
      newSnakePlay(20, 8, zero),
      { type: "focus" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
      { type: "tick" },
    );
    play = send(play, { type: "blur" });
    expect(play.clock).toEqual({ kind: "paused" });
    const at = head(play);
    expect(head(send(play, { type: "tick" }))).toEqual(at);
    // No keys reach a game without the keyboard.
    expect(send(play, { type: "steer", direction: "up" }, { type: "togglePause" })).toBe(play);
    play = send(play, { type: "focus" });
    expect(play.clock).toEqual({ kind: "countdown", step: 3 });
    expect(head(play)).toEqual(at);
  });

  it("pauses on space and counts down again to resume", () => {
    let play = send(
      newSnakePlay(20, 8, zero),
      { type: "focus" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
    );
    play = send(play, { type: "togglePause" });
    expect(play.clock).toEqual({ kind: "paused" });
    const at = head(play);
    expect(head(send(play, { type: "tick" }))).toEqual(at);
    expect(send(play, { type: "togglePause" }).clock).toEqual({ kind: "countdown", step: 3 });
    expect(send(play, { type: "play" }).clock).toEqual({ kind: "countdown", step: 3 });
    // An arrow on a paused game resumes it too, through the countdown, with the turn queued.
    const steered = send(play, { type: "steer", direction: "down" });
    expect(steered.clock).toEqual({ kind: "countdown", step: 3 });
    expect(steered.game.pending).toBe("down");
  });

  it("keeps counting through a resize, on the new board", () => {
    let play = send(newSnakePlay(20, 8, zero), { type: "focus" }, { type: "count" });
    expect(play.clock).toEqual({ kind: "countdown", step: 2 });
    play = send(play, { type: "resize", width: 30, height: 10 });
    expect(play.clock).toEqual({ kind: "countdown", step: 2 });
    expect([play.game.width, play.game.height]).toEqual([30, 10]);
  });

  it("counts down again on a resize while running: the new board is a new game", () => {
    let play = send(
      newSnakePlay(20, 8, zero),
      { type: "focus" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
      { type: "count" },
    );
    play = send(play, { type: "resize", width: 16, height: 6 });
    expect(play.clock).toEqual({ kind: "countdown", step: 3 });
    expect(send(play, { type: "resize", width: 16, height: 6 })).toBe(play);
  });

  it("starts a new game through the countdown after it ends", () => {
    const over: SnakePlay = {
      ...send(newSnakePlay(20, 8, zero), { type: "focus" }),
      clock: { kind: "ready" },
      game: { ...newSnakePlay(20, 8, zero).game, over: true, score: 4 },
    };
    expect(snakeHints(over)).toBe("enter/arrows again · esc/q leave");
    const again = send(over, { type: "steer", direction: "left" });
    expect(again.game.over).toBe(false);
    expect(again.game.score).toBe(0);
    expect(again.clock).toEqual({ kind: "countdown", step: 3 });
  });
});

describe("the game's keys", () => {
  it("steers on the arrows and on h j k l", () => {
    expect(["up", "down", "left", "right", "k", "j", "h", "l"].map(snakeKey)).toEqual([
      { type: "steer", direction: "up" },
      { type: "steer", direction: "down" },
      { type: "steer", direction: "left" },
      { type: "steer", direction: "right" },
      { type: "steer", direction: "up" },
      { type: "steer", direction: "down" },
      { type: "steer", direction: "left" },
      { type: "steer", direction: "right" },
    ]);
  });

  it("pauses on space or p, plays on enter, and leaves on esc or q", () => {
    expect(snakeKey("space")).toEqual({ type: "togglePause" });
    expect(snakeKey("p")).toEqual({ type: "togglePause" });
    expect(snakeKey("return")).toEqual({ type: "play" });
    expect(snakeKey("escape")).toEqual({ type: "leave" });
    expect(snakeKey("q")).toEqual({ type: "leave" });
    expect(snakeKey("a")).toBeNull();
    expect(snakeKey("tab")).toBeNull();
  });

  it("names its keys in the footer as the game goes", () => {
    const ready = newSnakePlay(20, 8, zero);
    const counting = send(ready, { type: "focus" });
    expect(snakeHints(counting)).toBe("←↑↓→/hjkl steer · space/p pause · esc/q leave");
    expect(snakeHints(send(counting, { type: "togglePause" }))).toBe(
      "enter/space resume · esc/q leave",
    );
  });
});
