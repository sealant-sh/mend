import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import { FoldersRepo, ReferencesRepo } from "@mend/db";
import type { ProjectId, WorktreeId } from "@mend/domain";
import { folderMountPath, referenceMountPath } from "@mend/domain/workbench";
import { BlobStore, captureSourceKey } from "@mend/store";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * What travels to a captured workspace beside the worktree (docs/adr/0003-organizations-and-tenancy.md
 * gate item 3). A session in capture mode mounts nothing from the host — the executor materialises
 * the worktree's head capture on its own disk — so the folders and reference repositories a
 * project selected cannot reach it as bind mounts. They travel instead: one gzipped archive per
 * source, content-addressed, named on `plan.get` for sealantd to lay down beside the worktree
 * (sealantd ADR-0015, "Sources beside the worktree"; the daemon extracts them at boot and at
 * every re-plan).
 *
 * Two archive shapes, because the two sources are different things:
 *
 * - A **folder** is a directory Mend keeps; it travels as `tar -czf` of its contents.
 * - A **reference** is a git clone kept for reading; it travels as `git archive HEAD`, the tree
 *   without the history. An agent reads a dependency's source, and shipping `.git` would multiply
 *   the bytes for nothing.
 *
 * A key is the archive's own digest under the session's epoch prefix
 * (`captures/<worktree>/<epoch>/sources/<sha256>.tar.gz`), which keeps sealantd's rule that an
 * executor only ever holds URLs under its own prefix, makes a re-plan of unchanged content a
 * no-op write, and lets capture retention sweep the archive with the rest of the fenced epoch.
 * Nothing is kept beyond the epoch, so a folder that changes leaves nothing behind.
 *
 * A source that cannot be archived is left out with a warning, never a refused boot: the session
 * is worth more than one directory. The daemon's own stamp means an unchanged source is not
 * extracted again.
 */
export interface PlanSource {
  /** A label for logs; never a path component. */
  readonly name: string;
  /** Absolute path inside the workspace, beside the worktree and never inside it. */
  readonly path: string;
  /** Object key under the caller's epoch prefix; its GET URL rides the plan's `get_urls`. */
  readonly key: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly read_only: boolean;
}

/** The same ceiling sealantd puts on one source; past it the source is left out. */
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export class CaptureSources extends Context.Service<
  CaptureSources,
  {
    /**
     * The project's folders and references, published for one session's epoch. Never fails: a
     * source that cannot be archived is logged and left out.
     */
    readonly forProject: (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      epoch: number,
    ) => Effect.Effect<ReadonlyArray<PlanSource>>;
  }
>()("@mend/sessions/CaptureSources") {}

/** Nothing travels (tests of the routes alone, and a world with no project selections). */
export const CaptureSourcesOff: Layer.Layer<CaptureSources> = Layer.succeed(CaptureSources, {
  forProject: () => Effect.succeed([]),
});

/**
 * One archive, in memory. `maxBuffer` is the ceiling itself: a source that would outgrow it fails
 * here instead of being buffered whole, and is then left out of the plan.
 */
const archive = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): Effect.Effect<Buffer, Error> =>
  Effect.callback((resume) => {
    const child = execFile(
      command,
      [...args],
      { cwd, encoding: "buffer", maxBuffer: MAX_SOURCE_BYTES },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout));
          return;
        }
        const detail = stderr.toString("utf8").trim();
        resume(Effect.fail(new Error(`${command} ${args[0] ?? ""}: ${detail || error.message}`)));
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

const digestOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export const CaptureSourcesLive: Layer.Layer<
  CaptureSources,
  never,
  FoldersRepo | ReferencesRepo | BlobStore
> = Layer.effect(
  CaptureSources,
  Effect.gen(function* () {
    const folders = yield* FoldersRepo;
    const references = yield* ReferencesRepo;
    const blobs = yield* BlobStore;

    /**
     * Put the archive under the session's own epoch prefix. `ifAbsent` makes a re-plan of the
     * same content a no-op, and capture retention sweeps the key when the epoch is fenced —
     * which is why there is no longer-lived copy anywhere.
     */
    const publish = Effect.fn("CaptureSources.publish")(function* (
      worktreeId: WorktreeId,
      epoch: number,
      bytes: Buffer,
    ) {
      const sha256 = digestOf(bytes);
      const key = captureSourceKey(worktreeId, epoch, sha256);
      yield* blobs.put(key, bytes, { ifAbsent: true });
      return { key, sha256, bytes: bytes.length };
    });

    const forProject = Effect.fn("CaptureSources.forProject")(function* (
      projectId: ProjectId,
      worktreeId: WorktreeId,
      epoch: number,
    ) {
      const selected = yield* folders
        .listForProject(projectId)
        .pipe(Effect.orElseSucceed(() => []));
      const selectedReferences = yield* references
        .listForProject(projectId)
        .pipe(Effect.orElseSucceed(() => []));
      const wanted = [
        ...selected.map(({ folder, selection }) => ({
          name: selection.name,
          path: folderMountPath(selection.name),
          readOnly: selection.readOnly,
          cwd: folder.path,
          // `.` keeps the folder's own name out of the archive: its contents are the mount.
          command: "tar" as const,
          args: ["-czf", "-", "."],
        })),
        ...selectedReferences.map((reference) => ({
          name: reference.name,
          path: referenceMountPath(reference.name),
          readOnly: true,
          cwd: reference.path,
          command: "git" as const,
          args: ["archive", "--format=tar.gz", "HEAD"],
        })),
      ];
      const published: Array<PlanSource> = [];
      for (const source of wanted) {
        const result = yield* archive(source.command, source.args, source.cwd).pipe(
          Effect.flatMap((bytes) => publish(worktreeId, epoch, bytes)),
          Effect.catchCause((cause) =>
            Effect.logWarning("capture sources: source left out of the plan")
              .pipe(
                Effect.annotateLogs({
                  name: source.name,
                  path: source.cwd,
                  cause: String(cause),
                }),
              )
              .pipe(Effect.as(null)),
          ),
        );
        if (result === null) continue;
        published.push({
          name: source.name,
          path: source.path,
          key: result.key,
          sha256: result.sha256,
          bytes: result.bytes,
          read_only: source.readOnly,
        });
      }
      return published;
    });

    return { forProject };
  }),
);
