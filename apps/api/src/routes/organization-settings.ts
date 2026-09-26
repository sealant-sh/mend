import {
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
  ORGANIZATION_SETTING_KEYS,
  organizationDefaults,
  OrganizationSettings,
  workspaceImagesEqual,
  type WorkspaceImage,
} from "@mend/domain";
import type { AuditData } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
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
    });
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
