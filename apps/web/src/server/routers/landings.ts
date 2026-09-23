import { LandRequest } from "@mend/api-contracts";
import { ChangeId, ChangeLandingId, SessionId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** A fetch of origin's branch is opt-in: a plain read makes no call with credentials. */
const probeOf = (probe: boolean | undefined) => (probe === true ? { probe: "true" as const } : {});

/** Landing (docs/adr/0007-landing.md): the record, the facts, and the owner's land action. */
export const landingsRouter = router({
  forChange: procedure
    .input(input(Schema.Struct({ id: ChangeId, probe: Schema.optional(Schema.Boolean) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.landings.forChange({ params: { id: i.id }, query: probeOf(i.probe) })),
    ),
  forSession: procedure
    .input(input(Schema.Struct({ id: SessionId, probe: Schema.optional(Schema.Boolean) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.landings.forSession({ params: { id: i.id }, query: probeOf(i.probe) })),
    ),
  land: procedure
    .input(input(Schema.Struct({ id: SessionId, request: LandRequest })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.landings.land({ params: { id: i.id }, payload: i.request })),
    ),
  refresh: procedure
    .input(input(Schema.Struct({ id: ChangeLandingId })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.landings.refresh({ params: { id: i.id } })),
    ),
});
