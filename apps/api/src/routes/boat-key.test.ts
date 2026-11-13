import { Project } from "@mend/domain/workbench";
import { SealantPlatformError } from "@mend/sealant";
import { Deferred, Duration, Effect } from "effect";
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
  const { keys, accounts, core, audited, reconciled, standbys, steps } = boat;

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
    // Removing again is a no-op that asks Core nothing and drains nothing.
    core.length = 0;
    steps.length = 0;
    const again = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(again.status).toBe(200);
    expect(await again.json()).not.toHaveProperty("removal");
    expect(core).toEqual([]);
    expect(steps).toEqual([]);
  });

  it("refuses at once a removal that would strand people's work, with Core's counts, and keeps the key", async () => {
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
    // Mend drained nothing there, so Core's count is final the first time.
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
    // Drained before Core was asked; the organization's projects rewarm once the change ends.
    expect(steps).toEqual(["drain core-boat-1", "remove core-boat-1", "rewarm"]);
    expect(standbys.size).toBe(0);
    expect(keys.has(organizationIdOf("A"))).toBe(false);
    expect(audited.at(-1)).toMatchObject({
      action: "boat_key.removed",
      data: { standbysDrained: 2 },
    });
  });

  it("asks Core again while it still counts a standby Mend just drained", async () => {
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

  it("refuses with only a person's sessions counted once Core's count stops falling, and the standbys warm again", async () => {
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

  it("says when only standbys still stopping hold the account, once the wait runs out", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 1);
    boat.stopping.count = 1;
    boat.holds.refusal = refusal("in-use", { liveRuns: 1 });
    const response = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(response.status).toBe(409);
    expect(((await response.json()) as { message: string }).message).toBe(
      "Mend is still stopping 1 standby workspace in the organization's Boat account, so nothing changed and the key stays. Remove the key again in a minute.",
    );
    expect(steps.filter((step) => step.startsWith("remove")).length).toBeGreaterThan(2);
    expect(steps.at(-1)).toBe("rewarm");
    expect(keys.has(organizationIdOf("A"))).toBe(true);
  });

  it("ends where one run would when Core removed the account but its answer was lost", async () => {
    await connect("alice");
    standbys.set("core-boat-1", 1);
    // Core removes the account, then its answer never reaches Mend.
    boat.lose.next = true;
    const lost = await api.request("alice", "DELETE", "/api/organization/boat-key");
    expect(lost.status).toBe(503);
    expect(keys.has(organizationIdOf("A"))).toBe(true);
    // Run again: Core says it is removing that account, which is done as far as Mend goes.
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
    const bodies = await Promise.all(
      [first, second].map(async (response) => {
        const answered = await response;
        expect(answered.status).toBe(200);
        return (await answered.json()) as { removal?: { standbysDrained: number } };
      }),
    );
    expect(bodies.map((body) => body.removal)).toEqual([{ standbysDrained: 1 }, undefined]);
    expect(core.filter((call) => call.call === "remove")).toHaveLength(1);
    expect(audited.filter((event) => event.action === "boat_key.removed")).toHaveLength(1);
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
    expect(await none.json()).toMatchObject({ state: "none", report: null });
    await connect("alice");
    const checked = await api.request("alice", "POST", "/api/organization/boat-key/check");
    const body = (await checked.json()) as { state: string; observedAt: string; report: null };
    expect(body).toMatchObject({ state: "active", report: null });
    expect(Number.isNaN(Date.parse(body.observedAt))).toBe(false);
    accounts.clear();
    const missing = await api.request("alice", "POST", "/api/organization/boat-key/check");
    expect(await missing.json()).toMatchObject({ state: "missing" });
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
