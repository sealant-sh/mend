import { ConnectBoatKeyRequest } from "@mend/api-contracts";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * The organization's Boat key (SLNT-790). Anyone in the organization reads whether there is one;
 * owners read its details, connect, replace, check and remove it. The key passes through once, in
 * `connect`, and this tier keeps no copy.
 */
export const boatKeyRouter = router({
  status: procedure.query(({ ctx }) => run(ctx, (api) => api.boatKey.status())),
  connect: procedure
    .input(input(ConnectBoatKeyRequest))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.boatKey.connect({ payload }))),
  check: procedure.mutation(({ ctx }) => run(ctx, (api) => api.boatKey.check())),
  disconnect: procedure.mutation(({ ctx }) => run(ctx, (api) => api.boatKey.disconnect())),
});
