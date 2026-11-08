import { ServerSetupError, setupError } from "./server-setup-error.ts";

/** HTTPS origins remote workspaces dial, and the loopback ports an operator's TLS proxy forwards. */
export interface ServerRemoteEndpoints {
  readonly sessionUrl: string;
  readonly blobUrl: string;
  readonly sessionPort: number;
  readonly blobPort: number;
}

/** Invalid endpoint settings are refused before setup changes the installation. */
export type RemoteEndpointsResult =
  | { readonly _tag: "ok"; readonly value: ServerRemoteEndpoints }
  | { readonly _tag: "error"; readonly error: ServerSetupError };

/** The remote channel and bucket overlay, applied after the install's other overlays. */
export const REMOTE_ENDPOINTS_COMPOSE_FILE = "compose.remote-endpoints.yaml";

const origin = (value: unknown, flag: string): string | ServerSetupError => {
  const url = typeof value === "string" ? URL.parse(value) : null;
  if (
    typeof value === "string" &&
    url !== null &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !/[\s$#\\]/u.test(value) &&
    !url.hostname.endsWith(".")
  )
    return url.origin;
  return setupError(
    `${flag} needs an HTTPS origin, such as https://mend.example.com:8443, with no credentials, path, query or fragment.`,
  );
};

/** Parse saved or requested endpoints; refusals identify the setting to change. */
export const parseRemoteEndpoints = (input: unknown): RemoteEndpointsResult => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("sessionUrl" in input) ||
    !("blobUrl" in input) ||
    !("sessionPort" in input) ||
    !("blobPort" in input)
  )
    return {
      _tag: "error",
      error: setupError("Remote workspace endpoints need both HTTPS URLs and both loopback ports."),
    };
  const sessionUrl = origin(input.sessionUrl, "--session-endpoint-url");
  if (sessionUrl instanceof ServerSetupError) return { _tag: "error", error: sessionUrl };
  const blobUrl = origin(input.blobUrl, "--blob-store-public-url");
  if (blobUrl instanceof ServerSetupError) return { _tag: "error", error: blobUrl };
  const { sessionPort, blobPort } = input;
  if (
    typeof sessionPort !== "number" ||
    !Number.isInteger(sessionPort) ||
    sessionPort < 1 ||
    sessionPort > 65535
  )
    return {
      _tag: "error",
      error: setupError("--session-endpoint-port must be an integer from 1 to 65535."),
    };
  if (
    typeof blobPort !== "number" ||
    !Number.isInteger(blobPort) ||
    blobPort < 1 ||
    blobPort > 65535
  )
    return {
      _tag: "error",
      error: setupError("--blob-store-port must be an integer from 1 to 65535."),
    };
  if (sessionPort === blobPort || sessionUrl === blobUrl)
    return {
      _tag: "error",
      error: setupError(
        "The session channel and bucket need different HTTPS origins and different loopback ports.",
      ),
    };
  return { _tag: "ok", value: { sessionUrl, blobUrl, sessionPort, blobPort } };
};

/** Compare settings across setup reruns and guide roundtrips. */
export const sameRemoteEndpoints = (
  left: ServerRemoteEndpoints | undefined,
  right: ServerRemoteEndpoints | undefined,
): boolean =>
  left?.sessionUrl === right?.sessionUrl &&
  left?.blobUrl === right?.blobUrl &&
  left?.sessionPort === right?.sessionPort &&
  left?.blobPort === right?.blobPort;

/** Only public addresses and local port numbers enter server.env; never bucket credentials. */
export const remoteEndpointsEnvLines = (
  remote: ServerRemoteEndpoints | undefined,
): ReadonlyArray<string> =>
  remote === undefined
    ? []
    : [
        `MEND_SESSION_ENDPOINT_URL=${remote.sessionUrl}`,
        `MEND_BLOB_STORE_PUBLIC_URL=${remote.blobUrl}`,
        `MEND_SESSION_ENDPOINT_PORT=${remote.sessionPort}`,
        `MEND_BLOB_STORE_PORT=${remote.blobPort}`,
      ];

/** Publish only on loopback. The operator supplies verified TLS forwarding at the advertised origins. */
export const renderRemoteEndpointsOverlay = (
  remote: ServerRemoteEndpoints | undefined,
): string | undefined =>
  remote === undefined
    ? undefined
    : [
        "# Written by mend server setup. TLS forwarding is configured separately by the operator.",
        "services:",
        "  mend:",
        "    ports:",
        '      - "127.0.0.1:${MEND_SESSION_ENDPOINT_PORT:?set MEND_SESSION_ENDPOINT_PORT in server.env}:3106"',
        "    environment:",
        "      MEND_SESSION_ENDPOINT_URL: ${MEND_SESSION_ENDPOINT_URL:?set MEND_SESSION_ENDPOINT_URL in server.env}",
        "      MEND_BLOB_STORE_PUBLIC_URL: ${MEND_BLOB_STORE_PUBLIC_URL:?set MEND_BLOB_STORE_PUBLIC_URL in server.env}",
        '      MEND_EXECUTOR_NETWORK: ""',
        "  garage:",
        "    ports:",
        '      - "127.0.0.1:${MEND_BLOB_STORE_PORT:?set MEND_BLOB_STORE_PORT in server.env}:3900"',
        "",
      ].join("\n");
