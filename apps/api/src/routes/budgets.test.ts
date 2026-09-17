import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";
import { DEFAULT_BUDGET_LIMITS, makeBudgets } from "../budgets.ts";

/**
 * Budgets through the real routes, over the two-organization world (docs/adr/0004, "Budgets";
 * MEND-05). A budget refuses after authorization and before any effect, so every refusal here is
 * asserted together with an empty effect log. Nothing already open is touched.
 */
let api: TenancyApi | null = null;
afterEach(async () => {
  await api?.dispose();
  api = null;
});

const newSession = { harness: "claude", label: null, name: null, base: null };
const createSession = (
  on: TenancyApi,
  user: "alice" | "carol" | "bob",
  project: "shared-a" | "shared-b",
) => on.request(user, "POST", `/api/projects/${ids(project).project}/sessions`, newSession);

describe("session ceilings", () => {
  it("refuses one more session for an account at its ceiling, with no effect", async () => {
    // Every session in the world is unsettled, and alice owns at least one of them.
    api = await createTenancyApi({ accountLiveSessions: 1 });
    api.world.calls.splice(0, api.world.calls.length);
    const response = await createSession(api, "alice", "shared-a");
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      _tag: "BudgetExceeded",
      budget: "accountLiveSessions",
      limit: 1,
      retryAfterSeconds: null,
      message:
        "budget reached · 1 unsettled sessions for one account · nothing running was stopped",
    });
    expect(api.world.calls).toEqual([]);
  });

  it("refuses for the organization at its ceiling, and only for that organization", async () => {
    // Organization A holds three sessions in the world, organization B one.
    api = await createTenancyApi({ accountLiveSessions: 0, organizationLiveSessions: 3 });
    api.world.calls.splice(0, api.world.calls.length);
    const inA = await createSession(api, "carol", "shared-a");
    expect(inA.status).toBe(429);
    expect(await inA.json()).toMatchObject({ budget: "organizationLiveSessions", limit: 3 });
    expect(api.world.calls).toEqual([]);

    const inB = await createSession(api, "bob", "shared-b");
    expect(inB.status).not.toBe(429);
  });

  it("authorization still comes first: a project the caller cannot see is missing, not over budget", async () => {
    api = await createTenancyApi({ accountLiveSessions: 1, organizationLiveSessions: 1 });
    api.world.calls.splice(0, api.world.calls.length);
    const response = await createSession(api, "bob", "shared-a");
    expect(response.status).toBe(404);
    expect(api.world.calls).toEqual([]);
  });
});

describe("the event stream budget", () => {
  it("refuses a stream over the account's budget and leaves the open ones delivering", async () => {
    api = await createTenancyApi({ accountEventStreams: 1 });
    const first = await api.events("carol");
    expect(first.status).toBe(200);
    const second = await api.events("carol");
    expect(second.status).toBe(429);
    // Another account has its own allowance.
    const other = await api.events("alice");
    expect(other.status).toBe(200);

    const sharedA = ids("shared-a");
    await api.notify({ type: "session", sessionId: sharedA.session, projectId: sharedA.project });
    expect(await first.next()).toContain(sharedA.session);

    // The allowance comes back when a stream ends; nothing had to be closed to make room.
    await first.close();
    await second.close();
    // The server sees the close when the socket does, so ask until it has, up to a deadline.
    const deadline = Date.now() + 5_000;
    let third = await api.events("carol");
    while (third.status !== 200 && Date.now() < deadline) {
      await third.close();
      await new Promise((resolve) => setTimeout(resolve, 10));
      third = await api.events("carol");
    }
    expect(third.status).toBe(200);
    await third.close();
    await other.close();
  });
});

describe("launch slots", () => {
  it("holds a bounded number of launches per account and releases however the launch ends", async () => {
    const budgets = makeBudgets({ ...DEFAULT_BUDGET_LIMITS, accountLaunchesInFlight: 1 });
    const gate = Promise.withResolvers<void>();
    const running = Effect.runPromise(
      budgets.withLaunchSlot(
        "alice",
        Effect.promise(() => gate.promise).pipe(Effect.as("launched")),
      ),
    );
    // A second launch for the same account is refused while the first is starting.
    expect(
      await Effect.runPromise(budgets.withLaunchSlot("alice", Effect.succeed("x"))),
    ).toBeNull();
    // Another account is not.
    expect(await Effect.runPromise(budgets.withLaunchSlot("bob", Effect.succeed("x")))).toBe("x");
    gate.resolve();
    expect(await running).toBe("launched");
    expect(await Effect.runPromise(budgets.withLaunchSlot("alice", Effect.succeed("y")))).toBe("y");

    // A launch that fails frees its slot too.
    await Effect.runPromise(
      budgets.withLaunchSlot("alice", Effect.fail("boom")).pipe(Effect.ignore),
    );
    expect(await Effect.runPromise(budgets.withLaunchSlot("alice", Effect.succeed("z")))).toBe("z");
  });
});
