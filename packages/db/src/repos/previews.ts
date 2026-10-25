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
  type PreviewGatewayResolution,
  previewGatewayResolution,
  previewResumeCandidate,
  PreviewView,
  resolvePreviewBinding,
  selectPreviewTarget,
  type Service,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { Context, Crypto, DateTime, Effect, Layer, Schema } from "effect";

import { type MendDatabase, MendDB } from "../client.ts";
import {
  agentSessions,
  previewControls,
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
    /** Apply a deciding person's Stop or Start under the row's lock; answers the control after. */
    readonly changeControl: (
      id: PreviewId,
      intent: PreviewControlIntent,
    ) => Effect.Effect<PreviewControl>;
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
  }
>()("@mend/db/PreviewsRepo") {}

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

const targetsOf = (tx: Reader, worktreeId: WorktreeId) =>
  tx
    .select({
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
    .where(eq(agentSessions.worktreeId, worktreeId))
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          service: toService(row.service),
          liveAttempt: row.liveAttempt === null ? null : toSessionProcess(row.liveAttempt),
          recordedCommand: row.recordedCommand,
        })),
      ),
    );

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
        row.state === "owner-stopped"
          ? { _tag: "OwnerStopped", revision: row.revision, by: row.stoppedBy, at: row.stoppedAt }
          : { _tag: "Automatic", revision: row.revision },
      ).pipe(Effect.orDie);

const readControl = (tx: Reader, id: PreviewId) =>
  tx
    .select()
    .from(previewControls)
    .where(eq(previewControls.previewId, id))
    .pipe(Effect.flatMap(([row]) => controlOfRow(row)));

/** The Service's attempts newest first, each with whether a probe saw that attempt answer. */
const historyOf = (tx: Reader, service: Service) =>
  tx
    .select({
      attempt: sessionProcesses,
      // Spelled out: a single-table select renders its columns unqualified, which inside this
      // subquery would name the observation's own id.
      reachable: sql<boolean>`EXISTS (
        SELECT 1 FROM service_observations observed
        WHERE observed.attempt_id = session_processes.id AND observed.state = 'reachable'
      )`,
    })
    .from(sessionProcesses)
    .where(
      and(
        eq(sessionProcesses.serviceId, service.id),
        eq(sessionProcesses.sessionId, service.sessionId),
        eq(sessionProcesses.kind, "service"),
      ),
    )
    .orderBy(desc(sessionProcesses.createdAt), desc(sessionProcesses.id))
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({ attempt: toSessionProcess(row.attempt), reachable: row.reachable })),
      ),
    );

const readGatewaySnapshot = (tx: Reader, id: PreviewId) =>
  Effect.gen(function* () {
    const [row] = yield* tx.select().from(previews).where(eq(previews.id, id)).limit(1);
    if (row === undefined) return null;
    const preview = yield* decodePreview(row);
    const targets = preview.worktreeId === null ? [] : yield* targetsOf(tx, preview.worktreeId);
    const control = yield* readControl(tx, id);
    const selected = selectPreviewTarget(preview, targets);
    const candidate = previewResumeCandidate(selected);
    const history = candidate === null ? [] : yield* historyOf(tx, candidate);
    return { preview, resolution: previewGatewayResolution(control, selected, history) };
  });

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

      const changeControl = Effect.fn("PreviewsRepo.changeControl")(function* (
        id: PreviewId,
        intent: PreviewControlIntent,
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
            const next = changePreviewControl(current, intent);
            if (next === current) return current;
            yield* tx
              .update(previewControls)
              .set({
                revision: next.revision,
                ...(next._tag === "OwnerStopped"
                  ? { state: "owner-stopped", stoppedBy: next.by, stoppedAt: next.at }
                  : { state: "automatic", stoppedBy: null, stoppedAt: null }),
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

      const gatewaySnapshot = Effect.fn("PreviewsRepo.gatewaySnapshot")(function* (id: PreviewId) {
        return yield* snapshot((tx) => readGatewaySnapshot(tx, id));
      }, Effect.catchTags(queryErrorsDie));

      const gatewaySnapshots = Effect.fn("PreviewsRepo.gatewaySnapshots")(function* (
        ids: ReadonlyArray<PreviewId>,
      ) {
        return yield* snapshot((tx) =>
          Effect.gen(function* () {
            const read = new Map<PreviewId, PreviewGatewaySnapshot>();
            for (const id of new Set(ids)) {
              const found = yield* readGatewaySnapshot(tx, id);
              if (found !== null) read.set(id, found);
            }
            return read;
          }),
        );
      }, Effect.catchTags(queryErrorsDie));

      return {
        ensureForWorktree,
        resolveByLabel,
        byId,
        byLabel,
        controlOf,
        changeControl,
        previewOfService,
        gatewaySnapshot,
        gatewaySnapshots,
      };
    }),
  );
