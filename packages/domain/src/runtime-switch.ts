import { Schema } from "effect";

import { ProjectId } from "./ids.ts";
import {
  environmentRefusal,
  hostDirectoriesRefusal,
  newProjectWorkspaceImage,
  RuntimeKind,
  type RuntimeSupport,
  type RuntimeSupportReading,
} from "./runtime-support.ts";
import { WorkspaceImage } from "./settings.ts";

/**
 * What moving an organization's new sessions to another runtime would change for them, from what
 * Sealant says that runtime supports (SLNT-796). It is about new sessions only: an existing
 * worktree keeps the runtime it was created on.
 */

/** An environment the runtime cannot run, and the one Mend would move it to. */
const EnvironmentMoveFields = {
  /** Sealant's reason the runtime cannot run `from`. */
  refusal: Schema.String,
  from: WorkspaceImage,
  /** Mend's default packages on the first OS family the runtime runs; null when it runs none. */
  to: Schema.NullOr(WorkspaceImage),
};

export const OrganizationEnvironmentMove = Schema.Struct({
  ...EnvironmentMoveFields,
  /** True while the organization follows the instance's environment rather than its own. */
  inherited: Schema.Boolean,
});
export type OrganizationEnvironmentMove = typeof OrganizationEnvironmentMove.Type;

export const ProjectEnvironmentMove = Schema.Struct({
  ...EnvironmentMoveFields,
  /** True when the project follows the organization's environment: it moves with that one. */
  inherited: Schema.Boolean,
});
export type ProjectEnvironmentMove = typeof ProjectEnvironmentMove.Type;

/** One project the runtime would treat differently, and how. */
export const ProjectRuntimeImpact = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  /** Its environment, when the runtime cannot run it: no new session there would start. */
  environment: Schema.NullOr(ProjectEnvironmentMove),
  /** Its Services on a port the runtime holds for itself: they could not listen. */
  services: Schema.Array(Schema.Struct({ name: Schema.String, port: Schema.Int })),
  /** Its server folders, when the runtime cannot bind them: sessions start without them. */
  serverFolders: Schema.NullOr(Schema.Struct({ count: Schema.Int, refusal: Schema.String })),
});
export type ProjectRuntimeImpact = typeof ProjectRuntimeImpact.Type;

/**
 * - `observed`: Sealant listed the runtime. `organizationDefault` and `projects` are what it would
 *   not run as they are; both empty and `unseen` zero means nothing changes for new sessions.
 * - `not-launched`: Sealant answered without the runtime. No new session would start there.
 * - `unread`: Sealant did not answer. Mend cannot tell what would change.
 */
export const RuntimeSwitchImpact = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("observed"),
    observedAt: Schema.Date,
    runtime: RuntimeKind,
    organizationDefault: Schema.NullOr(OrganizationEnvironmentMove),
    /** Only projects the caller can see, by name. */
    projects: Schema.Array(ProjectRuntimeImpact),
    /** Affected projects the caller cannot see (another member's private ones): never named. */
    unseen: Schema.Int,
  }),
  Schema.Struct({
    state: Schema.Literal("not-launched"),
    observedAt: Schema.Date,
    runtime: RuntimeKind,
  }),
  Schema.Struct({ state: Schema.Literal("unread"), reason: Schema.String }),
]);
export type RuntimeSwitchImpact = typeof RuntimeSwitchImpact.Type;

/** What an owner chose to move in the same step as the switch. */
export const RuntimeSwitchMoves = Schema.Struct({
  organizationDefault: Schema.Boolean,
  /** Projects whose own environment moves; one that inherits moves with the organization's. */
  projects: Schema.Array(ProjectId),
});
export type RuntimeSwitchMoves = typeof RuntimeSwitchMoves.Type;

/** The facts about one project that the comparison reads. */
export interface ProjectRuntimeFacts {
  readonly id: ProjectId;
  readonly name: string;
  /** Whether the caller can see it; one they cannot is counted, never named. */
  readonly visible: boolean;
  /** Its own environment; null follows the organization's. */
  readonly workspaceImage: WorkspaceImage | null;
  readonly services: ReadonlyArray<{ readonly name: string; readonly port: number }>;
  readonly serverFolders: number;
}

const moveOf = (support: RuntimeSupport, image: WorkspaceImage) => {
  const refusal = environmentRefusal(support, image);
  return refusal === null
    ? null
    : { refusal, from: image, to: newProjectWorkspaceImage(image, support) };
};

const projectImpact = (
  support: RuntimeSupport,
  inheritedMove: ReturnType<typeof moveOf>,
  project: ProjectRuntimeFacts,
): ProjectRuntimeImpact | null => {
  const own = project.workspaceImage === null ? null : moveOf(support, project.workspaceImage);
  const environment =
    project.workspaceImage === null
      ? inheritedMove === null
        ? null
        : { ...inheritedMove, inherited: true }
      : own === null
        ? null
        : { ...own, inherited: false };
  const services = project.services.filter((service) =>
    support.reservedPorts.includes(service.port),
  );
  const folderRefusal = project.serverFolders > 0 ? hostDirectoriesRefusal(support) : null;
  const serverFolders =
    folderRefusal === null ? null : { count: project.serverFolders, refusal: folderRefusal };
  if (environment === null && services.length === 0 && serverFolders === null) return null;
  return { id: project.id, name: project.name, environment, services, serverFolders };
};

/**
 * Compare the organization's default environment and its projects with what the runtime supports.
 * A project the runtime runs as it is does not appear.
 */
export const runtimeSwitchImpact = (input: {
  readonly reading: RuntimeSupportReading;
  /** The organization's environment, and whether it is the instance's. */
  readonly organizationDefault: { readonly image: WorkspaceImage; readonly inherited: boolean };
  readonly projects: ReadonlyArray<ProjectRuntimeFacts>;
}): RuntimeSwitchImpact => {
  const { reading } = input;
  if (reading.state !== "observed") return reading;
  const support = reading.support;
  const inheritedMove = moveOf(support, input.organizationDefault.image);
  const affected = input.projects.flatMap((project) => {
    const impact = projectImpact(support, inheritedMove, project);
    return impact === null ? [] : [{ impact, visible: project.visible }];
  });
  return {
    state: "observed",
    observedAt: reading.observedAt,
    runtime: support.runtime,
    organizationDefault:
      inheritedMove === null
        ? null
        : { ...inheritedMove, inherited: input.organizationDefault.inherited },
    projects: affected.filter((entry) => entry.visible).map((entry) => entry.impact),
    unseen: affected.filter((entry) => !entry.visible).length,
  };
};

/** Whether the switch changes nothing for new sessions, as far as Sealant's report shows. */
export const switchChangesNothing = (impact: RuntimeSwitchImpact): boolean =>
  impact.state === "observed" &&
  impact.organizationDefault === null &&
  impact.projects.length === 0 &&
  impact.unseen === 0;

/**
 * Every move the impact offers: the organization's environment when it has a target, and each
 * visible project's own environment that has one. Projects that inherit move with the
 * organization's.
 */
export const offeredMoves = (impact: RuntimeSwitchImpact): RuntimeSwitchMoves => {
  if (impact.state !== "observed") return { organizationDefault: false, projects: [] };
  return {
    organizationDefault:
      impact.organizationDefault !== null && impact.organizationDefault.to !== null,
    projects: impact.projects.flatMap((project) =>
      project.environment !== null &&
      !project.environment.inherited &&
      project.environment.to !== null
        ? [project.id]
        : [],
    ),
  };
};

/** Whether `moves` moves anything. */
export const movesAnything = (moves: RuntimeSwitchMoves | undefined): boolean =>
  moves !== undefined && (moves.organizationDefault || moves.projects.length > 0);
