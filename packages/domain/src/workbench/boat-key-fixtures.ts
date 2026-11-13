import type { BoatFailure } from "./boat-failure.ts";
import { BOAT_KEY_REQUIRED_PERMISSIONS } from "./boat-key.ts";
import type {
  BoatKeyNotObserved,
  BoatKeyProof,
  BoatKeyProofStep,
  BoatKeyReport,
} from "./boat-key.ts";
import type { ServerBoatFacts } from "./server-boat.ts";

/**
 * Boat key reports shaped as sealant answers them since sealant#641 (its fake Boat), for the
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
  wallets: {
    observed: true,
    choices: [
      { id: "personal", kind: "personal", name: null, role: null, active: false },
      { id: "org_9", kind: "organization", name: "acme-boat", role: "admin", active: true },
    ],
  },
  billing: { mode: "pinned", organization: "org_9" },
  requiredPermissions: [...BOAT_KEY_REQUIRED_PERMISSIONS],
  permissions: {
    observed: true,
    held: [...BOAT_KEY_REQUIRED_PERMISSIONS],
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

/** A key Boat refuses outright (`403 api_key_expired`): every fact Sealant asks about is unread. */
export const refusedKeyReportFixture = (now: Date = new Date()): BoatKeyReport => {
  const refused: BoatKeyNotObserved = {
    observed: false,
    reason: "refused",
    boat: {
      ...KEY_LIST_FORBIDDEN,
      kind: "key-expired",
      operation: "me",
      code: "api_key_expired",
      message: "API key has expired.",
    },
  };
  return boatKeyReportFixture(
    {
      identity: refused,
      keyKind: refused,
      wallet: refused,
      permissions: refused,
      expiry: refused,
      start: refused,
      snapshots: refused,
    },
    now,
  );
};

/**
 * A server that offers Boat as its machine view reports it to an operator: both public addresses
 * answered, its own key checked, and Sealant listing Boat with the resource gateway.
 */
export const serverBoatFactsFixture = (
  overrides: Partial<ServerBoatFacts> = {},
  now: Date = new Date(),
): ServerBoatFacts => ({
  addresses: [
    {
      purpose: "sessions",
      url: "https://mend.example.ts.net:8443",
      answer: { answered: true, status: 404 },
      observedAt: now,
    },
    {
      purpose: "saved-work",
      url: "https://mend.example.ts.net:10000",
      answer: { answered: true, status: 403 },
      observedAt: now,
    },
  ],
  serverKey: { state: "held", report: boatKeyReportFixture({}, now) },
  storedKeys: 1,
  launch: { state: "listed", observedAt: now, resourceGateway: true },
  ...overrides,
});

const passed = (step: BoatKeyProofStep["step"]): BoatKeyProofStep => ({
  step,
  outcome: "passed",
  boat: null,
});
const notReached = (step: BoatKeyProofStep["step"]): BoatKeyProofStep => ({
  step,
  outcome: "not-reached",
  boat: null,
});

/**
 * A full check shaped as sealant 0.40.0-next.874 answers it (sealant#638's fake Boat): `passed`, refused
 * at publishing a port for a missing `host` permission, or interrupted and swept. Never a real VM.
 */
export const boatKeyProofFixture = (
  outcome: BoatKeyProof["outcome"],
  finishedAt: Date = new Date(),
  leftBehind: BoatKeyProof["leftBehind"] = { vm: null, snapshot: null, removalConfirmed: true },
): BoatKeyProof => {
  const startedAt = new Date(finishedAt.getTime() - 64_000);
  const steps: BoatKeyProof["steps"] =
    outcome === "passed"
      ? [
          passed("start-vm"),
          passed("run-command"),
          passed("publish-port"),
          passed("save-snapshot"),
          passed("delete-snapshot"),
          passed("delete-vm"),
        ]
      : outcome === "refused"
        ? [
            passed("start-vm"),
            passed("run-command"),
            {
              step: "publish-port",
              outcome: "refused",
              boat: {
                ...KEY_LIST_FORBIDDEN,
                kind: "permission-missing",
                operation: "publishPort",
                code: "api_key_action_forbidden",
                message: "This API key is not allowed to perform host.",
                permission: "host",
              },
            },
            notReached("save-snapshot"),
            notReached("delete-snapshot"),
            passed("delete-vm"),
          ]
        : [
            passed("start-vm"),
            { step: "run-command", outcome: "no-answer", boat: null },
            notReached("publish-port"),
            notReached("save-snapshot"),
            passed("delete-snapshot"),
            passed("delete-vm"),
          ];
  return {
    proofId: `proof-${outcome}`,
    startedAt,
    finishedAt,
    outcome,
    steps,
    starts: 1,
    leftBehind,
  };
};
