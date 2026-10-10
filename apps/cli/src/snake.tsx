/**
 * The snake in the detail pane while a session is `starting`, and over the dashboard for
 * `mend snake` (see snake-game.ts for the rules and snake-play.ts for focus and the countdown).
 * The dashboard decides when the game has the keyboard and routes its keys through `send`;
 * this file only times the countdown and the ticks, and draws.
 */
import { useEffect, useState } from "react";

import { render } from "./snake-game.ts";
import {
  COUNTDOWN_STEP_MS,
  TICK_MS,
  countdownArt,
  countdownLabel,
  newSnakePlay,
  overlayArt,
  reduceSnake,
  snakeHints,
  type SnakeEvent,
  type SnakePlay,
} from "./snake-play.ts";
import { ACCENT, FAINT, GREEN, INK, MUTED, RULE } from "./tui-theme.ts";

export interface SnakeHandle {
  readonly play: SnakePlay;
  readonly send: (event: SnakeEvent) => void;
}

export const useSnake = (options: {
  readonly width: number;
  readonly height: number;
  /** Whether the game has the keyboard: gaining it counts down, losing it pauses. */
  readonly focused: boolean;
}): SnakeHandle => {
  const { width, height, focused } = options;
  const [stored, setPlay] = useState<SnakePlay>(() => newSnakePlay(width, height, Math.random));
  // The board size and the focus belong to the dashboard. A change folds in while rendering,
  // so the countdown and the new board show in the same frame as the focus that caused them.
  let play = reduceSnake(stored, { type: "resize", width, height }, Math.random);
  if (play.focused !== focused) {
    play = reduceSnake(play, { type: focused ? "focus" : "blur" }, Math.random);
  }
  if (play !== stored) setPlay(play);
  const { clock } = play;
  const step = clock.kind === "countdown" ? clock.step : null;
  // The timers are the one outside system here: a timeout per countdown step, an interval
  // while the snake runs, and nothing at all otherwise.
  useEffect(() => {
    if (clock.kind === "countdown") {
      const timer = setTimeout(
        () => setPlay((current) => reduceSnake(current, { type: "count" }, Math.random)),
        COUNTDOWN_STEP_MS,
      );
      return () => clearTimeout(timer);
    }
    if (clock.kind !== "running") return;
    const timer = setInterval(
      () => setPlay((current) => reduceSnake(current, { type: "tick" }, Math.random)),
      TICK_MS,
    );
    return () => clearInterval(timer);
    // `step` restarts the timeout per step; a resize keeps both, so the count carries on.
  }, [clock.kind, step]);
  const send = (event: SnakeEvent): void =>
    setPlay((current) => reduceSnake(current, event, Math.random));
  return { play, send };
};

/** The score line; the same wording in the pane and over the dashboard. */
export const SnakeHeading = ({ play }: { readonly play: SnakePlay }) => {
  const { game, clock } = play;
  const state = game.over ? "over" : clock.kind === "paused" ? "paused" : null;
  return (
    <text height={1} bg="transparent">
      <span>{"  "}</span>
      <span fg={INK}>play snake while you wait</span>
      <span fg={FAINT}>{" · score "}</span>
      <span fg={game.over ? MUTED : ACCENT}>{String(game.score)}</span>
      {state === null ? null : <span fg={FAINT}>{` · ${state}`}</span>}
    </text>
  );
};

/** Under a board without the keyboard: how to give it the keys. */
export const SNAKE_IDLE = "enter plays";
/** Under a board waiting on a dialog: the dialog has the keys until it closes. */
export const SNAKE_BEHIND_DIALOG = "the countdown starts when this dialog closes";

/** The keys, under the board: the game's own while it has the keyboard, else `idle`. */
export const SnakeFooter = ({
  play,
  idle,
}: {
  readonly play: SnakePlay;
  readonly idle: string;
}) => (
  <text height={1} bg="transparent" fg={FAINT}>
    {`  ${play.focused ? snakeHints(play) : idle}`}
  </text>
);

const cellColor = (cell: string): string =>
  cell === "◆" ? ACCENT : cell === "█" ? GREEN : cell === "●" ? INK : FAINT;

/**
 * The board's rows, with the countdown's digits over them while it counts. The snake and the
 * food stay on top of the digits, so the player sees where the snake starts and which way it
 * heads.
 */
export const SnakeRows = ({ play }: { readonly play: SnakePlay }) => {
  const { game, clock } = play;
  const board = render(game);
  if (clock.kind !== "countdown") {
    return (
      <>
        {board.map((row, index) => (
          <text key={index} height={1} bg="transparent">
            {[...row].map((cell, x) => (
              <span key={x} fg={cellColor(cell)}>
                {cell === "·" ? " " : cell}
              </span>
            ))}
          </text>
        ))}
      </>
    );
  }
  const cells = overlayArt(
    board,
    countdownArt(countdownLabel(clock.step), game.width, game.height),
  );
  return (
    <>
      {cells.map((row, index) => (
        <text key={index} height={1} bg="transparent">
          {row.map((cell, x) =>
            cell.board !== "·" || cell.art === null ? (
              <span key={x} fg={cellColor(cell.board)}>
                {cell.board === "·" ? " " : cell.board}
              </span>
            ) : (
              <span key={x} fg={ACCENT}>
                {cell.art}
              </span>
            ),
          )}
        </text>
      ))}
    </>
  );
};

/** The game in the detail pane: the score, the board in its own frame, the keys under it. */
export const SnakeBoard = ({
  handle,
  idle,
}: {
  readonly handle: SnakeHandle;
  readonly idle: string;
}) => {
  const { play } = handle;
  return (
    <>
      <SnakeHeading play={play} />
      <box
        border
        borderStyle="rounded"
        borderColor={play.focused ? ACCENT : RULE}
        title=" snake "
        titleAlignment="left"
        width={play.game.width + 2}
        height={play.game.height + 2}
        flexShrink={0}
        marginLeft={2}
        flexDirection="column"
      >
        <SnakeRows play={play} />
      </box>
      <SnakeFooter play={play} idle={idle} />
    </>
  );
};
