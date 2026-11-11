import { createHmac } from "node:crypto";

import { ServerSetupError, setupError } from "./server-setup-error.ts";

/**
 * Boat sessions (`--session-runtime boat`): the VMs run in the operator's own Boat account, and
 * this server holds its key, as an AWS install holds its credentials. The key is a secret and
 * lives in `server.env` only (`SEALANT_BOAT_API_KEY`); the config keeps what is not secret.
 */
export interface ServerBoat {
  /**
   * The name Core labels this install's Boat VMs with (`sealant-deployment`), so installs that share
   * one Boat account each find only their own. It is not a Boat object: the operator may pick it,
   * and without one setup derives it from the install's identity (`boatEnvLines`).
   */
  readonly deploymentId?: string | undefined;
  /**
   * Whether Boat sessions reach project resources (`@db`) through Core's resource gateway on this
   * server's Docker host. The worker carries each tunnel over Boat's HTTPS, so the host takes no
   * inbound connection. Off, only sessions in projects without resources run on Boat.
   */
  readonly resources: boolean;
}

/** The overlay that hands the Boat settings to the `mend` container. */
export const BOAT_COMPOSE_FILE = "compose.boat.yaml";
/** Core's native build journal: it must outlive the container, so it has a volume of its own. */
export const BOAT_STATE_VOLUME = "mend-boat-state";
export const BOAT_STATE_DIRECTORY = "/var/lib/sealant/boat";
/**
 * The Mend image's label naming Core's Boat resource gateway image, by digest (Dockerfile). Setup
 * preloads it, and the bundle hands the same reference to the worker (scripts/bundle-supervisor.mjs).
 */
export const BOAT_GATEWAY_IMAGE_LABEL = "dev.sealant.mend.boat-gateway-image";

/** What Core takes as a Boat deployment ID (`SEALANT_BOAT_DEPLOYMENT_ID`). */
const DEPLOYMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
/** What Core takes as a Boat API key (`BoatSecret`). */
const API_KEY = /^[A-Za-z0-9._~-]{16,4096}$/;

export const isBoatDeploymentId = (value: string): boolean => DEPLOYMENT_ID.test(value);
export const isBoatApiKey = (value: string): boolean => API_KEY.test(value);

export const parseBoatDeploymentId = (value: string): string => {
  if (!isBoatDeploymentId(value))
    throw setupError(
      `--boat-deployment-id is a name for this install's Boat VMs: letters, digits and _ . : -, starting with a letter or digit, up to 128 characters; not "${value}". Leave it out and setup picks one.`,
    );
  return value;
};

/** A saved Boat setting; refusals name the setting that is damaged. */
export const parseBoatField = (input: unknown): ServerBoat => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw setupError("Server config is corrupt: boat must be an object.");
  const deploymentId: unknown = Reflect.get(input, "deploymentId");
  const resources: unknown = Reflect.get(input, "resources");
  if (
    deploymentId !== undefined &&
    (typeof deploymentId !== "string" || !isBoatDeploymentId(deploymentId))
  )
    throw setupError("Server config is corrupt: boat.deploymentId is not a Boat deployment name.");
  if (typeof resources !== "boolean")
    throw setupError("Server config is corrupt: boat.resources must be true or false.");
  return { ...(deploymentId === undefined ? {} : { deploymentId }), resources };
};

export const sameBoat = (left: ServerBoat | undefined, right: ServerBoat | undefined): boolean =>
  left?.deploymentId === right?.deploymentId && left?.resources === right?.resources;

/**
 * A stable UUID for this install, derived from its identity like Garage's values: the same install
 * always renders the same one, so it survives reruns, upgrades and restarts without being stored.
 * Version 4 and RFC 9562's variant, which Core's settings require.
 */
const derivedUuid = (identitySecret: string, label: string): string => {
  const hex = createHmac("sha256", Buffer.from(identitySecret, "hex")).update(label).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
};

/** The name this install's Boat VMs carry: the operator's, or one derived from the identity. */
export const boatDeploymentIdOf = (boat: ServerBoat, identitySecret: string): string =>
  boat.deploymentId ?? `mend-${derivedUuid(identitySecret, "mend-boat-deployment")}`;

/**
 * The Boat lines of `server.env`. Core's builder owner (who owns this install's Boat images) and,
 * with resources, its gateway host are derived from the identity. The key is the operator's.
 */
export const boatEnvLines = (
  boat: ServerBoat | undefined,
  apiKey: string | undefined,
  identitySecret: string,
): ReadonlyArray<string> =>
  boat === undefined || apiKey === undefined
    ? []
    : [
        `SEALANT_BOAT_API_KEY=${apiKey}`,
        `SEALANT_BOAT_DEPLOYMENT_ID=${boatDeploymentIdOf(boat, identitySecret)}`,
        `SEALANT_BOAT_BUILDER_OWNER=${derivedUuid(identitySecret, "mend-boat-builder-owner")}`,
        ...(boat.resources
          ? [
              `SEALANT_BOAT_GATEWAY_HOST_ID=${derivedUuid(identitySecret, "mend-boat-gateway-host")}`,
            ]
          : []),
      ];

/**
 * `compose.boat.yaml`: the Boat settings for the `mend` container, read from `server.env`, and
 * the volume Core keeps its native build journal in. The gateway's image and the address the
 * worker reaches it at are the image's and the container's own (scripts/bundle-supervisor.mjs).
 */
export const renderBoatOverlay = (boat: ServerBoat | undefined): string | undefined =>
  boat === undefined
    ? undefined
    : [
        "# Written by mend server setup: Boat sessions, in the operator's own Boat account.",
        "services:",
        "  mend:",
        "    environment:",
        "      SEALANT_BOAT_API_KEY: ${SEALANT_BOAT_API_KEY:?set SEALANT_BOAT_API_KEY in server.env}",
        "      SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID:?set SEALANT_BOAT_DEPLOYMENT_ID in server.env}",
        "      SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER:?set SEALANT_BOAT_BUILDER_OWNER in server.env}",
        `      SEALANT_BOAT_STATE_DIRECTORY: ${BOAT_STATE_DIRECTORY}`,
        ...(boat.resources
          ? [
              "      SEALANT_BOAT_GATEWAY_HOST_ID: ${SEALANT_BOAT_GATEWAY_HOST_ID:?set SEALANT_BOAT_GATEWAY_HOST_ID in server.env}",
            ]
          : []),
        "    volumes:",
        `      - ${BOAT_STATE_VOLUME}:${BOAT_STATE_DIRECTORY}`,
        // A volume of the Compose project, like the t3code gateway's: uninstall removes it with the rest.
        "volumes:",
        `  ${BOAT_STATE_VOLUME}: {}`,
        "",
      ].join("\n");

/** The settings a person changes Boat with, and what setup refuses about them. */
export interface BoatRequest {
  readonly deploymentId: string | undefined;
  readonly apiKeyStdin: boolean;
  /** `--boat-resources` (true), `--no-boat-resources` (false); omitted keeps the saved choice. */
  readonly resources: boolean | undefined;
  /** `--no-boat`: forget Boat's key and settings. */
  readonly off: boolean;
}

export const KEEP_BOAT: BoatRequest = {
  deploymentId: undefined,
  apiKeyStdin: false,
  resources: undefined,
  off: false,
};

/**
 * What the saved Boat setting becomes. A first setting needs the key on standard input; the
 * deployment name is optional. Afterwards either may change alone. `--no-boat` takes it away.
 */
export const resolveBoat = (
  saved: ServerBoat | undefined,
  request: BoatRequest,
): ServerBoat | undefined => {
  if (request.off) return undefined;
  if (saved === undefined && request.deploymentId === undefined && !request.apiKeyStdin) {
    if (request.resources !== undefined)
      throw setupError(
        `${request.resources ? "--boat-resources" : "--no-boat-resources"} needs Boat set up: pipe the Boat API key with --boat-api-key-stdin.`,
      );
    return undefined;
  }
  if (saved === undefined && !request.apiKeyStdin)
    throw setupError(
      "Boat needs its API key: pipe it on standard input with --boat-api-key-stdin.",
    );
  const deploymentId = request.deploymentId ?? saved?.deploymentId;
  return {
    ...(deploymentId === undefined ? {} : { deploymentId }),
    resources: request.resources ?? saved?.resources ?? true,
  };
};

/** The key from standard input: the key alone, a trailing newline allowed. */
export const parseBoatApiKey = (input: string): string | ServerSetupError => {
  const key = input.trim();
  return isBoatApiKey(key)
    ? key
    : setupError(
        "--boat-api-key-stdin read no Boat API key: pipe the key alone, as Boat shows it (boat_…).",
      );
};
