import { homedir } from "node:os";
import { join } from "node:path";

import * as Config from "effect/Config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Where the gateway listens, which Mend it speaks for, and where it keeps its own state. Nothing in
 * Mend starts the gateway: it runs only when someone runs `mend-t3-gateway` (ADR 0012, "Access").
 */
export interface GatewayConfigShape {
  /** Mend's API origin; the gateway calls `<mendUrl>/api/...` with each person's device token. */
  readonly mendUrl: URL;
  /** Loopback by default. Anything wider is an exposure (ADR 0004). */
  readonly host: string;
  readonly port: number;
  /** The gateway's own `node:sqlite` file. Mend's database is never touched. */
  readonly statePath: string;
  /** What t3code shows for this environment. */
  readonly label: string;
  /** How long a person's hub outlives their last socket; two minutes when unset. */
  readonly hubIdleTimeToLive?: Duration.Input;
}

export class GatewayConfig extends Context.Service<GatewayConfig, GatewayConfigShape>()(
  "@mend/t3-gateway/GatewayConfig",
) {}

export const DEFAULT_MEND_URL = "http://127.0.0.1:3101";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3120;
export const DEFAULT_LABEL = "Mend";

const defaultStatePath = (): string => {
  const stateHome = process.env["XDG_STATE_HOME"];
  const base =
    stateHome !== undefined && stateHome !== "" ? stateHome : join(homedir(), ".local", "state");
  return join(base, "mend", "t3-gateway", "state.sqlite");
};

/** `MEND_T3_GATEWAY_*` from the environment, each with its default. */
export const GatewayConfigFromEnv: Layer.Layer<GatewayConfig, Config.ConfigError> = Layer.effect(
  GatewayConfig,
  Effect.gen(function* () {
    const mendUrl = yield* Config.URL("MEND_T3_GATEWAY_MEND_URL").pipe(
      Config.withDefault(new URL(DEFAULT_MEND_URL)),
    );
    const host = yield* Config.NonEmptyString("MEND_T3_GATEWAY_HOST").pipe(
      Config.withDefault(DEFAULT_HOST),
    );
    const port = yield* Config.Port("MEND_T3_GATEWAY_PORT").pipe(Config.withDefault(DEFAULT_PORT));
    const statePath = yield* Config.NonEmptyString("MEND_T3_GATEWAY_STATE_PATH").pipe(
      Config.withDefault(defaultStatePath()),
    );
    const label = yield* Config.NonEmptyString("MEND_T3_GATEWAY_LABEL").pipe(
      Config.withDefault(DEFAULT_LABEL),
    );
    return { mendUrl, host, port, statePath, label };
  }),
);
