import { ConnectAccountInput } from "@mend/api-contracts";
import { PersonSettings } from "@mend/domain";
import {
  AgentLogins,
  MessageSettings,
  SessionDefaults,
  SettleSettings,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/** Platform · identity · machine. */
export const platformRouter = router({
  health: procedure.query(({ ctx }) => run(ctx, (api) => api.health.status())),
  /** Public: the login page asks whether any account exists before it renders. */
  instance: procedure.query(({ ctx }) => run(ctx, (api) => api.instance.get())),
  machine: procedure.query(({ ctx }) => run(ctx, (api) => api.machine.get())),
  /**
   * What the operator declared (`MEND_EXPOSURE`) and every public exposure gate item with how it
   * was established (docs/adr/0004). The operator's only: anyone else gets 404.
   */
  exposure: procedure.query(({ ctx }) => run(ctx, (api) => api.operator.exposure())),
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
  /** Whether the caller's Send steers their own running turn. */
  messageSettings: procedure.query(({ ctx }) => run(ctx, (api) => api.accounts.messageSettings())),
  setMessageSettings: procedure
    .input(input(MessageSettings))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accounts.setMessageSettings({ payload })),
    ),
  /** Whether settling a thread in T3 Code stops its session too. */
  settleSettings: procedure.query(({ ctx }) => run(ctx, (api) => api.accounts.settleSettings())),
  setSettleSettings: procedure
    .input(input(SettleSettings))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.accounts.setSettleSettings({ payload })),
    ),
  /**
   * The caller's own automation switches (You · Sessions, Review, Landing), what each follows on
   * Inherit and who set that, and what their sessions get.
   */
  automation: procedure.query(({ ctx }) => run(ctx, (api) => api.personSettings.automation())),
  setAutomation: procedure
    .input(input(PersonSettings))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.personSettings.setAutomation({ payload })),
    ),
  /** The agent, model and effort the caller's composer picks first, on every device. */
  sessionDefaults: procedure.query(({ ctx }) =>
    run(ctx, (api) => api.personSettings.sessionDefaults()),
  ),
  setSessionDefaults: procedure
    .input(input(SessionDefaults))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.personSettings.setSessionDefaults({ payload })),
    ),
  /** A browser's own defaults from before they moved to the server, kept if none are saved. */
  adoptSessionDefaults: procedure
    .input(input(SessionDefaults))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.personSettings.adoptSessionDefaults({ payload })),
    ),
  /** The gateway and the caller's own workspace SSH keys (docs/WORKSPACE-SSH.md). */
  workspaceSsh: procedure.query(({ ctx }) => run(ctx, (api) => api.workspaceSsh.get())),
  removeWorkspaceSshKey: procedure
    .input(input(Schema.Struct({ sshKeyId: Schema.String })))
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.workspaceSsh.removeKey({ params: { sshKeyId: i.sshKeyId } })),
    ),
});
