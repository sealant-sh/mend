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
