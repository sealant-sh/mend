import * as fs from "node:fs";

import { ProjectsRepo, ReferencesRepo } from "@mend/db";
import { Store } from "@mend/store";
import { Effect, Layer, Schedule } from "effect";

/** How the sweep retries a repository it could not clean: 1 s, doubling, then every 5 minutes. */
export const SCRUB_RETRY: Schedule.Schedule<unknown> = Schedule.exponential("1 second").pipe(
  Schedule.either(Schedule.spaced("5 minutes")),
);

/**
 * Take a login or token out of the git remotes Mend already holds (docs/GIT-ACCESS.md,
 * "Credentials in repository URLs"). Servers before 0.36 cloned an adopted URL as typed, so a
 * project's bare store and a reference clone could keep `https://oauth2:TOKEN@host/…` in their git
 * config, where a co-located workspace reads it. Migration 0121 strips the rows; this strips the
 * repositories, once per start, in the background. Idempotent: a clean config is left as it is.
 *
 * A repository that cannot be cleaned (its config locked by another git, a store this process
 * cannot write) is retried on `retry` until it is, each repository on its own, so one never holds
 * up the rest. Until then the store refuses to fetch, push or open a worktree with it
 * (`Store.cleanRemotes`). Each failure is logged with the repository's name, never its URL.
 *
 * A remote that fetched only because of its token fails from now on. The log names those projects
 * and references and says what to do.
 */
export const scrubRemoteCredentials = (retry: Schedule.Schedule<unknown> = SCRUB_RETRY) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;
    const references = yield* ReferencesRepo;
    const scrub = (kind: "project" | "reference", name: string, gitDir: string) =>
      fs.existsSync(gitDir)
        ? store.scrubRemoteCredentials(gitDir).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                "store: a repository's git remotes could not be checked for a login or token yet; Mend retries, and does not fetch or push with them until then",
              ).pipe(Effect.annotateLogs({ [kind]: name, gitDir, stderr: error.stderr })),
            ),
            Effect.retry(retry),
            Effect.map((rewritten) => (rewritten > 0 ? [name] : [])),
          )
        : Effect.succeed([]);
    const scrubbed = yield* Effect.all(
      [
        Effect.forEach(
          yield* projects.listAll(),
          (project) => scrub("project", project.name, project.storePath),
          { concurrency: "unbounded" },
        ),
        Effect.forEach(
          yield* references.listAll(),
          (reference) => scrub("reference", reference.name, reference.path),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const result = { projects: scrubbed[0].flat(), references: scrubbed[1].flat() };
    if (result.projects.length + result.references.length > 0) {
      yield* Effect.logWarning(
        "store: removed a login or token from the git remotes of these projects and references. A remote that fetched only with it now fails: adopt the project again from its SSH URL, with your Mend key (`mend keys`) or the agent bridge.",
      ).pipe(Effect.annotateLogs(result));
    }
    return result;
  });

/** `scrubRemoteCredentials` once per worker start, forked so nothing waits on it. */
export const RemoteCredentialScrubLive: Layer.Layer<
  never,
  never,
  Store | ProjectsRepo | ReferencesRepo
> = Layer.effectDiscard(Effect.forkScoped(scrubRemoteCredentials()));
