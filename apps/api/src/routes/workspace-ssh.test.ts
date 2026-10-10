import { createHash } from "node:crypto";

import type { NewAuditEvent } from "@mend/db";
import { type PlatformSshKey, SealantPlatformError, type SshKeysApi } from "@mend/sealant";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";

const LAPTOP =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl laptop";
const DESKTOP =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBYI7oX0Kq0lA2N0d1H3h1Tz4pB2Gg2wC6k9Q8bZcYxW desktop";

/** OpenSSH's `SHA256:<unpadded base64>` form, as the platform reports it. */
const fingerprintOf = (publicKey: string): string =>
  `SHA256:${createHash("sha256")
    .update(Buffer.from(publicKey.split(" ")[1] ?? "", "base64"))
    .digest("base64")
    .replace(/=+$/, "")}`;

interface Row extends PlatformSshKey {
  readonly userId: string;
  archived: boolean;
}

const unavailable = () =>
  new SealantPlatformError({
    code: "UNREACHABLE",
    status: null,
    message: "platform unreachable",
    cause: null,
  });
const view = (row: Row): PlatformSshKey => ({
  sshKeyId: row.sshKeyId,
  ownerUserId: row.ownerUserId,
  name: row.name,
  algorithm: row.algorithm,
  fingerprint: row.fingerprint,
  createdAt: row.createdAt,
});

/**
 * The platform's key table as Core keeps it: active fingerprints are unique across accounts, an
 * archive is scoped to the owner, and the gateway resolves a fingerprint to an active row only.
 */
const makePlatform = () => {
  const rows: Array<Row> = [];
  let down = false;
  const sshKeys = (userId: string): SshKeysApi => ({
    list: () =>
      down
        ? Effect.fail(unavailable())
        : Effect.succeed(rows.filter((row) => row.userId === userId && !row.archived).map(view)),
    ensure: (input) =>
      Effect.suspend(() => {
        if (down) return Effect.fail(unavailable());
        const fingerprint = fingerprintOf(input.publicKey);
        const active = rows.find((row) => row.fingerprint === fingerprint && !row.archived);
        if (active !== undefined && active.userId !== userId) {
          return Effect.fail(
            new SealantPlatformError({
              code: "SshKeyConflictError",
              status: 409,
              message: "This SSH key is already registered to another account.",
              cause: null,
            }),
          );
        }
        if (active !== undefined) return Effect.succeed(view(active));
        const row: Row = {
          sshKeyId: `key-${rows.length + 1}`,
          ownerUserId: `sealant-${userId}`,
          userId,
          name: input.name ?? "key",
          algorithm: "ssh-ed25519",
          fingerprint,
          createdAt: "2026-10-10T00:00:00.000Z",
          archived: false,
        };
        rows.push(row);
        return Effect.succeed(view(row));
      }),
    remove: (sshKeyId) =>
      Effect.suspend(() => {
        if (down) return Effect.fail(unavailable());
        const row = rows.find(
          (candidate) =>
            candidate.sshKeyId === sshKeyId && candidate.userId === userId && !candidate.archived,
        );
        if (row === undefined) return Effect.succeed(null);
        row.archived = true;
        return Effect.succeed(view(row));
      }),
  });
  /** What the gateway's resolve-principal answers for an offered key: its owner, or nobody. */
  const resolve = (publicKey: string): string | null =>
    rows.find((row) => row.fingerprint === fingerprintOf(publicKey) && !row.archived)?.userId ??
    null;
  return {
    sshKeys,
    resolve,
    setDown: (value: boolean) => {
      down = value;
    },
  };
};

describe("workspace SSH keys", () => {
  let api: TenancyApi;
  const platform = makePlatform();
  const audited: Array<NewAuditEvent> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        sshKeys: platform.sshKeys,
        workspaceSshInfo: () =>
          Effect.succeed({ host: "0.0.0.0", port: 2222, usernamePrefix: "workspace" }),
        audit: {
          record: (event) =>
            Effect.sync(() => {
              audited.push(event);
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    platform.setDown(false);
  });

  const register = async (user: "carol" | "bob" | "alice", publicKey: string, name: string) => {
    const response = await api.request(user, "POST", "/api/workspace-ssh/keys", {
      publicKey,
      name,
    });
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("sshKeyId" in body)) {
      throw new Error("no key in the answer");
    }
    return String(body.sshKeyId);
  };

  const fingerprintsOf = async (user: "carol" | "bob" | "alice") => {
    const response = await api.request(user, "GET", "/api/workspace-ssh");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("keys" in body)) {
      throw new Error("no keys in the answer");
    }
    return Array.isArray(body.keys)
      ? body.keys.map((key: unknown) =>
          typeof key === "object" && key !== null && "fingerprint" in key
            ? String(key.fingerprint)
            : "",
        )
      : [];
  };

  it("lists only the caller's keys, audits a new key once, and never another's removal", async () => {
    const carolKey = await register("carol", LAPTOP, "carol-laptop");
    // Re-offering the same key (every `mend ssh setup`) returns the same row and records nothing.
    expect(await register("carol", LAPTOP, "carol-laptop")).toBe(carolKey);
    const bobKey = await register("bob", DESKTOP, "bob-desktop");

    expect(await fingerprintsOf("carol")).toEqual([fingerprintOf(LAPTOP)]);
    expect(await fingerprintsOf("bob")).toEqual([fingerprintOf(DESKTOP)]);
    expect(await fingerprintsOf("alice")).toEqual([]);
    expect(audited.map((event) => [event.action, event.actorUserId, event.subjectId])).toEqual([
      ["ssh_key.added", "carol", "carol"],
      ["ssh_key.added", "bob", "bob"],
    ]);
    expect(audited[0]?.data).toEqual({
      sshKeyId: carolKey,
      fingerprint: fingerprintOf(LAPTOP),
      name: "carol-laptop",
    });

    // Another organization's owner, and carol's own organization owner (the instance operator),
    // are answered exactly like an unknown id; carol's key still opens connections.
    for (const user of ["bob", "alice"] as const) {
      const refused = await api.request(user, "DELETE", `/api/workspace-ssh/keys/${carolKey}`);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({
        _tag: "WorkspaceSshKeyNotFound",
        sshKeyId: carolKey,
      });
    }
    expect(platform.resolve(LAPTOP)).toBe("carol");
    expect(audited).toHaveLength(2);

    const unknown = await api.request("carol", "DELETE", `/api/workspace-ssh/keys/${bobKey}`);
    expect(unknown.status).toBe(404);
    expect(platform.resolve(DESKTOP)).toBe("bob");
  });

  it("removes the caller's key so the gateway resolves it to nobody, and audits the removal", async () => {
    const carolKey = await register("carol", LAPTOP, "carol-laptop");
    expect(platform.resolve(LAPTOP)).toBe("carol");
    const before = audited.length;

    const removed = await api.request("carol", "DELETE", `/api/workspace-ssh/keys/${carolKey}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      sshKeyId: carolKey,
      fingerprint: fingerprintOf(LAPTOP),
    });
    expect(platform.resolve(LAPTOP)).toBeNull();
    expect(await fingerprintsOf("carol")).toEqual([]);
    expect(audited.slice(before)).toEqual([
      {
        organizationId: expect.any(String),
        actorUserId: "carol",
        action: "ssh_key.removed",
        subjectType: "member",
        subjectId: "carol",
        data: { sshKeyId: carolKey, fingerprint: fingerprintOf(LAPTOP), name: "carol-laptop" },
      },
    ]);

    // Removed once; a second removal is a 404 and records nothing.
    const again = await api.request("carol", "DELETE", `/api/workspace-ssh/keys/${carolKey}`);
    expect(again.status).toBe(404);
    expect(audited).toHaveLength(before + 1);
  });

  it("answers 502 and records nothing when the platform cannot be reached", async () => {
    const before = audited.length;
    platform.setDown(true);
    const refused = await api.request("carol", "DELETE", "/api/workspace-ssh/keys/key-1");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toMatchObject({ _tag: "SealantUnavailable" });
    expect(audited).toHaveLength(before);
  });
});
