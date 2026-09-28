import { StoreRefsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  type CaptureManifest,
  type GitFsckOutcome,
  git,
  gitBytes,
  gitSectionTrees,
  GitOpsRunner,
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
 * Two checks, both on the runner cache: `git index-pack --verify` on every pack as it is
 * installed (`GitOpsRunner.ensure`), then `git rev-list --objects --missing=error` from every
 * sha the section names, bounded below by the project's store refs so a large repository is
 * walked only across what the capture added.
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
  }
>()("@mend/sessions/CaptureGitVerifier") {}

/** No runner at hand (tests of the routes alone): every capture stays `unverified`. */
export const CaptureGitVerifierOff: Layer.Layer<CaptureGitVerifier> = Layer.succeed(
  CaptureGitVerifier,
  {
    verify: () => Effect.succeed({ outcome: "unverified", detail: "no git verifier configured" }),
    treePaths: () => Effect.succeed(null),
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
export const parseTreeListing = (output: Buffer): ReadonlyMap<string, WorktreeTreeKind> => {
  const paths = new Map<string, WorktreeTreeKind>();
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(0, start);
    if (end < 0) end = output.length;
    const record = output.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    if (tab < 0) continue;
    const mode = record.subarray(0, record.indexOf(0x20)).toString("latin1");
    const kind = kindOfMode(mode);
    if (kind !== null) paths.set(record.subarray(tab + 1).toString("hex"), kind);
  }
  return paths;
};

const HEX40 = /^[0-9a-f]{40}$/;

export const CaptureGitVerifierLive: Layer.Layer<
  CaptureGitVerifier,
  never,
  GitOpsRunner | StoreRefsRepo
> = Layer.effect(
  CaptureGitVerifier,
  Effect.gen(function* () {
    const runner = yield* GitOpsRunner;
    const refs = yield* StoreRefsRepo;

    const verify = Effect.fn("CaptureGitVerifier.verify")(function* (
      projectId: ProjectId,
      manifest: CaptureManifest,
    ) {
      const section = manifest.sections.git;
      // Every ref, `head`, and every tree the section names beside its refs (the `git_trees`
      // fields, or the pseudo-refs before them): a restore checks each out.
      const tips = [
        ...new Set([...Object.values(section.refs), section.head, ...gitSectionTrees(section)]),
      ].filter((sha) => HEX40.test(sha));
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
      const boundary = [...new Set(Object.values(storeRefs))].filter(
        (sha) => HEX40.test(sha) && !tipSet.has(sha),
      );
      const walked = yield* git(
        [
          "rev-list",
          "--objects",
          "--missing=error",
          "--no-object-names",
          ...tips,
          ...(boundary.length === 0 ? [] : ["--not", ...boundary]),
        ],
        ensured.success.path,
      ).pipe(Effect.result);
      return Result.isFailure(walked)
        ? ({ outcome: "failed", detail: walked.failure.stderr.trim() } satisfies GitVerification)
        : ({ outcome: "verified", detail: null } satisfies GitVerification);
    });

    const treePaths = Effect.fn("CaptureGitVerifier.treePaths")(function* (
      projectId: ProjectId,
      manifest: CaptureManifest,
      tree: string,
    ) {
      if (!HEX40.test(tree)) return null;
      const storeRefs = yield* refs.refsMap(projectId);
      const ensured = yield* runner.ensure({ projectId, manifest, storeRefs }).pipe(Effect.result);
      if (Result.isFailure(ensured)) return null;
      const listed = yield* gitBytes(
        ["ls-tree", "-r", "-t", "-z", "--full-tree", tree],
        ensured.success.path,
      ).pipe(Effect.result);
      return Result.isFailure(listed) ? null : parseTreeListing(listed.success);
    });

    return { verify, treePaths };
  }),
);
