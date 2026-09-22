/**
 * The snake in the detail pane while a session is `starting` (see snake-game.ts for the rules).
 * The dashboard owns the game through `useSnake` so its keyboard handler can steer it; this file
 * only ticks and draws.
 */
import { useEffect, useState } from "react";

import { newSnakeGame, render, tick, turn, type Direction, type SnakeGame } from "./snake-game.ts";
import { ACCENT, FAINT, GREEN, INK, MUTED } from "./tui-theme.ts";

const TICK_MS = 140;

export interface SnakeHandle {
  readonly game: SnakeGame;
  /** A turn; after the game is over, any turn starts a new one. */
  readonly steer: (direction: Direction) => void;
}

export const useSnake = (options: {
  readonly width: number;
  readonly height: number;
  readonly enabled: boolean;
}): SnakeHandle => {
  const { width, height, enabled } = options;
  const [game, setGame] = useState<SnakeGame>(() => newSnakeGame(width, height, Math.random));
  // A new board size, or a game that comes back after the pane was elsewhere, starts fresh.
  useEffect(() => {
    if (enabled) setGame(newSnakeGame(width, height, Math.random));
  }, [width, height, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setGame((current) => tick(current, Math.random)), TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  const steer = (direction: Direction): void =>
    setGame((current) =>
      current.over
        ? newSnakeGame(current.width, current.height, Math.random)
        : turn(current, direction),
    );
  return { game, steer };
};

export const SnakeBoard = ({
  handle,
  focused,
}: {
  readonly handle: SnakeHandle;
  readonly focused: boolean;
}) => {
  const { game } = handle;
  const rows = render(game);
  return (
    <>
      <text height={1} bg="transparent">
        <span>{"  "}</span>
        <span fg={FAINT}>{focused ? "arrows steer" : "focus this pane to play"}</span>
        <span fg={FAINT}>{" · score "}</span>
        <span fg={game.over ? MUTED : ACCENT}>{String(game.score)}</span>
        {game.over ? <span fg={FAINT}>{" · over, any arrow starts again"}</span> : null}
      </text>
      {rows.map((row, index) => (
        <text key={index} height={1} bg="transparent">
          <span>{"  "}</span>
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
    </>
  );
};
