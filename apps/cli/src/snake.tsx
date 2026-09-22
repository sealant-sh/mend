/**
 * The snake in the detail pane while a session is `starting` (see snake-game.ts for the rules).
 * The dashboard owns the game through `useSnake` so its keyboard handler can steer, pause and put
 * it away; this file only ticks and draws.
 */
import { useEffect, useState } from "react";

import { newSnakeGame, render, tick, turn, type Direction, type SnakeGame } from "./snake-game.ts";
import { ACCENT, FAINT, GREEN, INK, MUTED, RULE } from "./tui-theme.ts";

const TICK_MS = 140;

export interface SnakeHandle {
  readonly game: SnakeGame;
  readonly paused: boolean;
  /** A turn; after the game is over, any turn starts a new one. Steering resumes a pause. */
  readonly steer: (direction: Direction) => void;
  readonly togglePause: () => void;
}

export const useSnake = (options: {
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
}): SnakeHandle => {
  const { width, height, enabled } = options;
  const [game, setGame] = useState<SnakeGame>(() => newSnakeGame(width, height, Math.random));
  const [paused, setPaused] = useState(false);
  // A new board size, or a game that comes back after the pane was elsewhere, starts fresh.
  useEffect(() => {
    if (enabled) {
      setGame(newSnakeGame(width, height, Math.random));
      setPaused(false);
    }
  }, [width, height, enabled]);
  useEffect(() => {
    if (!enabled || paused) return;
    const timer = setInterval(() => setGame((current) => tick(current, Math.random)), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, paused]);
  const steer = (direction: Direction): void => {
    setPaused(false);
    setGame((current) =>
      current.over
        ? newSnakeGame(current.width, current.height, Math.random)
        : turn(current, direction),
    );
  };
  const togglePause = (): void => setPaused((current) => !current);
  return { game, paused, steer, togglePause };
};

export const SnakeBoard = ({
  handle,
  focused,
}: {
  readonly handle: SnakeHandle;
  readonly focused: boolean;
}) => {
  const { game, paused } = handle;
  const rows = render(game);
  const state = game.over ? "over · any arrow starts again" : paused ? "paused" : null;
  return (
    <>
      <text height={1} bg="transparent">
        <span>{"  "}</span>
        <span fg={INK}>play snake while you wait</span>
        <span fg={FAINT}>{" · score "}</span>
        <span fg={game.over ? MUTED : ACCENT}>{String(game.score)}</span>
        {state === null ? null : <span fg={FAINT}>{` · ${state}`}</span>}
      </text>
      <text height={1} bg="transparent" fg={FAINT}>
        {focused
          ? "  arrows steer · space pauses · esc puts it away"
          : "  focus this pane to play · esc puts it away"}
      </text>
      <box
        border
        borderStyle="rounded"
        borderColor={focused ? ACCENT : RULE}
        width={game.width + 2}
        height={game.height + 2}
        flexShrink={0}
        marginLeft={2}
      >
        {rows.map((row, index) => (
          <text key={index} height={1} bg="transparent">
            {[...row].map((cell, x) => (
              <span
                key={x}
                fg={cell === "◆" ? ACCENT : cell === "█" ? GREEN : cell === "●" ? INK : FAINT}
              >
                {cell === "·" ? " " : cell}
              </span>
            ))}
          </text>
        ))}
      </box>
    </>
  );
};
