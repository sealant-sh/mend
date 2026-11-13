import { boatKeyReportFixture } from "@mend/domain/boat-key-fixtures";
import { BOAT_KEY_REQUIRED_PERMISSIONS, Project } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { Deferred, Duration, Effect, Predicate, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeBoatWorld, refusal } from "../../test/support/boat-world.ts";
import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { accessKeyBearerOf, organizationIdOf } from "../../test/support/tenancy-harness.ts";

/** A Boat key status's details as a test reads them: the report is compared, not decoded. */
const detailsBody = Schema.decodeUnknownSync(
  Schema.Struct({ details: Schema.NullOr(Schema.Struct({ report: Schema.Unknown })) }),
);

/** A refusal's words, as a test reads them. */
const messageBody = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }));

const KEY = "boat_live_SYNTHETIC0123456789abcdef";
const REPLACEMENT = "boat_live_SYNTHETICreplacement98765";

/** A refusal's words, or "" when the answer carries none. */
const messageOf = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  return Predicate.isObject(body) && typeof body["message"] === "string" ? body["message"] : "";
};

describe("an organization's Boat key", () => {
  let api: TenancyApi;
  const logs: Array<string> = [];
  const boat = makeBoatWorld();
  const { keys, core, audited, reconciled, standbys, steps } = boat;

  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      logs,
      sessionRuntime: "boat",
      implement: boat.implement,
      boatKeyRemovalWait: { within: Duration.millis(200), every: Duration.millis(20) },
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

  it("lets an owner connect a key: sealant gets the key, Mend keeps only sealant's account", async () => {
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
        // Nothing observed about the key itself until the pinned SDK returns sealant's report.
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
    expect(await status.json()).toEqual({
      connected: true,
      sessionRuntime: "boat",
      details: null,
      peopleWithOwnKeys: null,
    });
  });

  it("keeps each organization's key to itself", async () => {
    await connect("alice");
    const theirs = await api.request("bob", "GET", "/api/organization/boat-key");
    expect(await theirs.json()).toEqual({
      connected: false,
      sessionRuntime: "boat",
      details: null,
      peopleWithOwnKeys: [],
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

  it("replaces the key in the same sealant account and records it", async () => {
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
      peopleWithOwnKeys: [],
      removal: { standbysDrained: 0 },
    });
    expect(keys.has(organizationIdOf("A"))).toBe(false);
    expect(audited.at(-1)).toEqual({
      action: "boat_key.removed",
      subjectId: "core-boat-1",
      data: { standbysDrained: 0 },
      actor: "alice",
    });
    expect(steps).toEqual(["drain core-boat-1", "remove core-boat-1", "rewarm"]);
    // Removing again is a no-op that asks sealant nothing and drains nothing.
    core.length = 0;
    steps.length = 0;
    const again = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(again.status).toBe(200);
    expect(await again.json()).not.toHaveProperty("removal");
    expect(core).toEqual([]);
    expect(steps).toEqual([]);
  });

  it("refuses at once a removal that would strand people's work, with sealant's counts, and keeps the key", async () => {
    await connect("alice");
    boat.refuseNext(refusal("in-use", { liveRuns: 2, buildsInFlight: 1 }));
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "BoatKeyConflict",
      reason: "in-use",
      liveRuns: 2,
      buildsInFlight: 1,
      message:
        "The organization's Boat account still has 2 session workspaces whose VMs and 1 image build Boat may be running, so nothing changed and the key stays. To remove it, stop the organization's Boat sessions and wait for its image builds to finish, then remove the key again.",
    });
    // Mend drained nothing there, so sealant's count is final the first time.
    expect(steps).toEqual(["drain core-boat-1", "remove core-boat-1", "rewarm"]);
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    expect(audited.map((event) => event.action)).toEqual(["boat_key.connected"]);
  });

  it("drains the standbys Mend started in the account first, then removes it in one step (SLNT-803)", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 2);
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: false,
      removal: { standbysDrained: 2 },
    });
    // Drained before sealant was asked; the organization's projects rewarm once the change ends.
    expect(steps).toEqual(["drain core-boat-1", "remove core-boat-1", "rewarm"]);
    expect(standbys.size).toBe(0);
    expect(keys.has(organizationIdOf("A"))).toBe(false);
    expect(audited.at(-1)).toMatchObject({
      action: "boat_key.removed",
      data: { standbysDrained: 2 },
    });
  });

  it("asks sealant again while it still counts a standby Mend just drained", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 1);
    boat.refuseNext(refusal("in-use", { liveRuns: 1 }));
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ removal: { standbysDrained: 1 } });
    expect(steps).toEqual([
      "drain core-boat-1",
      "remove core-boat-1",
      "drain core-boat-1",
      "remove core-boat-1",
      "rewarm",
    ]);
    expect(keys.has(organizationIdOf("A"))).toBe(false);
  });

  it("refuses with only a person's sessions counted once sealant's count stops falling, and the standbys warm again", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 2);
    boat.holds.refusal = refusal("in-use", { liveRuns: 1 });
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "BoatKeyConflict",
      reason: "in-use",
      liveRuns: 1,
      message:
        "The organization's Boat account still has 1 session workspace whose VM Boat may be running, so nothing changed and the key stays. To remove it, stop the organization's Boat sessions, then remove the key again. Mend stopped 2 standby workspaces there first; they warm again while the key stays.",
    });
    // Two answers counting the same VMs, then final; the change ended, so the pool rewarms.
    expect(steps).toEqual([
      "drain core-boat-1",
      "remove core-boat-1",
      "drain core-boat-1",
      "remove core-boat-1",
      "rewarm",
    ]);
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    expect(audited.map((event) => event.action)).toEqual(["boat_key.connected"]);
  });

  it("names Mend's own standbys, never a person's sessions, when only they hold the account (box check)", async () => {
    await connect("alice");
    // As on the box: two of Mend's standbys there, neither seen to end; no session anywhere.
    standbys.set("core-boat-1", 2);
    boat.stopping.count = 2;
    boat.holds.refusal = refusal("in-use", { liveRuns: 2 });
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    const message = await messageOf(response);
    expect(message).toMatch(
      /^Mend asked Sealant to end 2 of its own standby workspaces in the organization's Boat account and did not see them end within \d+ s, so nothing changed and the key stays\. No session holds the account\. Their VMs may still be running and billed\. Mend asks Sealant to end them again at least every 10 minutes, and again each time the key is removed\.$/,
    );
    expect(message).not.toContain("stop the organization's Boat sessions");
    expect(steps.filter((step) => step.startsWith("remove")).length).toBeGreaterThan(2);
    expect(steps.at(-1)).toBe("rewarm");
    expect(keys.has(organizationIdOf("A"))).toBe(true);
  });

  it("counts a person's session apart from Mend's standbys still ending", async () => {
    await connect("alice");
    boat.stopping.count = 1;
    boat.holds.refusal = refusal("in-use", { liveRuns: 2 });
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toMatch(
      /^The organization's Boat account still has 1 session workspace whose VM Boat may be running, so nothing changed and the key stays\. To remove it, stop the organization's Boat sessions, then remove the key again\. Mend also asked Sealant to end 1 of its own standby workspaces there and did not see it end within \d+ s\. Its VM may still be running and billed\. Mend asks Sealant to end it again at least every 10 minutes, and again each time the key is removed\.$/,
    );
  });

  it("ends where one run would when sealant removed the account but its answer was lost", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 1);
    // sealant removes the account, then its answer never reaches Mend.
    boat.lose.next = true;
    const lost = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(lost.status).toBe(503);
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    // Run again: sealant says it is removing that account, which is done as far as Mend goes.
    boat.refuseNext(refusal("removing"));
    const again = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(again.status).toBe(200);
    expect(keys.has(organizationIdOf("A"))).toBe(false);
    expect(audited.filter((event) => event.action === "boat_key.removed")).toHaveLength(1);
    expect(steps.filter((step) => step === "rewarm")).toHaveLength(2);
  });

  it("lets only one of two removals at once report the removal", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 1);
    const gate = await Effect.runPromise(Deferred.make<void>());
    boat.gate.next = gate;
    const first = api.request("alice", "DELETE", "/api/organization/boat-key");
    while (!steps.includes("remove core-boat-1")) await new Promise((wake) => setTimeout(wake, 5));
    const second = api.request("alice", "DELETE", "/api/organization/boat-key");
    await new Promise((wake) => setTimeout(wake, 50));
    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const removals = await Promise.all(
      [first, second].map(async (response) => {
        const answered = await response;
        expect(answered.status).toBe(200);
        const body: unknown = await answered.json();
        return Predicate.isObject(body) ? body["removal"] : undefined;
      }),
    );
    expect(removals).toEqual([{ standbysDrained: 1 }, undefined]);
    expect(core.filter((call) => call.call === "remove")).toHaveLength(1);
    expect(audited.filter((event) => event.action === "boat_key.removed")).toHaveLength(1);
  });

  it("forgets a key sealant already removed", async () => {
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
      expect(await messageOf(response)).toContain(scenario.words);
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
      expect(await messageOf(response)).toContain(scenario.words);
      expect(keys.get(organizationIdOf("A"))?.keyReplacedAt).toBeNull();
      expect(audited.map((event) => event.action)).toEqual(["boat_key.connected"]);
    });
  }

  it("checks what sealant holds, and says when it was observed", async () => {
    const none = await api.request("alice", "POST", "/api/organization/boat-key/check");
    expect(await none.json()).toMatchObject({ state: "none", report: null, unanswered: null });
    await connect("alice");
    const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
    const body: unknown = await checked.json();
    expect(body).toMatchObject({ state: "active", report: null, unanswered: null });
    const { observedAt } = Schema.decodeUnknownSync(Schema.Struct({ observedAt: Schema.String }))(
      body,
    );
    expect(Number.isNaN(Date.parse(observedAt))).toBe(false);
    boat.refuseNext(refusal("not-found"));
    const missing = await api.request("alice", "POST", "/api/organization/boat-key/check");
    expect(await missing.json()).toMatchObject({ state: "missing" });
  });

  describe("what Boat says about the key", () => {
    const OBSERVED = new Date("2026-11-13T14:02:00.000Z");
    const report = boatKeyReportFixture({}, OBSERVED);
    const statusOf = async (user: "alice" | "carol") =>
      detailsBody(await (await api.request(user, "GET", "/api/organization/boat-key")).json());

    it("answers sealant's report after a connect, without asking Boat again", async () => {
      boat.observe(report);
      const body = detailsBody(await (await connect("alice")).json());
      expect(body.details?.report).toMatchObject({
        observedAt: OBSERVED.toISOString(),
        identity: { observed: true, login: "acme-ci" },
        permissions: { observed: true, missing: [] },
        snapshots: { observed: true, used: 7, included: 10 },
      });
      expect(core.map((call) => call.call)).toEqual(["create"]);
    });

    it("reads the last report on status from sealant's list, never a check", async () => {
      boat.observe(report);
      await connect("alice");
      core.length = 0;
      expect((await statusOf("alice")).details?.report).toMatchObject({
        observedAt: OBSERVED.toISOString(),
        wallet: { observed: true, organizationName: "acme-boat" },
      });
      expect(core.map((call) => call.call)).toEqual(["list"]);
    });

    it("gives a member no details and asks sealant nothing", async () => {
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
      const body = detailsBody(await (await connect("alice", REPLACEMENT)).json());
      expect(body.details?.report).toMatchObject({ expiry: { observed: true, expired: true } });
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

    it("names the missing permissions when sealant refuses a key without them", async () => {
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
      const body = messageBody(await refused.json());
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

    it("logs when sealant needs a permission the page's command does not ask for", async () => {
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

describe("a person's own Boat key (SLNT-797)", () => {
  let api: TenancyApi;
  const logs: Array<string> = [];
  const boat = makeBoatWorld();
  const { keys, core, audited, reconciled, standbys, steps } = boat;
  const A = organizationIdOf("A");
  const B = organizationIdOf("B");

  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      logs,
      sessionRuntime: "boat",
      implement: boat.implement,
      boatKeyRemovalWait: { within: Duration.millis(200), every: Duration.millis(20) },
    });
    const kept = [...api.world.projects.values()].find((project) => project.organizationId === A);
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

  const ROUTE = "/api/me/boat-key";
  const connectOwn = (user: "alice" | "bob" | "carol" | "erin", key = KEY) =>
    api.request(user, "PUT", ROUTE, { key });

  it("lets a member connect their own key in their organization, kept apart from the organization's", async () => {
    const response = await connectOwn("carol");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      organizationName: "Organization A",
      connected: true,
      sessionRuntime: "boat",
      organizationKey: false,
      details: {
        sealantBoatAccountId: "core-boat-1",
        connectedByUserId: "carol",
        connectedByName: "Carol",
        keyReplacedAt: null,
        report: null,
      },
    });
    expect(core).toEqual([{ call: "create", label: "Mend · Organization A · carol", key: KEY }]);
    expect(keys.get(`${A}/carol`)?.owner).toEqual({
      kind: "person",
      organizationId: A,
      userId: "carol",
    });
    expect(keys.has(A)).toBe(false);
    expect(audited).toEqual([
      {
        action: "boat_key.connected",
        subjectId: "core-boat-1",
        data: { key: "own" },
        actor: "carol",
      },
    ]);
    // Her standbys in the organization's account drain: a person's own key keeps none.
    expect(reconciled).toHaveLength(1);
    // The organization's key is still not connected, and members still read only that.
    const organization = await api.request("carol", "GET", "/api/organization/boat-key");
    expect(await organization.json()).toEqual({
      connected: false,
      sessionRuntime: "boat",
      details: null,
      peopleWithOwnKeys: null,
    });
  });

  it("answers what Boat says about the caller's own key, as the organization's", async () => {
    const OBSERVED = new Date("2026-11-13T14:02:00.000Z");
    boat.observe(boatKeyReportFixture({}, OBSERVED));
    const connected = detailsBody(await (await connectOwn("carol")).json());
    expect(connected.details?.report).toMatchObject({
      observedAt: OBSERVED.toISOString(),
      identity: { observed: true, login: "acme-ci" },
    });
    core.length = 0;
    const status = detailsBody(await (await api.request("carol", "GET", ROUTE)).json());
    expect(status.details?.report).toMatchObject({ wallet: { observed: true } });
    expect(core.map((call) => call.call)).toEqual(["list"]);
    core.length = 0;
    const checked = await api.request("carol", "POST", `${ROUTE}/check`);
    expect(await checked.json()).toMatchObject({
      state: "active",
      observedAt: OBSERVED.toISOString(),
      report: { identity: { observed: true, displayName: "Acme CI" } },
      unanswered: null,
    });
    expect(core.map((call) => call.call)).toEqual(["check"]);
  });

  it("words a refusal of the caller's own key with their own page and command", async () => {
    boat.refuseNext(
      refusal("key-refused", {
        boat: {
          kind: "key-expired",
          retryable: false,
          operation: "verify",
          status: 403,
          code: "api_key_expired",
          message: "API key expired.",
          requestId: "req_route2",
          permission: null,
          retryAfterSeconds: null,
          retryAt: null,
          billingUrl: null,
        },
      }),
    );
    const refused = await connectOwn("carol");
    expect(refused.status).toBe(422);
    expect(messageBody(await refused.json()).message).toBe(
      "This Boat key has expired, so Boat refused it and nothing changed. Create a new key using the command in Settings, Account and connect that one there, or with mend boat connect --mine. Boat keys last 90 days unless made to last longer; the command on the Boat page makes one that lasts a year.",
    );
    boat.refuseNext(refusal("missing-permissions", { missingPermissions: ["host"] }));
    const lacking = await connectOwn("carol");
    expect(messageBody(await lacking.json()).message).toContain(
      "Create a key with the command on the Boat key card in Settings, Account, which grants",
    );
  });

  it("shows an owner that a member has their own key, and none of its details", async () => {
    await connectOwn("carol");
    const owner = await api.request("alice", "GET", "/api/organization/boat-key");
    const body = await owner.json();
    expect(body).toEqual({
      connected: false,
      sessionRuntime: "boat",
      details: null,
      peopleWithOwnKeys: [{ userId: "carol", name: "Carol" }],
    });
    expect(JSON.stringify(body)).not.toContain("core-boat-1");
    // Another organization's owner sees nobody from organization A.
    const other = await api.request("bob", "GET", "/api/organization/boat-key");
    expect(await other.json()).toMatchObject({ peopleWithOwnKeys: [] });
  });

  it("gives nobody else a way to read, check, replace or remove a person's key", async () => {
    await connectOwn("carol");
    core.length = 0;
    // An owner's own requests act on the owner's own row: carol's key stays as it is.
    const ownerStatus = await api.request("alice", "GET", ROUTE);
    expect(await ownerStatus.json()).toMatchObject({ connected: false, details: null });
    const ownerCheck = await api.request("alice", "POST", `${ROUTE}/check`);
    expect(await ownerCheck.json()).toMatchObject({ state: "none" });
    const ownerRemove = await api.request("alice", "DELETE", ROUTE);
    expect(await ownerRemove.json()).not.toHaveProperty("removal");
    // The organization's routes never reach it either.
    await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(core).toEqual([]);
    expect(steps).toEqual([]);
    expect(keys.get(`${A}/carol`)?.sealantBoatAccountId).toBe("core-boat-1");
    expect(keys.get(`${A}/carol`)?.keyReplacedAt).toBeNull();
    // A connect by the owner makes the owner's own key, beside carol's.
    await connectOwn("alice", REPLACEMENT);
    expect(core).toEqual([
      { call: "create", label: "Mend · Organization A · alice", key: REPLACEMENT },
    ]);
    expect(keys.get(`${A}/carol`)?.sealantBoatAccountId).toBe("core-boat-1");
    expect(keys.get(`${A}/alice`)?.sealantBoatAccountId).toBe("core-boat-2");
  });

  it("keeps a person's key to the organization it was connected in", async () => {
    // Erin owns A and is a member of B; her active organization is A.
    await connectOwn("erin");
    expect(keys.get(`${A}/erin`)?.sealantBoatAccountId).toBe("core-boat-1");
    expect(keys.has(`${B}/erin`)).toBe(false);
    // Bob, B's owner, sees no one with their own key in B.
    const owner = await api.request("bob", "GET", "/api/organization/boat-key");
    expect(await owner.json()).toMatchObject({ peopleWithOwnKeys: [] });
    // In B, bob's own key is his and nobody else's.
    await connectOwn("bob", REPLACEMENT);
    expect(keys.get(`${B}/bob`)?.sealantBoatAccountId).toBe("core-boat-2");
    const erinStatus = await api.request("erin", "GET", ROUTE);
    expect(await erinStatus.json()).toMatchObject({
      organizationName: "Organization A",
      details: { sealantBoatAccountId: "core-boat-1" },
    });
  });

  it("says when the organization has its own key, which decides once theirs is gone", async () => {
    await api.request("alice", "PUT", "/api/organization/boat-key", { key: REPLACEMENT });
    await connectOwn("carol");
    const status = await api.request("carol", "GET", ROUTE);
    expect(await status.json()).toMatchObject({ connected: true, organizationKey: true });
  });

  it("replaces a person's key in the same sealant account and records it as theirs", async () => {
    await connectOwn("carol");
    const response = await connectOwn("carol", REPLACEMENT);
    expect(await response.json()).toMatchObject({
      details: { sealantBoatAccountId: "core-boat-1", keyReplacedAt: "2026-11-13T13:00:00.000Z" },
    });
    expect(core.at(-1)).toEqual({ call: "rotate", boatAccountId: "core-boat-1", key: REPLACEMENT });
    expect(audited.at(-1)).toMatchObject({ action: "boat_key.replaced", data: { key: "own" } });
  });

  it("refuses a replacement in the person's words, and keeps the key", async () => {
    await connectOwn("carol");
    boat.refuseNext(refusal("cannot-see", { unseen: 2 }));
    const response = await connectOwn("carol", REPLACEMENT);
    expect(response.status).toBe(409);
    expect(await messageOf(response)).toContain(
      "This key cannot see 2 VMs or saved images your Boat account holds now",
    );
    expect(keys.get(`${A}/carol`)?.keyReplacedAt).toBeNull();
  });

  it("removes a person's key: their standbys drain first, and their sessions go back to the organization's key", async () => {
    await connectOwn("carol");
    standbys.set("core-boat-1", 1);
    const response = await api.request("carol", "DELETE", ROUTE);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: false,
      details: null,
      removal: { standbysDrained: 1 },
    });
    expect(steps).toEqual(["drain core-boat-1", "remove core-boat-1", "rewarm"]);
    expect(keys.has(`${A}/carol`)).toBe(false);
    expect(audited.at(-1)).toEqual({
      action: "boat_key.removed",
      subjectId: "core-boat-1",
      data: { key: "own", standbysDrained: 1 },
      actor: "carol",
    });
    // A retry finds nothing to remove, and asks sealant nothing.
    core.length = 0;
    steps.length = 0;
    const again = await api.request("carol", "DELETE", ROUTE);
    expect(again.status).toBe(200);
    expect(await again.json()).not.toHaveProperty("removal");
    expect(core).toEqual([]);
    expect(steps).toEqual([]);
  });

  it("refuses a removal while a session of theirs holds the account, with the count, and keeps the key", async () => {
    await connectOwn("carol");
    boat.refuseNext(refusal("in-use", { liveRuns: 1 }));
    const response = await api.request("carol", "DELETE", ROUTE);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "BoatKeyConflict",
      reason: "in-use",
      liveRuns: 1,
      message:
        "Your Boat account still has 1 session workspace whose VM Boat may be running, so nothing changed and the key stays. To remove it, stop your Boat sessions, then remove the key again.",
    });
    expect(keys.has(`${A}/carol`)).toBe(true);
  });

  it("refuses an access key connecting or removing a person's key, and sends sealant nothing", async () => {
    const headers = { authorization: `Bearer ${accessKeyBearerOf("carol")}` };
    for (const response of [
      await api.request(null, "PUT", ROUTE, { key: KEY }, headers),
      await api.request(null, "DELETE", ROUTE, undefined, headers),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ _tag: "AccessKeyRefused" });
    }
    expect(core).toEqual([]);
    expect(keys.size).toBe(0);
  });

  it("never writes the key to a response, an error, the audit log or a log line", async () => {
    const bodies: Array<string> = [];
    bodies.push(await (await connectOwn("carol")).text());
    boat.refuseNext(refusal("cannot-see", { unseen: 1 }));
    bodies.push(await (await connectOwn("carol", REPLACEMENT)).text());
    bodies.push(await (await connectOwn("carol", REPLACEMENT)).text());
    bodies.push(await (await connectOwn("carol", "x")).text());
    bodies.push(await (await api.request("carol", "GET", ROUTE)).text());
    bodies.push(await (await api.request("alice", "GET", "/api/organization/boat-key")).text());
    bodies.push(await (await api.request("carol", "POST", `${ROUTE}/check`)).text());
    bodies.push(await (await api.request("carol", "DELETE", ROUTE)).text());
    expect(logs.length).toBeGreaterThan(0);
    const everything = [...bodies, JSON.stringify(audited), JSON.stringify([...keys]), ...logs];
    for (const secret of [KEY, REPLACEMENT, KEY.slice(10), REPLACEMENT.slice(10)]) {
      expect(everything.filter((text) => text.includes(secret))).toEqual([]);
    }
  });
});
