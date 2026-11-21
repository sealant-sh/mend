import { useEffect, useRef, useState } from "react";

// How a reply that streams in is shown at a steady pace (SLNT-1231). The server's updates reach the
// page a few times a second, each with a sentence or two at once; shown as they land, the text
// jumps forward in lumps. The reveal spreads each update's new text over the time until the next
// one is expected, so the words come at the rate the agent writes them, a little behind it, and
// never more than about a second behind.

/** Where a reveal is: how much of the text shows, and how fast the rest is coming in. */
export interface Reveal {
  /** Characters shown, fractional between frames. */
  readonly shown: number;
  /** The text's length at the last update. */
  readonly length: number;
  /** Characters per millisecond to show until the next update. */
  readonly speed: number;
  /** The time between updates, smoothed, in milliseconds. */
  readonly gap: number;
  /** When the last update arrived, and when the last frame was drawn (the frame clock, in ms). */
  readonly arrived: number;
  readonly drawn: number;
}

/** The gap assumed before two updates have been seen; about what a check VM measured. */
const FIRST_GAP_MS = 300;
/** The range the smoothed gap stays in, so a pause in the agent's writing doesn't slow the next words to a crawl. */
const MIN_GAP_MS = 50;
const MAX_GAP_MS = 700;
/** Spread each update over a bit more than the expected gap, so a late update doesn't leave a pause. */
const SLACK = 1.25;
/** How far behind the text the reveal may fall, in milliseconds at its own speed. */
const MAX_BEHIND_MS = 1_000;
/** Once the reply is finished, what is left shows within this. */
const FINISH_MS = 250;
/** A frame that took longer than this (a tab in the background) counts as this long. */
const MAX_FRAME_MS = 100;

/** A text that shows whole: one already there when the reader opens it. */
export const revealed = (length: number, now: number): Reveal => ({
  shown: length,
  length,
  speed: 0,
  gap: FIRST_GAP_MS,
  arrived: now,
  drawn: now,
});

/**
 * The reveal at frame time `now`, for a text now `length` long that is still being written while
 * `live`. Text that grew since the last frame is an update: its new characters are spread over the
 * expected time to the next one. A text that got shorter was replaced, and shows whole.
 */
export const revealStep = (
  reveal: Reveal,
  { length, live, now }: { readonly length: number; readonly live: boolean; readonly now: number },
): Reveal => {
  if (length < reveal.length) return revealed(length, now);
  let { gap, speed, arrived } = reveal;
  if (length > reveal.length) {
    // The first update after a reveal caught up says nothing about the pace.
    const since = now - reveal.arrived;
    if (reveal.shown < reveal.length || since <= MAX_GAP_MS)
      gap = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap * 0.7 + since * 0.3));
    speed = (length - reveal.shown) / (gap * SLACK);
    arrived = now;
  }
  const behind = length - reveal.shown;
  speed = Math.max(speed, behind / MAX_BEHIND_MS, live ? 0 : behind / FINISH_MS);
  const frame = Math.min(MAX_FRAME_MS, Math.max(0, now - reveal.drawn));
  const shown = reveal.shown + speed * frame;
  return {
    // Within half a character of the end is the end: a reveal never creeps up on it forever.
    shown: shown > length - 0.5 ? length : shown,
    length,
    speed,
    gap,
    arrived,
    drawn: now,
  };
};

/**
 * How much of `text` to show for a reveal at `shown` characters: up to the end of the last whole
 * word, so a word appears at once rather than letter by letter and never jumps to the next line
 * as it grows. The whole text once the reveal reaches it.
 */
export const revealedText = (text: string, shown: number): string => {
  if (shown >= text.length) return text;
  const at = Math.floor(shown);
  for (let cut = at; cut > 0; cut -= 1) if (/\s/.test(text[cut] ?? "")) return text.slice(0, cut);
  return "";
};

/**
 * The part of `text` to show now, revealed at a steady pace as it grows while `live` (the agent
 * is still writing it). A text that is already there when it mounts shows whole; one that grows
 * after the agent finished shows the rest within a quarter of a second. The component re-renders
 * once per word shown, not once per frame. `growing` says the text has grown since it mounted.
 */
export const useRevealedText = (
  text: string,
  live: boolean,
): { readonly shown: string; readonly growing: boolean } => {
  const reveal = useRef<Reveal | null>(null);
  const [shown, setShown] = useState(text.length);
  const [growing, setGrowing] = useState(false);
  useEffect(() => {
    let frame = 0;
    const draw = (now: number) => {
      const next = revealStep(reveal.current ?? revealed(text.length, now), {
        length: text.length,
        live,
        now,
      });
      reveal.current = next;
      setShown(revealedText(text, next.shown).length);
      if (next.shown < text.length) {
        setGrowing(true);
        frame = requestAnimationFrame(draw);
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [text, live]);
  return { shown: shown >= text.length ? text : text.slice(0, shown), growing };
};
