import { projectNameFrom, repositoryCloneUrlIssue } from "@mend/domain/workbench";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  ProjectMutationError,
  SourceControlProviderKind,
  SourceControlRepositoryError,
  type Project,
  type AuthEnvironmentScope,
  type SourceControlDiscoveryResult,
  type ProjectMutation,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlRepositoryLookupInput,
  type SourceControlRepositoryInfo,
} from "@mend/t3-contracts";
import { Effect, Option } from "effect";

import type { PersonHub } from "./hub.ts";
import { projectWorkspaceRootOf } from "./project-paths.ts";
import type { BearerSession } from "./state.ts";

const github = SourceControlProviderKind.make("github");

/** Blocking repository adoption and project metadata operations for one paired person. */
export interface ProjectOperations {
  readonly discovery: () => Effect.Effect<
    SourceControlDiscoveryResult,
    EnvironmentAuthorizationError
  >;
  readonly lookup: (
    input: SourceControlRepositoryLookupInput,
  ) => Effect.Effect<
    SourceControlRepositoryInfo,
    SourceControlRepositoryError | EnvironmentAuthorizationError
  >;
  readonly clone: (
    input: SourceControlCloneRepositoryInput,
  ) => Effect.Effect<
    SourceControlCloneRepositoryResult,
    SourceControlRepositoryError | EnvironmentAuthorizationError
  >;
  readonly mutate: (
    input: Exclude<ProjectMutation, { readonly type: "project.delete" }>,
  ) => Effect.Effect<Project, ProjectMutationError | EnvironmentAuthorizationError>;
}

/** Uses Mend's adoption and ownership checks; client destination paths only supply a name. */
export const makeProjectOperations = (
  hub: PersonHub,
  session: BearerSession,
): ProjectOperations => {
  // Pinned T3 drops repository metadata between lookup and blocking clone on this connection.
  // Remember Mend's transport choice without changing the repository's web URL.
  const cloneUrls = new Map<string, string>();
  const authorize = (...scopes: ReadonlyArray<AuthEnvironmentScope>) =>
    Effect.gen(function* () {
      if (hub.isRefused(session.deviceToken))
        return yield* new EnvironmentAuthorizationError({
          message: "Mend no longer accepts this device. Pair again from Mend.",
          requiredScope: AuthOrchestrationReadScope,
        });
      for (const scope of scopes) {
        if (!session.scopes.includes(scope))
          return yield* new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${scope}.`,
            requiredScope: scope,
          });
      }
    });
  const failed = (operation: string, detail: string) =>
    new SourceControlRepositoryError({ provider: github, operation, detail });
  const lookup: ProjectOperations["lookup"] = (input) =>
    Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      if (input.provider !== github)
        return yield* failed(
          "lookupRepository",
          "Only GitHub repository lookup is available. Add another host by its Git URL.",
        );
      const { cloneUrl, ...repository } = yield* hub.mend
        .lookupRepository(session.deviceToken, input.repository)
        .pipe(Effect.mapError((error) => failed("lookupRepository", error.message)));
      cloneUrls.set(repository.url, cloneUrl);
      return repository;
    });
  const clone: ProjectOperations["clone"] = (input) =>
    Effect.gen(function* () {
      yield* authorize(AuthSourceControlWriteScope, AuthOrchestrationOperateScope);
      if (input.provider !== undefined && input.provider !== github)
        return yield* failed(
          "cloneRepository",
          "Only the GitHub picker is available. Add another host by its Git URL.",
        );
      const repository =
        input.remoteUrl !== undefined
          ? null
          : input.repository === undefined
            ? null
            : yield* lookup({ provider: input.provider ?? github, repository: input.repository });
      const requestedUrl =
        input.remoteUrl ?? (input.protocol === "ssh" ? repository?.sshUrl : repository?.url);
      const remoteUrl =
        requestedUrl === undefined
          ? undefined
          : input.protocol === "https"
            ? requestedUrl
            : (cloneUrls.get(requestedUrl) ?? requestedUrl);
      if (remoteUrl === undefined)
        return yield* failed("cloneRepository", "Enter a Git URL or choose a GitHub repository.");
      const problem = repositoryCloneUrlIssue(remoteUrl);
      if (problem !== null) return yield* failed("cloneRepository", problem);
      const name = projectNameFrom(
        input.destinationPath.split(/[/\\]/).filter(Boolean).at(-1) ??
          repository?.nameWithOwner.split("/").at(-1) ??
          "project",
      );
      const project = yield* hub
        .createProject(session, { kind: "adopt", name, source: remoteUrl })
        .pipe(Effect.mapError((error) => failed("cloneRepository", error.message)));
      return { cwd: projectWorkspaceRootOf(project, session.mendUser.id), remoteUrl, repository };
    });
  const discovery: ProjectOperations["discovery"] = () =>
    Effect.gen(function* () {
      yield* authorize(AuthOrchestrationReadScope);
      const accounts = yield* hub.mend
        .connectedAccounts(session.deviceToken)
        .pipe(Effect.orElseSucceed(() => null));
      const account = accounts?.find(
        (a) => a.provider === "github" && a.isDefault && a.status === "active",
      );
      const login = account?.metadata?.login;
      return {
        versionControlSystems: [
          {
            kind: "git",
            implemented: true,
            label: "Git",
            status: "available",
            version: Option.none(),
            installHint: "Git is managed by Mend.",
            detail: Option.some("Repositories are adopted into Mend's central store."),
          },
        ],
        sourceControlProviders: [
          {
            kind: github,
            label: "GitHub",
            status: "available",
            version: Option.none(),
            installHint: "Connect GitHub in Mend's connected accounts.",
            detail: Option.some("Repository lookup uses your connected GitHub login."),
            auth: {
              status:
                accounts === null
                  ? "unknown"
                  : account === undefined
                    ? "unauthenticated"
                    : "authenticated",
              account:
                typeof login === "string" && login.length > 0 ? Option.some(login) : Option.none(),
              host: Option.some("github.com"),
              detail: Option.some(
                accounts === null
                  ? "Mend could not read your connected accounts."
                  : account === undefined
                    ? "Connect and select a GitHub login in Mend."
                    : "Mend reports your selected GitHub login as active.",
              ),
            },
          },
        ],
      };
    });
  const mutate: ProjectOperations["mutate"] = (input) =>
    Effect.gen(function* () {
      yield* authorize(AuthOrchestrationOperateScope);
      const refuse = (message: string) =>
        new ProjectMutationError({ commandId: input.commandId, message });
      if (input.type === "project.create")
        return yield* refuse(
          "Add a project by Git URL or use New project. Importing a folder from your machine is not available yet.",
        );
      const fields = Object.entries(input).filter(
        ([key, value]) =>
          !["type", "commandId", "projectId", "title"].includes(key) && value !== undefined,
      );
      if (fields.length > 0)
        return yield* refuse(
          `Project settings are edited in Mend. This request changes ${fields.map(([key]) => key).join(", ")}.`,
        );
      if (input.title === undefined) {
        const existing = (yield* hub.shellSnapshot.pipe(
          Effect.mapError(() => refuse("Mend could not read the project.")),
        )).projects.find((p) => p.id === input.projectId);
        if (existing === undefined)
          return yield* refuse("This project is not in your environment.");
        return { ...existing, deletedAt: null };
      }
      const project = yield* hub.mend
        .renameProject(session.deviceToken, input.projectId, input.title)
        .pipe(Effect.mapError((error) => refuse(error.message)));
      yield* hub
        .refreshProject(project.id)
        .pipe(
          Effect.mapError(() =>
            refuse(`Mend renamed the project to ${project.name}. Refresh this window to show it.`),
          ),
        );
      const shown = (yield* hub.shellSnapshot.pipe(
        Effect.mapError(() => refuse("Mend could not read the renamed project.")),
      )).projects.find((p) => p.id === project.id);
      if (shown === undefined)
        return yield* refuse(
          `Mend renamed the project to ${project.name}. Refresh this window to show it.`,
        );
      return { ...shown, deletedAt: null };
    });
  return { discovery, lookup, clone, mutate };
};
