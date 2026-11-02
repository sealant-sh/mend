import { PgClient } from "@effect/sql-pg";
import { AgentItemId, type ChangeId, type ProofArtifactId, type SessionId } from "@mend/domain";
import {
  ProofArtifact,
  ProofCapture,
  ProofRef,
  ProofSource,
  proofItemProviderId,
  proofKindOf,
  proofLabel,
} from "@mend/domain/workbench";
import { and, asc, eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

import { MendDB, type MendDatabase } from "../client.ts";
import { notifyEvent } from "../events.ts";
import { agentItems, agentTurns, proofArtifacts } from "../schema/workbench.ts";
import {
  lockAgentConversation,
  nextAgentItemSeq,
  notifyAgentConversation,
} from "./agent-conversation.ts";

export class ProofArtifactStorageError extends Schema.TaggedError<ProofArtifactStorageError>()(
  "ProofArtifactStorageError",
  { cause: Schema.Defect() },
) {}

export type SettledProofCapture = Extract<ProofCapture, { readonly _tag: "Video" | "NotCaptured" }>;

export class ProofArtifactsRepo extends Context.Service<
  ProofArtifactsRepo,
  {
    readonly insert: (
      artifact: ProofArtifact,
      callKey: string | null,
    ) => Effect.Effect<ProofArtifact, ProofArtifactStorageError>;
    readonly byId: (
      id: ProofArtifactId,
    ) => Effect.Effect<ProofArtifact | null, ProofArtifactStorageError>;
    readonly byCall: (
      sessionId: SessionId,
      callKey: string,
    ) => Effect.Effect<ProofArtifact | null, ProofArtifactStorageError>;
    readonly listForChange: (
      id: ChangeId,
    ) => Effect.Effect<ReadonlyArray<ProofArtifact>, ProofArtifactStorageError>;
    /** At HTTP boot, recordings from the previous process have no recoverable encoder. */
    readonly settleStaleRecordings: () => Effect.Effect<void, ProofArtifactStorageError>;
    /** Only a Recording can settle; a repeated completion returns its first stored result. */
    readonly settleVideo: (
      id: ProofArtifactId,
      capture: SettledProofCapture,
    ) => Effect.Effect<ProofArtifact | null, ProofArtifactStorageError>;
  }
>()("@mend/db/ProofArtifactsRepo") {}

const storageFailed = (cause: unknown) => new ProofArtifactStorageError({ cause });
const decode = (row: typeof proofArtifacts.$inferSelect) =>
  Schema.decodeUnknownEffect(ProofArtifact)(row);

const refOf = (artifact: ProofArtifact, sessionId: SessionId) => {
  const capture = artifact.capture;
  const media = capture._tag === "Screenshot" || capture._tag === "Video" ? capture.media : null;
  return Schema.encodeSync(ProofRef)(
    new ProofRef({
      artifactId: artifact.id,
      sessionId,
      title: artifact.title,
      caption: artifact.caption,
      kind: proofKindOf(capture),
      label: proofLabel(artifact, (at) => `${at.toISOString().slice(11, 16)} UTC`),
      state:
        media !== null ? "stored" : capture._tag === "Recording" ? "recording" : "not-captured",
      mimeType: media?.mimeType ?? null,
    }),
  );
};

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "execute">;

const writeItem = Effect.fn("ProofArtifactsRepo.writeItem")(function* (
  tx: Tx,
  artifact: ProofArtifact,
) {
  if (artifact.sessionId === null || artifact.turnId === null) return false;
  yield* lockAgentConversation(tx, artifact.sessionId);
  const [turn] = yield* tx
    .select()
    .from(agentTurns)
    .where(and(eq(agentTurns.id, artifact.turnId), eq(agentTurns.sessionId, artifact.sessionId)))
    .limit(1);
  if (turn === undefined) return false;
  const seq = yield* nextAgentItemSeq(tx, artifact.sessionId);
  const data = refOf(artifact, artifact.sessionId);
  yield* tx
    .insert(agentItems)
    .values({
      id: AgentItemId.make(crypto.randomUUID()),
      sessionId: artifact.sessionId,
      processId: turn.processId,
      turnId: turn.id,
      seq,
      providerItemId: proofItemProviderId(artifact.id),
      providerOutputProcessId: turn.processId,
      providerOutputSeq: 0n,
      providerEventIndex: 0,
      kind: "proof",
      status: artifact.capture._tag === "Recording" ? "in-progress" : "completed",
      title: artifact.title,
      text: null,
      data,
    })
    .onConflictDoUpdate({
      target: [agentItems.processId, agentItems.providerItemId],
      set: {
        seq,
        data,
        status: artifact.capture._tag === "Recording" ? "in-progress" : "completed",
        updatedAt: new Date(),
      },
    });
  return true;
});

export const ProofArtifactsRepoLive: Layer.Layer<
  ProofArtifactsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ProofArtifactsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;
    const byId = Effect.fn("ProofArtifactsRepo.byId")(function* (id: ProofArtifactId) {
      const [row] = yield* db
        .select()
        .from(proofArtifacts)
        .where(eq(proofArtifacts.id, id))
        .limit(1);
      return row === undefined ? null : yield* decode(row);
    }, Effect.mapError(storageFailed));
    const byCall = Effect.fn("ProofArtifactsRepo.byCall")(function* (
      sessionId: SessionId,
      callKey: string,
    ) {
      const [row] = yield* db
        .select()
        .from(proofArtifacts)
        .where(and(eq(proofArtifacts.sessionId, sessionId), eq(proofArtifacts.callKey, callKey)))
        .limit(1);
      return row === undefined ? null : yield* decode(row);
    }, Effect.mapError(storageFailed));
    const notify = (artifact: ProofArtifact, itemChanged: boolean) =>
      Effect.gen(function* () {
        if (artifact.sessionId === null) return;
        if (itemChanged) yield* notifyAgentConversation(db, pg, artifact.sessionId);
        yield* notifyEvent(pg, {
          type: "session-change",
          changeId: artifact.changeId,
          worktreeId: artifact.worktreeId,
          sessionId: artifact.sessionId,
          projectId: artifact.projectId,
        });
      });
    const insert = Effect.fn("ProofArtifactsRepo.insert")(function* (
      artifact: ProofArtifact,
      callKey: string | null,
    ) {
      const written = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .insert(proofArtifacts)
              .values({
                ...artifact,
                callKey,
                source: Schema.encodeSync(ProofSource)(artifact.source),
                capture: Schema.encodeSync(ProofCapture)(artifact.capture),
              })
              .onConflictDoNothing({ target: [proofArtifacts.sessionId, proofArtifacts.callKey] })
              .returning();
            if (row === undefined) return null;
            const saved = yield* decode(row);
            return { artifact: saved, itemChanged: yield* writeItem(tx, saved) };
          }),
        )
        .pipe(Effect.mapError(storageFailed));
      if (written === null) {
        if (artifact.sessionId === null || callKey === null)
          return yield* Effect.die("proof insert conflict without call identity");
        const first = yield* byCall(artifact.sessionId, callKey);
        if (first === null)
          return yield* Effect.die("proof insert conflict without stored artifact");
        return first;
      }
      yield* notify(written.artifact, written.itemChanged);
      return written.artifact;
    });
    const listForChange = Effect.fn("ProofArtifactsRepo.listForChange")(function* (id: ChangeId) {
      const rows = yield* db
        .select()
        .from(proofArtifacts)
        .where(eq(proofArtifacts.changeId, id))
        .orderBy(asc(proofArtifacts.createdAt), asc(proofArtifacts.id));
      return yield* Effect.forEach(rows, decode);
    }, Effect.mapError(storageFailed));
    const settleVideo = Effect.fn("ProofArtifactsRepo.settleVideo")(function* (
      id: ProofArtifactId,
      capture: SettledProofCapture,
    ) {
      const written = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .update(proofArtifacts)
              .set({ capture: Schema.encodeSync(ProofCapture)(capture), observedTo: new Date() })
              .where(
                and(
                  eq(proofArtifacts.id, id),
                  sql`${proofArtifacts.capture}->>'_tag' = 'Recording'`,
                ),
              )
              .returning();
            if (row === undefined) return null;
            const artifact = yield* decode(row);
            return { artifact, itemChanged: yield* writeItem(tx, artifact) };
          }),
        )
        .pipe(Effect.mapError(storageFailed));
      if (written === null) return yield* byId(id);
      yield* notify(written.artifact, written.itemChanged);
      return written.artifact;
    });
    const settleStaleRecordings = Effect.fn("ProofArtifactsRepo.settleStaleRecordings")(
      function* () {
        const rows = yield* db
          .select({ id: proofArtifacts.id })
          .from(proofArtifacts)
          .where(sql`${proofArtifacts.capture}->>'_tag' = 'Recording'`)
          .pipe(Effect.mapError(storageFailed));
        yield* Effect.forEach(
          rows,
          ({ id }) =>
            settleVideo(id, {
              _tag: "NotCaptured",
              kind: "video",
              reason: "Mend restarted while recording",
            }),
          { discard: true },
        );
      },
    );
    return { insert, byId, byCall, listForChange, settleVideo, settleStaleRecordings };
  }),
);
