import * as fs from "node:fs";

import { ProjectsRepo, ReferencesRepo } from "@mend/db";
import { Store } from "@mend/store";
import { Effect, Layer } from "effect";

/**
 * Take a login or token out of the git remotes Mend already holds (docs/GIT-ACCESS.md,
 * "Credentials in repository URLs"). Servers before 0.36 cloned an adopted URL as typed, so a
 * project's bare store and a reference clone could keep `https://oauth2:TOKEN@host/…` in their git
 * config, where a co-located workspace reads it. Migration 0121 strips the rows; this strips the
 * repositories, once per start, in the background. Idempotent: a clean config is left as it is.
 *
 * A remote that fetched only because of its token fails from now on. The log names those projects
 * and references, never their URLs, and says what to do.
 */
export const scrubRemoteCredentials = Effect.gen(function* () {
  const store = yield* Store;
  const projects = yield* ProjectsRepo;
  const references = yield* ReferencesRepo;
  const scrub = (gitDir: string) =>
    fs.existsSync(gitDir)
      ? store
          .scrubRemoteCredentials(gitDir)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("store: could not read a repository's remotes").pipe(
                Effect.annotateLogs({ gitDir, stderr: error.stderr }),
                Effect.as(0),
              ),
            ),
          )
      : Effect.succeed(0);
  const scrubbedProjects: Array<string> = [];
  for (const project of yield* projects.listAll()) {
    if ((yield* scrub(project.storePath)) > 0) scrubbedProjects.push(project.name);
  }
  const scrubbedReferences: Array<string> = [];
  for (const reference of yield* references.listAll()) {
    if ((yield* scrub(reference.path)) > 0) scrubbedReferences.push(reference.name);
  }
  if (scrubbedProjects.length + scrubbedReferences.length > 0) {
    yield* Effect.logWarning(
      "store: removed a login or token from the git remotes of these projects and references. A remote that fetched only with it now fails: adopt the project again from its SSH URL, with your Mend key (`mend keys`) or the agent bridge.",
    ).pipe(Effect.annotateLogs({ projects: scrubbedProjects, references: scrubbedReferences }));
  }
  return { projects: scrubbedProjects, references: scrubbedReferences };
});

/** `scrubRemoteCredentials` once per worker start, forked so nothing waits on it. */
export const RemoteCredentialScrubLive: Layer.Layer<
  never,
  never,
  Store | ProjectsRepo | ReferencesRepo
> = Layer.effectDiscard(Effect.forkScoped(scrubRemoteCredentials));
