import { describe, expect, it } from "vitest";

import { type Reveal, revealed, revealedText, revealStep } from "./text-reveal.ts";

const FRAME = 1000 / 60;

/**
 * A reply streamed as a check VM measured it (SLNT-1231): `chunk` characters every `every`
 * milliseconds, `chunks` times, then the turn ends. Returns how many characters each frame showed
 * and the frame clock at each.
 */
const stream = ({
  chunk,
  every,
  chunks,
  jitter = () => 0,
}: {
  readonly chunk: number;
  readonly every: number;
  readonly chunks: number;
  readonly jitter?: (at: number) => number;
}) => {
  const arrivals = Array.from({ length: chunks }, (_, at) => (at + 1) * every + jitter(at));
  const end = arrivals.at(-1) ?? 0;
  let reveal: Reveal = revealed(0, 0);
  const frames: Array<{ readonly now: number; readonly shown: number; readonly length: number }> =
    [];
  for (let now = FRAME; now < end + 2_000; now += FRAME) {
    const length = arrivals.filter((at) => at <= now).length * chunk;
    reveal = revealStep(reveal, { length, live: now < end + 100, now });
    frames.push({ now, shown: reveal.shown, length });
  }
  return frames;
};

describe("revealStep", () => {
  it("shows an update's words across the time to the next one, not all at once", () => {
    const frames = stream({ chunk: 72, every: 333, chunks: 30 });
    const steps = frames.slice(1).map((frame, at) => frame.shown - (frames[at]?.shown ?? 0));
    // Shown as they land, each update would be a 72-character jump in one frame.
    expect(Math.max(...steps)).toBeLessThan(12);
    // Once the pace is known, the text keeps moving between updates: no frame stalls mid-reply.
    const steady = frames.filter((frame) => frame.now > 1_500 && frame.now < 30 * 333);
    const still = steady.filter((frame, at) => at > 0 && frame.shown === steady[at - 1]?.shown);
    expect(still.length).toBeLessThan(steady.length * 0.05);
  });

  it("stays within about a second of the text, however the updates come", () => {
    // Updates up to 400ms late or early, as the event stream delivers them.
    const frames = stream({
      chunk: 90,
      every: 300,
      chunks: 40,
      jitter: (at) => ((at * 7919) % 800) - 400,
    });
    const pace = (90 / 300) * 1.0;
    for (const frame of frames) expect(frame.length - frame.shown).toBeLessThan(pace * 1_500);
  });

  it("shows the rest within a quarter of a second once the agent is done", () => {
    let reveal = revealStep(revealed(0, 0), { length: 2_000, live: true, now: 10 });
    expect(reveal.shown).toBeLessThan(2_000);
    for (let now = 10 + FRAME; now <= 10 + 260; now += FRAME)
      reveal = revealStep(reveal, { length: 2_000, live: false, now });
    expect(reveal.shown).toBe(2_000);
  });

  it("shows text that was replaced by a shorter one whole", () => {
    const reveal = revealStep(revealed(500, 0), { length: 120, live: true, now: 16 });
    expect(reveal.shown).toBe(120);
  });

  it("doesn't jump after a frame the browser held back", () => {
    let reveal = revealStep(revealed(0, 0), { length: 600, live: true, now: 1 });
    reveal = revealStep(reveal, { length: 600, live: true, now: 5_001 });
    expect(reveal.shown).toBeLessThan(600);
  });
});

describe("revealedText", () => {
  it("ends at the last whole word, and shows the whole text at its end", () => {
    expect(revealedText("hash maps store keys", 7)).toBe("hash");
    expect(revealedText("hash maps store keys", 9)).toBe("hash maps");
    expect(revealedText("hash maps store keys", 20)).toBe("hash maps store keys");
    expect(revealedText("hash", 2)).toBe("");
  });
});
