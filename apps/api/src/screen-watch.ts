import { NotFound } from "@mend/api-contracts";
import { UpgradeTicketsRepo } from "@mend/db";
import type { SessionId, ViewerConnectionId } from "@mend/domain";
import { Data, Effect, Layer, type Scope } from "effect";
import * as Context from "effect/Context";

import {
  type AccessSubject,
  type Admission,
  makeAccessRecheck,
  type RecheckTiming,
} from "./access-recheck.ts";
import { ProjectAccess } from "./access.ts";
import { EventBus } from "./events-bus.ts";

/** One viewer of a session's screen, admitted: whose access it runs on, and on what. */
export interface ScreenViewer extends Admission {
  readonly sessionId: SessionId;
  readonly ownerUserId: string | null;
}

/** A recheck stopped the viewer: its access ended, or could not be checked in time. */
export class ScreenAccessEnded extends Data.TaggedError("ScreenAccessEnded")<{
  readonly reason: "access-ended" | "admission-unavailable";
}> {}

/**
 * Who may watch a session's screen, held for as long as they watch (ADR 0020, D2): anyone who can
 * see the session, on a sign-in or device that still stands. It also knows which viewer
 * connections are open, since Take over names one.
 */
export class ScreenWatch extends Context.Service<
  ScreenWatch,
  {
    readonly admit: (
      subject: AccessSubject,
      sessionId: SessionId,
    ) => Effect.Effect<ScreenViewer, NotFound>;
    /** Admits the viewer and runs `use` until it ends, or until the viewer's access does. */
    readonly hold: <B, E, R>(
      subject: AccessSubject,
      sessionId: SessionId,
      use: (viewer: ScreenViewer) => Effect.Effect<B, E, R>,
    ) => Effect.Effect<B, E | NotFound | ScreenAccessEnded, R>;
    /** Holds `connection` as `userId`'s open viewer of `sessionId` until the scope closes. */
    readonly open: (
      connection: ViewerConnectionId,
      userId: string,
      sessionId: SessionId,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly isOpen: (
      connection: ViewerConnectionId,
      userId: string,
      sessionId: SessionId,
    ) => Effect.Effect<boolean>;
  }
>()("@mend/api/ScreenWatch") {}

/** The preview recheck's numbers: a viewer closes within the ADR's 60 seconds of losing access. */
export const SCREEN_RECHECK_TIMING: RecheckTiming = {
  sweepEvery: "50 seconds",
  passDeadline: "5 seconds",
  closeGrace: "1 second",
};

const STANDING_CONCURRENCY = 8;

export const makeScreenWatchLayer = (
  timing: RecheckTiming,
): Layer.Layer<ScreenWatch, never, UpgradeTicketsRepo | ProjectAccess | EventBus> =>
  Layer.effect(
    ScreenWatch,
    Effect.gen(function* () {
      const tickets = yield* UpgradeTicketsRepo;
      const access = yield* ProjectAccess;
      const opened = new Map<
        ViewerConnectionId,
        { readonly userId: string; readonly sessionId: SessionId }
      >();

      const admit = Effect.fn("ScreenWatch.admit")(function* (
        subject: AccessSubject,
        sessionId: SessionId,
      ) {
        if (!(yield* tickets.credentialStands(subject.credential))) {
          return yield* new NotFound({ id: sessionId });
        }
        const session = yield* access.sessionAs(subject.userId, sessionId);
        const viewer = yield* access.viewerOf(subject.userId);
        if (viewer === null) return yield* new NotFound({ id: sessionId });
        return {
          subject,
          sessionId,
          projectId: session.projectId,
          organizationId: viewer.organizationId,
          ownerUserId: session.ownerUserId,
        } satisfies ScreenViewer;
      });

      const recheck = yield* makeAccessRecheck<ScreenViewer, "access-ended">({
        name: "screen",
        timing,
        groupOf: ({ subject, sessionId }) =>
          JSON.stringify([subject.userId, subject.credential, sessionId]),
        standing: (batch) =>
          Effect.forEach(
            batch,
            ({ subject, sessionId }) =>
              admit(subject, sessionId).pipe(
                Effect.match({
                  onFailure: (): "access-ended" => "access-ended",
                  onSuccess: () => null,
                }),
              ),
            { concurrency: STANDING_CONCURRENCY },
          ),
      });

      return {
        admit,
        hold: (subject, sessionId, use) =>
          recheck.hold({
            admit: admit(subject, sessionId),
            use,
            stopped: (stop) =>
              new ScreenAccessEnded({
                reason: stop._tag === "Refused" ? "access-ended" : "admission-unavailable",
              }),
          }),
        open: (connection, userId, sessionId) =>
          Effect.acquireRelease(
            Effect.sync(() => void opened.set(connection, { userId, sessionId })),
            () => Effect.sync(() => void opened.delete(connection)),
          ),
        isOpen: (connection, userId, sessionId) =>
          Effect.sync(() => {
            const held = opened.get(connection);
            return held?.userId === userId && held.sessionId === sessionId;
          }),
      };
    }),
  );

export const ScreenWatchLive: Layer.Layer<
  ScreenWatch,
  never,
  UpgradeTicketsRepo | ProjectAccess | EventBus
> = makeScreenWatchLayer(SCREEN_RECHECK_TIMING);
