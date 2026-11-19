import { useQuery, useSuspenseQuery } from "@tanstack/react-query";

import type { ProjectDetailDto } from "./api.ts";
import type { ProjectPeople } from "./project-settings.ts";
import { signedInOptions } from "./sign-in.ts";
import { useTRPC } from "./trpc.ts";

/**
 * What every project settings page reads: the project with what this person may do to it (the
 * settings layout's loader already read it), and who is looking, for the page's sentences about
 * who can change it. The organization's roster names people once it is read; until then, and if it
 * can't be read, the sentences say it generally.
 */
export const useProjectSettings = (
  projectId: string,
): { readonly detail: ProjectDetailDto; readonly people: ProjectPeople } => {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const members = useQuery(trpc.organization.members.queryOptions());
  return {
    detail,
    people: {
      projectName: detail.project.name,
      organizationName: viewer.organization.name,
      createdByUserId: detail.project.createdByUserId,
      viewerUserId: viewer.userId,
      members: members.status === "success" ? members.data : [],
    },
  };
};
