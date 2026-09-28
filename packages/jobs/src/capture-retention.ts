import type { CaptureRow, PackRow } from "@mend/db";
import { WorktreeId } from "@mend/domain";
import { CaptureRuntime, PRESIGN_TTL_SECONDS } from "@mend/sessions";
import { captureKeyOwner, keysOfSections, packIdxKeyOf, treePrefixesOfSections } from "@mend/store";
import { Duration, Effect, Layer, Schedule } from "effect";
import * as Context from "effect/Context";

/**
 * Retention and compaction (ADR-0002 "Retention and compaction"):
 *
 * - `checkpoint | suspend | final` captures live for the session's life; `auto | turn` are
 *   thinned — every one for 24 h, then one per hour, then none past 7 days (checkpoints only).
 * - Liveness is computed from `captures` rows reachable from the chain head — never from
 *   objects found in the bucket. A pack no remaining row names retires through the `packs`
 *   table after the 30 min grace (15 min URL TTL + 5 min materialise budget, rounded up), and
 *   its bytes go. Mend-made packs under `projects/<project>/packs/` (base packs, derived
 *   checkpoint commits) are referenced by refs, not captures, and never retire here.
 * - A fenced epoch prefix (`captures/<worktree>/<epoch>/` with `epoch` below the head's) is
 *   swept of everything no on-chain row references, once the head has stood for the grace
 *   period: a manifest whose CAS never ran is off-chain by definition.
 * - A row references what every one of its sections names, `other_bulk` included (sealantd PR
 *   #101): another platform's dependency tree is built under an epoch that is fenced as soon as
 *   the session moves, and is carried from capture to capture so that platform can restore it.
 *
 * - Nothing is deleted on a stale read. A chain's guard is read before its rows; what the pass
 *   would delete is tombstoned in one statement that lands only while that guard still reads
 *   so (`CaptureStoreRepo.condemn`), and only then retired and removed. A register that named
 *   any of it in between bumped the guard, and the chain keeps everything until the next pass;
 *   a register after it finds the tombstones and is refused (ADR-0002 decision 30). The grace
 *   protects uploads in flight; it was never protection against a new reference.
 *
 * - An open multipart upload nobody completed (an executor died between its part PUTs and
 *   `upload.complete`, or under a fenced epoch, where no complete can ever pass the lease
 *   predicate) is aborted once its part URLs have lapsed: the TTL plus the grace, or at once
 *   when its epoch is below the head's.
 *
 * CDC pack rewriting when live bytes fall below a threshold is a later slice; this pass only
 * ever removes whole objects.
 */

export const RETENTION_GRACE_MS = 30 * 60 * 1000;
export const KEEP_ALL_MS = 24 * 60 * 60 * 1000;
export const KEEP_HOURLY_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const RETENTION_INTERVAL = Duration.hours(1);
/** An open multipart upload older than this is an orphan: its part URLs have all lapsed. */
export const MULTIPART_ORPHAN_MS = PRESIGN_TTL_SECONDS * 1000 + RETENTION_GRACE_MS;

export interface RetentionReport {
  readonly chains: number;
  readonly capturesThinned: number;
  readonly packsRetired: number;
  readonly objectsRemoved: number;
  readonly multipartAborted: number;
}

export class CaptureRetention extends Context.Service<
  CaptureRetention,
  {
    /** One pass over every chain; `now` is injectable for tests. */
    readonly run: (now?: number) => Effect.Effect<RetentionReport>;
  }
>()("@mend/jobs/CaptureRetention") {}

const THINNED_KINDS = new Set(["auto", "turn"]);

/** Which of a chain's rows to drop, by the thinning schedule. The head is never a candidate. */
export const thinningPlan = (
  rows: ReadonlyArray<CaptureRow>,
  headId: string | null,
  now: number,
): ReadonlyArray<CaptureRow> => {
  const drop: Array<CaptureRow> = [];
  const keptHourly = new Set<number>();
  // Newest first so the newest capture of each hour bucket is the one kept.
  for (const row of rows.toSorted((a, b) => b.n - a.n)) {
    if (row.id === headId || !THINNED_KINDS.has(row.kind)) continue;
    const age = now - row.createdAt.getTime();
    if (age < KEEP_ALL_MS) continue;
    if (age >= KEEP_HOURLY_MS) {
      drop.push(row);
      continue;
    }
    const bucket = Math.floor(row.createdAt.getTime() / HOUR_MS);
    if (keptHourly.has(bucket)) drop.push(row);
    else keptHourly.add(bucket);
  }
  return drop;
};

/** What a row names (moved beside the capture format; register reads it too). */
export { keysOfSections, treePrefixesOfSections };

const treePrefixOf = (key: string): string | null => {
  const at = key.lastIndexOf("/trees/");
  return at < 0 ? null : key.slice(0, at + "/trees/".length);
};

const epochOfKey = (worktreeId: string, key: string): number | null => {
  const match = new RegExp(`^captures/${worktreeId}/(\\d+)/`).exec(key);
  return match?.[1] === undefined ? null : Number(match[1]);
};

export const CaptureRetentionLive: Layer.Layer<CaptureRetention, never, CaptureRuntime> =
  Layer.effect(
    CaptureRetention,
    Effect.gen(function* () {
      const capture = yield* CaptureRuntime;

      const run = Effect.fn("CaptureRetention.run")(function* (now: number = Date.now()) {
        const report = {
          chains: 0,
          capturesThinned: 0,
          packsRetired: 0,
          objectsRemoved: 0,
          multipartAborted: 0,
        };
        if (!capture.enabled) return report;
        const { repo, blobs } = capture;
        /** Remove one object; false (logged) when the store refused. */
        const remove = (key: string) =>
          blobs.remove(key).pipe(
            Effect.tap(() => Effect.sync(() => (report.objectsRemoved += 1))),
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning("capture retention: object removal failed").pipe(
                Effect.annotateLogs({ key, error: String(error) }),
                Effect.as(false),
              ),
            ),
          );

        // 1. Thin every chain; the head and the kept kinds stay by rule, and the SQL refuses
        //    the head regardless of what this pass computed. Each chain's guard is read before
        //    its rows: a register that lands after that read bumps it, and step 4 then
        //    condemns nothing of that chain this pass.
        const live = new Set<string>();
        const liveTreePrefixes = new Set<string>();
        const chains = yield* repo.listChains();
        const guards = new Map<string, number>();
        const headsByWorktree = new Map<WorktreeId, CaptureRow | null>();
        for (const chain of chains) {
          report.chains += 1;
          guards.set(chain.worktreeId, chain.guard);
          const rows = yield* repo.listChain(chain.worktreeId);
          const drop = thinningPlan(rows, chain.headCapture, now);
          if (drop.length > 0) {
            const removed = yield* repo.deleteCaptures(
              chain.worktreeId,
              drop.map((row) => row.id),
            );
            report.capturesThinned += removed;
            for (const row of drop) yield* remove(row.manifestKey);
          }
          const dropped = new Set(drop.map((row) => row.id));
          for (const row of rows) {
            if (dropped.has(row.id)) continue;
            live.add(row.manifestKey);
            for (const key of keysOfSections(row.sections)) live.add(key);
            for (const prefix of treePrefixesOfSections(row.sections)) liveTreePrefixes.add(prefix);
          }
          headsByWorktree.set(
            chain.worktreeId,
            rows.find((row) => row.id === chain.headCapture) ?? null,
          );
        }

        // What each chain's pass would delete, by the chain its keys belong to. `keys` are the
        // objects; `condemned` adds the `trees/` prefixes whose objects go (a register names a
        // format-1 root, not the dir objects below it).
        const doomed = new Map<
          string,
          { keys: Array<string>; condemned: Set<string>; retire: Array<PackRow> }
        >();
        const doomedOf = (owner: string) => {
          const found = doomed.get(owner);
          if (found !== undefined) return found;
          const fresh = { keys: [], condemned: new Set<string>(), retire: [] };
          doomed.set(owner, fresh);
          return fresh;
        };

        // 2. Packs no remaining row names, after the grace.
        const packs = yield* repo.listPacks();
        for (const pack of packs) {
          if (pack.state === "retired") continue;
          if (!pack.key.startsWith("captures/")) continue;
          if (live.has(pack.key)) continue;
          if (now - pack.createdAt.getTime() < RETENTION_GRACE_MS) continue;
          const owner = captureKeyOwner(pack.key);
          if (owner === null) continue;
          const plan = doomedOf(owner);
          plan.retire.push(pack);
          plan.keys.push(pack.key);
          plan.condemned.add(pack.key);
          // The index goes with its pack; the pack's tombstone stands for both.
          if (pack.class === "git") plan.keys.push(packIdxKeyOf(pack.key));
        }

        // 3. Fenced epoch prefixes, swept of everything off-chain once the head has stood for
        //    the grace period (every URL minted for the fenced epoch has lapsed by then).
        //    Recorded packs are step 2's: they retire through their row, never from a listing.
        const tracked = new Set<string>();
        for (const pack of packs) {
          if (pack.state === "retired") continue;
          tracked.add(pack.key);
          if (pack.class === "git") tracked.add(packIdxKeyOf(pack.key));
        }
        for (const [worktreeId, head] of headsByWorktree) {
          if (head === null || now - head.createdAt.getTime() < RETENTION_GRACE_MS) continue;
          const entries = yield* blobs
            .list(`captures/${worktreeId}/`)
            .pipe(Effect.catch(() => Effect.succeed([])));
          for (const entry of entries) {
            const epoch = epochOfKey(worktreeId, entry.key);
            if (epoch === null || epoch >= head.epoch) continue;
            if (live.has(entry.key) || tracked.has(entry.key)) continue;
            // A format-1 dir object below a live root: only the root is named by the row.
            const treePrefix = treePrefixOf(entry.key);
            if (treePrefix !== null && liveTreePrefixes.has(treePrefix)) continue;
            const plan = doomedOf(worktreeId);
            plan.keys.push(entry.key);
            // A `.idx` goes with its pack: a register names the pack, never the index.
            plan.condemned.add(entry.key.replace(/\.idx$/, ""));
            if (treePrefix !== null) plan.condemned.add(treePrefix);
          }
        }

        // 4. Condemn, then delete: a chain's objects are tombstoned while its guard still reads
        //    what step 1 read — no register named anything of it since — and only then retired
        //    (rows first, bytes second, so a crash between the two leaves a retired row and a
        //    stray object, never the reverse). A register that read the guard before this
        //    misses its CAS and reads again; one after it finds the tombstones and is refused
        //    until the bytes are gone and it has seen them uploaded again. A chain that moved
        //    keeps everything until the next pass. Objects of a worktree with no chain left
        //    need no tombstone: no register can name them (its guard is gone).
        for (const [owner, plan] of doomed) {
          const guard = guards.get(owner);
          if (guard !== undefined) {
            const condemned = yield* repo.condemn(WorktreeId.make(owner), guard, [
              ...plan.condemned,
            ]);
            if (!condemned) {
              yield* Effect.logInfo(
                "capture retention: a register moved the chain during the pass · kept for the next",
              ).pipe(Effect.annotateLogs({ worktreeId: owner }));
              continue;
            }
          }
          if (plan.retire.length > 0) {
            yield* repo.setPackState(
              plan.retire.map((pack) => pack.id),
              "retired",
            );
            report.packsRetired += plan.retire.length;
          }
          const failed: Array<string> = [];
          for (const key of plan.keys) {
            const removed = yield* remove(key);
            if (!removed) failed.push(key);
          }
          // A tombstone's bytes are gone once every object it stands for is: a pack with its
          // index, a `trees/` prefix with every object below it that this pass deleted. One
          // still there stays condemned; the next pass condemns and removes it again.
          const settled = [...plan.condemned].filter(
            (condemned) => !failed.some((key) => key === condemned || key.startsWith(condemned)),
          );
          if (guard !== undefined) yield* repo.markDeleted(settled);
        }

        // 5. Abort orphaned multipart uploads: every one under a fenced epoch, and every one
        //    older than the URL TTL plus the grace under the live epoch. An upload whose age
        //    the store does not report is left alone — nothing here judges by guesswork.
        for (const [worktreeId, head] of headsByWorktree) {
          const open = yield* blobs
            .listMultipart(`captures/${worktreeId}/`)
            .pipe(Effect.catch(() => Effect.succeed([])));
          for (const upload of open) {
            const epoch = epochOfKey(worktreeId, upload.key);
            const fenced = head !== null && epoch !== null && epoch < head.epoch;
            const stale =
              upload.initiatedAt !== null &&
              now - upload.initiatedAt.getTime() >= MULTIPART_ORPHAN_MS;
            if (!fenced && !stale) continue;
            yield* blobs.abortMultipart(upload.key, upload.uploadId).pipe(
              Effect.tap(() => Effect.sync(() => (report.multipartAborted += 1))),
              Effect.catch((error) =>
                Effect.logWarning("capture retention: multipart abort failed").pipe(
                  Effect.annotateLogs({
                    key: upload.key,
                    uploadId: upload.uploadId,
                    error: String(error),
                  }),
                ),
              ),
            );
          }
        }

        yield* Effect.logInfo("capture retention: pass complete").pipe(Effect.annotateLogs(report));
        return report;
      });

      return { run };
    }),
  );

/** The hourly fiber; a no-op outside capture mode. */
export const CaptureRetentionScheduleLive: Layer.Layer<
  never,
  never,
  CaptureRetention | CaptureRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const capture = yield* CaptureRuntime;
    if (!capture.enabled) return;
    const retention = yield* CaptureRetention;
    yield* Effect.forkScoped(
      retention.run().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("capture retention: pass failed").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
          ),
        ),
        Effect.repeat(Schedule.spaced(RETENTION_INTERVAL)),
      ),
    );
  }),
);
