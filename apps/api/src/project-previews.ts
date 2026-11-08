import {
  ProjectPreviewRefused,
  type ProjectPreviewTarget,
  type ProjectPreviewView,
} from "@mend/api-contracts";
import {
  PreviewsRepo,
  ProjectsRepo,
  ProjectServiceRecipesRepo,
  SessionsRepo,
  WorktreesRepo,
} from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  previewAuthTarget,
  previewStatusLine,
  type PreviewDeclaration,
} from "@mend/domain/workbench";
import { ProjectLocalWorktrees, SessionEngine, WorktreeReads } from "@mend/sessions";
import {
  LEGACY_MEND_TOML,
  MEND_TOML,
  parseMendToml,
  resolveDeclarations,
} from "@mend/sessions/recipes";
import { Context, Effect, Layer, Semaphore } from "effect";

import { Budgets } from "./budgets.ts";
import { PreviewSetupConfig } from "./preview-config.ts";
import { describeWorktreePreviews } from "./preview-reads.ts";
import { previewOriginOf } from "./preview-routing.ts";
import { requireSessionRoom } from "./session-budgets.ts";

type PreviewReadNeeds = Effect.Services<ReturnType<typeof describeWorktreePreviews>>;

/** Coordinates the project address without creating a checkout on a read or a target choice. */
export class ProjectPreviews extends Context.Service<
  ProjectPreviews,
  {
    readonly read: (projectId: ProjectId) => Effect.Effect<ProjectPreviewView>;
    readonly use: (
      projectId: ProjectId,
      target: ProjectPreviewTarget,
    ) => Effect.Effect<ProjectPreviewView, ProjectPreviewRefused>;
    readonly start: (
      projectId: ProjectId,
      userId: string,
    ) => Effect.Effect<ProjectPreviewView, ProjectPreviewRefused>;
  }
>()("@mend/api/ProjectPreviews") {}

const refused = (message: string) => new ProjectPreviewRefused({ message });
const FILE_LIMIT = 256 * 1024;
const SESSION_LABEL = "Project preview";

const make: Effect.Effect<
  ProjectPreviews["Service"],
  never,
  | PreviewsRepo
  | ProjectsRepo
  | ProjectServiceRecipesRepo
  | SessionsRepo
  | WorktreesRepo
  | ProjectLocalWorktrees
  | SessionEngine
  | WorktreeReads
  | PreviewSetupConfig
  | PreviewReadNeeds
  | Budgets
> = Effect.gen(function* () {
  const previews = yield* PreviewsRepo;
  const projects = yield* ProjectsRepo;
  const recipes = yield* ProjectServiceRecipesRepo;
  const sessions = yield* SessionsRepo;
  const worktrees = yield* WorktreesRepo;
  const local = yield* ProjectLocalWorktrees;
  const engine = yield* SessionEngine;
  const reads = yield* WorktreeReads;
  const { setup } = yield* PreviewSetupConfig;
  const readContext = yield* Effect.context<PreviewReadNeeds | Budgets | SessionsRepo>();
  const operations = new Map<ProjectId, Semaphore.Semaphore>();
  const serialize = <A, E, R>(id: ProjectId, effect: Effect.Effect<A, E, R>) => {
    const lock = operations.get(id) ?? Semaphore.makeUnsafe(1);
    operations.set(id, lock);
    return lock.withPermit(effect);
  };

  const declaration = Effect.fn("ProjectPreviews.declaration")(function* (id: ProjectId) {
    const checkout = yield* local
      .find(id)
      .pipe(Effect.mapError(() => refused("The project could not be read.")));
    const load = (name: string) =>
      (checkout === null
        ? reads.readDefaultBranchFile(id, name, FILE_LIMIT)
        : reads.readFile(id, checkout.id, name, null, FILE_LIMIT)
      ).pipe(
        Effect.mapError(() =>
          refused(
            "The default branch's .mend/mend.toml could not be read. Start or restore its shared Local worktree, then retry.",
          ),
        ),
      );
    let path = MEND_TOML;
    let file = (yield* load(path)).value;
    if (file === null) {
      path = LEGACY_MEND_TOML;
      file = (yield* load(path)).value;
    }
    if (file === null) return null;
    if (file.binary || file.truncated)
      return yield* refused(`${path} must be text no larger than 256 KiB.`);
    const parsed = yield* parseMendToml(new TextDecoder().decode(file.bytes), path).pipe(
      Effect.mapError((error) => refused(error.message)),
    );
    const declared = resolveDeclarations(parsed, yield* recipes.listForProject(id));
    const issue = declared.refused.find((item) => item.key.startsWith("preview."));
    if (issue !== undefined) return yield* refused(`${issue.key} ${issue.message}`);
    return declared.preview?.fixed === true ? declared.preview : null;
  });

  const requireDeclaration = Effect.fn("ProjectPreviews.requireDeclaration")(function* (
    id: ProjectId,
  ) {
    if (setup._tag === "Off") return yield* refused("Previews are off on this Mend server.");
    const declared = yield* declaration(id);
    if (declared === null)
      return yield* refused(
        'Declare [preview] service = "web" and fixed = true in the default branch\'s .mend/mend.toml first.',
      );
    return declared;
  });

  const address = Effect.fn("ProjectPreviews.address")(function* (
    id: ProjectId,
    declared: PreviewDeclaration,
  ) {
    const fixed = yield* previews
      .ensureProject(id, declared.service)
      .pipe(Effect.mapError(() => refused("The project is no longer available.")));
    if (setup._tag === "On" && setup.routing.mode === "tailnet-https") {
      const port = yield* previews.assignTailnetPort(fixed.preview.id, setup.routing.ports);
      switch (port._tag) {
        case "Assigned":
          break;
        case "Removed":
          return yield* refused("The project is no longer available.");
        case "PoolFull":
          return yield* refused(
            "No preview port is free. Ask the operator to add preview ports; fixed project reservations are never reclaimed for inactivity.",
          );
        case "ReservedOutsidePool":
          return yield* refused(
            `This project's fixed preview reserves port ${port.port}. Ask the operator to restore that port to the preview pool; Mend will not change its registered address.`,
          );
      }
    }
    return fixed;
  });

  const read = Effect.fn("ProjectPreviews.read")(function* (id: ProjectId) {
    const config = yield* declaration(id).pipe(Effect.result);
    const fixed = yield* previews.projectPreview(id);
    const preview = fixed?.preview ?? null;
    const target =
      preview?.worktreeId == null
        ? null
        : yield* worktrees.byId(preview.worktreeId).pipe(Effect.orElseSucceed(() => null));
    const port =
      preview === null
        ? null
        : ((yield* previews.tailnetPorts([preview.id])).get(preview.id) ?? null);
    const url =
      setup._tag !== "On" || preview === null
        ? null
        : previewOriginOf(setup.routing, { label: preview.label, tailnetPort: port });
    const view = preview === null ? null : yield* previews.resolveById(preview.id);
    const described =
      target === null || view === null
        ? null
        : ((yield* describeWorktreePreviews(target.id, [view], setup).pipe(
            Effect.provideContext(readContext),
          )).previews[0] ?? null);
    const status =
      config._tag === "Failure"
        ? [config.failure.message]
        : setup._tag === "Off"
          ? ["Previews are off on this Mend server."]
          : config.success === null
            ? ["No fixed preview is declared on the default branch."]
            : target === null
              ? [
                  fixed?.targetMode === "worktree"
                    ? "The selected worktree was removed. Choose a target."
                    : "Not started. Start uses the project's shared Local worktree.",
                ]
              : described === null || described.facts.length === 0
                ? ["Preview not prepared. Start its Service."]
                : described.facts.map((fact) => previewStatusLine(fact, { stable: true }));
    return {
      configured: config._tag === "Success" && config.success !== null,
      fixed,
      url,
      target: target === null ? null : { id: target.id, name: target.name, branch: target.branch },
      status,
      open:
        described?.open._tag === "Open" && preview !== null
          ? previewAuthTarget(preview.id, "/")
          : null,
      canManage: false,
    } satisfies ProjectPreviewView;
  });

  const use = Effect.fn("ProjectPreviews.use")(function* (
    id: ProjectId,
    target: ProjectPreviewTarget,
  ) {
    return yield* serialize(
      id,
      Effect.gen(function* () {
        const declared = yield* requireDeclaration(id);
        yield* address(id, declared);
        const selection =
          target._tag === "Default"
            ? {
                mode: "default" as const,
                worktreeId:
                  (yield* local
                    .find(id)
                    .pipe(Effect.mapError(() => refused("The project could not be read."))))?.id ??
                  null,
              }
            : { mode: "worktree" as const, worktreeId: target.worktreeId };
        yield* previews
          .useProject(id, selection)
          .pipe(Effect.mapError(() => refused("That worktree is no longer in this project.")));
        return yield* read(id);
      }),
    );
  });

  const start = Effect.fn("ProjectPreviews.start")(function* (id: ProjectId, userId: string) {
    return yield* serialize(
      id,
      Effect.gen(function* () {
        const declared = yield* requireDeclaration(id);
        let fixed = yield* address(id, declared);
        if (fixed.targetMode === "default") {
          const checkout = yield* local
            .start(id, userId)
            .pipe(
              Effect.mapError(() =>
                refused(
                  "The shared Local worktree could not be started. Its edits were kept. Check the project's default branch and retry.",
                ),
              ),
            );
          fixed = yield* previews
            .useProject(id, { mode: "default", worktreeId: checkout.id })
            .pipe(
              Effect.mapError(() => refused("The shared Local worktree is no longer available.")),
            );
        }
        const worktreeId = fixed.preview.worktreeId;
        if (worktreeId === null)
          return yield* refused(
            "The selected worktree was removed. Choose another target or use --default.",
          );
        const binding = (yield* previews.resolveById(fixed.preview.id))?.binding;
        if (binding?._tag === "Bound") {
          yield* previews.changeControl(fixed.preview.id, {
            _tag: "Start",
            seq: yield* previews.nextControlSeq(),
          });
          return yield* read(id);
        }
        const members = yield* sessions.listForWorktree(worktreeId);
        let holder = members.find(
          (session) =>
            session.harness === "shell" &&
            session.label === SESSION_LABEL &&
            session.ownerUserId === userId,
        );
        if (holder === undefined) {
          const project = yield* projects
            .byId(id)
            .pipe(Effect.mapError(() => refused("The project is no longer available.")));
          yield* requireSessionRoom(userId, project.organizationId).pipe(
            Effect.provideContext(readContext),
            Effect.mapError((error) => refused(error.message)),
          );
          holder = yield* engine
            .provisionSessionIn(worktreeId, {
              harness: "shell",
              label: SESSION_LABEL,
              ownerUserId: userId,
              autoLand: false,
            })
            .pipe(
              Effect.mapError(() =>
                refused("A preview session could not be created. The worktree was kept."),
              ),
            );
        }
        yield* engine
          .wakeWorkspace(holder.id, { reason: "preview", runsAs: userId })
          .pipe(
            Effect.mapError(() =>
              refused(
                "The preview workspace could not be started. Its worktree and registered address were kept.",
              ),
            ),
          );
        const current = yield* engine
          .serviceDeclarations(holder.id)
          .pipe(
            Effect.mapError(() =>
              refused("The target worktree's Service recipes could not be read."),
            ),
          );
        if (
          !current.recipes.some(
            (recipe) =>
              recipe.name === declared.service &&
              recipe.browserScheme === "http" &&
              recipe.command !== null &&
              recipe.shadowedBy === null,
          )
        )
          return yield* refused(
            `The target worktree needs a runnable HTTP Service named ${declared.service} in .mend/mend.toml.`,
          );
        yield* engine
          .runServiceRecipe(holder.id, declared.service, { kind: "person", userId })
          .pipe(
            Effect.catchTag("ServiceStartUnderWayError", () => Effect.succeed(null)),
            Effect.mapError((error) => refused(error.message)),
          );
        return yield* read(id);
      }),
    );
  });
  return ProjectPreviews.of({ read, use, start });
});

/** The API supplies its existing engine, read services and shared Local-worktree service once. */
export const ProjectPreviewsLive: Layer.Layer<
  ProjectPreviews,
  never,
  | PreviewsRepo
  | ProjectsRepo
  | ProjectServiceRecipesRepo
  | SessionsRepo
  | WorktreesRepo
  | ProjectLocalWorktrees
  | SessionEngine
  | WorktreeReads
  | PreviewSetupConfig
  | PreviewReadNeeds
  | Budgets
> = Layer.effect(ProjectPreviews, make);
