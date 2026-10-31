import type { ClientRequest } from "node:http";
import type { Duplex } from "node:stream";

import type { PreviewId } from "@mend/domain";
import type { PreviewBoundAttempt, PreviewGatewayResolution } from "@mend/domain/workbench";
import { asSealantUser, ForwardSessionOwner } from "@mend/sealant";
import {
  ForwardAdapter,
  ForwardAgent,
  ForwardRefusedError,
  ForwardSocket,
  type ForwardSocketConnect,
  type ForwardTarget,
  forwardSockets,
  WorkspaceCaller,
} from "@mend/sessions";
import { Cause, Effect, Option, type Scope } from "effect";

import { ceilingMessage, overCeiling } from "./budgets.ts";
import type { BusSignal } from "./events-bus.ts";
import {
  budgetPage,
  CEILING_RETRY_SECONDS,
  DIAL_DISPOSITION,
  notDelivered,
} from "./preview-headers.ts";
import { PreviewNotFound } from "./preview-identity.ts";
import type { ForwardLease } from "./preview-relay.ts";
import { gatewayPage, type PreviewAnswer, refusalAnswer } from "./preview-requests.ts";
import { PreviewTargets } from "./preview-targets.ts";

/** Dev servers close idle keep-alive connections after about 5 s (Node's `keepAliveTimeout`). */
const POOL = { maxSockets: 6, maxFreeSockets: 2, freeSocketMs: 4_000, idleMs: 10_000 } as const;

export type BoundResolution = Extract<PreviewGatewayResolution, { readonly _tag: "Bound" }>;

export interface Generation {
  readonly key: string;
  readonly attempt: PreviewBoundAttempt;
}

export const generationOf = (bound: BoundResolution): Generation => ({
  key: `${bound.revision}:${bound.attempt.attemptId}`,
  attempt: bound.attempt,
});

interface Pool {
  readonly key: string;
  readonly viewerId: string;
  readonly generation: Generation;
  readonly open: () => ForwardSocket;
  readonly agent: ForwardAgent;
  readonly requests: Set<ClientRequest>;
  /** A Node `Agent` forgets a socket once it is upgraded. */
  readonly upgraded: Set<Duplex>;
  leases: number;
  closed: boolean;
  idle: NodeJS.Timeout | null;
}

interface Entry {
  readonly previewId: PreviewId;
  readonly projectId: string;
  readonly serviceName: string;
  readonly pools: Map<string, Pool>;
  resolution: PreviewGatewayResolution | null;
  users: number;
}

export interface PreviewOpen {
  readonly id: PreviewId;
  readonly projectId: string;
  readonly serviceName: string;
}

export interface PreviewEntry {
  readonly resolution: () => PreviewGatewayResolution | null;
  readonly remember: (resolution: PreviewGatewayResolution | null) => void;
  readonly lease: (
    generation: Generation,
    viewerId: string,
  ) => Effect.Effect<ForwardLease, never, Scope.Scope>;
  readonly closeViewerPool: (generation: Generation, viewerId: string) => void;
}

export interface PreviewPools {
  /** End an idle binding, including its hot-reload sockets. */
  readonly closePreview: (id: PreviewId) => void;
  readonly enter: (preview: PreviewOpen) => Effect.Effect<PreviewEntry, never, Scope.Scope>;
  readonly onSignal: (signal: BusSignal) => Effect.Effect<void>;
  readonly refreshAll: Effect.Effect<void>;
  readonly recheckAllLending: Effect.Effect<void>;
  readonly closeAll: () => void;
}

class ForwardCeilingReached extends Error {}

const refusedSocket = (error: Error): ForwardSocket => {
  const socket = new ForwardSocket();
  setImmediate(() => socket.destroy(error));
  return socket;
};

const poolKey = (generation: Generation, viewerId: string) => `${generation.key}\u0000${viewerId}`;

const NOT_FOUND = refusalAnswer(new PreviewNotFound());

const logged = (message: string, cause: Cause.Cause<unknown>) =>
  Effect.logError(message).pipe(Effect.annotateLogs({ cause: Cause.pretty(cause) }));

export const makePreviewPools = (forwardCeiling: number) =>
  Effect.gen(function* () {
    const targets = yield* PreviewTargets;
    const caller = yield* WorkspaceCaller;
    const forwarding = yield* Effect.context<ForwardAdapter>();
    const entries = new Map<PreviewId, Entry>();
    let openForwards = 0;

    const retain = (entry: Entry) => {
      if (entry.users > 0 || entry.pools.size > 0) return;
      if (entries.get(entry.previewId) === entry) entries.delete(entry.previewId);
    };

    const closePool = (entry: Entry, pool: Pool) => {
      if (pool.closed) return;
      pool.closed = true;
      if (pool.idle !== null) clearTimeout(pool.idle);
      if (entry.pools.get(pool.key) === pool) entry.pools.delete(pool.key);
      for (const request of pool.requests) request.destroy();
      for (const socket of pool.upgraded) socket.destroy();
      pool.agent.destroy();
      retain(entry);
    };

    const settlePool = (entry: Entry, pool: Pool) => {
      if (pool.closed || pool.idle !== null) return;
      if (pool.leases > 0 || pool.requests.size > 0 || pool.upgraded.size > 0) return;
      pool.idle = setTimeout(() => closePool(entry, pool), POOL.idleMs);
      pool.idle.unref();
    };

    const dial = (pool: Pool, connect: ForwardSocketConnect, target: ForwardTarget) => {
      if (pool.closed) return refusedSocket(new Error("the preview's attempt changed"));
      if (overCeiling(openForwards, forwardCeiling)) {
        return refusedSocket(new ForwardCeilingReached());
      }
      openForwards += 1;
      const socket = connect(target, { purpose: "preview" });
      socket.once("close", () => {
        openForwards -= 1;
      });
      // Registered before Node's request waits on `connect` to write: a late dial from a closed
      // generation never carries a request.
      socket.once("connect", () => {
        if (pool.closed) socket.destroy();
      });
      return socket;
    };

    const poolFor = (entry: Entry, generation: Generation, viewerId: string): Pool => {
      const key = poolKey(generation, viewerId);
      const known = entry.pools.get(key);
      if (known !== undefined && !known.closed) return known;
      const { attempt } = generation;
      const target: ForwardTarget = {
        workspaceId: attempt.workspaceId,
        port: attempt.port,
        binding:
          attempt.dial === "port-scoped"
            ? { kind: "port" }
            : { kind: "session", session: ForwardSessionOwner.make(attempt.platformSessionId) },
      };
      const connect = Effect.runSyncWith(forwarding)(asSealantUser(viewerId)(forwardSockets));
      const open = () => dial(pool, connect, target);
      const pool: Pool = {
        key,
        viewerId,
        generation,
        open,
        // The Agent's timeout destroys a socket only while it is free: an active SSE stream in a
        // long gap keeps its forward.
        agent: new ForwardAgent(open, {
          maxSockets: POOL.maxSockets,
          maxFreeSockets: POOL.maxFreeSockets,
          timeout: POOL.freeSocketMs,
        }),
        requests: new Set(),
        upgraded: new Set(),
        leases: 0,
        closed: false,
        idle: null,
      };
      entry.pools.set(key, pool);
      return pool;
    };

    const refusalOf = (entry: Entry, pool: Pool, error: Error): PreviewAnswer => {
      if (error instanceof ForwardCeilingReached) {
        return budgetPage(
          ceilingMessage(forwardCeiling, "open forwards across previews"),
          CEILING_RETRY_SECONDS,
        );
      }
      if (pool.closed) {
        return gatewayPage(503, notDelivered(entry.serviceName, "the preview restarted"));
      }
      if (!(error instanceof ForwardRefusedError)) {
        return gatewayPage(502, notDelivered(entry.serviceName, "the forward failed"));
      }
      const disposition = DIAL_DISPOSITION[error.record.issue.reason];
      if (disposition._tag === "NotLent") {
        closePool(entry, pool);
        return NOT_FOUND;
      }
      return gatewayPage(disposition.status, notDelivered(entry.serviceName, disposition.fact));
    };

    const leaseOf = (entry: Entry, pool: Pool): ForwardLease => ({
      agent: pool.agent,
      dialOwn: pool.open,
      closed: () => pool.closed,
      track: (request) => {
        pool.requests.add(request);
        return () => {
          pool.requests.delete(request);
          settlePool(entry, pool);
        };
      },
      holdUpgraded: (socket) => {
        pool.upgraded.add(socket);
        return () => {
          pool.upgraded.delete(socket);
          settlePool(entry, pool);
        };
      },
      refusal: (error) => refusalOf(entry, pool, error),
    });

    const entryHandle = (entry: Entry): PreviewEntry => ({
      resolution: () => entry.resolution,
      remember: (resolution) => {
        entry.resolution = resolution;
      },
      lease: (generation, viewerId) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const pool = poolFor(entry, generation, viewerId);
            pool.leases += 1;
            if (pool.idle !== null) clearTimeout(pool.idle);
            pool.idle = null;
            return pool;
          }),
          (pool) =>
            Effect.sync(() => {
              pool.leases -= 1;
              settlePool(entry, pool);
            }),
        ).pipe(Effect.map((pool) => leaseOf(entry, pool))),
      closeViewerPool: (generation, viewerId) => {
        const pool = entry.pools.get(poolKey(generation, viewerId));
        if (pool !== undefined) closePool(entry, pool);
      },
    });

    const enter = (preview: PreviewOpen) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const known = entries.get(preview.id);
          const entry: Entry = known ?? {
            previewId: preview.id,
            projectId: preview.projectId,
            serviceName: preview.serviceName,
            pools: new Map(),
            resolution: null,
            users: 0,
          };
          entries.set(preview.id, entry);
          entry.users += 1;
          return entry;
        }),
        (entry) =>
          Effect.sync(() => {
            entry.users -= 1;
            retain(entry);
          }),
      ).pipe(Effect.map(entryHandle));

    const refresh = (selected: ReadonlyArray<Entry>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (selected.length === 0) return;
        const read = yield* targets.snapshots(selected.map((entry) => entry.previewId)).pipe(
          Effect.map(Option.some),
          Effect.catchDefect((defect) =>
            logged("preview gateway: bindings could not be read", Cause.die(defect)).pipe(
              Effect.as(Option.none()),
            ),
          ),
        );
        if (Option.isNone(read)) return;
        for (const entry of selected) {
          const resolution = read.value.get(entry.previewId) ?? null;
          entry.resolution = resolution;
          const current = resolution?._tag === "Bound" ? generationOf(resolution).key : null;
          for (const pool of entry.pools.values()) {
            if (pool.generation.key !== current) closePool(entry, pool);
          }
          retain(entry);
        }
      });

    const recheckLending = (selected: (pool: Pool) => boolean): Effect.Effect<void> =>
      Effect.suspend(() =>
        Effect.forEach(
          [...entries.values()].flatMap((entry) =>
            [...entry.pools.values()].filter(selected).map((pool) => ({ entry, pool })),
          ),
          ({ entry, pool }) =>
            asSealantUser(pool.viewerId)(caller.mayAct(pool.generation.attempt.workspaceId)).pipe(
              Effect.catch(() => Effect.sync(() => closePool(entry, pool))),
            ),
          { concurrency: 4, discard: true },
        ),
      );

    const onSignal = (signal: BusSignal): Effect.Effect<void> => {
      if (signal.kind === "resync") return refresh([...entries.values()]);
      const { event } = signal;
      switch (event.type) {
        case "worktree":
        case "project": {
          const { projectId } = event;
          return refresh([...entries.values()].filter((entry) => entry.projectId === projectId));
        }
        case "user": {
          const { userId } = event;
          return recheckLending((pool) => pool.viewerId === userId);
        }
        case "organization":
          return recheckLending(() => true);
        default:
          return Effect.void;
      }
    };

    return {
      closePreview: (id) => {
        const entry = entries.get(id);
        if (entry === undefined) return;
        entry.resolution = null;
        for (const pool of entry.pools.values()) closePool(entry, pool);
      },
      enter,
      onSignal,
      refreshAll: Effect.suspend(() => refresh([...entries.values()])),
      recheckAllLending: recheckLending(() => true),
      closeAll: () => {
        for (const entry of entries.values()) {
          for (const pool of entry.pools.values()) closePool(entry, pool);
        }
      },
    } satisfies PreviewPools;
  });
