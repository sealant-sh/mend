import { PgClient } from "@effect/sql-pg";
import type { OrganizationId, SessionId } from "@mend/domain";
import type { ExecutorCall, ExecutorCalls } from "@mend/domain/workbench";
import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentSessions,
  executorCalls,
  executorInstances,
  executorServiceConnections,
  executorLinkFlows,
  executorLinks,
  organizationExecutors,
} from "../schema/workbench.ts";

export type ExecutorConfigurationRow = typeof organizationExecutors.$inferSelect;
export type ExecutorLinkRow = typeof executorLinks.$inferSelect;
export type ExecutorFlowRow = typeof executorLinkFlows.$inferSelect;
export type ExecutorServiceConnectionRow = typeof executorServiceConnections.$inferSelect;
export type ExecutorCallRow = typeof executorCalls.$inferSelect;

export const executorCallView = ({
  linkId: _link,
  sealedResult: _result,
  ...call
}: ExecutorCallRow): ExecutorCall => call;

export class ExecutorRepo extends Context.Service<
  ExecutorRepo,
  {
    readonly managedOrganizationId: (
      organizationId: OrganizationId,
    ) => Effect.Effect<string | null>;
    readonly saveServiceConnection: (row: ExecutorServiceConnectionRow) => Effect.Effect<void>;
    readonly serviceConnection: (
      id: string,
      actorId: string,
    ) => Effect.Effect<ExecutorServiceConnectionRow | null>;
    readonly consumeServiceConnection: (
      stateHash: string,
      actorId: string,
      configurationId: string,
    ) => Effect.Effect<ExecutorServiceConnectionRow | null>;
    readonly deleteServiceConnection: (id: string) => Effect.Effect<void>;
    readonly configuration: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ExecutorConfigurationRow | null>;
    readonly saveConfiguration: (row: ExecutorConfigurationRow) => Effect.Effect<void>;
    readonly deleteConfiguration: (organizationId: OrganizationId) => Effect.Effect<void>;
    readonly links: (configurationId: string) => Effect.Effect<ReadonlyArray<ExecutorLinkRow>>;
    readonly link: (
      configurationId: string,
      subject: string,
    ) => Effect.Effect<ExecutorLinkRow | null>;
    readonly linkById: (id: string) => Effect.Effect<ExecutorLinkRow | null>;
    readonly saveLink: (row: ExecutorLinkRow) => Effect.Effect<void>;
    readonly deleteLink: (id: string) => Effect.Effect<void>;
    readonly saveFlow: (row: ExecutorFlowRow) => Effect.Effect<void>;
    readonly consumeFlow: (
      stateHash: string,
      actorId: string,
    ) => Effect.Effect<ExecutorFlowRow | null>;
    readonly flows: (configurationId: string) => Effect.Effect<ReadonlyArray<ExecutorFlowRow>>;
    readonly expiredFlows: () => Effect.Effect<ReadonlyArray<ExecutorFlowRow>>;
    readonly deleteFlow: (stateHash: string) => Effect.Effect<void>;
    readonly call: (id: string) => Effect.Effect<ExecutorCallRow | null>;
    readonly calls: (
      sessionId: SessionId,
      before?: string,
    ) => Effect.Effect<typeof ExecutorCalls.Type>;
    readonly saveCall: (row: ExecutorCallRow) => Effect.Effect<ExecutorCall>;
    readonly claimCall: (row: ExecutorCallRow) => Effect.Effect<boolean>;
    readonly claimApproval: (id: string, actorId: string) => Effect.Effect<boolean>;
    readonly withLock: <A, E, R>(
      key: string,
      body: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
  }
>()("@mend/db/ExecutorRepo") {}

export const ExecutorRepoLive: Layer.Layer<ExecutorRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    ExecutorRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;
      const configuration = (organizationId: OrganizationId) =>
        db
          .select()
          .from(organizationExecutors)
          .where(eq(organizationExecutors.organizationId, organizationId))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows[0] ?? null),
          );
      const call = (id: string) =>
        db
          .select()
          .from(executorCalls)
          .where(eq(executorCalls.id, id))
          .pipe(
            Effect.orDie,
            Effect.map((rows) => rows[0] ?? null),
          );
      const withLock = <A, E, R>(
        key: string,
        body: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E, R> =>
        pg
          .withTransaction(
            Effect.gen(function* () {
              yield* pg`select pg_advisory_xact_lock(hashtextextended(${`mend:Executor:${key}`}, 0))`;
              // Commit rotated credentials and refusals even when the operation reports an error.
              return yield* Effect.result(body);
            }),
          )
          .pipe(
            Effect.orDie,
            Effect.flatMap((result) =>
              result._tag === "Success"
                ? Effect.succeed(result.success)
                : Effect.fail(result.failure),
            ),
          );
      return {
        managedOrganizationId: (organizationId) =>
          db
            .select({ id: executorInstances.executorOrganizationId })
            .from(executorInstances)
            .where(eq(executorInstances.organizationId, organizationId))
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0]?.id ?? null),
            ),
        saveServiceConnection: (row) =>
          Effect.gen(function* () {
            yield* db
              .delete(executorServiceConnections)
              .where(lt(executorServiceConnections.expiresAt, new Date()))
              .pipe(Effect.orDie);
            yield* db
              .insert(executorServiceConnections)
              .values(row)
              .onConflictDoUpdate({ target: executorServiceConnections.id, set: row })
              .pipe(Effect.orDie);
          }),
        serviceConnection: (id, actorId) =>
          db
            .select()
            .from(executorServiceConnections)
            .where(
              and(
                eq(executorServiceConnections.id, id),
                eq(executorServiceConnections.actorId, actorId),
                gt(executorServiceConnections.expiresAt, new Date()),
              ),
            )
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        consumeServiceConnection: (stateHash, actorId, configurationId) =>
          db
            .delete(executorServiceConnections)
            .where(
              and(
                eq(executorServiceConnections.stateHash, stateHash),
                eq(executorServiceConnections.actorId, actorId),
                eq(executorServiceConnections.configurationId, configurationId),
                gt(executorServiceConnections.expiresAt, new Date()),
              ),
            )
            .returning()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        deleteServiceConnection: (id) =>
          db
            .delete(executorServiceConnections)
            .where(eq(executorServiceConnections.id, id))
            .pipe(Effect.orDie, Effect.asVoid),
        configuration,
        saveConfiguration: (row) =>
          db
            .insert(organizationExecutors)
            .values(row)
            .onConflictDoUpdate({ target: organizationExecutors.organizationId, set: row })
            .pipe(Effect.orDie, Effect.asVoid),
        deleteConfiguration: (organizationId) =>
          db
            .delete(organizationExecutors)
            .where(eq(organizationExecutors.organizationId, organizationId))
            .pipe(Effect.orDie, Effect.asVoid),
        links: (configurationId) =>
          db
            .select()
            .from(executorLinks)
            .where(eq(executorLinks.configurationId, configurationId))
            .pipe(Effect.orDie),
        link: (configurationId, subject) =>
          db
            .select()
            .from(executorLinks)
            .where(
              and(
                eq(executorLinks.configurationId, configurationId),
                eq(executorLinks.subject, subject),
              ),
            )
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        linkById: (id) =>
          db
            .select()
            .from(executorLinks)
            .where(eq(executorLinks.id, id))
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        saveLink: (row) =>
          db
            .insert(executorLinks)
            .values(row)
            .onConflictDoUpdate({ target: executorLinks.id, set: row })
            .pipe(Effect.orDie, Effect.asVoid),
        deleteLink: (id) =>
          db
            .delete(executorLinks)
            .where(eq(executorLinks.id, id))
            .pipe(Effect.orDie, Effect.asVoid),
        saveFlow: (row) =>
          db.insert(executorLinkFlows).values(row).pipe(Effect.orDie, Effect.asVoid),
        consumeFlow: (stateHash, actorId) =>
          db
            .delete(executorLinkFlows)
            .where(
              and(
                eq(executorLinkFlows.stateHash, stateHash),
                eq(executorLinkFlows.actorId, actorId),
                gt(executorLinkFlows.expiresAt, new Date()),
              ),
            )
            .returning()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows[0] ?? null),
            ),
        flows: (configurationId) =>
          db
            .select()
            .from(executorLinkFlows)
            .where(eq(executorLinkFlows.configurationId, configurationId))
            .pipe(Effect.orDie),
        expiredFlows: () =>
          db
            .select()
            .from(executorLinkFlows)
            .where(lt(executorLinkFlows.expiresAt, new Date()))
            .pipe(Effect.orDie),
        deleteFlow: (stateHash) =>
          db
            .delete(executorLinkFlows)
            .where(eq(executorLinkFlows.stateHash, stateHash))
            .pipe(Effect.orDie, Effect.asVoid),
        call,
        claimCall: (row) =>
          db
            .insert(executorCalls)
            .values(row)
            .onConflictDoNothing()
            .returning({ id: executorCalls.id })
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.length === 1),
            ),
        claimApproval: (id, actorId) =>
          db
            .update(executorCalls)
            .set({ outcome: "answering", observedAt: new Date() })
            .where(
              and(
                eq(executorCalls.id, id),
                eq(executorCalls.approverId, actorId),
                eq(executorCalls.outcome, "held"),
                gt(executorCalls.expiresAt, new Date()),
              ),
            )
            .returning({ id: executorCalls.id })
            .pipe(
              Effect.orDie,
              Effect.map((rows) => rows.length === 1),
            ),
        calls: (sessionId, before) =>
          Effect.gen(function* () {
            yield* db
              .update(executorCalls)
              .set({
                outcome: "expired",
                message: "This Executor call expired. Run the tool again if it is still needed.",
                sealedResult: null,
                observedAt: new Date(),
              })
              .where(
                and(
                  eq(executorCalls.sessionId, sessionId),
                  or(eq(executorCalls.outcome, "held"), eq(executorCalls.outcome, "answering")),
                  lt(executorCalls.expiresAt, new Date()),
                ),
              )
              .pipe(Effect.orDie);
            const anchor = before === undefined ? null : yield* call(before);
            const rows = yield* db
              .select()
              .from(executorCalls)
              .where(
                and(
                  eq(executorCalls.sessionId, sessionId),
                  anchor === null || anchor.sessionId !== sessionId
                    ? undefined
                    : or(
                        lt(executorCalls.createdAt, anchor.createdAt),
                        and(
                          eq(executorCalls.createdAt, anchor.createdAt),
                          lt(executorCalls.id, anchor.id),
                        ),
                      ),
                ),
              )
              .orderBy(desc(executorCalls.createdAt), desc(executorCalls.id))
              .limit(101)
              .pipe(Effect.orDie);
            const shown = rows.slice(0, 100);
            return {
              calls: shown.map(executorCallView),
              olderCursor: rows.length > 100 ? (shown.at(-1)?.id ?? null) : null,
            };
          }),
        saveCall: (row) =>
          Effect.gen(function* () {
            yield* db
              .insert(executorCalls)
              .values(row)
              .onConflictDoUpdate({ target: executorCalls.id, set: row })
              .pipe(Effect.orDie);
            const [session] = yield* db
              .select({ projectId: agentSessions.projectId })
              .from(agentSessions)
              .where(eq(agentSessions.id, row.sessionId))
              .pipe(Effect.orDie);
            if (session !== undefined)
              yield* notifyEvent(pg, {
                type: "agent-conversation",
                sessionId: row.sessionId,
                projectId: session.projectId,
              });
            return executorCallView(row);
          }),
        withLock,
      };
    }),
  );
