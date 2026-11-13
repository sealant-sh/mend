import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { BoatKeyCheck, BoatKeyStatus } from "./boat-key.ts";

const StatusWire = Schema.toCodecJson(BoatKeyStatus);
const CheckWire = Schema.toCodecJson(BoatKeyCheck);

const details = {
  sealantBoatAccountId: "core-boat-1",
  connectedByUserId: "alice",
  connectedByName: "Alice",
  connectedAt: "2026-11-08T09:00:00.000Z",
  keyReplacedAt: null,
};

const report = {
  observedAt: "2026-11-13T14:02:00.000Z",
  organization: null,
  identity: {
    observed: true,
    accountId: "acct_1",
    login: "acme",
    displayName: null,
    serviceAccount: null,
    accountStatus: "active",
  },
  keyKind: { observed: true, kind: "personal" },
  wallet: {
    observed: false,
    reason: "refused",
    boat: { code: "forbidden", status: 403, message: null },
  },
  requiredPermissions: ["exec"],
  permissions: { observed: true, held: ["*"], missing: [], limitedToSandboxes: false },
  expiry: { observed: true, expiresAt: null, expired: false, expiringSoon: false },
  start: { observed: false, reason: "no-answer", boat: null },
  snapshots: { observed: true, used: 7, included: 10 },
};

describe("the Boat key's wire", () => {
  it("reads an answer from a server that sends no report as one with nothing observed", () => {
    const status = Schema.decodeUnknownSync(StatusWire)({
      connected: true,
      sessionRuntime: "boat",
      details,
    });
    expect(status.details?.report).toBeNull();
  });

  it("carries a report with observed and not-observed facts, and its dates", () => {
    const check = Schema.decodeUnknownSync(CheckWire)({
      state: "active",
      observedAt: "2026-11-13T14:02:00.000Z",
      keyReplacedAt: null,
      report,
    });
    expect(check.report?.observedAt).toEqual(new Date("2026-11-13T14:02:00.000Z"));
    expect(check.report?.wallet).toEqual({
      observed: false,
      reason: "refused",
      boat: { code: "forbidden", status: 403, message: null },
    });
    expect(Schema.encodeSync(CheckWire)(check)).toMatchObject({ report });
  });
});
