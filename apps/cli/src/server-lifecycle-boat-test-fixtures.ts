/** What the Boat lifecycle tests share: a key, the gateway image and the two public addresses. */
export const KEY = "boat_live_0123456789abcdefABCDEF";
export const DEPLOYMENT = "1a2b3c4d-0000-4000-8000-00000000abcd";
export const GATEWAY =
  "ghcr.io/sealant-sh/sealant-boat-gateway-next@sha256:1111111111111111111111111111111111111111111111111111111111111111";
export const ENDPOINTS = [
  "--session-endpoint-url",
  "https://mend.example.com:8443",
  "--blob-store-public-url",
  "https://mend.example.com:10000",
];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * compose.boat.yaml as setup wrote it while Boat needed the server's own key (the box's today):
 * every setting required. A generation that has it must still read, start and upgrade.
 */
export const REQUIRED_KEY_OVERLAY = [
  "# Written by mend server setup: Boat sessions, in the operator's own Boat account.",
  "services:",
  "  mend:",
  "    environment:",
  "      SEALANT_BOAT_API_KEY: ${SEALANT_BOAT_API_KEY:?set SEALANT_BOAT_API_KEY in server.env}",
  "      SEALANT_BOAT_DEPLOYMENT_ID: ${SEALANT_BOAT_DEPLOYMENT_ID:?set SEALANT_BOAT_DEPLOYMENT_ID in server.env}",
  "      SEALANT_BOAT_BUILDER_OWNER: ${SEALANT_BOAT_BUILDER_OWNER:?set SEALANT_BOAT_BUILDER_OWNER in server.env}",
  "      SEALANT_BOAT_STATE_DIRECTORY: /var/lib/sealant/boat",
  "      SEALANT_BOAT_GATEWAY_HOST_ID: ${SEALANT_BOAT_GATEWAY_HOST_ID:?set SEALANT_BOAT_GATEWAY_HOST_ID in server.env}",
  "    volumes:",
  "      - mend-boat-state:/var/lib/sealant/boat",
  "volumes:",
  "  mend-boat-state: {}",
  "",
].join("\n");

export const valueIn = (env: string, name: string): string | undefined =>
  new RegExp(`^${name}=(.+)$`, "m").exec(env)?.[1];
