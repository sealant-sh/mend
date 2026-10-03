import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  type AuthEnvironmentScope,
  type DpopFailureReason,
  type EnvironmentAuthInvalidReason,
  type EnvironmentInternalErrorReason,
  type EnvironmentRequestInvalidReason,
  type EnvironmentResourceNotFoundReason,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

/** t3code's error bodies, shared by the HTTP routes and the `/ws` upgrade. */

/** t3code stamps every refusal with the request's trace id (`t3:apps/server/src/auth/http.ts`). */
const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export const authInvalid = (
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason,
        ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
        traceId,
      }),
    ),
  );

export const requestInvalid = (reason: EnvironmentRequestInvalidReason) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
  );

export const scopeRequired = (requiredScope: AuthEnvironmentScope) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(
      new EnvironmentScopeRequiredError({ code: "insufficient_scope", requiredScope, traceId }),
    ),
  );

export const internal = (reason: EnvironmentInternalErrorReason, cause: unknown) =>
  Effect.gen(function* () {
    const traceId = yield* currentTraceId;
    yield* Effect.logError("t3 gateway request failed", { reason, traceId, cause });
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });

export const notFound = (reason: EnvironmentResourceNotFoundReason) =>
  Effect.flatMap(currentTraceId, (traceId) =>
    Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
  );
