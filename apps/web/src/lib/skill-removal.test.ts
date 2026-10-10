import { ProjectId, SkillId } from "@mend/domain";
import { Skill, SkillWithFiles } from "@mend/domain/workbench";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { SkillDto } from "#/lib/api";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { makeTrpcProxy } from "#/lib/trpc";

const skill = (id: string, projectId: string | null): SkillDto =>
  new Skill({
    id: SkillId.make(id),
    scope: projectId === null ? "user" : "project",
    ownerUserId: projectId === null ? "user-1" : null,
    projectId: projectId === null ? null : ProjectId.make(projectId),
    name: id,
    description: "",
    fileCount: 1,
    bytes: 10,
    revision: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

describe("a removed skill", () => {
  it("leaves the user library the page returns to before any refetch answers", async () => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    queryClient.setQueryData(trpc.skills.list.queryKey(), [skill("a", null), skill("b", null)]);
    await dropRemovedSkill(queryClient, trpc, skill("a", null));
    expect(queryClient.getQueryData(trpc.skills.list.queryKey())?.map((entry) => entry.id)).toEqual(
      ["b"],
    );
  });

  it("leaves its project's library, and no other", async () => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    const own = trpc.skills.forProject.queryKey({ id: ProjectId.make("p1") });
    const other = trpc.skills.forProject.queryKey({ id: ProjectId.make("p2") });
    queryClient.setQueryData(own, [skill("a", "p1"), skill("b", "p1")]);
    queryClient.setQueryData(other, [skill("c", "p2")]);
    await dropRemovedSkill(queryClient, trpc, skill("a", "p1"));
    expect(queryClient.getQueryData(own)?.map((entry) => entry.id)).toEqual(["b"]);
    expect(queryClient.getQueryData(other)?.map((entry) => entry.id)).toEqual(["c"]);
  });

  it("is never asked for again once off its page, and the libraries re-read", async () => {
    const queryClient = new QueryClient();
    const trpc = makeTrpcProxy(queryClient);
    const detail = trpc.skills.detail.queryKey({ skillId: SkillId.make("a") });
    queryClient.setQueryData(detail, new SkillWithFiles({ skill: skill("a", null), files: [] }));
    queryClient.setQueryData(trpc.skills.list.queryKey(), [skill("b", null)]);
    await settleRemovedSkill(queryClient, trpc, skill("a", null));
    expect(queryClient.getQueryState(detail)).toBeUndefined();
    expect(queryClient.getQueryState(trpc.skills.list.queryKey())?.isInvalidated).toBe(true);
  });
});
