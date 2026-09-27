import type { CaptureRow, PackRow } from "@mend/db";
import type { WorktreeId } from "@mend/domain";
import { CaptureRuntime, PRESIGN_TTL_SECONDS } from "@mend/sessions";
import { packIdxKeyOf } from "@mend/store";
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

const stringsOf = (section: unknown, field: string): ReadonlyArray<string> => {
  if (typeof section !== "object" || section === null) return [];
  const value: unknown = Reflect.get(section, field);
  return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
};

const packsOf = (section: unknown): ReadonlyArray<string> => stringsOf(section, "packs");

/**
 * A chunked section's dir packs (format 2, sealantd PR #99). Read whatever the section lists,
 * whatever its `format` says: keeping a listed object alive is never the loss.
 */
const dirPacksOf = (section: unknown): ReadonlyArray<string> => stringsOf(section, "dir_packs");

/** A format-1 root is a key (`…/trees/<sha256>`); a format-2 root is a digest and names no object. */
const treeOf = (section: unknown): ReadonlyArray<string> => {
  if (typeof section !== "object" || section === null) return [];
  const root: unknown = Reflect.get(section, "root");
  return typeof root === "string" && root.includes("/trees/") ? [root] : [];
};

/**
 * The bulk sections captured on other platforms that a row carries (`other_bulk`, sealantd PR
 * #101), whatever their keys say: each is another platform's dependency tree, restorable only
 * while every object it names lives, however many captures ago it was built.
 */
const otherBulkOf = (sections: object): ReadonlyArray<unknown> => {
  const other: unknown = Reflect.get(sections, "other_bulk");
  if (typeof other !== "object" || other === null || Array.isArray(other)) return [];
  const entries: ReadonlyArray<unknown> = Object.values(other);
  return entries;
};

/** Every chunked section a row names: the workspace, the bulk section, every other platform's. */
const chunkedSectionsOf = (sections: object): ReadonlyArray<unknown> => [
  Reflect.get(sections, "workspace"),
  Reflect.get(sections, "bulk"),
  ...otherBulkOf(sections),
];

/** Every object key a capture row's sections name. */
export const keysOfSections = (sections: unknown): ReadonlyArray<string> => {
  if (typeof sections !== "object" || sections === null) return [];
  return [
    ...packsOf(Reflect.get(sections, "git")).flatMap((key) => [key, packIdxKeyOf(key)]),
    ...chunkedSectionsOf(sections).flatMap((section) => [
      ...packsOf(section),
      ...treeOf(section),
      ...dirPacksOf(section),
    ]),
  ];
};

/**
 * The `…/trees/` prefixes a row's format-1 roots live under. A format-1 root names its children
 * by key, and sealantd writes every dir object of one tree under the prefix its root has (the
 * epoch that built it), so a root that lives keeps every `trees/` object under its prefix alive
 * — without reading one dir object. A section carried from an older epoch (a bulk section that
 * rides along until the next bulk snap, or another platform's in `other_bulk`, which rides along
 * for good) keeps its whole tree that way.
 */
export const treePrefixesOfSections = (sections: unknown): ReadonlyArray<string> => {
  if (typeof sections !== "object" || sections === null) return [];
  return chunkedSectionsOf(sections)
    .flatMap(treeOf)
    .map((root) => root.slice(0, root.lastIndexOf("/trees/") + "/trees/".length));
};

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
        const remove = (key: string) =>
          blobs.remove(key).pipe(
            Effect.tap(() => Effect.sync(() => (report.objectsRemoved += 1))),
            Effect.catch((error) =>
              Effect.logWarning("capture retention: object removal failed").pipe(
                Effect.annotateLogs({ key, error: String(error) }),
              ),
            ),
          );

        // 1. Thin every chain; the head and the kept kinds stay by rule, and the SQL refuses
        //    the head regardless of what this pass computed.
        const live = new Set<string>();
        const liveTreePrefixes = new Set<string>();
        const chains = yield* repo.listChains();
        const headsByWorktree = new Map<WorktreeId, CaptureRow | null>();
        for (const chain of chains) {
          report.chains += 1;
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

        // 2. Retire packs no remaining row names, after the grace: rows first, bytes second,
        //    so a crash between the two leaves a retired row and a stray object, never the
        //    reverse.
        const packs = yield* repo.listPacks();
        const retire: Array<PackRow> = [];
        for (const pack of packs) {
          if (pack.state === "retired") continue;
          if (!pack.key.startsWith("captures/")) continue;
          if (live.has(pack.key)) continue;
          if (now - pack.createdAt.getTime() < RETENTION_GRACE_MS) continue;
          retire.push(pack);
        }
        if (retire.length > 0) {
          yield* repo.setPackState(
            retire.map((pack) => pack.id),
            "retired",
          );
          report.packsRetired += retire.length;
          for (const pack of retire) {
            yield* remove(pack.key);
            if (pack.class === "git") yield* remove(packIdxKeyOf(pack.key));
          }
        }

        // 3. Sweep fenced epoch prefixes of everything off-chain, once the head has stood for
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
            yield* remove(entry.key);
          }
        }

        // 4. Abort orphaned multipart uploads: every one under a fenced epoch, and every one
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
