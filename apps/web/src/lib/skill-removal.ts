import type { QueryClient } from "@tanstack/react-query";

import type { SkillDto } from "#/lib/api";
import type { TrpcProxy } from "#/lib/trpc";

/**
 * A removed skill leaves the library its page returns to before the navigation: that page's
 * loader serves what is cached, and the refetch an invalidation starts answers only later, so the
 * skill would stay listed until it did (live pass 2026-10-10).
 */
export const dropRemovedSkill = async (
  queryClient: QueryClient,
  trpc: TrpcProxy,
  skill: Pick<SkillDto, "id" | "projectId">,
): Promise<void> => {
  const without = <S extends { readonly id: string }>(skills: ReadonlyArray<S> | undefined) =>
    skills?.filter((entry) => entry.id !== skill.id);
  if (skill.projectId === null) {
    await queryClient.cancelQueries(trpc.skills.list.queryFilter());
    queryClient.setQueryData(trpc.skills.list.queryKey(), without);
    return;
  }
  const key = { id: skill.projectId };
  await queryClient.cancelQueries(trpc.skills.forProject.queryFilter(key));
  queryClient.setQueryData(trpc.skills.forProject.queryKey(key), without);
};

/**
 * Once off its page: the removed skill's detail is never asked for again (it would answer 404),
 * and every other library that listed it re-reads.
 */
export const settleRemovedSkill = (
  queryClient: QueryClient,
  trpc: TrpcProxy,
  skill: Pick<SkillDto, "id">,
): Promise<void> => {
  queryClient.removeQueries(trpc.skills.detail.queryFilter({ skillId: skill.id }));
  return queryClient.invalidateQueries(trpc.skills.pathFilter());
};
