import {
  encodePreviewLabel,
  PreviewId,
  type PreviewLabel,
  type ServiceId,
  type WorktreeId,
} from "@mend/domain";
import {
  changePreviewControl,
  Preview,
  PREVIEW_CONTROL_INITIAL,
  PreviewControl,
  type PreviewControlIntent,
  type PreviewControlRead,
  type PreviewGatewayResolution,
  previewGatewayResolution,
  type PreviewAttemptEvidence,
  previewResumeCandidate,
  type PreviewTarget,
  PreviewView,
  resolvePreviewBinding,
  selectPreviewTarget,
  type Service,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect";

import { type MendDatabase, MendDB } from "../client.ts";
import {
  agentSessions,
  previewControls,
  previewPorts,
  previews,
  projects,
  services,
  sessionProcesses,
  worktrees,
} from "../schema/workbench.ts";
import { toService } from "./services.ts";
import { toSessionProcess } from "./session-processes.ts";
import { uniqueViolationConstraint } from "./unique-violation.ts";
import { WorktreeNotFoundError } from "./worktrees.ts";

export class PreviewsRepo extends Context.Service<
  PreviewsRepo,
  {
    readonly ensureForWorktree: (
      id: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<PreviewView>, WorktreeNotFoundError>;
    readonly resolveByLabel: (label: PreviewLabel) => Effect.Effect<PreviewView | null>;
    readonly byId: (id: PreviewId) => Effect.Effect<Preview | null>;
    readonly byLabel: (label: PreviewLabel) => Effect.Effect<Preview | null>;
    /** The preview's control; a preview with no row is `PREVIEW_CONTROL_INITIAL`. */
    readonly controlOf: (id: PreviewId) => Effect.Effect<PreviewControl>;
    /**
     * Apply a deciding person's Stop or Start under the row's lock; answers the control after. A
     * Stop takes its place in the order of intents there, so a Start placed before it never clears
     * it.
     */
    readonly changeControl: (
      id: PreviewId,
      intent: PreviewControlRequest,
    ) => Effect.Effect<PreviewControl>;
    /** A place in the order of intents, for a person's Start as it is asked. */
    readonly nextControlSeq: () => Effect.Effect<number>;
    /**
     * The kept preview of the Service's name in its session's worktree, only while its rule selects
     * this Service (binds it, or would resume it); never allocates one.
     */
    readonly previewOfService: (serviceId: ServiceId) => Effect.Effect<PreviewId | null>;
    /** What the gateway does with a request to the preview, read in one snapshot. */
    readonly gatewaySnapshot: (id: PreviewId) => Effect.Effect<PreviewGatewaySnapshot | null>;
    /** The same for many previews, all read in one snapshot; unknown ids are absent. */
    readonly gatewaySnapshots: (
      ids: ReadonlyArray<PreviewId>,
    ) => Effect.Effect<ReadonlyMap<PreviewId, PreviewGatewaySnapshot>>;
    /**
     * The kept preview's port on the tailnet default: the one it holds if `ports` has it, else the
     * first never used, else the least recently used port whose preview, removed or not, has had
     * no open connection for `TAILNET_PORT_QUIET_HOURS`. Idempotent, and serialized with every
     * other assignment, so concurrent opens agree. An assignment outside `ports` is released and
     * replaced.
     */
    readonly assignTailnetPort: (
      id: PreviewId,
      ports: ReadonlyArray<number>,
    ) => Effect.Effect<TailnetPortAssignment>;
    /** The ports the previews hold now, whatever set they came from; a preview with none is absent. */
    readonly tailnetPorts: (
      ids: ReadonlyArray<PreviewId>,
    ) => Effect.Effect<ReadonlyMap<PreviewId, number>>;
    readonly byTailnetPort: (port: number) => Effect.Effect<TailnetPortHolder | null>;
    /**
     * Stamps `port` used now if `id` still holds it, else answers Moved. Serialized with every
     * assignment, so an assignment after it finds the port in use, and one before it wins.
     */
    readonly renewTailnetPort: (port: number, id: PreviewId) => Effect.Effect<"Renewed" | "Moved">;
    /** A connection to each of these previews is open now: their ports were used. */
    readonly touchTailnetPorts: (ids: ReadonlyArray<PreviewId>) => Effect.Effect<void>;
    /** Whether `port` held another preview before it held `id`. */
    readonly tailnetPortReused: (port: number, id: PreviewId) => Effect.Effect<boolean>;
  }
>()("@mend/db/PreviewsRepo") {}

/**
 * How long a port's preview, removed or not, goes with no open connection before the port can go
 * to another preview (ADR 0017, decision 6). A page of the old
 * preview still open in a browser would otherwise run on the new preview's origin.
 */
export const TAILNET_PORT_QUIET_HOURS = 24;

/**
 * A connection is admitted without renewing its port's stamp while the stamp is younger than
 * this: the port is then at least 23 hours from any reclaim, and an open one is stamped each pass.
 */
export const TAILNET_PORT_RENEW_AFTER_HOURS = TAILNET_PORT_QUIET_HOURS / 24;

/** The preview on a port, and whether an admission renews the port before serving it. */
export interface TailnetPortHolder {
  readonly preview: Preview;
  readonly renewDue: boolean;
}

export type TailnetPortAssignment =
  | { readonly _tag: "Assigned"; readonly port: number }
  /** Every port was used within the quiet period; the first can go to another preview at `nextFreeAt`. */
  | { readonly _tag: "PoolFull"; readonly size: number; readonly nextFreeAt: Date }
  | { readonly _tag: "Removed" };

export type PreviewControlRequest =
  | Omit<Extract<PreviewControlIntent, { readonly _tag: "Stop" }>, "seq">
  | Extract<PreviewControlIntent, { readonly _tag: "Start" }>;

export interface PreviewGatewaySnapshot {
  readonly preview: Preview;
  readonly resolution: PreviewGatewayResolution;
}

type Reader = Pick<MendDatabase, "select">;

const decodePreview = (row: typeof previews.$inferSelect) =>
  Schema.decodeUnknownEffect(Preview)({
    ...row,
    state: row.worktreeId === null ? "removed" : "kept",
  }).pipe(Effect.orDie);

const targetsIn = (tx: Reader, worktreeIds: ReadonlyArray<WorktreeId>) =>
  tx
    .select({
      worktreeId: agentSessions.worktreeId,
      workspaceId: agentSessions.sealantWorkspaceId,
      service: services,
      liveAttempt: sessionProcesses,
      recordedCommand: sql<boolean>`EXISTS (
        SELECT 1 FROM session_processes recorded
        WHERE recorded.service_id = ${services.id}
          AND recorded.session_id = ${services.sessionId}
          AND recorded.kind = 'service'
          AND jsonb_array_length(recorded.argv) > 0
      )`,
    })
    .from(services)
    .innerJoin(agentSessions, eq(agentSessions.id, services.sessionId))
    .leftJoin(
      sessionProcesses,
      and(
        eq(sessionProcesses.serviceId, services.id),
        eq(sessionProcesses.sessionId, services.sessionId),
        eq(sessionProcesses.kind, "service"),
        isNull(sessionProcesses.exitedAt),
      ),
    )
    .where(inArray(agentSessions.worktreeId, [...worktreeIds]))
    .pipe(
      Effect.map((rows) => {
        const byWorktree = new Map<WorktreeId, Array<PreviewTarget>>();
        for (const row of rows) {
          const targets = byWorktree.get(row.worktreeId) ?? [];
          targets.push({
            service: toService(row.service),
            liveAttempt: row.liveAttempt === null ? null : toSessionProcess(row.liveAttempt),
            recordedCommand: row.recordedCommand,
            workspaceId: row.workspaceId,
          });
          byWorktree.set(row.worktreeId, targets);
        }
        return byWorktree;
      }),
    );

const targetsOf = (tx: Reader, worktreeId: WorktreeId) =>
  Effect.map(targetsIn(tx, [worktreeId]), (byWorktree) => byWorktree.get(worktreeId) ?? []);

const readPreviews = (tx: Reader, id: WorktreeId) =>
  Effect.gen(function* () {
    const [worktree] = yield* tx
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(eq(worktrees.id, id));
    if (worktree === undefined) return yield* new WorktreeNotFoundError({ id });
    const rows = yield* tx
      .select()
      .from(previews)
      .where(eq(previews.worktreeId, id))
      .orderBy(asc(previews.serviceName));
    const targets = yield* targetsOf(tx, id);
    const views = yield* Effect.forEach(rows, (row) =>
      Effect.map(decodePreview(row), (preview) =>
        PreviewView.make({ preview, binding: resolvePreviewBinding(preview, targets) }),
      ),
    );
    const named = new Set(rows.map((row) => row.serviceName));
    const unnamed = [
      ...new Set(
        targets.flatMap(({ service }) =>
          service.browserScheme === null || named.has(service.name) ? [] : [service.name],
        ),
      ),
    ].toSorted();
    return { views, unnamed };
  });

const controlOfRow = (row: typeof previewControls.$inferSelect | undefined) =>
  row === undefined
    ? Effect.succeed(PREVIEW_CONTROL_INITIAL)
    : Schema.decodeUnknownEffect(PreviewControl)(
        row.state === "stopped"
          ? {
              _tag: "Stopped",
              revision: row.revision,
              by: row.stoppedBy,
              at: row.stoppedAt,
              seq: row.stoppedSeq,
            }
          : { _tag: "Automatic", revision: row.revision },
      ).pipe(Effect.orDie);

const readControl = (tx: Reader, id: PreviewId) =>
  tx
    .select()
    .from(previewControls)
    .where(eq(previewControls.previewId, id))
    .pipe(Effect.flatMap(([row]) => controlOfRow(row)));

const historiesOf = (tx: Reader, candidates: ReadonlyArray<Service>) =>
  candidates.length === 0
    ? Effect.succeed(new Map<ServiceId, Array<PreviewAttemptEvidence>>())
    : tx
        .select()
        .from(sessionProcesses)
        .where(
          and(
            inArray(
              sessionProcesses.serviceId,
              candidates.map((service) => service.id),
            ),
            eq(sessionProcesses.kind, "service"),
          ),
        )
        .orderBy(desc(sessionProcesses.createdAt), desc(sessionProcesses.id))
        .pipe(
          Effect.map((rows) => {
            const sessionOf = new Map(candidates.map((service) => [service.id, service.sessionId]));
            const histories = new Map<ServiceId, Array<PreviewAttemptEvidence>>();
            for (const row of rows) {
              if (row.serviceId === null || sessionOf.get(row.serviceId) !== row.sessionId)
                continue;
              const history = histories.get(row.serviceId) ?? [];
              history.push({ attempt: toSessionProcess(row), reachable: row.reachedAt !== null });
              histories.set(row.serviceId, history);
            }
            return histories;
          }),
        );

const readGatewaySnapshots = (tx: Reader, ids: ReadonlyArray<PreviewId>) =>
  Effect.gen(function* () {
    const read = new Map<PreviewId, PreviewGatewaySnapshot>();
    if (ids.length === 0) return read;
    const rows = yield* tx
      .select({
        preview: previews,
        control: previewControls,
        byName: sql<string | null>`(select nullif(u.name, '') from "user" u
          where u.id = ${previewControls.stoppedBy})`,
      })
      .from(previews)
      .leftJoin(previewControls, eq(previewControls.previewId, previews.id))
      .where(inArray(previews.id, [...new Set(ids)]));
    const found = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const control = yield* controlOfRow(row.control ?? undefined);
        const named: PreviewControlRead =
          control._tag === "Stopped" ? { ...control, byName: row.byName ?? "a member" } : control;
        return { preview: yield* decodePreview(row.preview), control: named };
      }),
    );
    const worktreeIds = [
      ...new Set(
        found.flatMap(({ preview }) => (preview.worktreeId === null ? [] : [preview.worktreeId])),
      ),
    ];
    const targets = worktreeIds.length === 0 ? new Map() : yield* targetsIn(tx, worktreeIds);
    const selected = found.map(({ preview, control }) => {
      const selection = selectPreviewTarget(
        preview,
        preview.worktreeId === null ? [] : (targets.get(preview.worktreeId) ?? []),
      );
      return { preview, control, selection, candidate: previewResumeCandidate(selection) };
    });
    const histories = yield* historiesOf(
      tx,
      selected.flatMap(({ candidate }) => (candidate === null ? [] : [candidate])),
    );
    for (const { preview, control, selection, candidate } of selected) {
      const history = candidate === null ? [] : (histories.get(candidate.id) ?? []);
      read.set(preview.id, {
        preview,
        resolution: previewGatewayResolution(control, selection, history),
      });
    }
    return read;
  });

const takeSeq = (tx: Reader) =>
  tx
    .select({ seq: sql<number>`nextval('preview_control_seq')::integer` })
    .from(sql`(select 1) as one`)
    .pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.die("nextval answered no row") : Effect.succeed(row.seq),
      ),
    );

const queryErrorsDie = {
  EffectDrizzleQueryError: (error: unknown) => Effect.die(error),
  SqlError: (error: unknown) => Effect.die(error),
};

export const PreviewsRepoLive: Layer.Layer<PreviewsRepo, never, MendDB | Crypto.Crypto> =
  Layer.effect(
    PreviewsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;
      const crypto = yield* Crypto.Crypto;

      const snapshot = <A, E>(read: (tx: Reader) => Effect.Effect<A, E>) =>
        db.transaction(read, { isolationLevel: "repeatable read", accessMode: "read only" });

      const allocate = (id: WorktreeId, names: ReadonlyArray<string>) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Lock the parent first: a cascading project delete takes project then worktree.
              // Reversing that order can deadlock with the insert's project foreign-key check.
              const [parent] = yield* tx
                .select({ projectId: projects.id })
                .from(projects)
                .innerJoin(worktrees, eq(worktrees.projectId, projects.id))
                .where(eq(worktrees.id, id))
                .for("key share", { of: projects });
              const [worktree] = yield* tx
                .select({ id: worktrees.id })
                .from(worktrees)
                .where(eq(worktrees.id, id))
                .for("key share");
              if (parent === undefined || worktree === undefined) {
                return yield* new WorktreeNotFoundError({ id });
              }
              for (const name of names) {
                const bytes = yield* crypto.randomBytes(16).pipe(Effect.orDie);
                const previewId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
                yield* tx
                  .insert(previews)
                  .values({
                    id: PreviewId.make(previewId),
                    projectId: parent.projectId,
                    worktreeId: id,
                    serviceName: name,
                    label: encodePreviewLabel(bytes),
                  })
                  .onConflictDoNothing({ target: [previews.worktreeId, previews.serviceName] });
              }
            }),
          )
          .pipe(
            Effect.retry({
              times: 2,
              while: (error) => uniqueViolationConstraint(error) === "previews_label_key",
            }),
          );

      const ensureForWorktree = Effect.fn("PreviewsRepo.ensureForWorktree")(function* (
        id: WorktreeId,
      ) {
        const first = yield* snapshot((tx) => readPreviews(tx, id));
        if (first.unnamed.length === 0) return first.views;
        yield* allocate(id, first.unnamed);
        return (yield* snapshot((tx) => readPreviews(tx, id))).views;
      }, Effect.catchTags(queryErrorsDie));

      const resolveByLabel = Effect.fn("PreviewsRepo.resolveByLabel")(function* (
        label: PreviewLabel,
      ) {
        return yield* snapshot((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .select()
              .from(previews)
              .where(eq(previews.label, label))
              .limit(1);
            if (row === undefined) return null;
            const preview = yield* decodePreview(row);
            const targets =
              preview.worktreeId === null ? [] : yield* targetsOf(tx, preview.worktreeId);
            return PreviewView.make({ preview, binding: resolvePreviewBinding(preview, targets) });
          }),
        );
      }, Effect.catchTags(queryErrorsDie));

      const rowWhere = (where: SQL) =>
        db
          .select()
          .from(previews)
          .where(where)
          .limit(1)
          .pipe(
            Effect.orDie,
            Effect.flatMap(([row]) =>
              row === undefined ? Effect.succeed(null) : decodePreview(row),
            ),
          );

      const byId = Effect.fn("PreviewsRepo.byId")(function* (id: PreviewId) {
        return yield* rowWhere(eq(previews.id, id));
      });

      const byLabel = Effect.fn("PreviewsRepo.byLabel")(function* (label: PreviewLabel) {
        return yield* rowWhere(eq(previews.label, label));
      });

      const controlOf = Effect.fn("PreviewsRepo.controlOf")(function* (id: PreviewId) {
        return yield* readControl(db, id).pipe(Effect.orDie);
      });

      const nextControlSeq = () => takeSeq(db).pipe(Effect.orDie);

      const changeControl = Effect.fn("PreviewsRepo.changeControl")(function* (
        id: PreviewId,
        request: PreviewControlRequest,
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .insert(previewControls)
              .values({ previewId: id, state: "automatic" })
              .onConflictDoNothing({ target: previewControls.previewId });
            const [row] = yield* tx
              .select()
              .from(previewControls)
              .where(eq(previewControls.previewId, id))
              .for("update");
            const current = yield* controlOfRow(row);
            const intent: PreviewControlIntent =
              request._tag === "Stop" ? { ...request, seq: yield* takeSeq(tx) } : request;
            const next = changePreviewControl(current, intent);
            if (next === current) return current;
            yield* tx
              .update(previewControls)
              .set({
                revision: next.revision,
                ...(next._tag === "Stopped"
                  ? {
                      state: "stopped",
                      stoppedBy: next.by,
                      stoppedAt: next.at,
                      stoppedSeq: next.seq,
                    }
                  : { state: "automatic", stoppedBy: null, stoppedAt: null, stoppedSeq: null }),
                updatedAt: yield* DateTime.nowAsDate,
              })
              .where(eq(previewControls.previewId, id));
            return next;
          }),
        );
      }, Effect.catchTags(queryErrorsDie));

      const previewOfService = Effect.fn("PreviewsRepo.previewOfService")(function* (
        serviceId: ServiceId,
      ) {
        return yield* snapshot((tx) =>
          Effect.gen(function* () {
            const [row] = yield* tx
              .select({ preview: previews })
              .from(services)
              .innerJoin(agentSessions, eq(agentSessions.id, services.sessionId))
              .innerJoin(
                previews,
                and(
                  eq(previews.worktreeId, agentSessions.worktreeId),
                  eq(previews.serviceName, services.name),
                ),
              )
              .where(eq(services.id, serviceId))
              .limit(1);
            if (row === undefined) return null;
            const preview = yield* decodePreview(row.preview);
            if (preview.worktreeId === null) return null;
            const selected = selectPreviewTarget(preview, yield* targetsOf(tx, preview.worktreeId));
            return selected.service?.id === serviceId ? preview.id : null;
          }),
        );
      }, Effect.catchTags(queryErrorsDie));

      const gatewaySnapshots = Effect.fn("PreviewsRepo.gatewaySnapshots")(function* (
        ids: ReadonlyArray<PreviewId>,
      ) {
        return yield* snapshot((tx) => readGatewaySnapshots(tx, ids));
      }, Effect.catchTags(queryErrorsDie));

      const gatewaySnapshot = Effect.fn("PreviewsRepo.gatewaySnapshot")(function* (id: PreviewId) {
        return (yield* gatewaySnapshots([id])).get(id) ?? null;
      });

      const assignTailnetPort = Effect.fn("PreviewsRepo.assignTailnetPort")(function* (
        id: PreviewId,
        ports: ReadonlyArray<number>,
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`select pg_advisory_xact_lock(hashtext('mend:preview-ports'))`);
            // Held until commit, so a removal of this preview waits and its trigger then frees
            // the port this transaction gave it.
            const [kept] = yield* tx
              .select({ id: previews.id })
              .from(previews)
              .where(and(eq(previews.id, id), isNotNull(previews.worktreeId)))
              .for("share");
            if (kept === undefined) return { _tag: "Removed" } satisfies TailnetPortAssignment;
            const [held] = yield* tx
              .select({ port: previewPorts.port })
              .from(previewPorts)
              .where(eq(previewPorts.previewId, id));
            if (held !== undefined) {
              if (ports.includes(held.port)) {
                return { _tag: "Assigned", port: held.port } satisfies TailnetPortAssignment;
              }
              yield* tx
                .update(previewPorts)
                .set({ previewId: null, releasedAt: sql`now()` })
                .where(eq(previewPorts.port, held.port));
            }
            const inSet = inArray(previewPorts.port, [...ports]);
            const known = new Set(
              (yield* tx.select({ port: previewPorts.port }).from(previewPorts).where(inSet)).map(
                (row) => row.port,
              ),
            );
            const fresh = ports.find((port) => !known.has(port));
            if (fresh !== undefined) {
              yield* tx.insert(previewPorts).values({
                port: fresh,
                previewId: id,
                assignedAt: sql`now()`,
                lastUsedAt: sql`now()`,
              });
              return { _tag: "Assigned", port: fresh } satisfies TailnetPortAssignment;
            }
            // Removal ends every open connection, so a removed preview's quiet starts then.
            const quietSince = sql`GREATEST(${previewPorts.lastUsedAt}, COALESCE(${previewPorts.releasedAt}, ${previewPorts.lastUsedAt}))`;
            const quietEnds = sql<Date>`${quietSince} + make_interval(hours => ${TAILNET_PORT_QUIET_HOURS})`;
            const [quiet] = yield* tx
              .select({ port: previewPorts.port })
              .from(previewPorts)
              .where(and(inSet, sql`${quietEnds} <= now()`))
              .orderBy(asc(previewPorts.lastUsedAt), asc(previewPorts.port))
              .limit(1);
            if (quiet === undefined) {
              const [next] = yield* tx
                .select({ at: sql<Date>`min(${quietEnds})`.mapWith(previewPorts.lastUsedAt) })
                .from(previewPorts)
                .where(inSet);
              if (next === undefined) return yield* Effect.die("an empty preview port set");
              return {
                _tag: "PoolFull",
                size: ports.length,
                nextFreeAt: next.at,
              } satisfies TailnetPortAssignment;
            }
            yield* tx
              .update(previewPorts)
              .set({
                previewId: id,
                assignedAt: sql`now()`,
                releasedAt: null,
                lastUsedAt: sql`now()`,
                reused: true,
              })
              .where(eq(previewPorts.port, quiet.port));
            return { _tag: "Assigned", port: quiet.port } satisfies TailnetPortAssignment;
          }),
        );
      }, Effect.catchTags(queryErrorsDie));

      const touchTailnetPorts = Effect.fn("PreviewsRepo.touchTailnetPorts")(function* (
        ids: ReadonlyArray<PreviewId>,
      ) {
        if (ids.length === 0) return;
        yield* db
          .update(previewPorts)
          .set({ lastUsedAt: sql`now()` })
          .where(inArray(previewPorts.previewId, [...new Set(ids)]));
      }, Effect.orDie);

      const tailnetPortReused = Effect.fn("PreviewsRepo.tailnetPortReused")(function* (
        port: number,
        id: PreviewId,
      ) {
        const [row] = yield* db
          .select({ reused: previewPorts.reused })
          .from(previewPorts)
          .where(and(eq(previewPorts.port, port), eq(previewPorts.previewId, id)));
        return row?.reused ?? false;
      }, Effect.orDie);

      const tailnetPorts = Effect.fn("PreviewsRepo.tailnetPorts")(function* (
        ids: ReadonlyArray<PreviewId>,
      ) {
        if (ids.length === 0) return new Map<PreviewId, number>();
        const rows = yield* db
          .select({ previewId: previewPorts.previewId, port: previewPorts.port })
          .from(previewPorts)
          .where(inArray(previewPorts.previewId, [...new Set(ids)]));
        return new Map(
          rows.flatMap((row) => (row.previewId === null ? [] : [[row.previewId, row.port]])),
        );
      }, Effect.orDie);

      const byTailnetPort = Effect.fn("PreviewsRepo.byTailnetPort")(function* (port: number) {
        const [row] = yield* db
          .select({
            preview: previews,
            renewDue: sql<boolean>`${previewPorts.lastUsedAt} <= now() - make_interval(hours => ${TAILNET_PORT_RENEW_AFTER_HOURS})`,
          })
          .from(previewPorts)
          .innerJoin(previews, eq(previews.id, previewPorts.previewId))
          .where(eq(previewPorts.port, port))
          .limit(1);
        if (row === undefined) return null;
        return {
          preview: yield* decodePreview(row.preview),
          renewDue: row.renewDue,
        } satisfies TailnetPortHolder;
      }, Effect.orDie);

      const renewTailnetPort = Effect.fn("PreviewsRepo.renewTailnetPort")(function* (
        port: number,
        id: PreviewId,
      ) {
        return yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.execute(sql`select pg_advisory_xact_lock(hashtext('mend:preview-ports'))`);
            const renewed = yield* tx
              .update(previewPorts)
              .set({ lastUsedAt: sql`now()` })
              .where(and(eq(previewPorts.port, port), eq(previewPorts.previewId, id)))
              .returning({ port: previewPorts.port });
            return renewed.length === 0 ? "Moved" : "Renewed";
          }),
        );
      }, Effect.orDie);

      return {
        assignTailnetPort,
        tailnetPorts,
        byTailnetPort,
        renewTailnetPort,
        touchTailnetPorts,
        tailnetPortReused,
        ensureForWorktree,
        resolveByLabel,
        byId,
        byLabel,
        controlOf,
        changeControl,
        nextControlSeq,
        previewOfService,
        gatewaySnapshot,
        gatewaySnapshots,
      };
    }),
  );
