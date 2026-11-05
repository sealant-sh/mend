import { SessionId } from "@mend/domain";
import {
  ExecutorApprovalInput,
  ExecutorCall,
  ExecutorCalls,
  ExecutorConfiguration,
  ExecutorConfigurationInput,
  ExecutorLinkStart,
  ExecutorLinkTarget,
  ExecutorPersonalStatus,
  ExecutorServices,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";
import { RemovalInProgress } from "./workbench-views.ts";

export class ExecutorRejected extends Schema.TaggedError<ExecutorRejected>()(
  "ExecutorRejected",
  { message: Schema.String },
  { httpApiStatus: 422 },
) {}
const errors = [NotFound, ExecutorRejected];
export const ExecutorFinishInput = Schema.Struct({
  state: Schema.String.check(Schema.isMaxLength(256)),
  code: Schema.String.check(Schema.isMaxLength(8192)),
});
export const executorGroup = HttpApiGroup.make("executor")
  .add(
    HttpApiEndpoint.get("configuration", "/organization/executor", {
      success: ExecutorConfiguration,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.put("configure", "/organization/executor", {
      payload: Schema.NullOr(ExecutorConfigurationInput),
      success: ExecutorConfiguration,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("personal", "/me/executor", {
      success: ExecutorPersonalStatus,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("begin", "/me/executor/link", {
      payload: Schema.Struct({ target: ExecutorLinkTarget }),
      success: ExecutorLinkStart,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("finish", "/me/executor/callback", {
      payload: ExecutorFinishInput,
      success: Schema.Struct({ url: Schema.NullOr(Schema.String), target: ExecutorLinkTarget }),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.delete("unlink", "/me/executor/link/:target", {
      params: { target: ExecutorLinkTarget },
      success: Schema.Void,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("calls", "/sessions/:sessionId/executor", {
      params: { sessionId: SessionId },
      query: { before: Schema.optionalKey(Schema.String) },
      success: ExecutorCalls,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("approval", "/sessions/:sessionId/executor/:callId", {
      params: { sessionId: SessionId, callId: Schema.String },
      success: Schema.Struct({
        call: ExecutorCall,
        message: Schema.String,
        inputSchema: Schema.Json,
        arguments: Schema.Json,
      }),
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.post("approve", "/sessions/:sessionId/executor/:callId", {
      params: { sessionId: SessionId, callId: Schema.String },
      payload: ExecutorApprovalInput,
      success: ExecutorCall,
      error: [...errors, RemovalInProgress],
    }),
  )
  .add(
    HttpApiEndpoint.get("services", "/me/executor/services", {
      query: {
        offset: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
      },
      success: ExecutorServices,
      error: errors,
    }),
  )
  .middleware(AuthMiddleware);
