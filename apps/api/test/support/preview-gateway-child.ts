import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { acceptanceGateway, decodeAcceptanceGatewayOptions } from "./preview-acceptance-world.ts";

/**
 * The acceptance gateway as its own process (`spawnGateway`): argv[2] is its options as JSON. It
 * prints `{"port":N}` once listening and `{"start":…}` for each start it asks of the engine, and
 * closes on SIGTERM.
 */
const options = decodeAcceptanceGatewayOptions(process.argv[2] ?? "");

NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const gateway = yield* acceptanceGateway(options, (request) => {
        process.stdout.write(`${JSON.stringify({ start: request })}\n`);
      });
      process.stdout.write(`${JSON.stringify({ port: gateway.port })}\n`);
      return yield* Effect.never;
    }),
  ),
);
