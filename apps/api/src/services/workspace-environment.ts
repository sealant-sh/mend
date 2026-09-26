import {
  SettingsFailure,
  WorkspaceEnvironmentSaveResult,
  WorkspacePackageResolutionView,
} from "@mend/api-contracts";
import { SettingsRepo } from "@mend/db";
import { MendSettings } from "@mend/domain";
import type { WorkspaceImage, WorkspaceImageOs } from "@mend/domain";
import { SealantClient } from "@mend/sealant";
import type { WorkspacePackageResolution } from "@mend/sealant";
import { Effect } from "effect";

export interface ResolvedWorkspaceEnvironment {
  readonly workspaceImage: WorkspaceImage | null;
  readonly resolutions: ReadonlyArray<WorkspacePackageResolution>;
}

interface WorkspaceEnvironmentPersistence<E> {
  readonly getSettings: () => Effect.Effect<MendSettings, E>;
  readonly modifySettings: (
    update: (current: MendSettings) => MendSettings,
  ) => Effect.Effect<MendSettings, E>;
  readonly resolvePackage: (
    packageName: string,
    os: WorkspaceImageOs,
  ) => Effect.Effect<WorkspacePackageResolution, E>;
}

/** Resolve the complete package draft for one OS; no partial environment is ever accepted. */
export const resolveWorkspaceEnvironment = <E>(
  workspaceImage: WorkspaceImage,
  resolvePackage: (
    packageName: string,
    os: WorkspaceImageOs,
  ) => Effect.Effect<WorkspacePackageResolution, E>,
): Effect.Effect<ResolvedWorkspaceEnvironment, E> =>
  Effect.gen(function* () {
    // Custom bases have no managed package catalog: names pass through verbatim to whatever
    // package manager the base itself carries (the platform fails the build readable when it
    // has none). There is nothing to resolve, so the draft saves as-is.
    if (workspaceImage.mode === "custom") {
      return { workspaceImage, resolutions: [] };
    }
    const resolutions = yield* Effect.forEach(
      workspaceImage.packages,
      (packageName) => resolvePackage(packageName, workspaceImage.os),
      { concurrency: 4 },
    );
    const canSave = resolutions.every(
      (resolution) => resolution.status === "resolved" && resolution.supported,
    );
    if (!canSave) return { workspaceImage: null, resolutions };

    const packages = [
      ...new Set(
        resolutions.map(
          (resolution) => resolution.canonicalId ?? resolution.packageName ?? resolution.normalized,
        ),
      ),
    ];
    return {
      workspaceImage: { ...workspaceImage, packages },
      resolutions,
    };
  });

/**
 * `resolveWorkspaceEnvironment` against the platform's package catalog, as every save runs it: the
 * instance's, an organization's and a project's. A platform failure is the save's failure.
 */
export const resolveWorkspaceEnvironmentWithSealant = (workspaceImage: WorkspaceImage) =>
  Effect.gen(function* () {
    const sealant = yield* SealantClient;
    return yield* resolveWorkspaceEnvironment(workspaceImage, sealant.resolveWorkspacePackage);
  }).pipe(
    Effect.catchTag("SealantPlatformError", (error) =>
      Effect.fail(new SettingsFailure({ message: error.message })),
    ),
  );

/** Why a whole-settings save was refused: each package that did not resolve, and why. */
export const unresolvedPackagesMessage = (
  workspaceImage: WorkspaceImage,
  resolutions: ReadonlyArray<WorkspacePackageResolution>,
): string => {
  const rejected = resolutions
    .filter((resolution) => resolution.status !== "resolved" || !resolution.supported)
    .map((resolution) =>
      resolution.status === "resolved"
        ? `${resolution.requested} (unsupported)`
        : `${resolution.requested} (${resolution.status})`,
    );
  const target = workspaceImage.mode === "custom" ? workspaceImage.baseImage : workspaceImage.os;
  return `Workspace packages did not resolve for ${target}: ${rejected.join(", ")}.`;
};

/**
 * Validate one complete environment draft, then merge it into the latest
 * settings snapshot. Reading after Sealant resolves prevents a slow save from
 * restoring settings that changed while validation was in flight.
 */
export const saveResolvedWorkspaceEnvironmentWith = <E>(
  workspaceImage: WorkspaceImage,
  merge: (latest: MendSettings, resolved: WorkspaceImage) => MendSettings,
  persistence: WorkspaceEnvironmentPersistence<E>,
) =>
  Effect.gen(function* () {
    const resolved = yield* resolveWorkspaceEnvironment(workspaceImage, persistence.resolvePackage);
    const resolutions = resolved.resolutions.map(
      (resolution) => new WorkspacePackageResolutionView(resolution),
    );

    if (resolved.workspaceImage === null) {
      const latest = yield* persistence.getSettings();
      return new WorkspaceEnvironmentSaveResult({
        saved: false,
        settings: latest,
        resolutions,
      });
    }

    const resolvedImage = resolved.workspaceImage;
    const saved = yield* persistence.modifySettings((latest) => merge(latest, resolvedImage));
    return new WorkspaceEnvironmentSaveResult({ saved: true, settings: saved, resolutions });
  });

export const saveResolvedWorkspaceEnvironment = (
  workspaceImage: WorkspaceImage,
  merge: (latest: MendSettings, resolved: WorkspaceImage) => MendSettings,
) =>
  Effect.gen(function* () {
    const settings = yield* SettingsRepo;
    const sealant = yield* SealantClient;
    return yield* saveResolvedWorkspaceEnvironmentWith(workspaceImage, merge, {
      getSettings: settings.get,
      modifySettings: settings.modify,
      resolvePackage: sealant.resolveWorkspacePackage,
    });
  }).pipe(
    Effect.catchTag("SealantPlatformError", (error) =>
      Effect.fail(new SettingsFailure({ message: error.message })),
    ),
  );
