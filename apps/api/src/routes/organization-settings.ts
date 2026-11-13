import {
  OrganizationRuntimeView,
  OrganizationSessionRuntimeView,
  OrganizationSettingsView,
  OrganizationWorkspaceEnvironmentSaveResult,
  SettingsFailure,
  WorkspacePackageResolutionView,
  type OrganizationWorkspaceEnvironmentRequest,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
  OrganizationSettingsRepo,
  ProjectsRepo,
  SettingsRepo,
  type OrganizationMembership,
} from "@mend/db";
import {
  environmentRefusal,
  newProjectWorkspaceImage,
  observedSupport,
  ORGANIZATION_SETTING_KEYS,
  organizationDefaults,
  type OrganizationId,
  OrganizationSettings,
  reservedPortRefusal,
  runtimeName,
  runtimeSupportFor,
  type SessionRuntime,
  sessionRuntimeFor,
  workspaceImagesEqual,
  type WorkspaceImage,
} from "@mend/domain";
import type { AuditData } from "@mend/domain/workbench";
import { WorkspaceRuntimesReport } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { DeploymentConfig, sessionRuntimeOfferOf } from "@mend/store";
import { Effect } from "effect";

import {
  resolveWorkspaceEnvironmentWithSealant,
  unresolvedPackagesMessage,
} from "../services/workspace-environment.ts";

/**
 * An organization's own defaults (docs/adr/0003-organizations-and-tenancy.md, "Resources that were
 * instance-global"). The instance's settings stay the operator's; owners set these over them, and
 * members read what their projects inherit. The group in routes/organization.ts authorizes first.
 */

const sameImage = (left: WorkspaceImage | null, right: WorkspaceImage | null): boolean =>
  left === null || right === null ? left === right : workspaceImagesEqual(left, right);

/** A workspace environment in an audit record: small, and never a package list. */
const imageFact = (image: WorkspaceImage | null): string | null => {
  if (image === null) return null;
  const packages = `${image.packages.length} package${image.packages.length === 1 ? "" : "s"}`;
  return image.mode === "custom"
    ? `custom ${image.baseImage} · ${packages}`
    : `${image.os} · ${packages}`;
};

/**
 * What a save changed, for the audit record: each changed value as it now stands, null where the
 * organization went back to following the instance. Empty when nothing changed.
 */
export const organizationSettingsChanges = (
  before: OrganizationSettings,
  after: OrganizationSettings,
): AuditData => {
  const changes: Record<string, string | boolean | null> = {};
  for (const key of ORGANIZATION_SETTING_KEYS) {
    if (key === "workspaceImage") {
      if (!sameImage(before.workspaceImage, after.workspaceImage)) {
        changes[key] = imageFact(after.workspaceImage);
      }
    } else if (before[key] !== after[key]) {
      changes[key] = after[key];
    }
  }
  return changes;
};

/**
 * Where the organization's new sessions run: its own choice while the server offers it, else the
 * server's default. Project creation and the Boat key's status read this too.
 */
export const organizationSessionRuntime = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const offer = sessionRuntimeOfferOf(yield* DeploymentConfig);
    const chosen = yield* (yield* OrganizationSettingsRepo).sessionRuntime(organizationId);
    return new OrganizationSessionRuntimeView({
      chosen,
      effective: sessionRuntimeFor(offer, chosen),
      offered: offer?.offered ?? [],
      serverDefault: offer?.default ?? null,
    });
  });

/**
 * Where the organization's new sessions run and what Sealant says that runtime supports. The
 * pickers, the save refusals, project creation and the hot sessions page all read this; a project
 * whose worktrees run elsewhere keeps them there, but what it chooses next is for new sessions.
 */
export const organizationRuntime = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const sessionRuntime = yield* organizationSessionRuntime(organizationId);
    const reading = yield* (yield* WorkspaceRuntimesReport).read();
    return new OrganizationRuntimeView({
      sessionRuntime,
      support: runtimeSupportFor(reading, sessionRuntime.effective),
    });
  });

/**
 * Refuse saving an environment the organization's runtime cannot run, with Sealant's reason. An
 * unread report refuses nothing: Mend does not know, and the launch still says why if it fails.
 */
export const refuseUnrunnableEnvironment = (
  organizationId: OrganizationId,
  image: WorkspaceImage,
) =>
  Effect.gen(function* () {
    const { support } = yield* organizationRuntime(organizationId);
    if (support.state !== "observed") return;
    const refusal = environmentRefusal(support.support, image);
    if (refusal === null) return;
    return yield* new SettingsFailure({
      message: `${refusal} New sessions in this organization run on ${runtimeName(support.support.runtime)}, so this environment was not saved.`,
    });
  });

/** Why a Service cannot be declared on `port` where the organization's sessions run; null if it can. */
export const reservedPortRefusalFor = (organizationId: OrganizationId, port: number) =>
  Effect.gen(function* () {
    const { support } = yield* organizationRuntime(organizationId);
    return support.state === "observed" ? reservedPortRefusal(support.support, port) : null;
  });

/**
 * The environment a new project in the organization starts with: null inherits the organization's,
 * unless Sealant says the runtime its sessions run on cannot run that one.
 */
export const newProjectWorkspaceImageFor = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const own = yield* (yield* OrganizationSettingsRepo).get(organizationId);
    const instance = yield* (yield* SettingsRepo).get();
    const { support } = yield* organizationRuntime(organizationId);
    return newProjectWorkspaceImage(
      organizationDefaults(instance, own).workspaceImage,
      observedSupport(support),
    );
  });

/** The organization's values, the instance's under them, and what a project on inherit gets. */
export const organizationSettingsView = (
  found: OrganizationMembership,
  own?: OrganizationSettings,
) =>
  Effect.gen(function* () {
    const organization =
      own ?? (yield* (yield* OrganizationSettingsRepo).get(found.organization.id));
    const instance = yield* (yield* SettingsRepo).get();
    return new OrganizationSettingsView({
      organization,
      instance,
      effective: organizationDefaults(instance, organization),
      editable: found.role === "owner",
      sessionRuntime: yield* organizationSessionRuntime(found.organization.id),
    });
  });

/** Hot standbys are built for one runtime: rewarm every project's after a change of runtime. */
const rewarmProjects = (organizationId: OrganizationId) =>
  Effect.gen(function* () {
    const projects = yield* (yield* ProjectsRepo).listForOrganization(organizationId);
    const engine = yield* SessionEngine;
    yield* Effect.forEach(
      projects.filter((project) => project.hotSessions > 0),
      (project) => engine.reconcileHotSessions(project.id),
      { discard: true },
    );
  });

/**
 * Choose where the organization's new sessions run, as an owner: one of the runtimes the server
 * offers, or null to follow the server's default. Worktrees that exist keep their runtime.
 */
export const saveOrganizationSessionRuntime = (
  found: OrganizationMembership,
  actorUserId: string,
  runtime: SessionRuntime | null,
) =>
  Effect.gen(function* () {
    const offer = sessionRuntimeOfferOf(yield* DeploymentConfig);
    if (runtime !== null && (offer === null || !offer.offered.includes(runtime))) {
      return yield* new SettingsFailure({
        message:
          offer === null
            ? "Sealant picks where sessions run on this server, so an organization cannot choose. Its operator can offer runtimes with MEND_SESSION_RUNTIMES."
            : `This server does not offer ${runtimeName(runtime)} for sessions. It offers ${offer.offered.map(runtimeName).join(" and ")}; its operator changes that with mend server setup --session-runtimes.`,
      });
    }
    const organizationId = found.organization.id;
    const before = yield* (yield* OrganizationSettingsRepo).setSessionRuntime(
      organizationId,
      runtime,
    );
    if (before !== runtime) {
      yield* (yield* AuditEventsRepo).record({
        organizationId,
        actorUserId,
        action: "organization.settings_changed",
        subjectType: "organization",
        subjectId: organizationId,
        data: { sessionRuntime: runtime },
      });
      if (sessionRuntimeFor(offer, before) !== sessionRuntimeFor(offer, runtime))
        yield* rewarmProjects(organizationId);
    }
    return yield* organizationSettingsView(found);
  });

/**
 * Record what changed and, when the workspace environment did, rewarm the hot workspaces of every
 * project that inherits it: their standbys were built from the old one.
 */
const settle = (
  found: OrganizationMembership,
  actorUserId: string,
  before: OrganizationSettings,
  after: OrganizationSettings,
) =>
  Effect.gen(function* () {
    const changes = organizationSettingsChanges(before, after);
    if (Object.keys(changes).length === 0) return;
    yield* (yield* AuditEventsRepo).record({
      organizationId: found.organization.id,
      actorUserId,
      action: "organization.settings_changed",
      subjectType: "organization",
      subjectId: found.organization.id,
      data: changes,
    });
    if ("workspaceImage" in changes) {
      const projects = yield* (yield* ProjectsRepo).listForOrganization(found.organization.id);
      const engine = yield* SessionEngine;
      yield* Effect.forEach(
        projects.filter((project) => project.workspaceImage === null && project.hotSessions > 0),
        (project) => engine.reconcileHotSessions(project.id),
        { discard: true },
      );
    }
  });

/**
 * Replace the organization's own values, as an owner. An unchanged workspace environment keeps the
 * latest one; a changed one is resolved like the environment save, and a package that does not
 * resolve refuses the whole save.
 */
export const saveOrganizationSettings = (
  found: OrganizationMembership,
  actorUserId: string,
  payload: OrganizationSettings,
) =>
  Effect.gen(function* () {
    const repo = yield* OrganizationSettingsRepo;
    const organizationId = found.organization.id;
    const before = yield* repo.get(organizationId);
    let image = payload.workspaceImage;
    const imageChanged = !sameImage(before.workspaceImage, image);
    if (image !== null && imageChanged) {
      yield* refuseUnrunnableEnvironment(organizationId, image);
      const resolved = yield* resolveWorkspaceEnvironmentWithSealant(image);
      if (resolved.workspaceImage === null) {
        return yield* new SettingsFailure({
          message: unresolvedPackagesMessage(image, resolved.resolutions),
        });
      }
      image = resolved.workspaceImage;
    }
    const saved = yield* repo.modify(
      organizationId,
      (latest) =>
        new OrganizationSettings({
          ...payload,
          workspaceImage: imageChanged ? image : latest.workspaceImage,
        }),
    );
    yield* settle(found, actorUserId, before, saved);
    return yield* organizationSettingsView(found, saved);
  });

/**
 * Save the organization's workspace environment, as an owner: null follows the instance's again;
 * an environment is resolved first, and `saved: false` reports the rejections and persists nothing.
 */
export const saveOrganizationWorkspaceEnvironment = (
  found: OrganizationMembership,
  actorUserId: string,
  payload: OrganizationWorkspaceEnvironmentRequest,
) =>
  Effect.gen(function* () {
    const repo = yield* OrganizationSettingsRepo;
    const organizationId = found.organization.id;
    let image: WorkspaceImage | null = null;
    let resolutions: ReadonlyArray<WorkspacePackageResolutionView> = [];
    if (payload.workspaceImage !== null) {
      yield* refuseUnrunnableEnvironment(organizationId, payload.workspaceImage);
      const resolved = yield* resolveWorkspaceEnvironmentWithSealant(payload.workspaceImage);
      resolutions = resolved.resolutions.map(
        (resolution) => new WorkspacePackageResolutionView(resolution),
      );
      if (resolved.workspaceImage === null) {
        return new OrganizationWorkspaceEnvironmentSaveResult({
          saved: false,
          settings: yield* organizationSettingsView(found),
          resolutions,
        });
      }
      image = resolved.workspaceImage;
    }
    const before = yield* repo.get(organizationId);
    const saved = yield* repo.modify(
      organizationId,
      (latest) => new OrganizationSettings({ ...latest, workspaceImage: image }),
    );
    yield* settle(found, actorUserId, before, saved);
    return new OrganizationWorkspaceEnvironmentSaveResult({
      saved: true,
      settings: yield* organizationSettingsView(found, saved),
      resolutions,
    });
  });
