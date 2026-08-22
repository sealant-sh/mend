import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

/**
 * How this Mend instance is deployed — the one fact that decides where transient things may
 * live (docs/KUBERNETES.md):
 *
 * - `local` (default): Mend runs on the machine that also runs Docker workspaces. The store is
 *   a host directory, and each session's control surface is a Unix socket under
 *   `<store>/_run/sessions/<id>` that the workspace bind-mounts at `/run/mend`.
 * - `kubernetes`: the store is an RWX claim shared with workspace Pods on other nodes. No socket
 *   is ever created on that filesystem; the session control surface is the authenticated
 *   network endpoint instead, and the workspace reaches it with a per-session token.
 */
export type DeploymentMode = "local" | "kubernetes";

export interface SessionEndpointConfig {
  /** `host:port` the network session channel listens on. */
  readonly listen: string;
  /** The URL workspaces are told to use, e.g. `http://mend-session.mend.svc:3106`. */
  readonly url: string;
  /** Optional TLS for the listener (PEM paths). */
  readonly tls?: { readonly certPath: string; readonly keyPath: string } | undefined;
}

export class DeploymentConfig extends Context.Service<
  DeploymentConfig,
  {
    readonly mode: DeploymentMode;
    /** Present when the network session channel is configured (required in kubernetes mode). */
    readonly sessionEndpoint: SessionEndpointConfig | undefined;
  }
>()("@mend/store/DeploymentConfig") {}

export class DeploymentConfigError extends Error {
  override readonly name = "DeploymentConfigError";
}

export interface DeploymentEnvLike {
  readonly MEND_DEPLOYMENT_MODE?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_LISTEN?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_URL?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_TLS_CERT?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_TLS_KEY?: string | undefined;
}

const LISTEN = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/;

/** Pure: validate the env contract. Throws a readable error on a contradictory configuration. */
export const resolveDeploymentConfig = (
  env: DeploymentEnvLike,
): {
  readonly mode: DeploymentMode;
  readonly sessionEndpoint: SessionEndpointConfig | undefined;
} => {
  const rawMode = env.MEND_DEPLOYMENT_MODE?.trim();
  const mode: DeploymentMode =
    rawMode === undefined || rawMode === "" || rawMode === "local"
      ? "local"
      : rawMode === "kubernetes"
        ? "kubernetes"
        : (() => {
            throw new DeploymentConfigError(
              `MEND_DEPLOYMENT_MODE must be "local" or "kubernetes", got "${rawMode}".`,
            );
          })();
  const listen = env.MEND_SESSION_ENDPOINT_LISTEN?.trim();
  const url = env.MEND_SESSION_ENDPOINT_URL?.trim();
  if (mode === "kubernetes" && (listen === undefined || listen === "")) {
    throw new DeploymentConfigError(
      "MEND_DEPLOYMENT_MODE=kubernetes requires MEND_SESSION_ENDPOINT_LISTEN (the workspace session channel cannot be a Unix socket across nodes).",
    );
  }
  if (listen === undefined || listen === "") {
    return { mode, sessionEndpoint: undefined };
  }
  const match = LISTEN.exec(listen);
  if (match === null || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new DeploymentConfigError(
      `MEND_SESSION_ENDPOINT_LISTEN must be host:port, got "${listen}".`,
    );
  }
  if (url === undefined || url === "") {
    throw new DeploymentConfigError(
      "MEND_SESSION_ENDPOINT_URL (the address workspaces use to reach the session channel) must be set with MEND_SESSION_ENDPOINT_LISTEN.",
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new DeploymentConfigError(`MEND_SESSION_ENDPOINT_URL is not a URL: "${url}".`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new DeploymentConfigError("MEND_SESSION_ENDPOINT_URL must be http:// or https://.");
  }
  const certPath = env.MEND_SESSION_ENDPOINT_TLS_CERT?.trim();
  const keyPath = env.MEND_SESSION_ENDPOINT_TLS_KEY?.trim();
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new DeploymentConfigError(
      "MEND_SESSION_ENDPOINT_TLS_CERT and MEND_SESSION_ENDPOINT_TLS_KEY must be set together.",
    );
  }
  if (certPath !== undefined && parsedUrl.protocol !== "https:") {
    throw new DeploymentConfigError(
      "MEND_SESSION_ENDPOINT_URL must be https:// when TLS is configured.",
    );
  }
  return {
    mode,
    sessionEndpoint: {
      listen,
      url: url.replace(/\/+$/, ""),
      ...(certPath !== undefined && keyPath !== undefined ? { tls: { certPath, keyPath } } : {}),
    },
  };
};

export const DeploymentConfigLive: Layer.Layer<DeploymentConfig> = Layer.effect(
  DeploymentConfig,
  Effect.sync(() => resolveDeploymentConfig(process.env)),
);

export const DeploymentConfigLocal: Layer.Layer<DeploymentConfig> = Layer.succeed(
  DeploymentConfig,
  {
    mode: "local",
    sessionEndpoint: undefined,
  },
);
