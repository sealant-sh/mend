import * as fs from "node:fs";

import { AuditEventsRepo, ProjectsRepo, ReferencesRepo } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import { Store } from "@mend/store";
import { Effect, Layer, Schedule } from "effect";

/** How the sweep retries a repository it could not clean: 1 s, doubling, then every 5 minutes. */
export const SCRUB_RETRY: Schedule.Schedule<unknown> = Schedule.exponential("1 second").pipe(
  Schedule.either(Schedule.spaced("5 minutes")),
);

/** One repository the sweep looks after: a project's store or a reference clone. */
interface SweptRepository {
  readonly kind: "project" | "reference";
  readonly id: string;
  readonly name: string;
  readonly organizationId: OrganizationId;
  /** Whose credential it was: the account that adopted or added it. Null when unknown. */
  readonly ownerUserId: string | null;
  readonly gitDir: string;
}

/**
 * Take a login or token out of the git remotes Mend already holds (docs/GIT-ACCESS.md,
 * "Credentials in repository URLs"). Servers before 0.36 cloned an adopted URL as typed, so a
 * project's bare store and a reference clone could keep `https://oauth2:TOKEN@host/…` in their git
 * config, where a co-located workspace reads it. Migration 0121 strips the rows; this strips the
 * repositories, once per start, in the background. Idempotent: a clean config is left as it is.
 *
 * Each repository is its own: its outcome is reported the moment it is known, never after the
 * others. One that cannot be cleaned (a config another git holds locked, an include Mend does not
 * run git through) is logged with its reason, its file named and no URL, and retried on `retry`
 * until it is; meanwhile the store refuses to fetch, push or open a worktree with it.
 *
 * One that was cleaned, here or by a fetch that got there first, is reported from the notice the
 * store left beside its config (`Store.remoteCredentialNotice`): a warning naming the repository,
 * and an entry in its organization's audit log credited to whoever adopted it. The notice is
 * cleared only once recorded, so a restart before then reports it again. A remote that fetched
 * only because of its token fails from now on, and the notice says what to do.
 */
export const scrubRemoteCredentials = (retry: Schedule.Schedule<unknown> = SCRUB_RETRY) =>
  Effect.gen(function* () {
    const store = yield* Store;
    const projects = yield* ProjectsRepo;
    const references = yield* ReferencesRepo;
    const audit = yield* AuditEventsRepo;

    const report = (repository: SweptRepository) =>
      Effect.gen(function* () {
        const notice = yield* store.remoteCredentialNotice(repository.gitDir);
        if (notice === null) return false;
        yield* Effect.logWarning(
          `store: removed a login or token from the git remotes of ${repository.kind} ${repository.name}. If its remote fetched only with it, it now fails: adopt it again from its SSH URL, with your Mend key (\`mend keys\`) or the agent bridge.`,
        ).pipe(
          Effect.annotateLogs({
            [repository.kind]: repository.name,
            keys: notice.keys.join(", "),
            removedAt: notice.removedAt ?? "unknown",
          }),
        );
        if (repository.ownerUserId !== null) {
          yield* audit.record({
            organizationId: repository.organizationId,
            actorUserId: repository.ownerUserId,
            action:
              repository.kind === "project"
                ? "project.remote_credentials_removed"
                : "reference.remote_credentials_removed",
            subjectType: repository.kind,
            subjectId: repository.id,
            data: { name: repository.name, keys: notice.keys.join(", ") },
          });
        }
        yield* store.clearRemoteCredentialNotice(repository.gitDir);
        return true;
      });

    const sweep = (repository: SweptRepository) =>
      fs.existsSync(repository.gitDir)
        ? store.scrubRemoteCredentials(repository.gitDir).pipe(
            Effect.tapError((error) =>
              Effect.logWarning(
                `store: the git remotes of ${repository.kind} ${repository.name} still hold a login or token Mend has not removed; it does not fetch, push or open a worktree with them until then, and retries`,
              ).pipe(
                Effect.annotateLogs({ [repository.kind]: repository.name, reason: error.stderr }),
              ),
            ),
            Effect.retry(retry),
            Effect.andThen(report(repository)),
            Effect.map((reported) => (reported ? [repository.name] : [])),
          )
        : Effect.succeed([]);

    const scrubbed = yield* Effect.all(
      [
        Effect.forEach(
          yield* projects.listAll(),
          (project) =>
            sweep({
              kind: "project",
              id: project.id,
              name: project.name,
              organizationId: project.organizationId,
              ownerUserId: project.createdByUserId,
              gitDir: project.storePath,
            }),
          { concurrency: "unbounded" },
        ),
        Effect.forEach(
          yield* references.listAll(),
          (reference) =>
            sweep({
              kind: "reference",
              id: reference.id,
              name: reference.name,
              organizationId: reference.organizationId,
              ownerUserId: reference.createdByUserId,
              gitDir: reference.path,
            }),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    return { projects: scrubbed[0].flat(), references: scrubbed[1].flat() };
  });

/** `scrubRemoteCredentials` once per worker start, forked so nothing waits on it. */
export const RemoteCredentialScrubLive: Layer.Layer<
  never,
  never,
  Store | ProjectsRepo | ReferencesRepo | AuditEventsRepo
> = Layer.effectDiscard(Effect.forkScoped(scrubRemoteCredentials()));
