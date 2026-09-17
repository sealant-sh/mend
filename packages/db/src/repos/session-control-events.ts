import { SessionControlEventId, type SessionId } from "@mend/domain";
import { SessionControlEvent, type SessionControlKind } from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionControlEvents } from "../schema/workbench.ts";

export interface NewSessionControlEvent {
  readonly sessionId: SessionId;
  readonly actorUserId: string;
  readonly kind: SessionControlKind;
  readonly refId: string | null;
}

/**
 * Who steered a session beyond turns and approvals (docs/adr/0003-organizations-and-tenancy.md).
 * Recorded after the act is authorized; a failed write is logged and never refuses the act.
 */
export class SessionControlEventsRepo extends Context.Service<
  SessionControlEventsRepo,
  {
    readonly record: (event: NewSessionControlEvent) => Effect.Effect<void>;
    /** Oldest first. */
    readonly listForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionControlEvent>>;
  }
>()("@mend/db/SessionControlEventsRepo") {}

export const SessionControlEventsRepoLive: Layer.Layer<SessionControlEventsRepo, never, MendDB> =
  Layer.effect(
    SessionControlEventsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const record = Effect.fn("SessionControlEventsRepo.record")(function* (
        event: NewSessionControlEvent,
      ) {
        yield* db
          .insert(sessionControlEvents)
          .values({ id: SessionControlEventId.make(crypto.randomUUID()), ...event })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("session control: event not recorded").pipe(
                Effect.annotateLogs({ kind: event.kind, cause: String(cause) }),
              ),
            ),
          );
      });

      const listForSession = Effect.fn("SessionControlEventsRepo.listForSession")(function* (
        sessionId: SessionId,
      ) {
        const rows = yield* db
          .select()
          .from(sessionControlEvents)
          .where(eq(sessionControlEvents.sessionId, sessionId))
          .orderBy(asc(sessionControlEvents.createdAt), asc(sessionControlEvents.id))
          .pipe(Effect.orDie);
        return rows.map((row) => new SessionControlEvent(row));
      });

      return { record, listForSession };
    }),
  );
