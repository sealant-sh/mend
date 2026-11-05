import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import type { AgentTurnId, OrganizationId, SessionId } from "@mend/domain";
import {
  BoundaryObservation,
  ForkProvenance,
  HistoryOperation,
  InheritedHistory,
  NativeHistorySeed,
  SessionHistoryRefusedError,
  type ForkPoint,
  type HistoryOperationId,
  type HistoryProgress,
  type NativeSeedId,
  type TurnBoundary,
  type TurnBoundaryId,
} from "@mend/domain/workbench";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

/** Retained bytes are internal conversation state, never configuration or login files. */
export interface NativeSeedFile {
  readonly relativePath: string;
  readonly content: string;
}

/** A child's own retained evidence, independent of the availability of its source session. */
export interface RetainedFork {
  readonly operation: HistoryOperation;
  readonly provenance: ForkProvenance;
  readonly history: InheritedHistory;
}

/** Immutable evidence and keyed history receipts. AgentConversationRepo alone schedules turns. */
export class SessionHistoryRepo extends Context.Service<
  SessionHistoryRepo,
  {
    readonly saveSeed: (
      seed: NativeHistorySeed,
      files: ReadonlyArray<NativeSeedFile>,
    ) => Effect.Effect<void>;
    readonly seed: (
      id: NativeSeedId,
    ) => Effect.Effect<{
      readonly manifest: NativeHistorySeed;
      readonly files: ReadonlyArray<NativeSeedFile>;
    } | null>;
    readonly observe: (observation: BoundaryObservation) => Effect.Effect<void>;
    readonly boundary: (id: TurnBoundaryId) => Effect.Effect<TurnBoundary | null>;
    readonly selectBoundary: (
      sessionId: SessionId,
      point: ForkPoint,
    ) => Effect.Effect<TurnBoundary | null>;
    readonly observations: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<BoundaryObservation>>;
    readonly operation: (
      organizationId: OrganizationId,
      actorId: string,
      commandId: string,
    ) => Effect.Effect<HistoryOperation | null>;
    readonly reserve: (
      operation: HistoryOperation,
      provenance: ForkProvenance,
      history: InheritedHistory,
    ) => Effect.Effect<HistoryOperation, SessionHistoryRefusedError>;
    readonly claim: (id: HistoryOperationId, token: string) => Effect.Effect<boolean>;
    readonly progress: (
      id: HistoryOperationId,
      token: string,
      progress: HistoryProgress,
    ) => Effect.Effect<boolean>;
    readonly release: (id: HistoryOperationId, token: string) => Effect.Effect<void>;
    readonly fork: (child: SessionId) => Effect.Effect<RetainedFork | null>;
  }
>()("@mend/db/SessionHistoryRepo") {}

const decodeObservation = Schema.decodeUnknownSync(BoundaryObservation);
const decodeOperation = Schema.decodeUnknownSync(HistoryOperation);
const decodeSeed = Schema.decodeUnknownSync(NativeHistorySeed);
const decodeProvenance = Schema.decodeUnknownSync(ForkProvenance);
const decodeHistory = Schema.decodeUnknownSync(InheritedHistory);
const encodeOperation = Schema.encodeSync(Schema.toCodecJson(HistoryOperation));
const encodeObservation = Schema.encodeSync(Schema.toCodecJson(BoundaryObservation));
const encodeProvenance = Schema.encodeSync(Schema.toCodecJson(ForkProvenance));
const encodeHistory = Schema.encodeSync(Schema.toCodecJson(InheritedHistory));

/** PostgreSQL retains seed references and inherited evidence after source deletion. */
export const SessionHistoryRepoLive: Layer.Layer<SessionHistoryRepo, never, PgClient.PgClient> =
  Layer.effect(
    SessionHistoryRepo,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      const operation = Effect.fn("SessionHistoryRepo.operation")(function* (
        organizationId: OrganizationId,
        actorId: string,
        commandId: string,
      ) {
        const rows = yield* sql<{
          readonly operation: unknown;
        }>`SELECT operation FROM session_history_operations WHERE organization_id = ${organizationId} AND actor_id = ${actorId} AND command_id = ${commandId}`.pipe(
          Effect.orDie,
        );
        return rows[0] === undefined ? null : decodeOperation(rows[0].operation);
      });
      const observations = Effect.fn("SessionHistoryRepo.observations")(function* (
        sessionId: SessionId,
      ) {
        const rows = yield* sql<{
          readonly observation: unknown;
        }>`SELECT observation FROM session_turn_boundaries WHERE session_id = ${sessionId} ORDER BY id`.pipe(
          Effect.orDie,
        );
        return rows.map((row) => decodeObservation(row.observation));
      });
      return SessionHistoryRepo.of({
        saveSeed: (seed, files) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const manifest = Schema.decodeUnknownSync(NativeHistorySeed)(seed);
                if (files.length !== manifest.files.length)
                  return yield* Effect.die("Native seed manifest does not cover its files.");
                for (const file of manifest.files) {
                  const bytes = files.find((item) => item.relativePath === file.relativePath);
                  if (
                    bytes === undefined ||
                    Buffer.byteLength(bytes.content) !== file.byteLength ||
                    createHash("sha256").update(bytes.content).digest("hex") !== file.sha256
                  )
                    return yield* Effect.die("Native seed file digest differs from its manifest.");
                }
                yield* sql`INSERT INTO session_native_seeds (id, manifest) VALUES (${seed.id}, ${JSON.stringify(manifest)}::jsonb) ON CONFLICT DO NOTHING`;
                const stored = yield* sql<{
                  readonly manifest: unknown;
                }>`SELECT manifest FROM session_native_seeds WHERE id = ${seed.id}`;
                if (JSON.stringify(decodeSeed(stored[0]?.manifest)) !== JSON.stringify(manifest))
                  return yield* Effect.die("Native seed identity conflict.");
                for (const file of files)
                  yield* sql`INSERT INTO session_native_seed_files (seed_id, relative_path, content) VALUES (${seed.id}, ${file.relativePath}, ${file.content}) ON CONFLICT DO NOTHING`;
              }),
            )
            .pipe(Effect.orDie),
        seed: (id) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly manifest: unknown;
            }>`SELECT manifest FROM session_native_seeds WHERE id = ${id}`.pipe(Effect.orDie);
            if (rows[0] === undefined) return null;
            const files = yield* sql<{
              readonly relativePath: string;
              readonly content: string;
            }>`SELECT relative_path AS "relativePath", content FROM session_native_seed_files WHERE seed_id = ${id} ORDER BY relative_path`.pipe(
              Effect.orDie,
            );
            return { manifest: decodeSeed(rows[0].manifest), files };
          }),
        observe: (observation) => {
          const ready = observation.kind === "ready" ? observation.boundary : null;
          const sessionId =
            observation.kind === "ready" ? observation.boundary.sessionId : observation.sessionId;
          const turnId: AgentTurnId | null =
            observation.kind === "unavailable"
              ? observation.turnId
              : observation.boundary.anchor.kind === "turn"
                ? observation.boundary.anchor.turnId
                : null;
          const id = ready?.id ?? `unavailable:${sessionId}:${turnId}`;
          return sql`INSERT INTO session_turn_boundaries (id, session_id, turn_id, checkpoint_id, seed_id, observation) VALUES (${id}, ${sessionId}, ${turnId}, ${ready?.checkpointId ?? null}, ${ready?.nativeSeedId ?? null}, ${JSON.stringify(encodeObservation(observation))}::jsonb) ON CONFLICT DO NOTHING`.pipe(
            Effect.orDie,
            Effect.asVoid,
          );
        },
        boundary: (id) =>
          sql<{
            readonly observation: unknown;
          }>`SELECT observation FROM session_turn_boundaries WHERE id = ${id}`.pipe(
            Effect.orDie,
            Effect.map((rows) => {
              const item = rows[0] === undefined ? null : decodeObservation(rows[0].observation);
              return item?.kind === "ready" ? item.boundary : null;
            }),
          ),
        selectBoundary: (sessionId, point) =>
          observations(sessionId).pipe(
            Effect.map(
              (rows) =>
                rows
                  .flatMap((row) => (row.kind === "ready" ? [row.boundary] : []))
                  .filter(
                    (boundary) =>
                      point.kind === "latestStable" ||
                      (point.kind === "turn"
                        ? boundary.anchor.kind === "turn" && boundary.anchor.turnId === point.turnId
                        : boundary.checkpointId === point.checkpointId),
                  )
                  .toSorted((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0] ?? null,
            ),
          ),
        observations,
        operation,
        reserve: (requested, provenance, history) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`mend:history:${requested.organizationId}:${requested.actorId}:${requested.commandId}`}))`;
                const existing = yield* operation(
                  requested.organizationId,
                  requested.actorId,
                  requested.commandId,
                );
                if (existing !== null) {
                  if (existing.intentDigest !== requested.intentDigest)
                    return yield* new SessionHistoryRefusedError({
                      reason: "command_conflict",
                      message: "This fork command was already used with different options.",
                    });
                  return existing;
                }
                yield* sql`INSERT INTO session_history_operations (id, organization_id, actor_id, command_id, intent_digest, operation) VALUES (${requested.id}, ${requested.organizationId}, ${requested.actorId}, ${requested.commandId}, ${requested.intentDigest}, ${JSON.stringify(encodeOperation(requested))}::jsonb)`;
                yield* sql`INSERT INTO session_forks (child_session_id, operation_id, source_boundary_id, seed_id, provenance, inherited_history) VALUES (${provenance.childSessionId}, ${requested.id}, ${provenance.sourceBoundaryId}, ${provenance.sourceNativeSeedId}, ${JSON.stringify(encodeProvenance(provenance))}::jsonb, ${JSON.stringify(encodeHistory(history))}::jsonb)`;
                return requested;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die)),
        claim: (id, token) =>
          sql`UPDATE session_history_operations SET lease_token = ${token}, lease_until = now() + interval '5 minutes' WHERE id = ${id} AND (lease_token IS NULL OR lease_until < now() OR lease_token = ${token}) RETURNING id`.pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length === 1),
          ),
        progress: (id, token, progress) =>
          sql`UPDATE session_history_operations SET operation = jsonb_set(jsonb_set(operation, '{progress}', ${JSON.stringify(progress)}::jsonb), '{updatedAt}', to_jsonb(now())) WHERE id = ${id} AND lease_token = ${token} AND lease_until > now() RETURNING id`.pipe(
            Effect.orDie,
            Effect.map((rows) => rows.length === 1),
          ),
        release: (id, token) =>
          sql`UPDATE session_history_operations SET lease_token = NULL, lease_until = NULL WHERE id = ${id} AND lease_token = ${token}`.pipe(
            Effect.orDie,
            Effect.asVoid,
          ),
        fork: (child) =>
          sql<{
            readonly operation: unknown;
            readonly provenance: unknown;
            readonly history: unknown;
          }>`SELECT o.operation, f.provenance, f.inherited_history AS history FROM session_forks f JOIN session_history_operations o ON o.id = f.operation_id WHERE f.child_session_id = ${child}`.pipe(
            Effect.orDie,
            Effect.map((rows) =>
              rows[0] === undefined
                ? null
                : {
                    operation: decodeOperation(rows[0].operation),
                    provenance: decodeProvenance(rows[0].provenance),
                    history: decodeHistory(rows[0].history),
                  },
            ),
          ),
      });
    }),
  );
