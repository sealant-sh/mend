import { CurrentUser } from "@mend/api-contracts";
import { OrganizationsRepo, ProjectsRepo, UserGitAccessRepo, UserGitAuthorRepo } from "@mend/db";
import { ProjectId } from "@mend/domain";
import {
  firstCommitAuthor,
  type Project,
  type ProjectName,
  projectNameCandidates,
  scratchProjectName,
} from "@mend/domain/workbench";
import { Store } from "@mend/store";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

/** A creation refusal a caller can display without persistence or Git details. */
export class ProjectCreationRefused extends Schema.TaggedError<ProjectCreationRefused>()(
  "ProjectCreationRefused",
  { message: Schema.String },
) {}

/** Owns name allocation and repository publication for both source-free entrypoints. */
export class ProjectCreation extends Context.Service<
  ProjectCreation,
  {
    readonly createNew: (
      name: ProjectName,
    ) => Effect.Effect<Project, ProjectCreationRefused, CurrentUser>;
    readonly ensureScratch: () => Effect.Effect<Project, ProjectCreationRefused, CurrentUser>;
  }
>()("@mend/api/ProjectCreation") {}

/** Request identity is read per operation, never captured when the layer is built. */
export const ProjectCreationLive: Layer.Layer<
  ProjectCreation,
  never,
  OrganizationsRepo | ProjectsRepo | UserGitAccessRepo | UserGitAuthorRepo | Store
> = Layer.effect(
  ProjectCreation,
  Effect.gen(function* () {
    const organizations = yield* OrganizationsRepo;
    const projects = yield* ProjectsRepo;
    const authors = yield* UserGitAuthorRepo;
    const access = yield* UserGitAccessRepo;
    const store = yield* Store;
    const refuse = (message: string) => Effect.fail(new ProjectCreationRefused({ message }));
    const create = Effect.fn("ProjectCreation.create")(function* (requested: ProjectName | null) {
      const caller = yield* CurrentUser;
      const membership = yield* organizations.membershipOf(caller.user.id);
      if (membership === null)
        return yield* refuse(
          "This account belongs to no organization, so it cannot create projects.",
        );
      const organizationId = membership.organization.id;
      const scratch = requested === null;
      const existing = () =>
        projects
          .byScratchOwner(caller.user.id)
          .pipe(
            Effect.flatMap((project) =>
              project === null || project.organizationId === organizationId
                ? Effect.succeed(project)
                : refuse(
                    "The scratch project belongs to a different organization. Ask an organization owner to recover it.",
                  ),
            ),
          );
      if (scratch) {
        const project = yield* existing();
        if (project !== null) return project;
      }
      const author = firstCommitAuthor((yield* authors.resolve(caller.user.id)) ?? caller.user);
      const gitAuthMode = (yield* access.mode(caller.user.id)) ?? "mend-key";
      const base = requested ?? scratchProjectName(caller.user);
      for (const name of projectNameCandidates(base)) {
        if (scratch) {
          const project = yield* existing();
          if (project !== null) return project;
        }
        if ((yield* projects.byName(organizationId, name)) !== null) continue;
        const id = ProjectId.make(crypto.randomUUID());
        // Keep the ownership handoff to SQL uninterrupted; only confirmed rollback permits cleanup.
        const made = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const repository = yield* store
              .createRepository(id, {
                readme: `# ${name}\n`,
                author,
                at: yield* DateTime.nowAsDate,
              })
              .pipe(
                Effect.mapError((error) => new ProjectCreationRefused({ message: error.message })),
              );
            const inserted = yield* projects
              .publishInitialized({
                id,
                organizationId,
                createdByUserId: caller.user.id,
                name,
                storePath: repository.storePath,
                gitAuthMode,
                purpose: scratch ? "scratch" : "named",
              })
              .pipe(
                Effect.map((project) => ({ kind: "created" as const, project })),
                Effect.catchTags({
                  ProjectNameTakenError: () => Effect.succeed({ kind: "conflict" as const }),
                  ScratchProjectExistsError: () => Effect.succeed({ kind: "conflict" as const }),
                  ProjectMembershipChanged: () => Effect.succeed({ kind: "departed" as const }),
                  ProjectNotPublished: () => Effect.succeed({ kind: "unpublished" as const }),
                  ProjectPublicationUnconfirmed: () =>
                    refuse(
                      "Project creation could have completed, but Mend could not confirm it. Refresh projects before trying again.",
                    ),
                }),
              );
            if (inserted.kind === "created") return inserted.project;
            const removed = yield* store.removeProjectStore(repository.storePath);
            if (removed.leftover !== null)
              return yield* refuse(
                "The unused project repository could not be removed. Ask the operator to inspect the store.",
              );
            if (inserted.kind === "departed")
              return yield* refuse("Organization membership changed during project creation.");
            if (inserted.kind === "unpublished")
              return yield* refuse(
                "Mend could not register the project, so it made nothing. Try again.",
              );
            return null;
          }),
        );
        if (made !== null) return made;
        if (scratch) {
          const project = yield* existing();
          if (project !== null) return project;
        }
      }
      if (scratch) {
        const project = yield* existing();
        if (project !== null) return project;
      }
      return yield* refuse("No project name is available for this request. Choose another name.");
    });
    return { createNew: (name) => create(name), ensureScratch: () => create(null) };
  }),
);
