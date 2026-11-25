import { callerSpanOf } from "@mend/network/http-observation";
import { initTRPC } from "@trpc/server";
import { Clock, Effect, Exit, Schema } from "effect";
import { Headers as HttpHeaders } from "effect/http";
import superjson from "superjson";

import { ApiRefusal } from "../api/errors.ts";
import type { TrpcContext } from "../api/index.ts";
import { runSync } from "../api/run.ts";

/**
 * tRPC init for the web tier. superjson carries the contract's Type side to
 * the browser intact — real Dates, bigint sequence counters, branded ids —
 * so the UI works with the same types the domain declares, not a JSON echo.
 */
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  // The refusal's tag rides beside its words for the pages that branch on it (a worktree that is
  // live, a name taken), with the facts of a refused removal, a failed setup or a shared control
  // refusal (a step no longer allowed, a sender's login to connect again); the message a
  // person reads never carries them (api/errors.ts).
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      ...shape.data,
      tag: error.cause instanceof ApiRefusal ? error.cause.tag : null,
      removal: error.cause instanceof ApiRefusal ? error.cause.removal : null,
      setup: error.cause instanceof ApiRefusal ? error.cause.setup : null,
      sharedControl: error.cause instanceof ApiRefusal ? error.cause.sharedControl : null,
    },
  }),
});

export const router = t.router;

/**
 * Each procedure is a span of the web tier, `mend.web.<path>` (a procedure's path is its route
 * template: no ids), a child of the trace the caller sent (`traceparent`, else `sentry-trace`),
 * whether the call came over /trpc or from a page the server renders. The API calls it makes are
 * its children (`api/run.ts`); it ends with the procedure's outcome.
 */
const traced = t.middleware(async ({ ctx, path, type, next }) => {
  const parent = callerSpanOf(HttpHeaders.fromInput(ctx.headers));
  const span = runSync(
    Effect.makeSpan(`mend.web.${path}`, {
      kind: "server",
      ...(parent === undefined ? {} : { parent }),
      attributes: { "rpc.system": "trpc", "rpc.method": path, "mend.trpc.type": type },
    }),
  );
  const result = await next({ ctx: { ...ctx, procedure: { span, path } } });
  span.end(runSync(Clock.currentTimeNanos), result.ok ? Exit.void : Exit.fail(result.error));
  return result;
});

export const procedure = t.procedure.use(traced);

/** Effect Schema speaks Standard Schema v1, which tRPC v11 accepts natively. */
export const input = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardSchemaV1(schema);
