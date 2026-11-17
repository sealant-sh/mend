import { SkillCreateRequest, SkillUpdateRequest } from "@mend/api-contracts";
import { ProjectId, SkillId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const bySkillId = input(Schema.Struct({ skillId: SkillId }));

/** Skill libraries — the signed-in user's and each project's. */
export const skillsRouter = router({
  list: procedure.query(({ ctx }) => run(ctx, (api) => api.skills.list())),
  forProject: procedure
    .input(input(Schema.Struct({ id: ProjectId })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.skills.forProject({ params: { id: i.id } })),
    ),
  detail: procedure
    .input(bySkillId)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.skills.detail({ params: { skillId: i.skillId } })),
    ),
  create: procedure
    .input(input(SkillCreateRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.skills.create({ payload }))),
  update: procedure
    .input(input(Schema.Struct({ skillId: SkillId, request: SkillUpdateRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.skills.update({ params: { skillId: i.skillId }, payload: i.request })),
    ),
  remove: procedure
    .input(bySkillId)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.skills.remove({ params: { skillId: i.skillId } })),
    ),
});
