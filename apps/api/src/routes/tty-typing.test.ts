import { describe, expect, it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Effect } from "effect";

import { isTyping, makeKeystrokeClear } from "./tty-typing.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("isTyping", () => {
  const replies: ReadonlyArray<readonly [string, string]> = [
    ["DA1 reply (primary device attributes)", `${ESC}[?1;2c`],
    ["DA2 reply (secondary device attributes)", `${ESC}[>0;276;0c`],
    ["DA3 reply (tertiary device attributes)", `${ESC}P!|00000000${ST}`],
    ["XTVERSION reply", `${ESC}P>|xterm.js(5.5.0)${ST}`],
    ["DSR cursor position report (CPR)", `${ESC}[24;1R`],
    ["DSR status report", `${ESC}[0n`],
    ["DECRQM reply (DECRPM)", `${ESC}[?2004;1$y`],
    ["kitty keyboard flags reply", `${ESC}[?0u`],
    ["focus in", `${ESC}[I`],
    ["focus out", `${ESC}[O`],
    ["OSC 10 foreground colour reply, BEL", `${ESC}]10;rgb:ffff/ffff/ffff${BEL}`],
    ["OSC 11 background colour reply, ST", `${ESC}]11;rgb:1e1e/1e1e/1e1e${ST}`],
    ["OSC 12 cursor colour reply", `${ESC}]12;rgb:ffff/ffff/ffff${BEL}`],
    ["OSC 52 clipboard reply", `${ESC}]52;c;aGVsbG8=${BEL}`],
    ["SGR mouse press", `${ESC}[<0;12;5M`],
    ["SGR mouse release", `${ESC}[<0;12;5m`],
    ["bracketed paste start", `${ESC}[200~`],
    ["bracketed paste end", `${ESC}[201~`],
    ["window size report (XTWINOPS 8)", `${ESC}[8;24;80t`],
  ];

  it.each(replies)("reads a %s as the emulator's, not the person's", (_name, reply) => {
    expect(isTyping(reply)).toBe(false);
    expect(isTyping(new TextEncoder().encode(reply))).toBe(false);
  });

  it("reads the replies a real xterm sends on attach, in one frame, as nobody typing", () => {
    expect(isTyping(replies.map(([, reply]) => reply).join(""))).toBe(false);
  });

  it("reads a key, an arrow, Enter, Escape and a pasted body as typing", () => {
    for (const key of ["y", `${ESC}[A`, `${ESC}OA`, "\r", ESC, "é"]) {
      expect(isTyping(key)).toBe(true);
    }
    expect(isTyping(`${ESC}[200~git status${ESC}[201~`)).toBe(true);
    expect(isTyping(`${ESC}[I\r`)).toBe(true);
  });

  it("keeps an OSC that is not one of the four replies, such as a title or a hyperlink", () => {
    expect(isTyping(`${ESC}]0;title${BEL}`)).toBe(true);
    expect(isTyping(`${ESC}]8;;https://example.test${ST}`)).toBe(true);
    expect(isTyping(`${ESC}]133;A${BEL}`)).toBe(true);
  });
});

const recordedClear = (answers: ReadonlyArray<boolean>) => {
  const calls: Array<number> = [];
  const clear = Effect.gen(function* () {
    calls.push(yield* Clock.currentTimeMillis);
    return answers[calls.length - 1] ?? false;
  });
  return { calls, clear };
};

describe("makeKeystrokeClear", () => {
  it.effect("lets keys typed while nothing waits pass, and holds back only after a clear", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, clear } = recordedClear([false, true, true]);
        const typed = makeKeystrokeClear(clear, yield* Effect.scope);
        yield* typed;
        yield* TestClock.adjust(100);
        yield* typed;
        yield* TestClock.adjust(500);
        yield* typed;
        expect(calls).toEqual([0, 100]);
        yield* TestClock.adjust(1_500);
        expect(calls).toEqual([0, 100, 2_100]);
      }),
    ),
  );

  it.effect("lands an answer typed right after a clear at the window's end, once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, clear } = recordedClear([true, true]);
        const typed = makeKeystrokeClear(clear, yield* Effect.scope);
        yield* typed;
        yield* TestClock.adjust(200);
        yield* typed;
        yield* TestClock.adjust(100);
        yield* typed;
        expect(calls).toEqual([0]);
        yield* TestClock.adjust(1_700);
        expect(calls).toEqual([0, 2_000]);
        yield* TestClock.adjust(5_000);
        expect(calls).toEqual([0, 2_000]);
      }),
    ),
  );
});
