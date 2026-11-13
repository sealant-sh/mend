import { boatKeyReportFixture } from "@mend/domain/boat-key-fixtures";
import { BOAT_KEY_REQUIRED_PERMISSIONS, Project } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeBoatWorld, refusal } from "../../test/support/boat-world.ts";
import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { organizationIdOf } from "../../test/support/tenancy-harness.ts";

const KEY = "boat_live_SYNTHETIC0123456789abcdef";
const REPLACEMENT = "boat_live_SYNTHETICreplacement98765";

describe("an organization's Boat key", () => {
  let api: TenancyApi;
  const logs: Array<string> = [];
  const boat = makeBoatWorld();
  const { keys, core, audited, reconciled } = boat;

  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      logs,
      sessionRuntime: "boat",
      implement: boat.implement,
    });
    const kept = [...api.world.projects.values()].find(
      (project) => project.organizationId === organizationIdOf("A"),
    );
    if (kept === undefined) throw new Error("organization A has no project");
    api.world.addProject(new Project({ ...kept, hotSessions: 1 }));
  });

  afterAll(async () => {
    await api.dispose();
  });

  beforeEach(() => {
    boat.reset();
    logs.length = 0;
  });

  const connect = (user: "alice" | "bob" | "carol", key = KEY) =>
    api.request(user, "PUT", "/api/organization/boat-key", { key });

  it("lets an owner connect a key: Core gets the key, Mend keeps only Core's account", async () => {
    const response = await connect("alice");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      connected: true,
      sessionRuntime: "boat",
      details: {
        sealantBoatAccountId: "core-boat-1",
        connectedByUserId: "alice",
        connectedByName: "Alice",
        keyReplacedAt: null,
        // Nothing observed about the key itself until the pinned SDK returns Core's report.
        report: null,
      },
    });
    expect(core).toEqual([{ call: "create", label: "Mend · Organization A", key: KEY }]);
    expect(keys.get(organizationIdOf("A"))).toMatchObject({
      sealantBoatAccountId: "core-boat-1",
      connectedByUserId: "alice",
    });
    expect(audited).toEqual([
      { action: "boat_key.connected", subjectId: "core-boat-1", data: {}, actor: "alice" },
    ]);
    // The organization's standbys move to the account its launches name now.
    expect(reconciled).toHaveLength(1);
  });

  it("trims a pasted key and refuses one that cannot be a Boat key without sending it", async () => {
    await connect("alice", `${KEY}\n`);
    expect(core.at(-1)?.key).toBe(KEY);
    keys.clear();
    core.length = 0;
    const response = await connect("alice", "boat key please");
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ _tag: "BoatKeyRefused", reason: "shape" });
    expect(core).toEqual([]);
  });

  it("refuses a member and tells them only whether the organization has a key", async () => {
    await connect("alice");
    core.length = 0;
    const refused = await connect("carol", REPLACEMENT);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ _tag: "BoatKeyOwnersOnly" });
    for (const [method, path] of [
      ["DELETE", "/api/organization/boat-key"],
      ["POST", "/api/organization/boat-key/check"],
    ] as const) {
      expect((await api.request("carol", method, path)).status).toBe(403);
    }
    expect(core).toEqual([]);
    const status = await api.request("carol", "GET", "/api/organization/boat-key");
    expect(await status.json()).toEqual({ connected: true, sessionRuntime: "boat", details: null });
  });

  it("keeps each organization's key to itself", async () => {
    await connect("alice");
    const theirs = await api.request("bob", "GET", "/api/organization/boat-key");
    expect(await theirs.json()).toEqual({
      connected: false,
      sessionRuntime: "boat",
      details: null,
    });
    // Bob's connect makes organization B's own account and leaves A's alone.
    await connect("bob", REPLACEMENT);
    expect(core.map((call) => call.call)).toEqual(["create", "create"]);
    expect(keys.get(organizationIdOf("A"))?.sealantBoatAccountId).toBe("core-boat-1");
    expect(keys.get(organizationIdOf("B"))?.sealantBoatAccountId).toBe("core-boat-2");
    const removed = await api.request("bob", "DELETE", "/api/organization/boat-key");
    expect(removed.status).toBe(200);
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    expect(core.at(-1)).toEqual({ call: "remove", boatAccountId: "core-boat-2" });
  });

  it("replaces the key in the same Core account and records it", async () => {
    await connect("alice");
    const response = await connect("alice", REPLACEMENT);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      details: { sealantBoatAccountId: "core-boat-1", keyReplacedAt: "2026-11-13T13:00:00.000Z" },
    });
    expect(core.at(-1)).toEqual({ call: "rotate", boatAccountId: "core-boat-1", key: REPLACEMENT });
    expect(audited.map((event) => event.action)).toEqual([
      "boat_key.connected",
      "boat_key.replaced",
    ]);
  });

  it("removes the key: new sessions go back to the server's key, and it is recorded", async () => {
    await connect("alice");
    reconciled.length = 0;
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: false,
      sessionRuntime: "boat",
      details: null,
    });
    expect(keys.has(organizationIdOf("A"))).toBe(false);
    expect(audited.at(-1)).toEqual({
      action: "boat_key.removed",
      subjectId: "core-boat-1",
      data: {},
      actor: "alice",
    });
    expect(reconciled).toHaveLength(1);
    // Removing again is a no-op that asks Core nothing.
    core.length = 0;
    expect((await api.request("alice", "DELETE", "/api/organization/boat-key")).status).toBe(200);
    expect(core).toEqual([]);
  });

  it("refuses a removal that would strand VMs, with Core's counts, and keeps the key", async () => {
    await connect("alice");
    boat.refuseNext(refusal("in-use", { liveRuns: 2, buildsInFlight: 1 }));
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "BoatKeyConflict",
      reason: "in-use",
      liveRuns: 2,
      buildsInFlight: 1,
      message: expect.stringContaining(
        "still has 2 workspaces whose VMs and 1 image build Boat may be running",
      ),
    });
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    expect(audited.map((event) => event.action)).toEqual(["boat_key.connected"]);
  });

  it("forgets a key Core already removed", async () => {
    await connect("alice");
    boat.refuseNext(refusal("not-found"));
    expect((await api.request("alice", "DELETE", "/api/organization/boat-key")).status).toBe(200);
    expect(keys.has(organizationIdOf("A"))).toBe(false);
  });

  for (const scenario of [
    {
      name: "a key Boat refused",
      error: refusal("key-refused"),
      status: 422,
      words: "Boat refused this key, so nothing changed.",
    },
    {
      name: "a key without every permission Mend needs",
      error: refusal("missing-permissions", {
        missingPermissions: ["sandbox.delete", "snapshot.write"],
      }),
      status: 422,
      words:
        "This Boat key lacks permissions Mend needs: sandbox.delete, snapshot.write. Nothing changed. Create a key with the command on Mend's Boat page",
    },
    {
      name: "Boat not answering",
      error: refusal("key-unverified"),
      status: 422,
      words: "Boat did not answer when Sealant checked the key",
    },
    {
      name: "a server without Boat",
      error: refusal("unavailable"),
      status: 503,
      words: "This server's Sealant does not run Boat",
    },
    {
      name: "Sealant out of reach",
      error: new SealantPlatformError({
        code: "HttpClientError",
        status: null,
        message: "connect ECONNREFUSED",
        cause: null,
      }),
      status: 503,
      words: "Mend could not reach this server's Sealant",
    },
  ]) {
    it(`says what to do about ${scenario.name} on connect, and keeps nothing`, async () => {
      boat.refuseNext(scenario.error);
      const response = await connect("alice");
      expect(response.status).toBe(scenario.status);
      expect(((await response.json()) as { message: string }).message).toContain(scenario.words);
      expect(keys.size).toBe(0);
      expect(audited).toEqual([]);
    });
  }

  for (const scenario of [
    {
      name: "a key that cannot see the account's VMs",
      error: refusal("cannot-see", { unseen: 3 }),
      words: "This key cannot see 3 VMs or saved images the organization's Boat account holds now",
    },
    {
      name: "a launch in flight",
      error: refusal("in-use", { liveRuns: 1 }),
      words: "A Boat session in the organization is starting right now",
    },
    {
      name: "an account being removed",
      error: refusal("removing"),
      words: "is being removed, so it cannot be replaced",
    },
  ]) {
    it(`says what to do about ${scenario.name} on replace, and keeps the key`, async () => {
      await connect("alice");
      boat.refuseNext(scenario.error);
      const response = await connect("alice", REPLACEMENT);
      expect(response.status).toBe(409);
      expect(((await response.json()) as { message: string }).message).toContain(scenario.words);
      expect(keys.get(organizationIdOf("A"))?.keyReplacedAt).toBeNull();
      expect(audited.map((event) => event.action)).toEqual(["boat_key.connected"]);
    });
  }

  it("checks what Core holds, and says when it was observed", async () => {
    const none = await api.request("alice", "POST", "/api/organization/boat-key/check");
    expect(await none.json()).toMatchObject({ state: "none", report: null, unanswered: null });
    await connect("alice");
    const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
    const body = (await checked.json()) as { state: string; observedAt: string; report: null };
    expect(body).toMatchObject({ state: "active", report: null, unanswered: null });
    expect(Number.isNaN(Date.parse(body.observedAt))).toBe(false);
    boat.refuseNext(refusal("not-found"));
    const missing = await api.request("alice", "POST", "/api/organization/boat-key/check");
    expect(await missing.json()).toMatchObject({ state: "missing" });
  });

  describe("what Boat says about the key", () => {
    const OBSERVED = new Date("2026-11-13T14:02:00.000Z");
    const report = boatKeyReportFixture({}, OBSERVED);
    const statusOf = async (user: "alice" | "carol") =>
      (await (await api.request(user, "GET", "/api/organization/boat-key")).json()) as {
        details: { report: unknown } | null;
      };

    it("answers Core's report after a connect, without asking Boat again", async () => {
      boat.observe(report);
      const body = (await (await connect("alice")).json()) as { details: { report: unknown } };
      expect(body.details.report).toMatchObject({
        observedAt: OBSERVED.toISOString(),
        identity: { observed: true, login: "acme-ci" },
        permissions: { observed: true, missing: [] },
        snapshots: { observed: true, used: 7, included: 10 },
      });
      expect(core.map((call) => call.call)).toEqual(["create"]);
    });

    it("reads the last report on status from Core's list, never a check", async () => {
      boat.observe(report);
      await connect("alice");
      core.length = 0;
      expect((await statusOf("alice")).details?.report).toMatchObject({
        observedAt: OBSERVED.toISOString(),
        wallet: { observed: true, organizationName: "acme-boat" },
      });
      expect(core.map((call) => call.call)).toEqual(["list"]);
    });

    it("gives a member no details and asks Core nothing", async () => {
      boat.observe(report);
      await connect("alice");
      core.length = 0;
      expect((await statusOf("carol")).details).toBeNull();
      expect(core).toEqual([]);
    });

    it("answers the new key's report after a replace", async () => {
      await connect("alice");
      const expired = boatKeyReportFixture(
        { expiry: { observed: true, expiresAt: OBSERVED, expired: true, expiringSoon: false } },
        OBSERVED,
      );
      boat.observe(expired);
      const body = (await (await connect("alice", REPLACEMENT)).json()) as {
        details: { report: unknown };
      };
      expect(body.details.report).toMatchObject({ expiry: { observed: true, expired: true } });
    });

    it("checks the key with Boat now on Check now, and answers the fresh report", async () => {
      await connect("alice");
      core.length = 0;
      boat.observe(report);
      const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
      expect(await checked.json()).toMatchObject({
        state: "active",
        observedAt: OBSERVED.toISOString(),
        report: { identity: { observed: true, displayName: "Acme CI" } },
        unanswered: null,
      });
      expect(core).toEqual([{ call: "check", boatAccountId: "core-boat-1" }]);
    });

    it("keeps the last report, and says so, when Boat does not answer a check", async () => {
      boat.observe(report);
      await connect("alice");
      boat.refuseNext(refusal("key-unverified"));
      const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
      expect(checked.status).toBe(200);
      expect(await checked.json()).toMatchObject({
        state: "active",
        report: { observedAt: OBSERVED.toISOString() },
        unanswered: expect.stringContaining("Boat did not answer this check"),
      });
    });

    it("names the missing permissions when Core refuses a key without them", async () => {
      boat.refuseNext(refusal("missing-permissions", { missingPermissions: ["sandbox.delete"] }));
      const refused = await connect("alice");
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        _tag: "BoatKeyRefused",
        reason: "missing-permissions",
        message: expect.stringContaining(
          "This Boat key lacks a permission Mend needs: sandbox.delete.",
        ),
      });
      expect(keys.size).toBe(0);
    });

    it("words a key Boat refused with Boat's reason from the shared table, and logs Boat's code", async () => {
      boat.refuseNext(
        refusal("key-refused", {
          boat: {
            kind: "key-expired",
            retryable: false,
            operation: "verify",
            status: 403,
            code: "api_key_expired",
            message: "API key expired.",
            requestId: "req_route1",
            permission: null,
            retryAfterSeconds: null,
            retryAt: null,
            billingUrl: null,
          },
        }),
      );
      const refused = await connect("alice");
      expect(refused.status).toBe(422);
      const body = (await refused.json()) as { message: string };
      expect(body.message).toBe(
        "This Boat key has expired, so Boat refused it and nothing changed. Create a new key using the command on Mend's Boat page (Settings, Organization, Boat) and connect that one. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
      );
      expect(body.message).not.toContain("api_key_expired");
      expect(body.message).not.toContain("req_route1");
      expect(logs.join("\n")).toContain("api_key_expired · request req_route1");
    });

    it("says when to try a check again when Boat asked to wait", async () => {
      boat.observe(report);
      await connect("alice");
      boat.refuseNext(
        refusal("key-unverified", {
          boat: {
            kind: "rate-limited",
            retryable: true,
            operation: "verify",
            status: 429,
            code: "rate_limited",
            message: null,
            requestId: null,
            permission: null,
            retryAfterSeconds: 30,
            retryAt: null,
            billingUrl: null,
          },
        }),
      );
      const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
      expect(await checked.json()).toMatchObject({
        report: { observedAt: OBSERVED.toISOString() },
        unanswered:
          "Boat asked Sealant to wait before asking about this Boat key again, so nothing changed. Try again in about 30 seconds, as Boat asked. Nothing needs changing. The report shown is the last one Sealant observed.",
      });
    });

    it("logs when Core needs a permission the page's command does not ask for", async () => {
      boat.observe(
        boatKeyReportFixture({
          requiredPermissions: [...BOAT_KEY_REQUIRED_PERMISSIONS, "sandbox.fork"],
        }),
      );
      await connect("alice");
      await api.request("alice", "GET", "/api/organization/boat-key");
      expect(logs.join("\n")).toContain(
        "Sealant needs Boat permissions the create-key command does not ask for: sandbox.fork",
      );
    });
  });

  it("never writes the key to a response, an error, the audit log or a log line", async () => {
    const bodies: Array<string> = [];
    bodies.push(await (await connect("alice")).text());
    boat.refuseNext(refusal("cannot-see", { unseen: 1 }));
    bodies.push(await (await connect("alice", REPLACEMENT)).text());
    bodies.push(await (await connect("alice", REPLACEMENT)).text());
    bodies.push(await (await connect("alice", "x")).text());
    bodies.push(await (await api.request("alice", "GET", "/api/organization/boat-key")).text());
    bodies.push(
      await (await api.request("alice", "POST", "/api/organization/boat-key/check")).text(),
    );
    bodies.push(await (await api.request("alice", "DELETE", "/api/organization/boat-key")).text());
    expect(logs.length).toBeGreaterThan(0);
    const everything = [...bodies, JSON.stringify(audited), JSON.stringify([...keys]), ...logs];
    for (const secret of [KEY, REPLACEMENT, KEY.slice(10), REPLACEMENT.slice(10)]) {
      expect(everything.filter((text) => text.includes(secret))).toEqual([]);
    }
  });
});
