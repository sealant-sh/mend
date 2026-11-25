#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { flushTelemetry, reportCause, telemetryLayer } from "@mend/telemetry";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GatewayConfigFromEnv } from "./config.ts";
import { GatewayServerLive } from "./server.ts";

/** Traces, logs and errors to Sentry when given a `SENTRY_DSN`; nothing otherwise (SLNT-1355). */
const TelemetryLive = Layer.unwrap(
  Effect.gen(function* () {
    const version = yield* Config.String("MEND_VERSION").pipe(Config.withDefault("dev"));
    return telemetryLayer({
      name: "mend-t3-gateway",
      release: version === "dev" ? undefined : `mend-server@${version}`,
    });
  }),
);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void flushTelemetry(2000));
}

// Off unless run: nothing in Mend starts the gateway (ADR 0012, "Access").
NodeRuntime.runMain(
  Layer.launch(
    GatewayServerLive.pipe(
      Layer.provide(GatewayConfigFromEnv),
      Layer.tapCause((cause) => reportCause(cause, { operation: "mend.gateway.start" })),
      Layer.provide(TelemetryLive),
    ),
  ),
);
