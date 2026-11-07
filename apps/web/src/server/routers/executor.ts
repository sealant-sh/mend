import { ExecutorFinishInput } from "@mend/api-contracts";
import { SessionId } from "@mend/domain";
import {
  ExecutorApprovalInput,
  ExecutorAddService,
  ExecutorConnectService,
  ExecutorServiceAccountAction,
  ExecutorServiceFinish,
  ExecutorServiceSubmit,
  ExecutorServiceTarget,
  ExecutorConfigurationInput,
  ExecutorLinkTarget,
  ExecutorManagedAction,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";
const call = Schema.Struct({ sessionId: Schema.String, callId: Schema.String });
export const executorRouter = router({
  manage: procedure
    .input(input(Schema.Struct({ action: ExecutorManagedAction })))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.executor.manage({ payload }))),
  configuration: procedure.query(({ ctx }) => run(ctx, (api) => api.executor.configuration())),
  configure: procedure
    .input(input(Schema.NullOr(ExecutorConfigurationInput)))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.executor.configure({ payload }))),
  personal: procedure.query(({ ctx }) => run(ctx, (api) => api.executor.personal())),
  services: procedure
    .input(input(Schema.Struct({ offset: Schema.Number })))
    .query(({ ctx, input: query }) => run(ctx, (api) => api.executor.services({ query }))),
  directory: procedure
    .input(input(Schema.Struct({ target: ExecutorServiceTarget })))
    .query(({ ctx, input: query }) => run(ctx, (api) => api.executor.directory({ query }))),
  shareService: procedure
    .input(input(Schema.Struct({ service: Schema.String })))
    .mutation(({ ctx, input: params }) => run(ctx, (api) => api.executor.shareService({ params }))),
  addService: procedure
    .input(input(ExecutorAddService))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.executor.addService({ payload }))),
  connectService: procedure
    .input(input(ExecutorConnectService))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.executor.connectService({ payload })),
    ),
  submitService: procedure
    .input(input(ExecutorServiceSubmit))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.executor.submitService({ payload })),
    ),
  finishService: procedure
    .input(input(ExecutorServiceFinish))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.executor.finishService({ payload })),
    ),
  disconnectService: procedure
    .input(input(ExecutorServiceAccountAction))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.executor.disconnectService({ payload })),
    ),
  useServiceAccount: procedure
    .input(input(ExecutorServiceAccountAction))
    .mutation(({ ctx, input: payload }) =>
      run(ctx, (api) => api.executor.useServiceAccount({ payload })),
    ),
  begin: procedure
    .input(input(Schema.Struct({ target: ExecutorLinkTarget })))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.executor.begin({ payload }))),
  finish: procedure
    .input(input(ExecutorFinishInput))
    .mutation(({ ctx, input: payload }) => run(ctx, (api) => api.executor.finish({ payload }))),
  unlink: procedure
    .input(input(Schema.Struct({ target: ExecutorLinkTarget })))
    .mutation(({ ctx, input: params }) => run(ctx, (api) => api.executor.unlink({ params }))),
  calls: procedure
    .input(
      input(Schema.Struct({ sessionId: Schema.String, before: Schema.optionalKey(Schema.String) })),
    )
    .query(({ ctx, input: { sessionId, ...query } }) =>
      run(ctx, (api) =>
        api.executor.calls({ params: { sessionId: SessionId.make(sessionId) }, query }),
      ),
    ),
  approval: procedure
    .input(input(call))
    .query(({ ctx, input: { sessionId, callId } }) =>
      run(ctx, (api) =>
        api.executor.approval({ params: { sessionId: SessionId.make(sessionId), callId } }),
      ),
    ),
  approve: procedure
    .input(input(Schema.Struct({ ...call.fields, ...ExecutorApprovalInput.fields })))
    .mutation(({ ctx, input: { sessionId, callId, ...payload } }) =>
      run(ctx, (api) =>
        api.executor.approve({ params: { sessionId: SessionId.make(sessionId), callId }, payload }),
      ),
    ),
});
