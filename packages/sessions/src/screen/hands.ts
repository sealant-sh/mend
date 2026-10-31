import { ScreensRepo } from "@mend/db";
import type { ScreenId } from "@mend/domain";
import type { Screen } from "@mend/domain/workbench";
import { ForwardSessionOwner, asSealantUser } from "@mend/sealant";
import { Deferred, Effect, Exit, Scope } from "effect";

import { ForwardAdapter } from "../forward.ts";
import { type Hand, openHand } from "./hand.ts";
import { ScreenHost } from "./screen-host.ts";
import { ScreenWorkers } from "./screen-workers.ts";

/** Xvnc listens on `127.0.0.1:5900+n` for display `:n`. */
const XVNC_PORT_BASE = 5900;

/**
 * A connection to the screen's Xvnc, as the session's owner and bound to the screen process's
 * PTY, with the passwords to sign in; null when this process holds none for the screen.
 */
export const dialScreen = Effect.fnUntraced(function* (screen: Screen) {
  const host = yield* ScreenHost;
  const forward = yield* ForwardAdapter;
  const pty = screen.processId === null ? null : yield* host.ptyOf(screen.processId);
  const passwords = yield* host.passwords(screen.sessionId);
  if (pty === null || passwords === null) return null;
  const owner = yield* host.ownerOf(screen.sessionId);
  const { bytes } = yield* forward
    .open(
      {
        workspaceId: screen.workspaceId,
        port: XVNC_PORT_BASE + screen.display,
        binding: { kind: "session", session: ForwardSessionOwner.make(pty) },
      },
      { purpose: "screen" },
    )
    .pipe(asSealantUser(owner));
  return { bytes, passwords };
});

export interface Hands {
  /** The live screen's hand, dialled when it has none; null when it cannot have one now. */
  readonly of: (screen: Screen) => Effect.Effect<Hand | null>;
  /** The hand already open for the screen, dialling none. */
  readonly open: (screenId: ScreenId) => Hand | null;
}

/**
 * One hand per live screen, held by this process for as long as the hand lasts. `ended` runs when
 * a hand ends by itself, never for the hands this scope's close ends.
 */
export const makeHands = Effect.fnUntraced(function* (
  ended: (screen: Screen) => Effect.Effect<void>,
) {
  const screens = yield* ScreensRepo;
  const host = yield* ScreenHost;
  const forward = yield* ForwardAdapter;
  const workers = yield* ScreenWorkers;
  const scope = yield* Scope.Scope;
  const dialling = new Map<ScreenId, Deferred.Deferred<Hand | null>>();
  const opened = new Map<ScreenId, Hand>();
  const owned = new Set<Scope.Closeable>();
  let closing = false;
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      closing = true;
      return Effect.forEach(owned, (own) => Scope.close(own, Exit.void), { discard: true });
    }),
  );

  const dial = (screen: Screen) =>
    Effect.gen(function* () {
      const dialled = yield* dialScreen(screen);
      if (dialled === null) return null;
      return yield* openHand({
        bytes: dialled.bytes,
        password: dialled.passwords.full,
        currentEpoch: Effect.map(screens.byId(screen.id), (now) => now?.input.epoch ?? -1),
      });
    }).pipe(
      Effect.provideService(ScreenWorkers, workers),
      Effect.provideService(ScreenHost, host),
      Effect.provideService(ForwardAdapter, forward),
    );

  const hold = (screen: Screen, answer: Deferred.Deferred<Hand | null>) =>
    Effect.gen(function* () {
      const own = yield* Scope.make();
      owned.add(own);
      const release = Effect.suspend(() => {
        owned.delete(own);
        return Scope.close(own, Exit.void);
      });
      const exit = yield* Effect.exit(Scope.provide(dial(screen), own));
      const hand = Exit.isSuccess(exit) ? exit.value : null;
      if (hand === null) {
        dialling.delete(screen.id);
        yield* release;
        if (Exit.isFailure(exit)) {
          yield* Effect.logWarning("screen: no hand").pipe(
            Effect.annotateLogs({ screenId: screen.id, cause: String(exit.cause) }),
          );
        }
        return yield* Deferred.succeed(answer, null);
      }
      opened.set(screen.id, hand);
      yield* Deferred.succeed(answer, hand);
      const reason = yield* Effect.flip(hand.ended);
      if (closing) return;
      dialling.delete(screen.id);
      opened.delete(screen.id);
      yield* release;
      yield* Effect.logInfo("screen: hand ended").pipe(
        Effect.annotateLogs({ screenId: screen.id, reason: reason.reason }),
      );
      yield* ended(screen);
    });

  const of = (screen: Screen): Effect.Effect<Hand | null> =>
    Effect.suspend(() => {
      if (screen.life._tag !== "Live") return Effect.succeed(null);
      const known = dialling.get(screen.id);
      if (known !== undefined) return Deferred.await(known);
      const answer = Deferred.makeUnsafe<Hand | null>();
      dialling.set(screen.id, answer);
      return Effect.forkIn(hold(screen, answer), scope).pipe(
        Effect.andThen(Deferred.await(answer)),
      );
    });

  return { of, open: (screenId) => opened.get(screenId) ?? null } satisfies Hands;
});
