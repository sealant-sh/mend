import { createHash } from "node:crypto";

import { WorkspaceImage } from "@mend/domain";
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
    readonly repository: {
      readonly url: string;
      readonly ref: string | null;
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

const byName = <T extends { readonly name: string }>(items: ReadonlyArray<T>): ReadonlyArray<T> =>
  items.toSorted((a, b) => a.name.localeCompare(b.name));

/** Stable content hash of the create-time-fixed inputs; key order is fixed by construction. */
export const hotFingerprint = (inputs: HotFingerprintInputs): string => {
  const canonical = {
    // Bump when launch preparation changes in a way an already-running standby cannot inherit.
    // v1 relocates every harness directory into sealantd's configured capture root before launch.
    harnessHomeLayout: "capture-root-v1",
    workspaceImage: encodeWorkspaceImage(inputs.workspaceImage),
    applyDotfiles: inputs.applyDotfiles,
    inheritUserSkills: inputs.inheritUserSkills,
    skills: byName(inputs.skills).map((skill) => ({
      id: skill.id,
      name: skill.name,
      revision: skill.revision,
    })),
    dotfiles: {
      repository:
        inputs.dotfiles.repository === null
          ? null
          : {
              url: inputs.dotfiles.repository.url,
              ref: inputs.dotfiles.repository.ref,
            },
      snapshotSha: inputs.dotfiles.snapshotSha,
    },
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
