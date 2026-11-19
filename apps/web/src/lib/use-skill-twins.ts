import { useQueries, useQuery } from "@tanstack/react-query";

import type { SkillDto } from "./api.ts";
import { projectTwins, type ProjectTwin } from "./skills.ts";
import { useTRPC } from "./trpc.ts";

const NONE: ReadonlyMap<string, ReadonlyArray<ProjectTwin>> = new Map();

/**
 * For each of your skills by name, the projects that have a skill of the same name and so use
 * theirs instead. Read from each project's skills; a project whose skills haven't arrived, or
 * failed to, names nothing, so the pages say less rather than something wrong. Given nothing (a
 * project's skill), it reads nothing.
 */
export const useSkillTwins = (
  yours: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyMap<string, ReadonlyArray<ProjectTwin>> => {
  const trpc = useTRPC();
  const wanted = yours !== undefined;
  const projects = useQuery({ ...trpc.projects.list.queryOptions(), enabled: wanted });
  const list = projects.status === "success" ? projects.data : [];
  const reads = useQueries({
    queries: list.map((project) => ({
      ...trpc.skills.forProject.queryOptions({ id: project.id }),
      enabled: wanted,
    })),
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

/**
 * Your own skill with this name, if you have one: on a project's skill, it is the one the project's
 * is used instead of. Undefined while your skills are read, if they couldn't be, or given no name.
 */
export const useYourSkillNamed = (name: string | undefined): SkillDto | undefined => {
  const trpc = useTRPC();
  const yours = useQuery({ ...trpc.skills.list.queryOptions(), enabled: name !== undefined });
  return yours.status === "success" ? yours.data.find((skill) => skill.name === name) : undefined;
};
