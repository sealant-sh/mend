import { ConnectAccountInput } from "@mend/api-contracts";
import { AgentLogins } from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Platform · identity · machine. */
export const platformRouter = router({
  health: procedure.query(({ ctx }) => run(ctx, (api) => api.health.status())),
  /** Public: the login page asks whether any account exists before it renders. */
  instance: procedure.query(({ ctx }) => run(ctx, (api) => api.instance.get())),
  machine: procedure.query(({ ctx }) => run(ctx, (api) => api.machine.get())),
  sealantConnection: procedure.query(({ ctx }) => run(ctx, (api) => api.sealant.connection())),
  sealantIdentity: procedure.query(({ ctx }) => run(ctx, (api) => api.accounts.identity())),
  connectAccount: procedure
    .input(input(ConnectAccountInput))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.accounts.connect({ payload }))),
  disconnectAccount: procedure
    .input(input(Schema.Struct({ id: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.accounts.disconnect({ params: { id: i.id } })),
    ),
  /** Which of the caller's own logins their Claude and Codex sessions receive. */
  agentLogins: procedure.query(({ ctx }) => run(ctx, (api) => api.accounts.agentLogins())),
  setAgentLogins: procedure
    .input(input(AgentLogins))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accounts.setAgentLogins({ payload })),
    ),
  /** The gateway and the caller's own workspace SSH keys (docs/WORKSPACE-SSH.md). */
  workspaceSsh: procedure.query(({ ctx }) => run(ctx, (api) => api.workspaceSsh.get())),
  removeWorkspaceSshKey: procedure
    .input(input(Schema.Struct({ sshKeyId: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.workspaceSsh.removeKey({ params: { sshKeyId: i.sshKeyId } })),
    ),
});
