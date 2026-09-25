import { PgClient } from "@effect/sql-pg";
import {
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionProcessId,
  type SealantWorkspaceId,
  type SessionId,
} from "@mend/domain";
import {
  Service,
  ServiceForward,
  ServiceObservation,
  type ServiceBrowserScheme,
  type ServiceDeclarationSource,
  type ServiceObservationSource,
  type ServiceTargetState,
  type ServiceTransport,
} from "@mend/domain/workbench";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { notifyEvent } from "../events.ts";
import {
  agentSessions,
  serviceForwards,
  serviceObservations,
  services,
  sessionProcesses,
} from "../schema/workbench.ts";

export interface NewService {
  readonly id?: ServiceId;
  readonly sessionId: SessionId;
  readonly name: string;
  readonly declarationSource: ServiceDeclarationSource;
  readonly workspacePort: number;
  readonly transport: ServiceTransport;
  readonly browserScheme: ServiceBrowserScheme;
  readonly bindAddresses: ReadonlyArray<string>;
  readonly preferredHostPort?: number | null;
  readonly attemptHistoryComplete?: boolean;
  readonly forwardHistoryComplete?: boolean;
  readonly observationHistoryComplete?: boolean;
}

/** Stable Service declarations and their current attempt/forward pointers. */
export class ServicesRepo extends Context.Service<
  ServicesRepo,
  {
    readonly create: (input: NewService) => Effect.Effect<Service>;
    readonly byId: (id: ServiceId) => Effect.Effect<Service | null>;
    /** Accept a stable Service id or any of its process-attempt ids. */
    readonly byReference: (id: string) => Effect.Effect<Service | null>;
    readonly byName: (sessionId: SessionId, name: string) => Effect.Effect<Service | null>;
    readonly listForSession: (sessionId: SessionId) => Effect.Effect<ReadonlyArray<Service>>;
    readonly listAll: () => Effect.Effect<ReadonlyArray<Service>>;
    /**
     * Per session, how many Services hold its workspace: a current attempt that has not exited,
     * or a current forward still binding or bound. Sessions with none are absent.
     */
    readonly liveCountsForSessions: (
      sessionIds: ReadonlyArray<SessionId>,
    ) => Effect.Effect<ReadonlyMap<SessionId, number>>;
    readonly setCurrentAttempt: (
      id: ServiceId,
      attemptId: SessionProcessId | null,
    ) => Effect.Effect<void>;
    readonly setCurrentForward: (
      id: ServiceId,
      forwardId: ServiceForwardId | null,
    ) => Effect.Effect<void>;
    readonly compareAndSetCurrentAttempt: (
      id: ServiceId,
      expected: SessionProcessId | null,
      next: SessionProcessId | null,
    ) => Effect.Effect<boolean>;
    readonly compareAndSetCurrentForward: (
      id: ServiceId,
      expected: ServiceForwardId | null,
      next: ServiceForwardId | null,
    ) => Effect.Effect<boolean>;
  }
>()("@mend/db/ServicesRepo") {}

export interface NewServiceForward {
  readonly id?: ServiceForwardId;
  readonly serviceId: ServiceId;
  readonly sealantWorkspaceId: SealantWorkspaceId;
  readonly preferredHostPort?: number | null;
  readonly supersedesForwardId?: ServiceForwardId | null;
}

/** Host bindings are durable records independent from process attempts. */
export class ServiceForwardsRepo extends Context.Service<
  ServiceForwardsRepo,
  {
    readonly create: (input: NewServiceForward) => Effect.Effect<ServiceForward>;
    /** Inserts a binding attempt and selects it on the Service in one transaction. */
    readonly createAndSelect: (input: NewServiceForward) => Effect.Effect<ServiceForward>;
    readonly byId: (id: ServiceForwardId) => Effect.Effect<ServiceForward | null>;
    readonly listForService: (serviceId: ServiceId) => Effect.Effect<ReadonlyArray<ServiceForward>>;
    readonly listOpen: () => Effect.Effect<ReadonlyArray<ServiceForward>>;
    readonly markBound: (
      id: ServiceForwardId,
      hostPort: number,
      boundAddresses: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    readonly markFailed: (id: ServiceForwardId, error: string) => Effect.Effect<void>;
    readonly markClosed: (id: ServiceForwardId) => Effect.Effect<void>;
  }
>()("@mend/db/ServiceForwardsRepo") {}

export interface NewServiceObservation {
  readonly serviceId: ServiceId;
  readonly forwardId: ServiceForwardId;
  readonly state: ServiceTargetState;
  readonly source: ServiceObservationSource;
  readonly error?: string | null;
}

/** Timestamped target facts; every transition is retained. */
export class ServiceObservationsRepo extends Context.Service<
  ServiceObservationsRepo,
  {
    readonly record: (input: NewServiceObservation) => Effect.Effect<ServiceObservation>;
    readonly latestForService: (serviceId: ServiceId) => Effect.Effect<ServiceObservation | null>;
    readonly listForService: (
      serviceId: ServiceId,
    ) => Effect.Effect<ReadonlyArray<ServiceObservation>>;
  }
>()("@mend/db/ServiceObservationsRepo") {}

const toService = (row: typeof services.$inferSelect): Service => new Service(row);
const toForward = (row: typeof serviceForwards.$inferSelect): ServiceForward =>
  new ServiceForward(row);
const toObservation = (row: typeof serviceObservations.$inferSelect): ServiceObservation =>
  new ServiceObservation(row);

export const ServicesRepoLive: Layer.Layer<ServicesRepo, never, MendDB | PgClient.PgClient> =
  Layer.effect(
    ServicesRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const pg = yield* PgClient.PgClient;

      const notify = Effect.fn("ServicesRepo.notify")(function* (sessionId: SessionId) {
        const [row] = yield* db
          .select({ projectId: agentSessions.projectId })
          .from(agentSessions)
          .where(eq(agentSessions.id, sessionId))
          .limit(1)
          .pipe(Effect.orDie);
        yield* notifyEvent(pg, {
          type: "session-process",
          sessionId,
          projectId: row?.projectId ?? "",
        });
      });

      const byId = Effect.fn("ServicesRepo.byId")(function* (id: ServiceId) {
        const [row] = yield* db
          .select()
          .from(services)
          .where(eq(services.id, id))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined ? null : toService(row);
      });

      const create = Effect.fn("ServicesRepo.create")(function* (input: NewService) {
        const [row] = yield* db
          .insert(services)
          .values({
            id: input.id ?? ServiceId.make(crypto.randomUUID()),
            sessionId: input.sessionId,
            name: input.name,
            declarationSource: input.declarationSource,
            workspacePort: input.workspacePort,
            transport: input.transport,
            browserScheme: input.browserScheme,
            bindAddresses: input.bindAddresses,
            preferredHostPort: input.preferredHostPort ?? null,
            currentAttemptId: null,
            currentForwardId: null,
            attemptHistoryComplete: input.attemptHistoryComplete ?? true,
            forwardHistoryComplete: input.forwardHistoryComplete ?? true,
            observationHistoryComplete: input.observationHistoryComplete ?? true,
          })
          .returning()
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("service insert returned no row");
        yield* notify(row.sessionId);
        return toService(row);
      });

      const byReference = Effect.fn("ServicesRepo.byReference")(function* (id: string) {
        const stable = yield* byId(ServiceId.make(id));
        if (stable !== null) return stable;
        const [process] = yield* db
          .select({ serviceId: sessionProcesses.serviceId })
          .from(sessionProcesses)
          .where(eq(sessionProcesses.id, SessionProcessId.make(id)))
          .limit(1)
          .pipe(Effect.orDie);
        return process?.serviceId === null || process?.serviceId === undefined
          ? null
          : yield* byId(process.serviceId);
      });

      const byName = Effect.fn("ServicesRepo.byName")(function* (
        sessionId: SessionId,
        name: string,
      ) {
        const [row] = yield* db
          .select()
          .from(services)
          .where(eq(services.sessionId, sessionId))
          .orderBy(desc(services.createdAt))
          .pipe(
            Effect.map((rows) => rows.filter((candidate) => candidate.name === name).slice(0, 1)),
            Effect.orDie,
          );
        return row === undefined ? null : toService(row);
      });

      const listForSession = Effect.fn("ServicesRepo.listForSession")(function* (
        sessionId: SessionId,
      ) {
        const rows = yield* db
          .select()
          .from(services)
          .where(eq(services.sessionId, sessionId))
          .orderBy(asc(services.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toService);
      });

      const listAll = Effect.fn("ServicesRepo.listAll")(function* () {
        const rows = yield* db
          .select()
          .from(services)
          .orderBy(desc(services.createdAt))
          .pipe(Effect.orDie);
        return rows.map(toService);
      });

      const liveCountsForSessions = Effect.fn("ServicesRepo.liveCountsForSessions")(function* (
        sessionIds: ReadonlyArray<SessionId>,
      ) {
        if (sessionIds.length === 0) return new Map<SessionId, number>();
        const rows = yield* db
          .select({ sessionId: services.sessionId, live: count() })
          .from(services)
          .leftJoin(
            sessionProcesses,
            and(
              eq(sessionProcesses.id, services.currentAttemptId),
              isNull(sessionProcesses.exitedAt),
            ),
          )
          .leftJoin(
            serviceForwards,
            and(
              eq(serviceForwards.id, services.currentForwardId),
              inArray(serviceForwards.state, ["binding", "bound"]),
            ),
          )
          .where(
            and(
              inArray(services.sessionId, [...sessionIds]),
              or(isNotNull(sessionProcesses.id), isNotNull(serviceForwards.id)),
            ),
          )
          .groupBy(services.sessionId)
          .pipe(Effect.orDie);
        return new Map(rows.map((row) => [row.sessionId, row.live]));
      });

      const setCurrentAttempt = Effect.fn("ServicesRepo.setCurrentAttempt")(function* (
        id: ServiceId,
        attemptId: SessionProcessId | null,
      ) {
        const rows = yield* db
          .update(services)
          .set({ currentAttemptId: attemptId, updatedAt: new Date() })
          .where(eq(services.id, id))
          .returning({ sessionId: services.sessionId })
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row !== undefined) yield* notify(row.sessionId);
      });

      const setCurrentForward = Effect.fn("ServicesRepo.setCurrentForward")(function* (
        id: ServiceId,
        forwardId: ServiceForwardId | null,
      ) {
        const rows = yield* db
          .update(services)
          .set({ currentForwardId: forwardId, updatedAt: new Date() })
          .where(eq(services.id, id))
          .returning({ sessionId: services.sessionId })
          .pipe(Effect.orDie);
        const row = rows[0];
        if (row !== undefined) yield* notify(row.sessionId);
      });

      const compareAndSetCurrentAttempt = Effect.fn("ServicesRepo.compareAndSetCurrentAttempt")(
        function* (
          id: ServiceId,
          expected: SessionProcessId | null,
          next: SessionProcessId | null,
        ) {
          const rows = yield* db
            .update(services)
            .set({ currentAttemptId: next, updatedAt: new Date() })
            .where(
              and(
                eq(services.id, id),
                expected === null
                  ? isNull(services.currentAttemptId)
                  : eq(services.currentAttemptId, expected),
              ),
            )
            .returning({ sessionId: services.sessionId })
            .pipe(Effect.orDie);
          const row = rows[0];
          if (row === undefined) return false;
          yield* notify(row.sessionId);
          return true;
        },
      );

      const compareAndSetCurrentForward = Effect.fn("ServicesRepo.compareAndSetCurrentForward")(
        function* (
          id: ServiceId,
          expected: ServiceForwardId | null,
          next: ServiceForwardId | null,
        ) {
          const rows = yield* db
            .update(services)
            .set({ currentForwardId: next, updatedAt: new Date() })
            .where(
              and(
                eq(services.id, id),
                expected === null
                  ? isNull(services.currentForwardId)
                  : eq(services.currentForwardId, expected),
              ),
            )
            .returning({ sessionId: services.sessionId })
            .pipe(Effect.orDie);
          const row = rows[0];
          if (row === undefined) return false;
          yield* notify(row.sessionId);
          return true;
        },
      );

      return {
        create,
        byId,
        byReference,
        byName,
        listForSession,
        listAll,
        liveCountsForSessions,
        setCurrentAttempt,
        setCurrentForward,
        compareAndSetCurrentAttempt,
        compareAndSetCurrentForward,
      };
    }),
  );

export const ServiceForwardsRepoLive: Layer.Layer<
  ServiceForwardsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ServiceForwardsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notify = Effect.fn("ServiceForwardsRepo.notify")(function* (serviceId: ServiceId) {
      const [row] = yield* db
        .select({ sessionId: services.sessionId, projectId: agentSessions.projectId })
        .from(services)
        .innerJoin(agentSessions, eq(agentSessions.id, services.sessionId))
        .where(eq(services.id, serviceId))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return;
      yield* notifyEvent(pg, {
        type: "session-process",
        sessionId: row.sessionId,
        projectId: row.projectId,
      });
    });

    const create = Effect.fn("ServiceForwardsRepo.create")(function* (input: NewServiceForward) {
      const [row] = yield* db
        .insert(serviceForwards)
        .values({
          id: input.id ?? ServiceForwardId.make(crypto.randomUUID()),
          serviceId: input.serviceId,
          sealantWorkspaceId: input.sealantWorkspaceId,
          preferredHostPort: input.preferredHostPort ?? null,
          hostPort: null,
          boundAddresses: null,
          state: "binding",
          error: null,
          supersedesForwardId: input.supersedesForwardId ?? null,
          boundAt: null,
          closedAt: null,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("service forward insert returned no row");
      yield* notify(row.serviceId);
      return toForward(row);
    });

    const createAndSelect = Effect.fn("ServiceForwardsRepo.createAndSelect")(function* (
      input: NewServiceForward,
    ) {
      const row = yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [created] = yield* tx
              .insert(serviceForwards)
              .values({
                id: input.id ?? ServiceForwardId.make(crypto.randomUUID()),
                serviceId: input.serviceId,
                sealantWorkspaceId: input.sealantWorkspaceId,
                preferredHostPort: input.preferredHostPort ?? null,
                hostPort: null,
                boundAddresses: null,
                state: "binding",
                error: null,
                supersedesForwardId: input.supersedesForwardId ?? null,
                boundAt: null,
                closedAt: null,
              })
              .returning();
            if (created === undefined) {
              return yield* Effect.die("service forward insert returned no row");
            }
            yield* tx
              .update(services)
              .set({ currentForwardId: created.id, updatedAt: new Date() })
              .where(eq(services.id, input.serviceId));
            return created;
          }),
        )
        .pipe(Effect.orDie);
      yield* notify(row.serviceId);
      return toForward(row);
    });

    const byId = Effect.fn("ServiceForwardsRepo.byId")(function* (id: ServiceForwardId) {
      const [row] = yield* db
        .select()
        .from(serviceForwards)
        .where(eq(serviceForwards.id, id))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toForward(row);
    });

    const listForService = Effect.fn("ServiceForwardsRepo.listForService")(function* (
      serviceId: ServiceId,
    ) {
      const rows = yield* db
        .select()
        .from(serviceForwards)
        .where(eq(serviceForwards.serviceId, serviceId))
        .orderBy(asc(serviceForwards.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toForward);
    });

    const listOpen = Effect.fn("ServiceForwardsRepo.listOpen")(function* () {
      const rows = yield* db
        .select()
        .from(serviceForwards)
        .where(inArray(serviceForwards.state, ["binding", "bound"]))
        .orderBy(asc(serviceForwards.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toForward);
    });

    const markBound = Effect.fn("ServiceForwardsRepo.markBound")(function* (
      id: ServiceForwardId,
      hostPort: number,
      boundAddresses: ReadonlyArray<string>,
    ) {
      const rows = yield* db
        .update(serviceForwards)
        .set({
          hostPort,
          boundAddresses,
          state: "bound",
          error: null,
          boundAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(serviceForwards.id, id), eq(serviceForwards.state, "binding")))
        .returning({ serviceId: serviceForwards.serviceId })
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row !== undefined) yield* notify(row.serviceId);
    });

    const markFailed = Effect.fn("ServiceForwardsRepo.markFailed")(function* (
      id: ServiceForwardId,
      error: string,
    ) {
      const now = new Date();
      const rows = yield* db
        .update(serviceForwards)
        .set({ state: "failed", error, closedAt: now, updatedAt: now })
        .where(eq(serviceForwards.id, id))
        .returning({ serviceId: serviceForwards.serviceId })
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row !== undefined) yield* notify(row.serviceId);
    });

    const markClosed = Effect.fn("ServiceForwardsRepo.markClosed")(function* (
      id: ServiceForwardId,
    ) {
      const now = new Date();
      const rows = yield* db
        .update(serviceForwards)
        .set({ state: "closed", closedAt: now, updatedAt: now })
        .where(eq(serviceForwards.id, id))
        .returning({ serviceId: serviceForwards.serviceId })
        .pipe(Effect.orDie);
      const row = rows[0];
      if (row !== undefined) yield* notify(row.serviceId);
    });

    return {
      create,
      createAndSelect,
      byId,
      listForService,
      listOpen,
      markBound,
      markFailed,
      markClosed,
    };
  }),
);

export const ServiceObservationsRepoLive: Layer.Layer<
  ServiceObservationsRepo,
  never,
  MendDB | PgClient.PgClient
> = Layer.effect(
  ServiceObservationsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    const pg = yield* PgClient.PgClient;

    const notify = Effect.fn("ServiceObservationsRepo.notify")(function* (serviceId: ServiceId) {
      const [row] = yield* db
        .select({ sessionId: services.sessionId, projectId: agentSessions.projectId })
        .from(services)
        .innerJoin(agentSessions, eq(agentSessions.id, services.sessionId))
        .where(eq(services.id, serviceId))
        .limit(1)
        .pipe(Effect.orDie);
      if (row === undefined) return;
      yield* notifyEvent(pg, {
        type: "session-process",
        sessionId: row.sessionId,
        projectId: row.projectId,
      });
    });

    const record = Effect.fn("ServiceObservationsRepo.record")(function* (
      input: NewServiceObservation,
    ) {
      const [latest] = yield* db
        .select()
        .from(serviceObservations)
        .where(eq(serviceObservations.forwardId, input.forwardId))
        .orderBy(desc(serviceObservations.lastObservedAt))
        .limit(1)
        .pipe(Effect.orDie);
      const error = input.error ?? null;
      if (
        latest !== undefined &&
        latest.state === input.state &&
        latest.source === input.source &&
        latest.error === error
      ) {
        const [extended] = yield* db
          .update(serviceObservations)
          .set({ lastObservedAt: new Date() })
          .where(eq(serviceObservations.id, latest.id))
          .returning()
          .pipe(Effect.orDie);
        if (extended === undefined) {
          return yield* Effect.die("service observation extension returned no row");
        }
        yield* notify(extended.serviceId);
        return toObservation(extended);
      }
      const [row] = yield* db
        .insert(serviceObservations)
        .values({
          id: ServiceObservationId.make(crypto.randomUUID()),
          serviceId: input.serviceId,
          forwardId: input.forwardId,
          state: input.state,
          source: input.source,
          error,
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("service observation insert returned no row");
      yield* notify(row.serviceId);
      return toObservation(row);
    });

    const latestForService = Effect.fn("ServiceObservationsRepo.latestForService")(function* (
      serviceId: ServiceId,
    ) {
      const [row] = yield* db
        .select()
        .from(serviceObservations)
        .where(eq(serviceObservations.serviceId, serviceId))
        .orderBy(desc(serviceObservations.lastObservedAt))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toObservation(row);
    });

    const listForService = Effect.fn("ServiceObservationsRepo.listForService")(function* (
      serviceId: ServiceId,
    ) {
      const rows = yield* db
        .select()
        .from(serviceObservations)
        .where(eq(serviceObservations.serviceId, serviceId))
        .orderBy(asc(serviceObservations.firstObservedAt))
        .pipe(Effect.orDie);
      return rows.map(toObservation);
    });

    return { record, latestForService, listForService };
  }),
);
