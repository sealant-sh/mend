import { readFileSync } from "node:fs";

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

/**
 * Where a session's work product is authoritative (docs/adr/0002-session-capture-store.md):
 * `captured` (the default, and the only store new installs run) makes the capture store (object
 * storage + Postgres pointers) truth and the executor a disposable cache. `colocated` keeps the
 * bind-mounted worktree as truth; it is DEPRECATED since decision 8 (2026-09-13, "captures
 * everywhere from day one") and survives only for installs that have not moved yet — the API
 * logs a warning at start and the adapters behind it are scheduled for removal. Orthogonal to
 * `mode`. `captured` needs the network session endpoint for its channel routes; as with
 * `kubernetes`, the engine enforces that, not this parser (the web tier has no listener).
 */
export type SessionStoreKind = "colocated" | "captured";

/** The store kind every install runs unless it opts back into the deprecated one. */
export const DEFAULT_SESSION_STORE: SessionStoreKind = "captured";

/** The one-line fact the API logs when the deprecated store is selected. */
export const COLOCATED_STORE_DEPRECATION =
  "MEND_SESSION_STORE=colocated is deprecated: the co-located worktree store is retired by decision 8 (docs/adr/0002-session-capture-store.md); unset the variable to run the capture store, which every new install uses.";

export interface SessionEndpointConfig {
  /** `host:port` the network session channel listens on. */
  readonly listen: string;
  /** The URL workspaces are told to use, e.g. `http://mend-session.mend.svc:3106`. */
  readonly url: string;
  /** Optional TLS for the listener (PEM paths). */
  readonly tls?: { readonly certPath: string; readonly keyPath: string } | undefined;
}

/**
 * How a captured workspace's executor dials the session channel and the object store (sealantd
 * ADR-0015 "Transport"; docs/adr/0004-access-without-a-private-network.md). The daemon dials HTTPS
 * with a verified certificate and refuses anything else, unless the launcher states otherwise:
 *
 * - `plaintext` (`MEND_EXECUTOR_NETWORK=private`): the operator's statement that the network between
 *   executors and the channel is private (a Docker network, a cluster network, a VPC), so plain HTTP
 *   may be dialled. Reported by the exposure gate as declared, never as observed.
 * - `channelCaPem` (`MEND_SESSION_ENDPOINT_CA_FILE`): the roots the channel's certificate chains to,
 *   for a channel served under a private CA.
 * - `objectCaPem` (`MEND_BLOB_STORE_CA_FILE`): the same for presigned object URLs.
 */
export interface ExecutorTransport {
  readonly plaintext: boolean;
  readonly channelCaPem: string | undefined;
  readonly objectCaPem: string | undefined;
}

export class DeploymentConfig extends Context.Service<
  DeploymentConfig,
  {
    readonly mode: DeploymentMode;
    /** Present when the network session channel is configured (required in kubernetes mode). */
    readonly sessionEndpoint: SessionEndpointConfig | undefined;
    readonly sessionStore: SessionStoreKind;
    /**
     * What every capture launch tells the daemon about its transport. Absent (a test fake) means
     * no statement: the daemon then requires verified HTTPS, which is the fail-closed reading.
     */
    readonly executorTransport?: ExecutorTransport;
  }
>()("@mend/store/DeploymentConfig") {}

export class DeploymentConfigError extends Error {
  override readonly name = "DeploymentConfigError";
}

export interface DeploymentEnvLike {
  readonly MEND_DEPLOYMENT_MODE?: string | undefined;
  readonly MEND_SESSION_STORE?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_LISTEN?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_URL?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_TLS_CERT?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_TLS_KEY?: string | undefined;
  readonly MEND_EXECUTOR_NETWORK?: string | undefined;
  readonly MEND_SESSION_ENDPOINT_CA_FILE?: string | undefined;
  readonly MEND_BLOB_STORE_CA_FILE?: string | undefined;
}

/**
 * Pure: the transport statement from the environment, with the CA bundles read by `readFile`
 * (injected so the resolution stays testable without a filesystem).
 */
export const resolveExecutorTransport = (
  env: DeploymentEnvLike,
  readFile: (path: string) => string,
): ExecutorTransport => {
  const network = env.MEND_EXECUTOR_NETWORK?.trim();
  if (network !== undefined && network !== "" && network !== "private") {
    throw new DeploymentConfigError(
      `MEND_EXECUTOR_NETWORK must be "private" or unset, got "${network}".`,
    );
  }
  const pem = (variable: "MEND_SESSION_ENDPOINT_CA_FILE" | "MEND_BLOB_STORE_CA_FILE") => {
    const file = env[variable]?.trim();
    if (file === undefined || file === "") return undefined;
    let content: string;
    try {
      content = readFile(file);
    } catch (cause) {
      throw new DeploymentConfigError(
        `${variable} names ${file}, which could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (!content.includes("-----BEGIN CERTIFICATE-----")) {
      throw new DeploymentConfigError(`${variable} names ${file}, which holds no PEM certificate.`);
    }
    return content;
  };
  return {
    plaintext: network === "private",
    channelCaPem: pem("MEND_SESSION_ENDPOINT_CA_FILE"),
    objectCaPem: pem("MEND_BLOB_STORE_CA_FILE"),
  };
};

const LISTEN = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/;

/** Pure: validate the env contract. Throws a readable error on a contradictory configuration. */
export const resolveDeploymentConfig = (
  env: DeploymentEnvLike,
): {
  readonly mode: DeploymentMode;
  readonly sessionEndpoint: SessionEndpointConfig | undefined;
  readonly sessionStore: SessionStoreKind;
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
  const rawStore = env.MEND_SESSION_STORE?.trim();
  const sessionStore: SessionStoreKind =
    rawStore === undefined || rawStore === "" || rawStore === "captured"
      ? DEFAULT_SESSION_STORE
      : rawStore === "colocated"
        ? "colocated"
        : (() => {
            throw new DeploymentConfigError(
              `MEND_SESSION_STORE must be "colocated" or "captured", got "${rawStore}".`,
            );
          })();
  const listen = env.MEND_SESSION_ENDPOINT_LISTEN?.trim();
  const url = env.MEND_SESSION_ENDPOINT_URL?.trim();
  // NOTE: kubernetes mode does not require the endpoint HERE — the web tier runs in kubernetes
  // mode without listening. The session ENGINE (worker) refuses to start without it, because
  // that is the process whose sessions would otherwise be unreachable.
  if (listen === undefined || listen === "") {
    return { mode, sessionEndpoint: undefined, sessionStore };
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
    sessionStore,
    sessionEndpoint: {
      listen,
      url: url.replace(/\/+$/, ""),
      ...(certPath !== undefined && keyPath !== undefined ? { tls: { certPath, keyPath } } : {}),
    },
  };
};

export const DeploymentConfigLive: Layer.Layer<DeploymentConfig> = Layer.effect(
  DeploymentConfig,
  Effect.sync(() => ({
    ...resolveDeploymentConfig(process.env),
    executorTransport: resolveExecutorTransport(process.env, (file) => readFileSync(file, "utf8")),
  })),
);

export const DeploymentConfigLocal: Layer.Layer<DeploymentConfig> = Layer.succeed(
  DeploymentConfig,
  {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: DEFAULT_SESSION_STORE,
  },
);

/** The deprecated co-located store on this machine — for the tests of that adapter only. */
export const DeploymentConfigColocated: Layer.Layer<DeploymentConfig> = Layer.succeed(
  DeploymentConfig,
  {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: "colocated",
  },
);
