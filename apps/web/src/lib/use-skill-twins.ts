import { useQueries, useQuery } from "@tanstack/react-query";

import { projectTwins, type ProjectTwin } from "./skills.ts";
import { useTRPC } from "./trpc.ts";

const NONE: ReadonlyMap<string, ReadonlyArray<ProjectTwin>> = new Map();

/**
 * For each of your skills by name, the projects that have a skill of the same name and so use
 * theirs instead. Read from each project's skills; a project whose skills haven't arrived, or
 * failed to, names nothing, so the pages say less rather than something wrong.
 */
export const useSkillTwins = (
  yours: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyMap<string, ReadonlyArray<ProjectTwin>> => {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const list = projects.status === "success" ? projects.data : [];
  const reads = useQueries({
    queries: list.map((project) => trpc.skills.forProject.queryOptions({ id: project.id })),
  });
  if (yours === undefined || yours.length === 0) return NONE;
  return projectTwins(
    yours,
    list.flatMap((project, at) => {
      const read = reads[at];
      return read?.status === "success"
        ? [{ projectId: project.id, projectName: project.name, skills: read.data }]
        : [];
    }),
  );
};
