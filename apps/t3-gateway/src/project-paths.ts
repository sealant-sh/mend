import type { ThreadWorkspace } from "./hub.ts";
import type { MendProject } from "./mend-workbench.ts";

/** Stable protocol labels, including before the person's first scratch request. */
export const personProjectPaths = (
  personId: string,
): { readonly newProjectsRoot: string; readonly scratchWorkspaceRoot: string } => ({
  newProjectsRoot: "Mend",
  scratchWorkspaceRoot: `/__mend__/people/${Buffer.from(personId, "utf8").toString("hex")}/scratch`,
});

/** Only exact roots in the person's hub resolve these labels to projects. */
export const projectWorkspaceRootOf = (project: MendProject, personId: string): string =>
  project.scratchOwnerUserId === personId
    ? personProjectPaths(personId).scratchWorkspaceRoot
    : project.storePath;

/**
 * Where a thread launched into `project` works. The viewer's scratch thread always starts in a
 * new worktree of the project's default branch, whatever t3code asked; any other thread works
 * where t3code asked. An ordinary project's root means its shared Local worktree.
 */
export const launchWorkspaceOf = (
  project: MendProject,
  viewerId: string,
  requested: ThreadWorkspace,
): ThreadWorkspace | { readonly kind: "refused"; readonly reason: string } => {
  if (project.scratchOwnerUserId === viewerId)
    return requested.kind === "join"
      ? { kind: "refused", reason: "A new scratch thread starts in a new worktree of its own." }
      : {
          kind: "new",
          name: null,
          strategy: { type: "worktree", baseRef: project.defaultBranch, startFromOrigin: false },
        };
  return requested;
};
