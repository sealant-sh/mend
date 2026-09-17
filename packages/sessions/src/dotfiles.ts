import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { DotfilesRepository } from "@mend/domain";
import { git } from "@mend/store";
import { Effect, Schema } from "effect";

/**
 * Launch-side dotfiles resolution. The platform applies dotfiles from archives the caller ships
 * with the create call, so nothing sensitive reaches the container — only file trees. Two
 * sources, in apply order:
 *
 * 1. the user's dotfiles REPOSITORY — cloned by the Mend server at launch, so every session gets
 *    the branch tip as of that moment;
 * 2. the user's dotfiles STORE snapshot — home files synced from wherever the user actually
 *    works, packed by the store as an exact, sha-named commit. Applied second, so the explicit
 *    selection wins over same-named repo files.
 *
 * The server's own home directory is deliberately never read (see @mend/store DotfilesStore).
 */

/** Resolving the user's dotfiles failed; the message is readable, the launch fails loudly. */
export class DotfilesResolveError extends Schema.TaggedErrorClass<DotfilesResolveError>()(
  "DotfilesResolveError",
  { message: Schema.String },
) {}

/** The platform caps one archive at ~4MB decoded; anything larger is a packaging mistake. */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;

/** What the launch hands the SDK: gzipped tars in apply order. */
export interface ResolvedDotfilesArchive {
  readonly data: string;
  readonly manager: "auto" | "chezmoi" | "stow" | "copy";
  readonly bootstrap: boolean;
}

const run = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string },
): Effect.Effect<Buffer, DotfilesResolveError> =>
  Effect.callback((resume) => {
    const child = execFile(
      command,
      [...args],
      { ...options, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed(stdout));
          return;
        }
        resume(
          Effect.fail(
            new DotfilesResolveError({
              message: `${command} ${args[0] ?? ""} failed: ${stderr.toString("utf8").trim() || error.message}`,
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

const capArchive = (archive: Buffer, label: string): Effect.Effect<Buffer, DotfilesResolveError> =>
  archive.byteLength > MAX_ARCHIVE_BYTES
    ? Effect.fail(
        new DotfilesResolveError({
          message: `${label} is ${(archive.byteLength / (1024 * 1024)).toFixed(1)}MB packed — the platform caps one dotfiles archive at 4MB. Trim it (dotfiles are text).`,
        }),
      )
    : Effect.succeed(archive);

/**
 * Shallow-clone the dotfiles repo with the server host's git/ssh setup and pack the checkout via
 * `git archive` (tracked files only, `.git` never included). BatchMode: a daemon cannot answer
 * an ssh prompt, so auth failures surface as readable errors instead of hangs.
 */
const buildRepositoryArchive = (
  repository: DotfilesRepository,
  cloneEnv: Readonly<Record<string, string>>,
): Effect.Effect<ResolvedDotfilesArchive, DotfilesResolveError> =>
  Effect.gen(function* () {
    const checkout = yield* Effect.sync(() =>
      fs.mkdtempSync(path.join(os.tmpdir(), "mend-dotfiles-")),
    );
    const cleanup = Effect.sync(() => {
      fs.rmSync(checkout, { recursive: true, force: true });
    });
    return yield* Effect.gen(function* () {
      yield* git(
        [
          "clone",
          "--depth",
          "1",
          ...(repository.ref === null ? [] : ["--branch", repository.ref]),
          repository.url,
          checkout,
        ],
        os.tmpdir(),
        { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes", ...cloneEnv },
      ).pipe(
        Effect.mapError(
          (error) =>
            new DotfilesResolveError({
              message: `dotfiles clone of ${repository.url} failed: ${error.stderr}`,
            }),
        ),
      );
      // `HEAD:<subdirectory>` re-roots the archive: the subtree's CONTENTS land at ~, so a repo
      // whose home mirror lives in a subfolder (`dots/`) applies without restructuring. A wrong
      // directory fails here with git's own message (readable, launch fails loudly).
      const treeish = repository.subdirectory === null ? "HEAD" : `HEAD:${repository.subdirectory}`;
      const archive = yield* run("git", ["archive", "--format=tar.gz", treeish], {
        cwd: checkout,
      });
      const capped = yield* capArchive(archive, `the dotfiles repo ${repository.url}`);
      return {
        data: capped.toString("base64"),
        manager: repository.manager,
        bootstrap: repository.bootstrap,
      };
    }).pipe(Effect.ensuring(cleanup));
  });

/**
 * Resolve the owner's dotfiles into launch archives: the repository first, the store snapshot
 * after (in-order apply means the synced selection wins). The snapshot is already a packed
 * `.tar.gz` from the dotfiles store; it applies with the copy manager and never a bootstrap.
 * Nothing configured resolves to no archives.
 */
export const resolveDotfilesArchives = (input: {
  readonly repository: DotfilesRepository | null;
  readonly snapshot: { readonly sha: string; readonly data: string } | null;
  /** Pins the clone to the address the source policy checked; merged over the defaults. */
  readonly cloneEnv?: Readonly<Record<string, string>>;
}): Effect.Effect<ReadonlyArray<ResolvedDotfilesArchive>, DotfilesResolveError> =>
  Effect.gen(function* () {
    const archives: ResolvedDotfilesArchive[] = [];
    if (input.repository !== null) {
      archives.push(yield* buildRepositoryArchive(input.repository, input.cloneEnv ?? {}));
    }
    if (input.snapshot !== null) {
      archives.push({ data: input.snapshot.data, manager: "copy", bootstrap: false });
    }
    return archives;
  });
