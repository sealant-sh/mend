import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import { projectSkillOwner, type SkillOwner } from "./project-skills.ts";
import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";

/**
 * A project's skills as their owner: who may change them, and their words. The project layout has
 * already read the project and the root route who is signed in; the person who added it is named
 * once the organization's members are read, and said generally until then.
 */
export const useProjectSkillOwner = (projectId: string): SkillOwner => {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const members = useQuery(trpc.organization.members.queryOptions());
  return projectSkillOwner({
    projectId: detail.project.id,
    projectName: detail.project.name,
    manage: detail.capabilities.manage,
    createdByUserId: detail.project.createdByUserId,
    viewerUserId: viewer.userId,
    organizationName: viewer.organization.name,
    members: members.status === "success" ? members.data : [],
  });
};
