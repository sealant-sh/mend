import { SealantClient } from "@mend/sealant";
import { Effect, Layer } from "effect";

/**
 * The platform's terminals as sealant answers them. Every read moves the run's sequence on, because
 * the run records telemetry (heartbeats, metrics) whether or not the terminal printed:
 * `outputHighWater` is that sequence and keeps rising on a silent terminal. Only `print` records
 * output, and `sessionOutput` answers only output chunks at or after `from`.
 */
export const makeFakeTerminalPlatform = () => {
  const state = {
    /** The run's telemetry sequence, as `TelemetryQuery.maxSequence` reads it. */
    sequence: 100n,
    /** Sequences of the chunks the terminal printed. */
    printed: [] as Array<bigint>,
    /** Calls the idle stop made to the platform. */
    reads: 0,
    /** The platform stops answering. */
    failing: false,
  };
  /** Telemetry recorded between any two reads, on a silent terminal too. */
  const tick = () => {
    state.sequence += 7n;
    state.reads += 1;
    if (state.failing) throw new Error("the platform did not answer");
  };
  const layer = Layer.mock(SealantClient, {
    getWorkspace: () => Effect.succeed({} as never),
    getSession: (_workspace, id) =>
      Effect.sync(
        () =>
          ({
            id,
            status: () => {
              tick();
              return Promise.resolve({ status: "running", outputHighWater: state.sequence });
            },
          }) as never,
      ),
    sessionOutput: (sessionId, options) =>
      Effect.try({
        try: () => {
          tick();
          const from = BigInt(options.from);
          const chunks = state.printed
            .filter((sequence) => sequence >= from)
            .slice(0, Number(options.limit))
            .map((sequence) => ({ sequence: sequence.toString(), dataBase64: "b2s=" }));
          const last = chunks.at(-1);
          return {
            sessionId,
            chunks,
            nextFrom: last === undefined ? options.from : (BigInt(last.sequence) + 1n).toString(),
            status: "running" as const,
          };
        },
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
  });
  /** The terminal prints: one chunk at the run's next sequence, then more telemetry. */
  const print = (chunks = 1) => {
    for (let i = 0; i < chunks; i += 1) {
      state.sequence += 1n;
      state.printed.push(state.sequence);
    }
    state.sequence += 3n;
  };
  return { state, layer, print };
};
