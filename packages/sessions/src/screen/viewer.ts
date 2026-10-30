import type { SessionId, ViewerConnectionId } from "@mend/domain";
import type { ForwardBytes, ForwardIssueReason } from "@mend/sealant";
import { Duration, Effect, Redacted, type Scope } from "effect";

import type { Input } from "./rfb-client.ts";
import { ByteQueue } from "./rfb-queue.ts";
import { type SignInRefusal, VncSignIn } from "./rfb-sign-in.ts";
import { VIEWER_GREETING, ViewerHello, readViewer, viewerVerdict } from "./rfb-viewer.ts";

/**
 * Most a viewer may leave unsent: two full 1280x800 frames in Raw. A viewer that falls further
 * behind is closed, so a slow one never grows the server's memory.
 */
export const VIEWER_UNSENT_CEILING = 8 * 1024 * 1024;

const HELLO_DEADLINE = Duration.seconds(10);
const SIGN_IN_DEADLINE = Duration.seconds(10);

/** One watcher's side of the relay, as the API's socket carries it. */
export interface ViewerBytes {
  /** The viewer's next bytes; null once it has gone. */
  readonly read: Effect.Effect<Uint8Array | null>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void>;
  /** Bytes written to the viewer and not yet sent on. */
  readonly unsent: Effect.Effect<number>;
}

export interface Watcher {
  readonly sessionId: SessionId;
  readonly connection: ViewerConnectionId;
  /** The session's owner: the one watcher whose keys reach the screen, and only while holding it. */
  readonly mayTakeInput: boolean;
}

/** Why a watch ended. Each maps to one close of the viewer's socket. */
export type WatchEnd =
  | { readonly _tag: "ViewerLeft" }
  /** The screen's connection closed (the screen stopped) or was reset. */
  | { readonly _tag: "ScreenEnded"; readonly how: "closed" | "reset" }
  /** No live screen this process can sign in to. */
  | { readonly _tag: "NoScreen" }
  | {
      readonly _tag: "Unreachable";
      readonly reason: ForwardIssueReason | SignInRefusal | "sign-in-deadline";
    }
  /** The viewer broke the handshake, or sent a message outside the allow-list. */
  | {
      readonly _tag: "ViewerRefused";
      readonly reason: "handshake" | "unknown-type" | "oversized";
    }
  | { readonly _tag: "FellBehind"; readonly unsent: number };

/** What the relay asks of the screen it watches. */
export interface RelayPorts {
  /** A connection to the screen's Xvnc and the view-only password, or the end it met instead. */
  readonly dial: Effect.Effect<
    { readonly bytes: ForwardBytes; readonly password: Redacted.Redacted<string> },
    WatchEnd,
    Scope.Scope
  >;
  /** The holder's keys and pointer, put on the screen through its hand. */
  readonly input: (inputs: ReadonlyArray<Input>) => Effect.Effect<boolean>;
  /** The holder's paste, put on the screen's clipboard through its hand. */
  readonly paste: (text: string) => Effect.Effect<boolean>;
}

const RESET: WatchEnd = { _tag: "ScreenEnded", how: "reset" };
const CLOSED: WatchEnd = { _tag: "ScreenEnded", how: "closed" };

/**
 * A watcher's view of a screen (ADR 0020, "Watch-only is a filter on RFB messages"). The relay
 * answers the viewer's RFB handshake itself, dials the screen, signs in with the view-only
 * password, and passes the screen's bytes on untouched. Each viewer message goes through
 * `viewerVerdict`: the holder's keys, pointer and paste reach the screen only through its hand,
 * and a message outside the allow-list ends the watch.
 */
export const relayViewer = (
  watcher: Watcher,
  viewer: ViewerBytes,
  ports: RelayPorts,
): Effect.Effect<WatchEnd, never, Scope.Scope> =>
  Effect.gen(function* () {
    const incoming = new ByteQueue();

    const fromViewer = Effect.flatMap(viewer.read, (chunk) =>
      chunk === null ? Effect.fail<WatchEnd>({ _tag: "ViewerLeft" }) : Effect.succeed(chunk),
    );
    const toViewer = (bytes: Uint8Array) =>
      viewer.write(bytes).pipe(
        Effect.andThen(viewer.unsent),
        Effect.flatMap((unsent) =>
          unsent > VIEWER_UNSENT_CEILING
            ? Effect.fail<WatchEnd>({ _tag: "FellBehind", unsent })
            : Effect.void,
        ),
      );

    yield* viewer.write(VIEWER_GREETING);
    const hello = new ViewerHello();
    yield* Effect.gen(function* () {
      for (;;) {
        incoming.push(yield* fromViewer);
        const step = hello.read(incoming);
        if (step._tag === "Refused") {
          return yield* Effect.fail<WatchEnd>({ _tag: "ViewerRefused", reason: "handshake" });
        }
        for (const bytes of step.send) yield* viewer.write(bytes);
        if (step._tag === "Ready") return;
      }
    }).pipe(
      Effect.timeoutOrElse({
        duration: HELLO_DEADLINE,
        orElse: () => Effect.fail<WatchEnd>({ _tag: "ViewerRefused", reason: "handshake" }),
      }),
    );

    const screen = yield* ports.dial;
    const fromScreen = screen.bytes.read().pipe(
      Effect.mapError(() => RESET),
      Effect.flatMap((read) =>
        read.kind === "eof" ? Effect.fail(CLOSED) : Effect.succeed(read.bytes),
      ),
    );
    const toScreen = (bytes: Uint8Array) =>
      screen.bytes.write(bytes).pipe(Effect.mapError(() => RESET));

    const signIn = new VncSignIn(Redacted.value(screen.password));
    const handshake = new ByteQueue();
    yield* Effect.gen(function* () {
      for (;;) {
        handshake.push(yield* fromScreen);
        const step = signIn.read(handshake);
        if (step._tag === "Refused") {
          return yield* Effect.fail<WatchEnd>({ _tag: "Unreachable", reason: step.reason });
        }
        if (step.send.length > 0) yield* toScreen(Buffer.concat(step.send));
        if (step._tag === "SignedIn") break;
      }
      // The screen's ServerInit, after the viewer's ClientInit as RFB orders it.
      if (handshake.length > 0) yield* toViewer(handshake.take(handshake.length));
    }).pipe(
      Effect.timeoutOrElse({
        duration: SIGN_IN_DEADLINE,
        orElse: () => Effect.fail<WatchEnd>({ _tag: "Unreachable", reason: "sign-in-deadline" }),
      }),
    );

    const down = Effect.forever(Effect.flatMap(fromScreen, toViewer));

    const up = Effect.forever(
      Effect.gen(function* () {
        incoming.push(yield* fromViewer);
        let held: Array<Input> = [];
        const flush = Effect.suspend(() => {
          const inputs = held;
          held = [];
          return inputs.length === 0 ? Effect.void : Effect.asVoid(ports.input(inputs));
        });
        for (const message of readViewer(incoming)) {
          const verdict = viewerVerdict(message, watcher.mayTakeInput);
          switch (verdict._tag) {
            case "Reissue":
              held.push(verdict.input);
              break;
            case "Drop":
              break;
            case "Pass":
              yield* flush;
              yield* toScreen(verdict.bytes);
              break;
            case "Paste":
              yield* flush;
              yield* ports.paste(verdict.text);
              break;
            case "Close":
              yield* flush;
              return yield* Effect.fail<WatchEnd>({
                _tag: "ViewerRefused",
                reason: verdict.reason,
              });
          }
        }
        yield* flush;
      }),
    );

    return yield* Effect.raceFirst(down, up);
  }).pipe(Effect.flip);
