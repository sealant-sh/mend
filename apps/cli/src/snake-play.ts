/**
 * How a game of snake is played around its rules (snake-game.ts): who has the keys, the
 * countdown before the snake moves, pausing, and the countdown's digits. Pure, like the rules:
 * a play is a value and every event is a function of it, so the countdown, focus and key
 * routing are testable without a terminal.
 *
 * The snake never moves without the player: it waits on the board until the game has the
 * keyboard, then counts 3, 2, 1, go, then runs. Leaving pauses it; coming back, resuming or a
 * new game counts down again.
 */
import { newSnakeGame, tick, turn, type Direction, type SnakeGame } from "./snake-game.ts";

/** The countdown's steps, 3 down to 0, where 0 is "go". */
export type CountdownStep = 3 | 2 | 1 | 0;

export type SnakeClock =
  /** On the board, not started: nothing has handed it the keyboard yet, or the last game ended. */
  | { readonly kind: "ready" }
  | { readonly kind: "countdown"; readonly step: CountdownStep }
  | { readonly kind: "running" }
  | { readonly kind: "paused" };

export interface SnakePlay {
  readonly game: SnakeGame;
  readonly clock: SnakeClock;
  /** Whether the game has the keyboard. */
  readonly focused: boolean;
  /** The board size asked for; the game clamps it to its minimum. */
  readonly width: number;
  readonly height: number;
}

export type SnakeEvent =
  | { readonly type: "focus" }
  | { readonly type: "blur" }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  /** The countdown's timer: one step down, and from "go" to running. */
  | { readonly type: "count" }
  | { readonly type: "tick" }
  | { readonly type: "steer"; readonly direction: Direction }
  | { readonly type: "togglePause" }
  /** Enter: start, resume or start again; nothing while running. */
  | { readonly type: "play" };

export const TICK_MS = 140;
export const COUNTDOWN_STEP_MS = 1000;

const COUNTDOWN: SnakeClock = { kind: "countdown", step: 3 };
const RUNNING: SnakeClock = { kind: "running" };
const PAUSED: SnakeClock = { kind: "paused" };
const READY: SnakeClock = { kind: "ready" };

export const newSnakePlay = (width: number, height: number, random: () => number): SnakePlay => ({
  game: newSnakeGame(width, height, random),
  clock: READY,
  focused: false,
  width,
  height,
});

/** Count down again, on a fresh board if the last game ended. */
const countDown = (play: SnakePlay, random: () => number): SnakePlay => ({
  ...play,
  game: play.game.over ? newSnakeGame(play.width, play.height, random) : play.game,
  clock: COUNTDOWN,
});

export const reduceSnake = (
  play: SnakePlay,
  event: SnakeEvent,
  random: () => number,
): SnakePlay => {
  switch (event.type) {
    case "focus":
      return play.focused ? play : { ...countDown(play, random), focused: true };
    case "blur": {
      // Only a running game reads as paused; a countdown cut short goes back to waiting.
      if (!play.focused) return play;
      const clock =
        play.clock.kind === "running"
          ? PAUSED
          : play.clock.kind === "countdown"
            ? READY
            : play.clock;
      return { ...play, focused: false, clock };
    }
    case "resize": {
      if (event.width === play.width && event.height === play.height) return play;
      // A new board is a new game. A countdown already under way keeps counting (the snake has
      // not moved yet); a game that was running counts down again on the new board.
      return {
        ...play,
        width: event.width,
        height: event.height,
        game: newSnakeGame(event.width, event.height, random),
        clock: play.clock.kind === "running" ? COUNTDOWN : play.clock,
      };
    }
    case "count": {
      if (!play.focused || play.clock.kind !== "countdown") return play;
      const { step } = play.clock;
      return {
        ...play,
        clock:
          step === 0 ? RUNNING : { kind: "countdown", step: step === 3 ? 2 : step === 2 ? 1 : 0 },
      };
    }
    case "tick": {
      // Only a running clock moves the snake: never during the countdown, a pause, or unfocused.
      if (!play.focused || play.clock.kind !== "running") return play;
      const game = tick(play.game, random);
      return { ...play, game, clock: game.over ? READY : play.clock };
    }
    case "steer": {
      if (!play.focused) return play;
      if (play.game.over) return countDown(play, random);
      // A turn during the countdown is queued for the first move. A turn on a paused game
      // resumes it, through the countdown.
      const game = turn(play.game, event.direction);
      return play.clock.kind === "running" || play.clock.kind === "countdown"
        ? { ...play, game }
        : { ...play, game, clock: COUNTDOWN };
    }
    case "togglePause":
      if (!play.focused) return play;
      return play.clock.kind === "running" || play.clock.kind === "countdown"
        ? { ...play, clock: PAUSED }
        : countDown(play, random);
    case "play":
      if (!play.focused || play.clock.kind === "running" || play.clock.kind === "countdown") {
        return play;
      }
      return countDown(play, random);
  }
};

/** What a key means while the game has the keyboard; `leave` hands it back. */
export type SnakeKey =
  | { readonly type: "steer"; readonly direction: Direction }
  | { readonly type: "togglePause" }
  | { readonly type: "play" }
  | { readonly type: "leave" };

const KEY_DIRECTIONS: Readonly<Record<string, Direction>> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  k: "up",
  j: "down",
  h: "left",
  l: "right",
};

/** The game's keymap; null for a key it ignores (it still swallows it). */
export const snakeKey = (name: string): SnakeKey | null => {
  const direction = KEY_DIRECTIONS[name];
  if (direction !== undefined) return { type: "steer", direction };
  if (name === "space" || name === "p") return { type: "togglePause" };
  if (name === "return" || name === "linefeed") return { type: "play" };
  if (name === "escape" || name === "q") return { type: "leave" };
  return null;
};

/** The footer for a game with the keyboard, in the dashboard's hint style. */
export const snakeHints = (play: SnakePlay): string =>
  play.game.over
    ? "enter/arrows again · esc/q leave"
    : play.clock.kind === "paused" || play.clock.kind === "ready"
      ? "enter/space resume · esc/q leave"
      : "←↑↓→/hjkl steer · space/p pause · esc/q leave";

// ─── the countdown's digits ──────────────────────────────────────────────────

/**
 * Seven segments per glyph: a top, b top right, c bottom right, d bottom, e bottom left,
 * f top left, g middle. G and O spell "go" in the same segments.
 */
const SEGMENTS: Readonly<Record<string, string>> = {
  "1": "bc",
  "2": "abdeg",
  "3": "abcdg",
  G: "acdef",
  O: "abcdef",
};

/**
 * One glyph as pixels, `length` long per segment and `thickness` thick. The corners join the
 * segments they touch, so the digits read as pixel art rather than a calculator's gaps.
 */
const glyphPixels = (char: string, length: number, thickness: number): boolean[][] => {
  const lit = new Set(SEGMENTS[char] ?? "");
  const on = (...segments: string[]): boolean => segments.some((segment) => lit.has(segment));
  const width = length + 2 * thickness;
  const height = 2 * length + 3 * thickness;
  const column = (x: number): "left" | "middle" | "right" =>
    x < thickness ? "left" : x < thickness + length ? "middle" : "right";
  const row = (y: number): "top" | "upper" | "centre" | "lower" | "bottom" =>
    y < thickness
      ? "top"
      : y < thickness + length
        ? "upper"
        : y < 2 * thickness + length
          ? "centre"
          : y < 2 * thickness + 2 * length
            ? "lower"
            : "bottom";
  const pixel = (x: number, y: number): boolean => {
    const where = `${column(x)} ${row(y)}`;
    switch (where) {
      case "middle top":
        return on("a");
      case "middle centre":
        return on("g");
      case "middle bottom":
        return on("d");
      case "left upper":
        return on("f");
      case "right upper":
        return on("b");
      case "left lower":
        return on("e");
      case "right lower":
        return on("c");
      case "left top":
        return on("a", "f");
      case "right top":
        return on("a", "b");
      case "left centre":
        return on("f", "e", "g");
      case "right centre":
        return on("b", "c", "g");
      case "left bottom":
        return on("e", "d");
      case "right bottom":
        return on("c", "d");
      default:
        return false;
    }
  };
  return Array.from({ length: height }, (_row, y) =>
    Array.from({ length: width }, (_cell, x) => pixel(x, y)),
  );
};

/** Pixels two to a cell, top and bottom, as half blocks; a space is transparent. */
const halfBlocks = (pixels: readonly (readonly boolean[])[]): string[] => {
  const rows: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    const top = pixels[y] ?? [];
    const bottom = pixels[y + 1] ?? [];
    rows.push(
      top
        .map((upper, x) => {
          const lower = bottom[x] === true;
          return upper && lower ? "█" : upper ? "▀" : lower ? "▄" : " ";
        })
        .join(""),
    );
  }
  return rows;
};

/** A label ("3", "GO") at one size: its glyphs side by side, `thickness` apart. */
const drawLabel = (label: string, length: number, thickness: number): string[] => {
  const glyphs = [...label].map((char) => glyphPixels(char, length, thickness));
  const gap = Array.from({ length: thickness }, () => false);
  const height = 2 * length + 3 * thickness;
  const pixels = Array.from({ length: height }, (_, y) =>
    glyphs.flatMap((glyph, index) => (index === 0 ? glyph[y]! : [...gap, ...glyph[y]!])),
  );
  // Unlit columns at the edges go, so a "1" centres on its stroke and not on a digit's box.
  const lit = (x: number): boolean => pixels.some((line) => line[x] === true);
  const width = pixels[0]?.length ?? 0;
  let first = 0;
  while (first < width && !lit(first)) first += 1;
  let last = width - 1;
  while (last > first && !lit(last)) last -= 1;
  return halfBlocks(pixels.map((line) => line.slice(first, last + 1)));
};

export const countdownLabel = (step: CountdownStep): string => (step === 0 ? "GO" : String(step));

/** The longest segment the countdown draws, so a big board gets big digits but not a wall. */
const MAX_SEGMENT = 12;

/**
 * The countdown label as big digits sized to a board of `cols` × `rows` cells: the largest
 * that fits with a margin, thicker strokes once there is room, and down to three-row digits on
 * the smallest board. A board too small even for those gets the label as plain text.
 */
export const countdownArt = (label: string, cols: number, rows: number): readonly string[] => {
  const marginRows = Math.floor(rows / 8);
  const marginCols = cols >= 12 ? 1 : 0;
  const fitRows = rows - 2 * marginRows;
  const fitCols = cols - 2 * marginCols;
  for (let length = MAX_SEGMENT; length >= 1; length -= 1) {
    const thickness = length >= 5 ? 2 : 1;
    const art = drawLabel(label, length, thickness);
    if (art.length <= fitRows && (art[0]?.length ?? 0) <= fitCols) return art;
  }
  return label.length <= cols ? [label] : [label.slice(0, Math.max(1, cols))];
};

/**
 * The board with the countdown over it: `art` centred, its spaces transparent. Returns, per
 * cell, the board's character and the art's (null where the art is transparent), so the
 * component can keep the snake and the food on top while the digits fill around them.
 */
export const overlayArt = (
  board: readonly string[],
  art: readonly string[],
): readonly (readonly { readonly board: string; readonly art: string | null }[])[] => {
  const height = board.length;
  const width = [...(board[0] ?? "")].length;
  const artWidth = Math.max(0, ...art.map((line) => [...line].length));
  const top = Math.floor((height - art.length) / 2);
  const left = Math.floor((width - artWidth) / 2);
  return board.map((line, y) => {
    const artLine = art[y - top];
    const artCells = artLine === undefined ? [] : [...artLine];
    return [...line].map((cell, x) => {
      const char = artCells[x - left];
      return { board: cell, art: char === undefined || char === " " ? null : char };
    });
  });
};
