import { WorktreesRepo } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { CaptureRuntime, stampOf, WorktreeReads } from "@mend/sessions";
import { type ChangeSummary, decodeChangeSummary, observedChangeSummaryKey } from "@mend/store";
import { Clock, Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { JobRunner } from "./job-runner.ts";

/**
 * The observed pass (ADR-0002 "Review", decision 14): a change summary the executor posted is
 * `claimed` until a runner recomputes it from the capture's git class. Equal → stamped
 * `observed`; different → the runner's answer replaces the posted one and is stamped
 * `observed`, with the disagreement logged as a fact. A summary whose capture is no longer the
 * chain head is left alone: the head moved, and the next checkpoint posts its own.
 */
export class SummaryObserveJob extends Schema.Class<SummaryObserveJob>("SummaryObserveJob")({
  worktreeId: WorktreeId,
  captureId: Schema.String,
}) {}

/** How long a purge waits for the observed summary's write: past its timeout, with room. */
const SUMMARY_PUT_TIMEOUT_MS = 5 * 60_000;
const SUMMARY_PUT_WINDOW_MS = 2 * SUMMARY_PUT_TIMEOUT_MS;

export type SummaryObserveOutcome =
  | { readonly outcome: "observed"; readonly agreed: boolean }
  | { readonly outcome: "skipped"; readonly reason: string };

export class SummaryObserver extends Context.Service<
  SummaryObserver,
  {
    readonly observe: (job: SummaryObserveJob) => Effect.Effect<SummaryObserveOutcome>;
  }
>()("@mend/jobs/SummaryObserver") {}

const sameSummary = (claimed: ChangeSummary, observed: ChangeSummary): boolean =>
  claimed.base_sha === observed.base_sha &&
  claimed.diff === observed.diff &&
  claimed.files.length === observed.files.length &&
  claimed.files.every((file, index) => {
    const other = observed.files[index];
    return (
      other !== undefined &&
      other.path === file.path &&
      other.additions === file.additions &&
      other.deletions === file.deletions
    );
  });

export const SummaryObserverLive: Layer.Layer<
  SummaryObserver,
  never,
  CaptureRuntime | WorktreeReads | WorktreesRepo
> = Layer.effect(
  SummaryObserver,
  Effect.gen(function* () {
    const capture = yield* CaptureRuntime;
    const reads = yield* WorktreeReads;
    const worktrees = yield* WorktreesRepo;

    const observe = Effect.fn("SummaryObserver.observe")(function* (job: SummaryObserveJob) {
      if (!capture.enabled) {
        return { outcome: "skipped", reason: "not in capture mode" } as const;
      }
      const chain = yield* capture.repo.headOf(job.worktreeId);
      if (chain?.head === null || chain?.head === undefined || chain.head.id !== job.captureId) {
        return { outcome: "skipped", reason: "the capture is no longer the chain head" } as const;
      }
      const head = chain.head;
      if (head.gitFsck === "failed") {
        return {
          outcome: "skipped",
          reason: "the capture's Git section failed verification",
        } as const;
      }
      const summaryRow = yield* capture.repo.summaryOf(job.captureId);
      if (summaryRow === null) {
        return { outcome: "skipped", reason: "no summary was posted for the capture" } as const;
      }
      const worktree = yield* worktrees
        .byId(job.worktreeId)
        .pipe(Effect.catchTag("WorktreeNotFoundError", () => Effect.succeed(null)));
      if (worktree === null) {
        return { outcome: "skipped", reason: "the worktree row is gone" } as const;
      }
      const claimed = yield* capture.blobs.get(summaryRow.key).pipe(
        Effect.flatMap((bytes) =>
          decodeChangeSummary(JSON.parse(Buffer.from(bytes).toString("utf8"))),
        ),
        Effect.option,
      );
      const diff = yield* reads
        .diffWorktree(worktree.projectId, worktree.id, worktree.baseSha)
        .pipe(Effect.orDie);
      const files = yield* reads
        .changedFiles(worktree.projectId, worktree.id, worktree.baseSha)
        .pipe(Effect.orDie);
      const stamps = [diff.stamp, files.stamp];
      const expectedStamp = stampOf(head);
      if (
        stamps.some(
          (stamp) =>
            stamp.source !== "capture" ||
            stamp.captureId !== job.captureId ||
            stamp.captureN !== expectedStamp.captureN ||
            stamp.seq !== expectedStamp.seq ||
            stamp.kind !== expectedStamp.kind ||
            stamp.partial !== expectedStamp.partial ||
            stamp.observedAt !== expectedStamp.observedAt,
        )
      ) {
        return {
          outcome: "skipped",
          reason: "the reads do not belong to the job capture",
        } as const;
      }
      const observed: ChangeSummary = {
        base_sha: worktree.baseSha,
        files: files.value.map((file) => ({
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
        })),
        diff: diff.value,
      };
      const agreed = claimed._tag === "Some" && sameSummary(claimed.value, observed);
      if (!agreed) {
        yield* Effect.logInfo("summary-observe: the posted summary differs from the runner's").pipe(
          Effect.annotateLogs({
            worktreeId: job.worktreeId,
            captureId: job.captureId,
            claimedFiles: claimed._tag === "Some" ? claimed.value.files.length : null,
            observedFiles: observed.files.length,
          }),
        );
      }
      // Agreement does not protect the posted key from a concurrent executor repost.
      const bytes = new Uint8Array(Buffer.from(JSON.stringify(observed), "utf8"));
      const key = observedChangeSummaryKey(job.worktreeId, head.n, bytes);
      // The write goes on record first, refused once the project is removed: a purge waits it
      // out, so its object never lands after the purge read what to delete.
      const admitted = yield* capture.repo.recordUploadWindow(
        job.worktreeId,
        new Date((yield* Clock.currentTimeMillis) + SUMMARY_PUT_WINDOW_MS),
      );
      if (!admitted) {
        return { outcome: "skipped", reason: "the project was removed" } as const;
      }
      yield* capture.blobs
        .put(key, bytes, { ifAbsent: true })
        .pipe(Effect.timeout(SUMMARY_PUT_TIMEOUT_MS), Effect.orDie);
      const published = yield* capture.repo.publishObservedSummary({
        worktreeId: job.worktreeId,
        captureId: job.captureId,
        baseSha: worktree.baseSha,
        key,
      });
      if (!published) {
        return { outcome: "skipped", reason: "the summary changed before publication" } as const;
      }
      return { outcome: "observed", agreed } as const;
    });

    return { observe };
  }),
);

const decodeJob = Schema.decodeUnknownEffect(SummaryObserveJob);

/** Register the worker; the handler dies into pg-boss retry like every other job. */
export const SummaryObserveWorkerLive: Layer.Layer<never, never, JobRunner | SummaryObserver> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const jobs = yield* JobRunner;
      const observer = yield* SummaryObserver;
      yield* jobs.work("summary-observe", (payload) =>
        decodeJob(payload).pipe(
          Effect.flatMap((job) => observer.observe(job)),
          Effect.asVoid,
          Effect.orDie,
        ),
      );
    }),
  );
