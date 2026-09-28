import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StoreRefsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  type CaptureManifest,
  digestOfKey,
  type GitFsckOutcome,
  GIT_OBJECT_ID,
  type GitObjectFormat,
  git,
  gitObjectFormatOf,
  gitObjectIdPattern,
  gitBytes,
  gitSectionTrees,
  GitOpsRunner,
  type RestoreTreePath,
  type WorktreeTreeKind,
} from "@mend/store";
import { Effect, Layer, Result } from "effect";
import * as Context from "effect/Context";

/**
 * Mend's own verification of a capture's git section (ADR-0002 "Replacement and pickup":
 * pickup prefers the newest capture whose git section verifies). The executor's manifest
 * carries an `fsck` claim; this is the observation Mend records in `captures.git_fsck`
 * instead of that claim — a capture whose pack is intact but whose refs point at objects no
 * pack holds (observed on the cluster: a root tree naming subtrees the executor never packed,
 * `fsck: "verified"` notwithstanding) is `failed` here and never poisons a pickup or a read.
 *
 * Two checks: `git index-pack --verify` on every pack as it is installed in the runner cache
 * (`GitOpsRunner.ensure`), then `git rev-list --objects --missing=error` from every sha the
 * section names — in a namespace holding the manifest's listed packs and nothing else
 * (`isolatedPacks`), never the shared cache: a restore fetches exactly those packs, so an object
 * another capture left in the cache must not satisfy this one's closure (review 2026-09-28 (4)
 * #12). The walk is bounded below by the project's store refs whose WHOLE closure one listed pack
 * holds (the base the capture carries, which Mend packed whole), so a large repository is walked
 * only across what the capture added. `--not <ref>` lets git skip everything below the ref without
 * reading it, so the ref's presence proves nothing about the blobs a checkout needs under it
 * (review 2026-09-28 (5) #9): a ref bounds the walk only once a walk of its own closure, in a
 * namespace holding that one pack alone, found every object. Packs are immutable (named by their
 * sha256), so that proof is kept per (ref sha, pack) for the process; a store ref no single listed
 * pack closes bounds nothing, and the tips are walked whole.
 */

export interface GitVerification {
  readonly outcome: GitFsckOutcome;
  /** What was observed when the outcome is not `verified`: git's stderr, or why nothing ran. */
  readonly detail: string | null;
}

export class CaptureGitVerifier extends Context.Service<
  CaptureGitVerifier,
  {
    readonly verify: (
      projectId: ProjectId,
      manifest: CaptureManifest,
    ) => Effect.Effect<GitVerification>;
    /**
     * Every path of the tree `tree` names, from the section's packs on the runner: the hex of its
     * bytes → what it is (`WorktreeTreeKind`). What the worktree metadata document is checked
     * against at register (`metaNamespaceProblem`). Null when nothing could be observed (no
     * runner, the cache could not be prepared, git failed): never an empty tree.
     */
    readonly treePaths: (
      projectId: ProjectId,
      manifest: CaptureManifest,
      tree: string,
    ) => Effect.Effect<ReadonlyMap<string, WorktreeTreeKind> | null>;
    /**
     * `treePaths` with each path's git object: what a hardlink group's members and a shared
     * link's tracked side are checked against before a seal (`linkTopologyProblem`, review
     * 2026-09-28 (6) #10). Null when nothing could be observed.
     */
    readonly treeObjects: (
      projectId: ProjectId,
      manifest: CaptureManifest,
      tree: string,
    ) => Effect.Effect<ReadonlyMap<string, RestoreTreePath> | null>;
  }
>()("@mend/sessions/CaptureGitVerifier") {}

/** No runner at hand (tests of the routes alone): every capture stays `unverified`. */
export const CaptureGitVerifierOff: Layer.Layer<CaptureGitVerifier> = Layer.succeed(
  CaptureGitVerifier,
  {
    verify: () => Effect.succeed({ outcome: "unverified", detail: "no git verifier configured" }),
    treePaths: () => Effect.succeed(null),
    treeObjects: () => Effect.succeed(null),
  },
);

/** A git mode (`ls-tree`) as what the path is on disk after a checkout. */
const kindOfMode = (mode: string): WorktreeTreeKind | null => {
  if (mode === "040000") return "dir";
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return mode.startsWith("100") ? "file" : null;
};

/**
 * `git ls-tree -r -t -z --full-tree` output: `<mode> SP <type> SP <object> TAB <path> NUL`, the
 * path as bytes. Answers hex of the path → its kind.
 */
export const parseTreeListing = (output: Buffer): ReadonlyMap<string, WorktreeTreeKind> =>
  new Map([...parseTreeObjects(output)].map(([at, found]) => [at, found.kind] as const));

/** `parseTreeListing`, keeping each path's object id beside its kind. */
export const parseTreeObjects = (output: Buffer): ReadonlyMap<string, RestoreTreePath> => {
  const paths = new Map<string, RestoreTreePath>();
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(0, start);
    if (end < 0) end = output.length;
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const [mode = "", , object = ""] = record.subarray(0, tab).toString("latin1").split(" ");
    const kind = kindOfMode(mode);
    if (kind !== null) paths.set(record.subarray(tab + 1).toString("hex"), { kind, object });
  }
  return paths;
};

/** How many store refs' closure proofs the verifier keeps before it starts over. */
const CLOSED_BOUNDARY_LIMIT = 10_000;

/**
 * A bare repository whose object store is exactly `packKeys` as the runner cache at `cachePath`
 * installed them (links to `objects/pack/pack-<sha256>.{pack,idx}`), made for `use` and removed
 * after. Nothing else is reachable from it: no other pack, no loose object, no alternate.
 */
const isolatedPacks = <A, E>(
  cachePath: string,
  packKeys: ReadonlyArray<string>,
  format: GitObjectFormat,
  use: (repo: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | { readonly _tag: "IsolationError"; readonly detail: string }> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-verify-"));
        for (const dir of ["objects/pack", "objects/info", "refs"]) {
          fs.mkdirSync(path.join(repo, dir), { recursive: true });
        }
        fs.writeFileSync(path.join(repo, "HEAD"), "ref: refs/heads/main\n");
        // A SHA-256 section's packs are read in a SHA-256 repository (review 2026-09-28 (8) #10).
        fs.writeFileSync(
          path.join(repo, "config"),
          format === "sha1"
            ? "[core]\n\trepositoryformatversion = 0\n\tbare = true\n"
            : `[core]\n\trepositoryformatversion = 1\n\tbare = true\n[extensions]\n\tobjectformat = ${format}\n`,
        );
        for (const key of new Set(packKeys)) {
          const digest = digestOfKey(key);
          if (digest === null) throw new Error(`pack key carries no sha256: ${key}`);
          for (const ext of ["pack", "idx"]) {
            fs.symlinkSync(
              path.join(cachePath, "objects", "pack", `pack-${digest}.${ext}`),
              path.join(repo, "objects", "pack", `pack-${digest}.${ext}`),
            );
          }
        }
        return repo;
      },
      catch: (cause) => ({
        _tag: "IsolationError" as const,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
    }),
    use,
    (repo) => Effect.sync(() => fs.rmSync(repo, { recursive: true, force: true })),
  );

/** Which of `shas` the repository at `repo` holds (`cat-file --batch-check`). */
const presentIn = (repo: string, shas: ReadonlyArray<string>, format: GitObjectFormat) =>
  shas.length === 0
    ? Effect.succeed<ReadonlyArray<string>>([])
    : git(
        ["cat-file", "--batch-check=%(objectname)"],
        repo,
        undefined,
        undefined,
        `${shas.join("\n")}\n`,
      ).pipe(
        Effect.map((out) =>
          out
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => gitObjectIdPattern(format).test(line)),
        ),
      );

export const CaptureGitVerifierLive: Layer.Layer<
  CaptureGitVerifier,
  never,
  GitOpsRunner | StoreRefsRepo
> = Layer.effect(
  CaptureGitVerifier,
  Effect.gen(function* () {
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;
    // Store ref sha → the pack digests a walk proved hold its whole closure.
    const closedIn = new Map<string, Set<string>>();

    /** Whether the pack `key` alone holds `sha` and every object reachable from it. */
    const closureHeldBy = (cachePath: string, key: string, sha: string, format: GitObjectFormat) =>
      isolatedPacks(cachePath, [key], format, (repo) =>
        Effect.gen(function* () {
          if ((yield* presentIn(repo, [sha], format)).length === 0) return false;
          yield* git(["rev-list", "--objects", "--missing=error", "--no-object-names", sha], repo);
          return true;
        }),
      ).pipe(Effect.catch(() => Effect.succeed(false)));

    /**
     * Which of `candidates` (store refs the listed packs hold) may bound the walk: those whose
     * whole closure one of `packKeys` holds, proved by a walk (or remembered from one).
     */
    const closedBoundaries = (
      cachePath: string,
      packKeys: ReadonlyArray<string>,
      candidates: ReadonlyArray<string>,
      format: GitObjectFormat,
    ) =>
      Effect.filter(candidates, (sha) =>
        Effect.gen(function* () {
          const proved = closedIn.get(sha);
          const digests = packKeys.map((key) => ({ key, digest: digestOfKey(key) }));
          if (digests.some(({ digest }) => digest !== null && proved?.has(digest) === true)) {
            return true;
          }
          for (const { key, digest } of digests) {
            if (digest === null) continue;
            if (yield* closureHeldBy(cachePath, key, sha, format)) {
              if (closedIn.size >= CLOSED_BOUNDARY_LIMIT) closedIn.clear();
              closedIn.set(sha, new Set([...(closedIn.get(sha) ?? []), digest]));
              return true;
            }
          }
          return false;
        }),
      );

    const verify = Effect.fn("CaptureGitVerifier.verify")(function* (
      projectId: ProjectId,
      manifest: CaptureManifest,
    ) {
      const section = manifest.sections.git;
      // The section's object format (`object_format`, absent: sha1): the width of every id it
      // names, and the format of the repository its packs are read in (review 2026-09-28 (8)
      // #10). One Mend does not read is never verified — nor failed: nothing was observed.
      const format = gitObjectFormatOf(section);
      if (format === null) {
        return {
          outcome: "unverified",
          detail: `object format ${JSON.stringify(section.object_format)} is not one Mend reads`,
        } satisfies GitVerification;
      }
      const id = gitObjectIdPattern(format);
      // Every ref, `head`, and every tree the section names beside its refs (the `git_trees`
      // fields, or the pseudo-refs before them): a restore checks each out.
      const named = [
        ...new Set([...Object.values(section.refs), section.head, ...gitSectionTrees(section)]),
      ].filter((value) => GIT_OBJECT_ID.test(value));
      // An id of another width than the section's format names objects no walk here reads: never
      // verified by walking nothing.
      const otherWidth = named.filter((sha) => !id.test(sha));
      if (otherWidth.length > 0) {
        return {
          outcome: "unverified",
          detail: `${otherWidth.length} object id(s) the git section names are not ${format} ids`,
        } satisfies GitVerification;
      }
      const tips = named;
      // Nothing named, nothing to walk: a git section without objects restores nothing.
      if (tips.length === 0) return { outcome: "verified", detail: null } satisfies GitVerification;
      const storeRefs = yield* refs.refsMap(projectId);
      const ensured = yield* runner.ensure({ projectId, manifest, storeRefs }).pipe(Effect.result);
      if (Result.isFailure(ensured)) {
        const error = ensured.failure;
        switch (error._tag) {
          case "RunnerPackError":
            return {
              outcome: "failed",
              detail: `${error.key}: ${error.reason}`,
            } satisfies GitVerification;
          case "BlobNotFoundError":
            return {
              outcome: "failed",
              detail: `pack missing from the bucket: ${error.key}`,
            } satisfies GitVerification;
          case "GitError":
            return { outcome: "failed", detail: error.stderr.trim() } satisfies GitVerification;
          default:
            // The bucket or the cache directory failed, not the capture: nothing was observed.
            return {
              outcome: "unverified",
              detail: `the runner cache could not be prepared: ${error._tag}`,
            } satisfies GitVerification;
        }
      }
      const tipSet = new Set(tips);
      const storeTips = [...new Set(Object.values(storeRefs))].filter(
        (sha) => id.test(sha) && !tipSet.has(sha),
      );
      // The closure walk sees the listed packs alone (review 2026-09-28 (4) #12): what a restore
      // fetches is what must hold it.
      const cachePath = ensured.success.path;
      const walked = yield* isolatedPacks(cachePath, section.packs, format, (repo) =>
        Effect.gen(function* () {
          const held = yield* presentIn(repo, storeTips, format);
          const boundary = yield* closedBoundaries(cachePath, section.packs, held, format);
          return yield* git(
            [
              "rev-list",
              "--objects",
              "--missing=error",
              "--no-object-names",
              ...tips,
              ...(boundary.length === 0 ? [] : ["--not", ...boundary]),
            ],
            repo,
          );
        }),
      ).pipe(Effect.result);
      if (Result.isFailure(walked)) {
        const error = walked.failure;
        return error._tag === "IsolationError"
          ? ({
              outcome: "unverified",
              detail: `the listed packs could not be isolated: ${error.detail}`,
            } satisfies GitVerification)
          : ({ outcome: "failed", detail: error.stderr.trim() } satisfies GitVerification);
      }
      return { outcome: "verified", detail: null } satisfies GitVerification;
    });

    const listTree = Effect.fn("CaptureGitVerifier.listTree")(function* (
      projectId: ProjectId,
      manifest: CaptureManifest,
      tree: string,
    ) {
      const format = gitObjectFormatOf(manifest.sections.git);
      if (format === null || !gitObjectIdPattern(format).test(tree)) return null;
      const storeRefs = yield* refs.refsMap(projectId);
      const ensured = yield* runner.ensure({ projectId, manifest, storeRefs }).pipe(Effect.result);
      if (Result.isFailure(ensured)) return null;
      const listed = yield* gitBytes(
        ["ls-tree", "-r", "-t", "-z", "--full-tree", tree],
        ensured.success.path,
      ).pipe(Effect.result);
      return Result.isFailure(listed) ? null : listed.success;
    });

    const treePaths = (projectId: ProjectId, manifest: CaptureManifest, tree: string) =>
      listTree(projectId, manifest, tree).pipe(
        Effect.map((listed) => (listed === null ? null : parseTreeListing(listed))),
      );

    const treeObjects = (projectId: ProjectId, manifest: CaptureManifest, tree: string) =>
      listTree(projectId, manifest, tree).pipe(
        Effect.map((listed) => (listed === null ? null : parseTreeObjects(listed))),
      );

    return { verify, treePaths, treeObjects };
  }),
);
