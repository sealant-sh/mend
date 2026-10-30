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
    const exhausted = refuse("No project name is available for this request. Choose another name.");

    const currentCreator = Effect.gen(function* () {
      const caller = yield* CurrentUser;
      const membership = yield* organizations.membershipOf(caller.user.id);
      if (membership === null)
        return yield* refuse(
          "This account belongs to no organization, so it cannot create projects.",
        );
      return { user: caller.user, organizationId: membership.organization.id };
    });
    type Creator = Effect.Success<typeof currentCreator>;

    /** The repository is the attempt's until SQL takes it; "lost" means another request won. */
    const attempt = (creator: Creator, name: ProjectName, purpose: "named" | "scratch") =>
      Effect.gen(function* () {
        const author = firstCommitAuthor((yield* authors.resolve(creator.user.id)) ?? creator.user);
        const gitAuthMode = (yield* access.mode(creator.user.id)) ?? "mend-key";
        const id = ProjectId.make(crypto.randomUUID());
        // Keep the ownership handoff to SQL uninterrupted; only confirmed rollback permits cleanup.
        return yield* Effect.uninterruptible(
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
                organizationId: creator.organizationId,
                createdByUserId: creator.user.id,
                name,
                storePath: repository.storePath,
                defaultBranch: repository.defaultBranch,
                headSha: repository.headSha,
                gitAuthMode,
                purpose,
              })
              .pipe(
                Effect.map((project) => ({ kind: "created" as const, project })),
                Effect.catchTags({
                  ProjectNameTakenError: () => Effect.succeed({ kind: "lost" as const }),
                  ScratchProjectExistsError: () => Effect.succeed({ kind: "lost" as const }),
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
            return "lost" as const;
          }),
        );
      });

    const scratchOf = (creator: Creator) =>
      projects
        .byScratchOwner(creator.user.id)
        .pipe(
          Effect.flatMap((project) =>
            project === null || project.organizationId === creator.organizationId
              ? Effect.succeed(project)
              : refuse(
                  "The scratch project belongs to a different organization. Ask an organization owner to recover it.",
                ),
          ),
        );

    /**
     * The project made from the first free candidate of `base`; null when every one is taken. A
     * scratch request answers with the person's scratch project once a concurrent first use has
     * made it, whichever name it took.
     */
    const allocate = (creator: Creator, base: ProjectName, purpose: "named" | "scratch") =>
      Effect.gen(function* () {
        for (const name of projectNameCandidates(base)) {
          const taken = yield* projects.byName(creator.organizationId, name);
          if (taken !== null) {
            if (purpose === "scratch" && taken.scratchOwnerUserId === creator.user.id) return taken;
            continue;
          }
          const made = yield* attempt(creator, name, purpose);
          if (made !== "lost") return made;
          if (purpose === "scratch") {
            const winner = yield* scratchOf(creator);
            if (winner !== null) return winner;
          }
        }
        return null;
      });

    return {
      createNew: Effect.fn("ProjectCreation.createNew")(function* (name: ProjectName) {
        return (yield* allocate(yield* currentCreator, name, "named")) ?? (yield* exhausted);
      }),
      ensureScratch: Effect.fn("ProjectCreation.ensureScratch")(function* () {
        const creator = yield* currentCreator;
        return (
          (yield* scratchOf(creator)) ??
          (yield* allocate(creator, scratchProjectName(creator.user), "scratch")) ??
          (yield* exhausted)
        );
      }),
    };
  }),
);
