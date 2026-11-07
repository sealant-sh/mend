import {
  CurrentUser,
  GhFailure,
  GithubRepositoryView,
  NotFound,
  StoreFailure,
} from "@mend/api-contracts";
import { AuditEventsRepo, ProjectsRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import { PROJECT_NAME_PATTERN } from "@mend/domain/workbench";
import { gh, PullRequestWorkspaces } from "@mend/landing";
import { Effect, Schema } from "effect";

import { ProjectAccess } from "./access.ts";

/** Rename project metadata without moving its store or any worktree. */
export const renameProject = Effect.fn("ProjectOperations.rename")(function* (
  id: ProjectId,
  name: string,
) {
  const previous = yield* (yield* ProjectAccess).manageProject(id);
  if (!PROJECT_NAME_PATTERN.test(name))
    return yield* new StoreFailure({
      message:
        "Project names use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
    });
  if (previous.scratchOwnerUserId !== null)
    return yield* new StoreFailure({
      message: "The scratch project's name is managed by Mend. Create a named project instead.",
    });
  const project = yield* (yield* ProjectsRepo).setName(id, name).pipe(
    Effect.catchTags({
      ProjectNotFoundError: () => Effect.fail(new NotFound({ id })),
      ProjectNameTakenError: () =>
        Effect.fail(new StoreFailure({ message: `A project named "${name}" already exists.` })),
    }),
  );
  yield* (yield* AuditEventsRepo).record({
    organizationId: project.organizationId,
    actorUserId: (yield* CurrentUser).user.id,
    action: "project.renamed",
    subjectType: "project",
    subjectId: id,
    data: { previousName: previous.name, name },
  });
  return project;
});

const GithubRepository = Schema.Struct({
  nameWithOwner: Schema.String,
  url: Schema.String,
  sshUrl: Schema.String,
  visibility: Schema.Literals(["PUBLIC", "PRIVATE", "INTERNAL"]),
});

/** Resolve GitHub through the caller's connected login. No host credential is consulted. */
export const lookupProjectRepository = Effect.fn("ProjectOperations.lookupRepository")(function* (
  repository: string,
) {
  // Only an owner/name or a GitHub web URL is accepted; argv never contains a flag or another host.
  const slug = repository
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9._-]+$/.test(slug))
    return yield* new GhFailure({
      message: "Enter a GitHub repository as owner/name or https://github.com/owner/name.",
    });
  const caller = yield* CurrentUser;
  return yield* (yield* PullRequestWorkspaces)
    .within({ ownerUserId: caller.user.id, sessionId: null }, (workspace) =>
      Effect.gen(function* () {
        const output = yield* workspace.exec(
          gh(["repo", "view", slug, "--json=nameWithOwner,url,sshUrl,visibility"]),
        );
        if (output.exitCode !== 0)
          return yield* new GhFailure({
            message:
              output.stderr.trim() ||
              "GitHub did not return this repository. Check your connected GitHub login and repository access.",
          });
        const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(GithubRepository))(
          output.stdout,
        ).pipe(
          Effect.mapError(
            () => new GhFailure({ message: "GitHub returned an unreadable repository." }),
          ),
        );
        return yield* Schema.decodeUnknownEffect(GithubRepositoryView)({
          ...value,
          provider: "github",
          // Same transport choice as Mend's web picker, cloneUrlOf in adopt-dialog.tsx.
          cloneUrl:
            value.visibility === "PUBLIC"
              ? `https://github.com/${value.nameWithOwner}`
              : `git@github.com:${value.nameWithOwner}.git`,
        }).pipe(
          Effect.mapError(
            () => new GhFailure({ message: "GitHub returned an incomplete repository." }),
          ),
        );
      }),
    )
    .pipe(
      Effect.catchTag("PullRequestStepError", (error) =>
        Effect.fail(new GhFailure({ message: error.message })),
      ),
    );
});
