import * as fs from "node:fs";

import { ProjectsRepo, ReferencesRepo } from "@mend/db";
import { logRemoteCredentialFindings, remoteCredentialFindings } from "@mend/store";
import { Effect, Layer } from "effect";

/** One repository the check reads: a project's store or a reference clone. */
interface CheckedRepository {
  readonly kind: "project" | "reference";
  readonly name: string;
  readonly gitDir: string;
}

/** One repository's findings, logged with their commands; its name when Mend refuses it. */
const check = (repository: CheckedRepository) =>
  fs.existsSync(repository.gitDir)
    ? remoteCredentialFindings(repository.gitDir).pipe(
        Effect.tap((findings) =>
          findings.length === 0
            ? Effect.void
            : logRemoteCredentialFindings(`${repository.kind} ${repository.name}`, findings),
        ),
        Effect.map((findings) => (findings.length === 0 ? [] : [repository.name])),
        Effect.catch((error) =>
          Effect.logWarning(
            `store: could not read the git config of ${repository.kind} ${repository.name}`,
          ).pipe(
            Effect.annotateLogs({ [repository.kind]: repository.name, reason: error.stderr }),
            Effect.as([]),
          ),
        ),
      )
    : Effect.succeed([]);

/**
 * Name, at each start, every project and reference whose git config keeps Mend from running git
 * with it (docs/GIT-ACCESS.md, "Credentials in repository URLs"): a remote URL with a login or
 * token in it, as servers before 0.36 cloned an adopted URL, a `url.<base>.insteadOf` whose base
 * holds one, or an include. Mend does not rewrite a store's config; every fetch, push, worktree and
 * workspace mount of such a repository is refused (`refuseRemoteCredentials`), and this says so up
 * front, once per repository, with each finding's file and the command that removes it, never a
 * URL with a credential. Read
 * only and stateless: the next start says it again until someone fixes it. Answers the names.
 */
export const checkRemoteCredentials = Effect.gen(function* () {
  const projects = yield* ProjectsRepo;
  const references = yield* ReferencesRepo;

  const refusedProjects = (yield* Effect.forEach(
    yield* projects.listAll(),
    (project) => check({ kind: "project", name: project.name, gitDir: project.storePath }),
    { concurrency: 8 },
  )).flat();
  const refusedReferences = (yield* Effect.forEach(
    yield* references.listAll(),
    (reference) => check({ kind: "reference", name: reference.name, gitDir: reference.path }),
    { concurrency: 8 },
  )).flat();
  if (refusedProjects.length + refusedReferences.length > 0) {
    yield* Effect.logWarning(
      `store: ${refusedProjects.length} projects and ${refusedReferences.length} references are refused until their git config holds no login, token or include`,
    );
  }
  return { projects: refusedProjects, references: refusedReferences };
});

/** `checkRemoteCredentials` once per worker start, forked so nothing waits on it. */
export const RemoteCredentialCheckLive: Layer.Layer<never, never, ProjectsRepo | ReferencesRepo> =
  Layer.effectDiscard(Effect.forkScoped(checkRemoteCredentials));
