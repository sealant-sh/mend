import { encodePreviewLabel, PreviewId, type PreviewLabel, type WorktreeId } from "@mend/domain";
import { Preview, PreviewView, resolvePreviewBinding } from "@mend/domain/workbench";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Context, Crypto, Effect, Layer, Schema } from "effect";

import { type MendDatabase, MendDB } from "../client.ts";
import {
  agentSessions,
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
  }
>()("@mend/db/PreviewsRepo") {}

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

      return { ensureForWorktree, resolveByLabel };
    }),
  );
