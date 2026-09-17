import {
  CurrentUser,
  MendApi,
  NotFound,
  SkillRejected,
  SkillStaleWrite,
  SkillsSyncReport,
} from "@mend/api-contracts";
import {
  ProjectsRepo,
  SkillsRepo,
  type SkillDuplicateNameError,
  type SkillInvalidError,
  type SkillLimitError,
  type SkillOwner,
} from "@mend/db";
import type { ProjectId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";

/**
 * Skill libraries over `SkillsRepo`. Authorization is by scope: user skills
 * belong to the authenticated account (anyone else's read as absent — 404,
 * never 403), project skills are the instance's shared material like every
 * other project surface.
 */

/** Repo write refusals as one readable 422; the message already says which rule bit. */
const rejected = (
  error: SkillInvalidError | SkillDuplicateNameError | SkillLimitError,
): SkillRejected =>
  new SkillRejected({
    message:
      error._tag === "SkillInvalidError"
        ? error.message
        : error._tag === "SkillDuplicateNameError"
          ? `a skill named ${error.name} already exists in that library`
          : `that library is capped at ${error.limit} skills`,
  });

/** New sessions read skills at provision, so pooled skeletons rebake on a library change. */
const rewarmForOwner = (owner: SkillOwner) =>
  Effect.gen(function* () {
    const engine = yield* SessionEngine;
    const projects = yield* ProjectsRepo;
    if (owner.scope === "project") {
      yield* engine.reconcileHotSessions(owner.projectId);
      return;
    }
    const all = yield* projects.list();
    yield* Effect.forEach(
      all.filter((project) => project.hotSessions > 0),
      (project) => engine.reconcileHotSessions(project.id),
    );
  });

const resolveOwner = (
  caller: { readonly user: { readonly id: string } },
  payload: { readonly scope: "user" | "project"; readonly projectId: ProjectId | null },
): Effect.Effect<SkillOwner, SkillRejected> =>
  payload.scope === "user"
    ? Effect.succeed({ scope: "user", userId: caller.user.id })
    : payload.projectId === null
      ? Effect.fail(new SkillRejected({ message: "a project skill needs a projectId" }))
      : Effect.succeed({ scope: "project", projectId: payload.projectId });

/**
 * A project skill is the project's shared material, so it is as visible as the project
 * (docs/adr/0002); a user skill was already gated above. The skill id is what reads absent.
 */
const visibleSkillProject = Effect.fn("Skills.visibleSkillProject")(function* (
  projectId: ProjectId | null,
  skillId: string,
) {
  if (projectId === null) return;
  const access = yield* ProjectAccess;
  yield* access.project(projectId).pipe(Effect.mapError(() => new NotFound({ id: skillId })));
});

export const SkillsGroupLive = HttpApiBuilder.group(MendApi, "skills", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        return yield* repo.listForUser(caller.user.id);
      }),
    )
    .handle("forProject", ({ params }) =>
      Effect.gen(function* () {
        const repo = yield* SkillsRepo;
        yield* (yield* ProjectAccess).project(params.id);
        return yield* repo.listForProject(params.id);
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        const bundle = yield* repo
          .byId(params.skillId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.skillId })));
        if (bundle.skill.scope === "user" && bundle.skill.ownerUserId !== caller.user.id) {
          return yield* new NotFound({ id: params.skillId });
        }
        yield* visibleSkillProject(bundle.skill.projectId, params.skillId);
        return bundle;
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        const owner = yield* resolveOwner(caller, payload);
        if (owner.scope === "project") yield* (yield* ProjectAccess).project(owner.projectId);
        const bundle = yield* repo
          .create(owner, {
            name: payload.name,
            description: payload.description,
            files: payload.files,
          })
          .pipe(
            Effect.catchTag("ProjectNotFoundError", (error) =>
              Effect.fail(new NotFound({ id: error.projectId })),
            ),
            Effect.catchTags({
              SkillInvalidError: (error) => Effect.fail(rejected(error)),
              SkillDuplicateNameError: (error) => Effect.fail(rejected(error)),
              SkillLimitError: (error) => Effect.fail(rejected(error)),
            }),
          );
        yield* rewarmForOwner(owner);
        return bundle;
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        const current = yield* repo
          .byId(params.skillId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.skillId })));
        if (current.skill.scope === "user" && current.skill.ownerUserId !== caller.user.id) {
          return yield* new NotFound({ id: params.skillId });
        }
        yield* visibleSkillProject(current.skill.projectId, params.skillId);
        const bundle = yield* repo
          .update(params.skillId, {
            name: payload.name,
            description: payload.description,
            files: payload.files,
            expectedRevision: payload.expectedRevision,
          })
          .pipe(
            Effect.catchTags({
              SkillNotFoundError: () => Effect.fail(new NotFound({ id: params.skillId })),
              SkillInvalidError: (error) => Effect.fail(rejected(error)),
              SkillDuplicateNameError: (error) => Effect.fail(rejected(error)),
              SkillStaleWriteError: (error) =>
                Effect.fail(
                  new SkillStaleWrite({
                    skillId: params.skillId,
                    currentRevision: error.currentRevision,
                  }),
                ),
            }),
          );
        yield* rewarmForOwner(
          bundle.skill.projectId === null
            ? { scope: "user", userId: caller.user.id }
            : { scope: "project", projectId: bundle.skill.projectId },
        );
        return bundle;
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        const current = yield* repo
          .byId(params.skillId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.skillId })));
        if (current.skill.scope === "user" && current.skill.ownerUserId !== caller.user.id) {
          return yield* new NotFound({ id: params.skillId });
        }
        yield* visibleSkillProject(current.skill.projectId, params.skillId);
        yield* repo
          .remove(params.skillId)
          .pipe(Effect.mapError(() => new NotFound({ id: params.skillId })));
        yield* rewarmForOwner(
          current.skill.projectId === null
            ? { scope: "user", userId: caller.user.id }
            : { scope: "project", projectId: current.skill.projectId },
        );
      }),
    )
    .handle("sync", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* SkillsRepo;
        const owner = yield* resolveOwner(caller, payload);
        if (owner.scope === "project") yield* (yield* ProjectAccess).project(owner.projectId);
        const report = yield* repo.sync(owner, payload.skills, { prune: payload.prune }).pipe(
          Effect.catchTag("ProjectNotFoundError", (error) =>
            Effect.fail(new NotFound({ id: error.projectId })),
          ),
          Effect.catchTags({
            SkillInvalidError: (error) => Effect.fail(rejected(error)),
            SkillDuplicateNameError: (error) => Effect.fail(rejected(error)),
            SkillLimitError: (error) => Effect.fail(rejected(error)),
          }),
        );
        yield* rewarmForOwner(owner);
        return new SkillsSyncReport(report);
      }),
    ),
);
