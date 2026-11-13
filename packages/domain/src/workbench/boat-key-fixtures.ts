import type { BoatFailure } from "./boat-failure.ts";
import { BOAT_KEY_COMMAND_PERMISSIONS, BOAT_KEY_REQUIRED_PERMISSIONS } from "./boat-key.ts";
import type { BoatKeyNotObserved, BoatKeyReport } from "./boat-key.ts";

/**
 * Boat key reports shaped as Core 0.40.0-next.872 answers them (sealant#635's fake Boat), for the
 * API, web and CLI tests. Never a real account.
 */

const DAY_MS = 86_400_000;

/** A personal key with every permission Mend asks for, in a wallet that can start VMs. */
export const boatKeyReportFixture = (
  overrides: Partial<BoatKeyReport> = {},
  now: Date = new Date(),
): BoatKeyReport => ({
  observedAt: now,
  organization: null,
  identity: {
    observed: true,
    accountId: "acct_123",
    login: "acme-ci",
    displayName: "Acme CI",
    serviceAccount: true,
    accountStatus: "active",
  },
  keyKind: { observed: true, kind: "personal" },
  wallet: {
    observed: true,
    kind: "organization",
    organizationId: "org_9",
    organizationName: "acme-boat",
    role: "admin",
  },
  requiredPermissions: [...BOAT_KEY_REQUIRED_PERMISSIONS],
  permissions: {
    observed: true,
    held: [...BOAT_KEY_COMMAND_PERMISSIONS],
    missing: [],
    limitedToSandboxes: false,
  },
  expiry: {
    observed: true,
    expiresAt: new Date(now.getTime() + 200 * DAY_MS),
    expired: false,
    expiringSoon: false,
  },
  start: {
    observed: true,
    canStart: true,
    blockedReason: null,
    billingStatus: "active",
    runningVms: 2,
    allowedVms: 5,
  },
  snapshots: { observed: true, used: 7, included: 10 },
  ...overrides,
});

/** What Boat sends an organization's key that asks for the key list: `403 forbidden`. */
export const KEY_LIST_FORBIDDEN: BoatFailure = {
  kind: "refused",
  retryable: false,
  operation: "verify",
  status: 403,
  code: "forbidden",
  message: "Organization API keys cannot list API keys.",
  requestId: "req_fixture1",
  permission: null,
  retryAfterSeconds: null,
  retryAt: null,
  billingUrl: null,
};

const refusedKeyList: BoatKeyNotObserved = {
  observed: false,
  reason: "refused",
  boat: KEY_LIST_FORBIDDEN,
};

/** A Boat organization's key: Boat refuses it the key list, so permissions and expiry are unread. */
export const organizationKeyReportFixture = (now: Date = new Date()): BoatKeyReport =>
  boatKeyReportFixture(
    {
      organization: "acme-boat",
      keyKind: { observed: true, kind: "organization" },
      permissions: refusedKeyList,
      expiry: refusedKeyList,
    },
    now,
  );
