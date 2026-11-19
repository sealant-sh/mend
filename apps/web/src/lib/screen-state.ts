import type { ViewerConnectionId } from "@mend/domain";

import type { LiveScreenDto, ScreenControlDto } from "./api.ts";

/** This viewer's socket to the screen; `connection` is the id the server named it. */
export type ScreenWire =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Watching"; readonly connection: ViewerConnectionId }
  | { readonly _tag: "Closed"; readonly words: string };

/**
 * Whether this viewer's own connection holds the input, as the server last reported: only then do
 * its keys reach the screen. A takeover from another tab names that tab's connection.
 */
export const heldHere = (screen: LiveScreenDto, wire: ScreenWire): boolean =>
  wire._tag === "Watching" &&
  screen.holder._tag === "Person" &&
  screen.holder.connection === wire.connection;

/** What Take over or Hand back answered, when it did not simply happen. */
export const screenControlNotice = (result: ScreenControlDto): string | null => {
  switch (result._tag) {
    case "Changed":
    case "Unchanged":
      return null;
    case "Refused":
      return result.why === "owner-only"
        ? "Only the session's owner puts input on this screen."
        : result.why === "held"
          ? "Someone else has the input."
          : "The agent looks at the screen before it acts again.";
    case "NoScreen":
      return "The session has no live screen.";
    case "NoHand":
      return "Mend has no input connection to this screen right now, so nothing was taken.";
    case "NotWatching":
      return "This viewer isn't open on the screen yet. Reconnect and try again.";
  }
};

/**
 * A screen that isn't live, as the view says it (ADR 0020, D7). It runs while its session does,
 * so while the session runs it is starting, or it failed and offers to start again; otherwise it
 * stopped with the session and starts again when the session resumes.
 */
export type ScreenDown =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Failed"; readonly started: boolean }
  | { readonly _tag: "Stopped" };

export const screenDown = (
  life: LiveScreenDto["life"],
  sessionLive: boolean,
  waking: boolean,
): ScreenDown | null => {
  if (life._tag === "Live") return null;
  if (waking || life._tag === "Starting") return { _tag: "Starting" };
  if (!sessionLive) return { _tag: "Stopped" };
  return life._tag === "NotStarted"
    ? { _tag: "Starting" }
    : { _tag: "Failed", started: life.reason !== "start-failed" };
};

/** What the view's bar says, and the one control it offers. */
export interface ScreenBar {
  /** Who has the input, or where the screen stands: "Codex has input", "Connecting…". */
  readonly title: string;
  /** The muted line after it: "You're watching", "Codex waits until you hand back". */
  readonly sub: string | null;
  readonly control: "take" | "hand-back" | null;
}

const reasonWords = (reason: string): string => reason.replace(/-/g, " ");

const none = (title: string): ScreenBar => ({ title, sub: null, control: null });

/**
 * The bar of the Screen view (Doop "Screen · live", "you have input", "couldn't connect"): who has
 * the input, as the server last read it, and Take over or Hand back for the session's owner, the
 * one person who may put input on the screen (ADR 0020, D3).
 */
export const screenBar = ({
  screen,
  wire,
  sessionLive,
  waking,
  owner,
  agent,
  nameOf,
}: {
  readonly screen: LiveScreenDto;
  readonly wire: ScreenWire;
  readonly sessionLive: boolean;
  readonly waking: boolean;
  /** The viewer is the session's owner. */
  readonly owner: boolean;
  readonly agent: string;
  readonly nameOf: (userId: string) => string;
}): ScreenBar => {
  const down = screenDown(screen.life, sessionLive, waking);
  if (down?._tag === "Starting") return none("Starting the screen…");
  if (down?._tag === "Failed") return none(down.started ? "Stopped" : "Didn't start");
  if (down?._tag === "Stopped") return none("Stopped with the session");
  if (wire._tag === "Connecting") return none("Connecting…");
  if (wire._tag === "Closed") return none("Not connected");
  const held = heldHere(screen, wire);
  const control = owner ? (held ? "hand-back" : "take") : null;
  const watching = held ? null : "You're watching";
  switch (screen.holder._tag) {
    case "Paused":
      return { title: "Input paused", sub: reasonWords(screen.holder.reason), control };
    case "Person":
      return held
        ? { title: "You have input", sub: `${agent} waits until you hand back`, control }
        : { title: `${nameOf(screen.holder.userId)} has input`, sub: watching, control };
    case "Agent":
      return {
        title: screen.holder.awaiting
          ? `${agent} takes the input at its next look`
          : `${agent} has input`,
        sub: watching,
        control,
      };
  }
};

/** "Display :1 · 1280 × 800". */
export const displayWords = (screen: Pick<LiveScreenDto, "display" | "width" | "height">) =>
  `Display :${screen.display} · ${screen.width} × ${screen.height}`;
