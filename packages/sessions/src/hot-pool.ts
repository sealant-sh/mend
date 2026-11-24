import { createHash } from "node:crypto";

import { type DotfilesManager, WorkspaceImage } from "@mend/domain";
import type { CapturePosition } from "@mend/domain/workbench";
import { Schema } from "effect";

/**
 * Everything fixed when a hot workspace is prepared, resolved to comparable facts. A hot
 * workspace is claimable only while the project still resolves to the same inputs. The platform
 * cannot mutate create-time inputs, and skills are already materialized in its harness home, so a
 * mismatch means drain-and-rewarm.
 *
 * Deliberately absent: the base ref (the worktree is a bind mount, freshened host-side at claim)
 * and reference head SHAs (reference mounts are live host clones; the mounted content is whatever
 * is on disk either way).
 */
export interface HotFingerprintInputs {
  /** Standbys must match the worktree's runtime choice; null or omitted keeps sealant selection. */
  readonly runtime?: "docker" | "host-vm" | "boat" | null;
  /**
   * The canonical hash of the Access policy rules the standby was created under (its network
   * policy is create-time-fixed): it serves only a worktree that pinned the same rules. Null or
   * omitted: Standard, as before Access policies.
   */
  readonly accessPolicyHash?: string | null;
  /**
   * The Brokered secrets the standby's egress proxy holds, as a digest of their ids and bind
   * hosts (`brokeredDigestOf`): a standby serves only a launch that would deliver exactly them.
   * Null or omitted: none.
   */
  readonly brokeredSecrets?: string | null;
  /**
   * The sealant Boat account a Boat standby runs in (SLNT-790): a standby is a paid VM in that
   * account, so it serves only a launch that would name the same one. Null or omitted: the
   * server's.
   */
  readonly boatAccountId?: string | null;
  readonly workspaceImage: WorkspaceImage;
  readonly applyDotfiles: boolean;
  /** Skills are written before boot; a toggle must invalidate already-prepared harness homes. */
  readonly inheritUserSkills: boolean;
  /** The resolved delivered bundles. Revisions change whenever bundle contents change. */
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly revision: number;
  }>;
  readonly dotfiles: {
    /**
     * The saved repository, every field of it: the branch, subdirectory, manager and bootstrap
     * decide what the workspace applied as much as the URL does.
     */
    readonly repository: {
      readonly url: string;
      readonly ref: string | null;
      readonly subdirectory: string | null;
      readonly manager: DotfilesManager;
      readonly bootstrap: boolean;
    } | null;
    readonly snapshotSha: string | null;
  };
  readonly environmentRevision: number;
  readonly secretRevision: number;
  /** Cluster bindings are create-time-fixed too: a binding/SA mutation drains warm skeletons. */
  readonly clusterBindingRevision: number;
  readonly references: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
  }>;
  readonly mounts: ReadonlyArray<{
    readonly name: string;
    readonly hostPath: string;
    readonly readOnly: boolean;
  }>;
  /**
   * Linked projects (ADR-0001): the root mounted per link is create-time-fixed; WHICH worktree
   * is bound is not (the launch binds it), so the worktree name stays out.
   */
  readonly links: ReadonlyArray<{
    readonly name: string;
    readonly rootPath: string;
  }>;
}

const encodeWorkspaceImage = Schema.encodeSync(WorkspaceImage);

/**
 * A deterministic digest of the Brokered secrets a launch delivers: each id with its bind hosts,
 * sorted. Null when there are none.
 */
export const brokeredDigestOf = (
  secrets: ReadonlyArray<{ readonly id: string; readonly bindHosts: ReadonlyArray<string> }>,
): string | null =>
  secrets.length === 0
    ? null
    : createHash("sha256")
        .update(
          JSON.stringify(
            secrets
              .map((secret) => [secret.id, [...secret.bindHosts].toSorted()] as const)
              .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
        )
        .digest("hex");

/** An image without a screen hashes as before the switch existed, so its standbys stay claimable. */
const fingerprintedImage = (image: WorkspaceImage) =>
  Object.fromEntries(
    Object.entries(encodeWorkspaceImage(image)).filter(
      ([key, value]) => key !== "screen" || value === true,
    ),
  );

const byName = <T extends { readonly name: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
  items.toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * Stable content hash of the create-time-fixed inputs; key order is fixed by construction. A
 * person standby's layout and the image answer it booted on are part of it (docs/adr/0016,
 * per-person standbys): booted in its owner's per-person posture, it serves only a launch
 * predicted per person on that answer. A shared standby's hash is what it was before them.
 */
export const hotFingerprint = (
  inputs: HotFingerprintInputs,
  standby: { readonly layout: "shared" } | { readonly layout: "person"; readonly imageKey: string },
): string => {
  const canonical = {
    ...(inputs.runtime == null ? {} : { runtime: inputs.runtime }),
    ...(inputs.boatAccountId == null ? {} : { boatAccountId: inputs.boatAccountId }),
    // Absent under Standard and without Brokered secrets, so a standby made before Access
    // policies hashes as it did.
    ...(inputs.accessPolicyHash == null ? {} : { accessPolicyHash: inputs.accessPolicyHash }),
    ...(inputs.brokeredSecrets == null ? {} : { brokeredSecrets: inputs.brokeredSecrets }),
    ...(standby.layout === "person"
      ? { harnessLayout: { layout: standby.layout, imageKey: standby.imageKey } }
      : {}),
    // Bump when launch preparation changes in a way an already-running standby cannot inherit.
    // v1 relocates every harness directory into sealantd's configured capture root before launch;
    // v2 relocates pi's `.pi` too (a standby made before it would leave pi's state ephemeral).
    harnessHomeLayout: "capture-root-v2",
    workspaceImage: fingerprintedImage(inputs.workspaceImage),
    // A person standby applies no dotfiles at boot: its owner's are resolved at claim, so a
    // dotfiles change does not drain it (review of mend#596, N7). A shared standby's keys keep
    // their order, so its hash is what it was.
    ...(standby.layout === "person" ? {} : { applyDotfiles: inputs.applyDotfiles }),
    inheritUserSkills: inputs.inheritUserSkills,
    skills: byName(inputs.skills).map((skill) => ({
      id: skill.id,
      name: skill.name,
      revision: skill.revision,
    })),
    ...(standby.layout === "person"
      ? {}
      : {
          dotfiles: {
            repository:
              inputs.dotfiles.repository === null
                ? null
                : {
                    url: inputs.dotfiles.repository.url,
                    ref: inputs.dotfiles.repository.ref,
                    subdirectory: inputs.dotfiles.repository.subdirectory,
                    manager: inputs.dotfiles.repository.manager,
                    bootstrap: inputs.dotfiles.repository.bootstrap,
                  },
            snapshotSha: inputs.dotfiles.snapshotSha,
          },
        }),
    environmentRevision: inputs.environmentRevision,
    secretRevision: inputs.secretRevision,
    clusterBindingRevision: inputs.clusterBindingRevision,
    references: byName(inputs.references).map((r) => ({
      name: r.name,
      path: r.path,
    })),
    mounts: byName(inputs.mounts).map((m) => ({
      name: m.name,
      hostPath: m.hostPath,
      readOnly: m.readOnly,
    })),
    links: byName(inputs.links).map((l) => ({
      name: l.name,
      rootPath: l.rootPath,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
};

// ─── Capture-mode standby ───────────────────────────────────────────────────
//
// ADR-0002 amended 2026-09-13, revised for SDK 0.31.0 / sealantd 0.15. A standby executor
// exists before any worktree does: it is launched with the `capture` source and NO worktree id,
// and the channel answers its `plan.get` with the project's base plan — the default branch's
// base pack, an empty workspace class, the shared dependency cache for the executor's platform
// when the request names one — under a placeholder name and a synthetic epoch (the standby
// row's creation time in ms). The daemon takes both from the answer; they exist so the plan has
// a manifest identity and a key prefix, nothing more, and nothing writes under them (a standby
// holds no lease, so every write is refused until a claim).
//
// At claim the session adopts the pooled id, Mend makes sure capture 0 exists, takes the
// worktree's lease at a fresh epoch with the executor as holder, and the launch calls
// `workspace.capture.replan()`: the daemon fetches `plan.get` again with no worktree named, the
// channel answers the claimed worktree, its epoch and its head plan, and the daemon materialises
// the head as a delta over what it has and captures under that identity from then on. So a
// standby serves any worktree — fresh, joined, picked up — and nothing about the placeholder
// outlives the replan. Retention never lists `captures/standby-*/`: an abandoned standby's
// uploads are a leak to sweep, never a wrongful delete.

/** The placeholder name a standby's base plan is answered under, until its replan. */
export const standbyWorktreeAlias = (hotWorkspaceId: string): string => `standby-${hotWorkspaceId}`;

/** A standby's synthetic epoch: its creation time in ms; replaced by the claim's at replan. */
export const standbyEpochOf = (createdAt: Date): number => createdAt.getTime();

/**
 * Where a claimed standby answered before its claim's re-plan took: its own launch, under its
 * placeholder epoch (`standbyEpochOf`).
 */
export interface StandbyPlaceholder {
  readonly launchId: string;
  readonly epoch: number;
}

/**
 * Whether an answer at `position` is one a claimed standby gave under its placeholder (SLNT-1044):
 * about the base it booted on as `standby-<id>`, never about the worktree its claim re-planned it
 * onto. The daemon takes the claim's epoch at the re-plan and never answers under the placeholder
 * again, so every such answer was made before the session's worktree was on the executor and
 * before anything of the session ran in it. An answer without a launch is matched by its epoch
 * alone: a standby's creation time in ms, which no lease epoch is.
 */
export const isStandbyPlaceholderAnswer = (
  position: CapturePosition | null | undefined,
  placeholder: StandbyPlaceholder,
): boolean =>
  position !== null &&
  position !== undefined &&
  position.epoch === placeholder.epoch &&
  (position.launchId === null || position.launchId === placeholder.launchId);
