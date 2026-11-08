import { InferenceCallId, type InferenceContext, type InferenceToolName } from "@mend/domain";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { inferenceCalls } from "../schema/workbench.ts";
import { toPostgresJsonb } from "./postgres-values.ts";

interface NewInferenceCall {
  readonly context: InferenceContext;
  readonly tool: InferenceToolName | null;
  readonly input: unknown;
  readonly output: unknown;
}

/**
 * The interface-inference audit trail (ARCHITECTURE.md §3, `inference_calls`).
 * Every tool call and model exchange lands here — the log is part of the
 * product's audit surface, not diagnostics.
 */
export class InferenceCallsRepo extends Context.Service<
  InferenceCallsRepo,
  {
    readonly record: (call: NewInferenceCall) => Effect.Effect<void>;
  }
>()("@mend/db/InferenceCallsRepo") {}

export const InferenceCallsRepoLive: Layer.Layer<InferenceCallsRepo, never, MendDB> = Layer.effect(
  InferenceCallsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const record = Effect.fn("InferenceCallsRepo.record")(function* (call: NewInferenceCall) {
      yield* db
        .insert(inferenceCalls)
        .values({
          id: InferenceCallId.make(crypto.randomUUID()),
          ...call,
          input: toPostgresJsonb(call.input),
          output: toPostgresJsonb(call.output),
        })
        .pipe(Effect.orDie);
    });

    return { record };
  }),
);
