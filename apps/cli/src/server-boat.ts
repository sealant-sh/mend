import { createHmac } from "node:crypto";

import { ServerSetupError, setupError } from "./server-setup-error.ts";

/**
 * Boat sessions (`--session-runtime boat`): the VMs run in Boat accounts, each organization's own
 * once an owner connects its Boat key (Settings, Organization, Boat, or `mend boat connect`), and
 * Sealant keeps those keys sealed. The server needs no key for that. The config keeps what is not
 * secret; the server's own key, when it has one (`ServerBoatKey`), is in `server.env` only.
 */
export interface ServerBoat {
  /**
   * The name sealant labels this install's Boat VMs with (`sealant-deployment`), so installs that share
   * one Boat account each find only their own. It is not a Boat object: the operator may pick it,
   * and without one setup derives it from the install's identity (`boatEnvLines`).
   */
  readonly deploymentId?: string | undefined;
  /**
   * Whether Boat sessions reach project resources (`@db`) through sealant's resource gateway on this
   * server's Docker host. The worker carries each tunnel over Boat's HTTPS, so the host takes no
   * inbound connection. Off, only sessions in projects without resources run on Boat.
   */
  readonly resources: boolean;
}

/**
 * The server's own Boat key, which is optional: Boat sessions of every organization that has no
 * key connected run in this key's Boat account, and that account pays for them. `organization`
 * names the Boat organization it bills (`SEALANT_BOAT_ORGANIZATION`), for a key that can bill
 * more than one. Both live in `server.env` only.
 */
export interface ServerBoatKey {
  readonly apiKey: string;
  readonly organization?: string | undefined;
}

/** The overlay that hands the Boat settings to the `mend` container. */
export const BOAT_COMPOSE_FILE = "compose.boat.yaml";
/** sealant's native build journal: it must outlive the container, so it has a volume of its own. */
export const BOAT_STATE_VOLUME = "mend-boat-state";
export const BOAT_STATE_DIRECTORY = "/var/lib/sealant/boat";
/**
 * The Mend image's label naming sealant's Boat resource gateway image, by digest (Dockerfile). Setup
 * preloads it, and the bundle hands the same reference to the worker (scripts/bundle-supervisor.mjs).
 */
export const BOAT_GATEWAY_IMAGE_LABEL = "dev.sealant.mend.boat-gateway-image";

/** What sealant takes as a Boat deployment ID (`SEALANT_BOAT_DEPLOYMENT_ID`). */
const DEPLOYMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
/** What sealant takes as a Boat key (`BoatSecret`). */
const API_KEY = /^[A-Za-z0-9._~-]{16,4096}$/;
/** What Core takes as the Boat organization the server's own key bills (its id or name). */
const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;

export const isBoatDeploymentId = (value: string): boolean => DEPLOYMENT_ID.test(value);
export const isBoatApiKey = (value: string): boolean => API_KEY.test(value);
export const isBoatOrganization = (value: string): boolean =>
  ORGANIZATION.test(value) && value.trim() === value;

export const parseBoatOrganization = (value: string): string => {
  if (!isBoatOrganization(value))
    throw setupError(
      `--boat-organization is the id or name of the Boat organization this server's own Boat key bills: letters, digits, spaces and _ . -, starting with a letter or digit, up to 128 characters; not "${value}".`,
    );
  return value;
};

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
 * Version 4 and RFC 9562's variant, which sealant's settings require.
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
 * The Boat lines of `server.env`. The deployment name, sealant's builder owner (who owns this
 * install's Boat images) and, with resources, its gateway host are derived from the identity.
 * sealant keeps the first two itself since 0.40.0-next.874, adopting what it was given on its first
 * start, so a server that ran Boat before keeps them and so recognises its VMs and images. The
 * server's own key and its organization are the operator's, and only when there is one.
 */
export const boatEnvLines = (
  boat: ServerBoat | undefined,
  key: ServerBoatKey | undefined,
  identitySecret: string,
): ReadonlyArray<string> =>
  boat === undefined
    ? []
    : [
        ...(key === undefined ? [] : [`SEALANT_BOAT_API_KEY=${key.apiKey}`]),
        ...(key?.organization === undefined
          ? []
          : [`SEALANT_BOAT_ORGANIZATION=${key.organization}`]),
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
 * the volume sealant keeps its native build journal in. A setting `server.env` does not carry (the
 * server's own key, say) reaches sealant empty, which sealant reads as unset. The gateway's image and
 * the address the worker reaches it at are the image's and the container's own
 * (scripts/bundle-supervisor.mjs).
 */
export const renderBoatOverlay = (boat: ServerBoat | undefined): string | undefined =>
  boat === undefined
    ? undefined
    : [
        "# Written by mend server setup: Boat sessions, in each organization's Boat account.",
        "services:",
        "  mend:",
        "    environment:",
        "      SEALANT_BOAT_API_KEY: ${SEALANT_BOAT_API_KEY:-}",
        "      SEALANT_BOAT_ORGANIZATION: ${SEALANT_BOAT_ORGANIZATION:-}",
        "      SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID:-}",
        "      SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER:-}",
        `      SEALANT_BOAT_STATE_DIRECTORY: ${BOAT_STATE_DIRECTORY}`,
        ...(boat.resources
          ? ["      SEALANT_BOAT_GATEWAY_HOST_ID: ${SEALANT_BOAT_GATEWAY_HOST_ID:-}"]
          : []),
        "    volumes:",
        `      - ${BOAT_STATE_VOLUME}:${BOAT_STATE_DIRECTORY}`,
        // A volume of the Compose project, like the t3code gateway's: uninstall removes it with the rest.
        "volumes:",
        `  ${BOAT_STATE_VOLUME}: {}`,
        "",
      ].join("\n");

/**
 * The overlay setup wrote while Boat needed the server's own key: every setting required. A generation that has it is read as it is; the next one setup writes has the
 * current overlay.
 */
const renderRequiredKeyBoatOverlay = (boat: ServerBoat): string =>
  [
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
    "volumes:",
    `  ${BOAT_STATE_VOLUME}: {}`,
    "",
  ].join("\n");

/** Whether a generation's `compose.boat.yaml` is one setup writes, or wrote, for these settings. */
export const isBoatOverlayOf = (
  overlay: string | undefined,
  boat: ServerBoat | undefined,
): boolean =>
  overlay === renderBoatOverlay(boat) ||
  (boat !== undefined && overlay === renderRequiredKeyBoatOverlay(boat));

/** The settings a person changes Boat with, and what setup refuses about them. */
export interface BoatRequest {
  readonly deploymentId: string | undefined;
  /** `--boat-api-key-stdin`: give the server a key of its own, or replace it. */
  readonly apiKeyStdin: boolean;
  /** `--no-boat-api-key`: the server keeps no key of its own. */
  readonly removeKey: boolean;
  /** `--boat-organization` (a name), `--no-boat-organization` (null); omitted keeps the saved one. */
  readonly organization: string | null | undefined;
  /** `--boat-resources` (true), `--no-boat-resources` (false); omitted keeps the saved choice. */
  readonly resources: boolean | undefined;
  /** `--no-boat`: forget Boat's settings and the server's key; sessions run on Docker. */
  readonly off: boolean;
}

export const KEEP_BOAT: BoatRequest = {
  deploymentId: undefined,
  apiKeyStdin: false,
  removeKey: false,
  organization: undefined,
  resources: undefined,
  off: false,
};

/** Whether the request names any Boat setting, which turns Boat on. */
const namesBoat = (request: BoatRequest): boolean =>
  request.deploymentId !== undefined ||
  request.apiKeyStdin ||
  typeof request.organization === "string" ||
  request.resources !== undefined;

/**
 * What the saved Boat setting becomes. Boat is turned on by naming it where sessions run
 * (`wanted`) or by any Boat setting, and stays on until `--no-boat` takes it away. No key is
 * needed: each organization's owner connects its own.
 */
export const resolveBoat = (
  saved: ServerBoat | undefined,
  request: BoatRequest,
  wanted: boolean,
): ServerBoat | undefined => {
  if (request.off) return undefined;
  if (saved === undefined && !wanted && !namesBoat(request)) return undefined;
  const deploymentId = request.deploymentId ?? saved?.deploymentId;
  return {
    ...(deploymentId === undefined ? {} : { deploymentId }),
    resources: request.resources ?? saved?.resources ?? true,
  };
};

/**
 * The server's own key after this run: the one on standard input, else the saved one, unless
 * `--no-boat-api-key` or `--no-boat` drops it. Its organization goes with it.
 */
export const resolveBoatKey = (
  saved: ServerBoatKey | undefined,
  request: BoatRequest,
  given: string | undefined,
): ServerBoatKey | undefined => {
  if (request.off) return undefined;
  const apiKey = given ?? (request.removeKey ? undefined : saved?.apiKey);
  const organization =
    request.organization === null ? undefined : (request.organization ?? saved?.organization);
  if (apiKey === undefined) {
    if (typeof request.organization === "string")
      throw setupError(
        "--boat-organization names the Boat organization this server's own Boat key bills, and this server has no key of its own. Give it one with --boat-api-key-stdin, or leave --boat-organization out: an organization's own Boat key bills that organization's Boat account.",
      );
    return undefined;
  }
  return { apiKey, ...(organization === undefined ? {} : { organization }) };
};

/** The key from standard input: the key alone, a trailing newline allowed. */
export const parseBoatApiKey = (input: string): string | ServerSetupError => {
  const key = input.trim();
  return isBoatApiKey(key)
    ? key
    : setupError(
        "--boat-api-key-stdin read no Boat key: pipe the key alone, as Boat shows it (boat_…).",
      );
};
