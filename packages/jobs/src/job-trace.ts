import { currentTraceCarrier, reportCause, spanOfCarrier } from "@mend/telemetry";
import { Effect } from "effect";

/**
 * A job's trace, carried in its data (SLNT-1349, "Crossing async boundaries"): the publisher
 * writes the W3C context it enqueued under into `_trace`, and the consumer runs each attempt in
 * one `mend.job.process` span parented on it, so the work a request queued joins that request's
 * trace. sealant's queues carry the same envelope.
 */
export const TRACE_KEY = "_trace";

/** `payload` with the current span's context under `_trace`, or as it is outside any span. */
export const withTraceEnvelope = (
  payload: Record<string, unknown>,
): Effect.Effect<Record<string, unknown>> =>
  Effect.map(currentTraceCarrier, (carrier) =>
    carrier === undefined ? payload : { ...payload, [TRACE_KEY]: carrier },
  );

/** A job's data without its envelope, for the handler, and the span the envelope names. */
export const openEnvelope = (
  data: unknown,
): { readonly payload: unknown; readonly parent: ReturnType<typeof spanOfCarrier> } => {
  if (typeof data !== "object" || data === null || Array.isArray(data) || !(TRACE_KEY in data))
    return { payload: data, parent: undefined };
  const { [TRACE_KEY]: carrier, ...payload } = data;
  return { payload, parent: spanOfCarrier(carrier) };
};

/** What the consumer knows of an attempt. pg-boss counts retries from 0. */
export interface JobAttempt {
  readonly queue: string;
  readonly id: string;
  readonly data: unknown;
  readonly retryCount?: number | undefined;
  readonly createdOn?: Date | undefined;
}

/**
 * One attempt of a job: a CONSUMER span parented on the job's publisher, or a trace of its own for
 * a job enqueued with none (or by an older Mend), with the queue, the attempt and how long the job
 * waited. A failed attempt is reported once, with its trace, before pg-boss retries it.
 */
export const processAttempt = (
  attempt: JobAttempt,
  handler: (payload: unknown) => Effect.Effect<void>,
): Effect.Effect<void> => {
  const { payload, parent } = openEnvelope(attempt.data);
  const number = (attempt.retryCount ?? 0) + 1;
  return Effect.gen(function* () {
    if (attempt.createdOn !== undefined) {
      const waited = Date.now() - attempt.createdOn.getTime();
      yield* Effect.annotateCurrentSpan("mend.job.queue_wait_ms", Math.max(0, waited));
    }
    yield* handler(payload).pipe(
      Effect.tapCause((cause) =>
        reportCause(cause, {
          operation: "mend.job.process",
          tags: { "messaging.destination.name": attempt.queue, "mend.job.attempt": number },
        }),
      ),
    );
  }).pipe(
    Effect.withSpan("mend.job.process", {
      kind: "consumer",
      ...(parent === undefined ? { root: true } : { parent }),
      attributes: {
        "messaging.system": "pg-boss",
        "messaging.destination.name": attempt.queue,
        "mend.job_id": attempt.id,
        "mend.job.attempt": number,
      },
    }),
  );
};
