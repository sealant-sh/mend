import { Clock, Effect, type Scope } from "effect";

/**
 * What a terminal emulator sends by itself, unasked by the person: replies to the program's
 * queries (DA1, DA2, DA3, XTVERSION, DSR, DECRQM, kitty keyboard flags, the OSC 10/11/12 colour
 * and OSC 52 clipboard replies, the window size report), focus in/out, SGR mouse reports and the
 * bracketed-paste markers (xterm ctlseqs names). Only those four OSC numbers are replies; any
 * other OSC from the client is kept as typing.
 */
const EMULATOR_REPLIES = new RegExp(
  [
    String.raw`\x1b\[\?[\d;]*c`,
    String.raw`\x1b\[>[\d;]*c`,
    String.raw`\x1bP!\|[0-9A-Fa-f]*\x1b\\`,
    String.raw`\x1bP>\|[^\x1b]*\x1b\\`,
    String.raw`\x1b\[\??\d+;\d+(?:;\d+)?R`,
    String.raw`\x1b\[[03]n`,
    String.raw`\x1b\[\??[\d;]*\$y`,
    String.raw`\x1b\[\?\d*u`,
    String.raw`\x1b\[[IO]`,
    String.raw`\x1b\](?:1[012]|52);[^\x07\x1b]*(?:\x07|\x1b\\)`,
    String.raw`\x1b\[<[\d;]*[Mm]`,
    String.raw`\x1b\[20[01]~`,
    String.raw`\x1b\[\d+;\d+;\d+t`,
  ].join("|"),
  "g",
);

const utf8 = new TextDecoder();

/**
 * Whether an input frame holds anything the person typed, once the emulator's own sequences are
 * taken out. A reply split across two frames reads as typing; that is rare and costs one clear.
 */
export const isTyping = (bytes: Uint8Array | string): boolean =>
  (typeof bytes === "string" ? bytes : utf8.decode(bytes)).replace(EMULATOR_REPLIES, "") !== "";

export const TYPED_CLEAR_EVERY_MS = 2_000;

/**
 * Keys in a terminal agent's terminal, as calls to `clear` (the engine's `personTyped`, true when
 * it cleared a wait). Only a call that cleared something opens the window, so keys typed while
 * nothing waits never hold back the answer to the next ask. A key inside the window schedules one
 * call at the window's end, so an answer typed right after a clear lands late, never dropped.
 */
export const makeKeystrokeClear = (
  clear: Effect.Effect<boolean>,
  scope: Scope.Scope,
  windowMs: number = TYPED_CLEAR_EVERY_MS,
): Effect.Effect<void> => {
  let windowEndsAt = Number.NEGATIVE_INFINITY;
  let trailing = false;
  const call = clear.pipe(
    Effect.flatMap((cleared) =>
      cleared
        ? Clock.currentTimeMillis.pipe(
            Effect.map((now) => {
              windowEndsAt = now + windowMs;
            }),
          )
        : Effect.void,
    ),
  );
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now >= windowEndsAt) {
      yield* Effect.forkIn(call, scope);
      return;
    }
    if (trailing) return;
    trailing = true;
    yield* Effect.forkIn(
      Effect.sleep(windowEndsAt - now).pipe(
        Effect.andThen(
          Effect.sync(() => {
            trailing = false;
          }),
        ),
        Effect.andThen(call),
      ),
      scope,
    );
  });
};
