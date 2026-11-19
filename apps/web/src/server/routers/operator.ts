import { run } from "../api/index.ts";
import { procedure, router } from "./trpc.ts";

/**
 * What the server's operators read about the server they run (docs/adr/0003, "Operator"): the
 * organizations on it and the multi mode gate. The API answers anyone else 404 and an access key
 * 403, so these are the operator's alone; the Server settings page reads them.
 */
export const operatorRouter = router({
  /** Every organization on this server, with its member and owner counts. */
  organizations: procedure.query(({ ctx }) => run(ctx, (api) => api.operator.organizations())),
  /** Each item of the multi mode gate as observed now, with what would satisfy it. */
  gate: procedure.query(({ ctx }) => run(ctx, (api) => api.operator.gate())),
});
