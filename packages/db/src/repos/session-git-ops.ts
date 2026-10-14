import { SessionGitOpId, type ProjectId, type SessionId } from "@mend/domain";
import type { GitAuthMode, GitTransportKind } from "@mend/domain/workbench";
import { desc, eq } from "drizzle-orm";
import { DateTime, Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { sessionGitOps } from "../schema/workbench.ts";

export type SessionGitOpRow = typeof sessionGitOps.$inferSelect;

export interface NewSessionGitOp {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly host: string;
  readonly port: number | null;
  readonly kind: GitTransportKind;
  readonly command: string;
  readonly authMode: GitAuthMode;
}

/**
 * The workspace git transport log (docs/GIT-ACCESS.md): the host opens every
 * authenticated remote connection for a session, so the host records every
 * one — start, target, identity, outcome. Evidence, not judgment.
 */
export class SessionGitOpsRepo extends Context.Service<
  SessionGitOpsRepo,
  {
    readonly record: (op: NewSessionGitOp) => Effect.Effect<SessionGitOpRow>;
    readonly finish: (
      id: SessionGitOpId,
      exitCode: number | null,
      refUpdates: ReadonlyArray<string> | null,
    ) => Effect.Effect<void>;
    readonly listForSession: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionGitOpRow>>;
  }
>()("@mend/db/SessionGitOpsRepo") {}

export const SessionGitOpsRepoLive: Layer.Layer<SessionGitOpsRepo, never, MendDB> = Layer.effect(
  SessionGitOpsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const record = Effect.fn("SessionGitOpsRepo.record")(function* (op: NewSessionGitOp) {
      const [row] = yield* db
        .insert(sessionGitOps)
        .values({ id: SessionGitOpId.make(crypto.randomUUID()), ...op })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("session git op insert returned no row");
      return row;
    });

    const finish = Effect.fn("SessionGitOpsRepo.finish")(function* (
      id: SessionGitOpId,
      exitCode: number | null,
      refUpdates: ReadonlyArray<string> | null,
    ) {
      yield* db
        .update(sessionGitOps)
        .set({ exitCode, refUpdates, finishedAt: yield* DateTime.nowAsDate })
        .where(eq(sessionGitOps.id, id))
        .pipe(Effect.orDie);
    });

    const listForSession = Effect.fn("SessionGitOpsRepo.listForSession")(function* (
      sessionId: SessionId,
    ) {
      return yield* db
        .select()
        .from(sessionGitOps)
        .where(eq(sessionGitOps.sessionId, sessionId))
        .orderBy(desc(sessionGitOps.startedAt))
        .pipe(Effect.orDie);
    });

    return { record, finish, listForSession };
  }),
);
