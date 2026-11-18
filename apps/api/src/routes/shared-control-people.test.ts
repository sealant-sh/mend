import { SharedControlStepRefused } from "@mend/db";
import { SessionId } from "@mend/domain";
import { Session } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids, makeSession } from "../../test/support/tenancy-harness.ts";

/**
 * Shared control for one person (docs/adr/0026, decision 7) over the two-organization world:
 * Alice owns the session, Carol is a member who sees it, Erin owns the organization, and Bob is
 * in another organization.
 */
describe("shared control for one person", () => {
  let api: TenancyApi;
  const sharedA = ids("shared-a");
  const base = `/api/sessions/${sharedA.session}/shared-control`;
  const grantedToCarol = SessionId.make("session-shared-a-granted-carol");

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        sessions: [
          new Session({
            ...makeSession(grantedToCarol, sharedA.project, sharedA.worktree, "alice"),
            sharedControlUserIds: ["carol"],
          }),
        ],
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    api.world.calls.splice(0, api.world.calls.length);
  });

  const stepCalls = () =>
    api.world.calls.filter(
      (call) => call.startsWith("sharedControl.") && call !== "sharedControl.people",
    );

  it("someone who sees the session asks; someone who cannot see it is not told it exists", async () => {
    const carol = await api.request("carol", "POST", `${base}/ask`);
    expect(carol.status).toBe(200);
    expect(api.world.calls).toEqual(
      expect.arrayContaining(["sharedControl.ask", "controlEvents.record"]),
    );

    api.world.calls.splice(0, api.world.calls.length);
    const bob = await api.request("bob", "POST", `${base}/ask`);
    expect({ status: bob.status, steps: stepCalls() }).toEqual({ status: 404, steps: [] });
  });

  it("only the owner grants or declines; an organization owner does not", async () => {
    const refused = [
      await api.request("carol", "POST", `${base}/people/carol/grant`),
      await api.request("erin", "POST", `${base}/people/carol/grant`),
      await api.request("erin", "POST", `${base}/people/carol/decline`),
    ];
    expect({ statuses: refused.map((response) => response.status), steps: stepCalls() }).toEqual({
      statuses: [403, 403, 403],
      steps: [],
    });

    const granted = await api.request("alice", "POST", `${base}/people/carol/grant`);
    expect(granted.status).toBe(200);
    expect(api.world.calls).toEqual(
      expect.arrayContaining(["sharedControl.grant", "controlEvents.record", "audit.record"]),
    );
  });

  it("the owner or an organization owner takes a grant back; the person's queued turns go", async () => {
    const member = await api.request("carol", "POST", `${base}/people/carol/take-back`);
    expect({ status: member.status, steps: stepCalls() }).toEqual({ status: 403, steps: [] });

    const erin = await api.request("erin", "POST", `${base}/people/carol/take-back`);
    expect(erin.status).toBe(200);
    expect(api.world.calls).toEqual(
      expect.arrayContaining([
        "sharedControl.takeBack",
        "engine.cancelQueuedTurnsBy",
        "controlEvents.record",
        "audit.record",
      ]),
    );
  });

  it("a person granted it steers, and nobody else who only sees the session", async () => {
    const turns = `/api/sessions/${grantedToCarol}/turns`;
    const carol = await api.request("carol", "POST", turns, { input: "Continue" });
    expect(carol.status).not.toBe(403);

    api.world.calls.splice(0, api.world.calls.length);
    const erin = await api.request("erin", "POST", turns, { input: "Continue" });
    expect({ status: erin.status, calls: api.world.calls }).toEqual({ status: 403, calls: [] });
  });

  it("a step the session's state no longer allows answers 409 with its reason", async () => {
    const world = await createTenancyApi(
      {},
      {
        implement: {
          sharedControl: {
            grant: (sessionId, userId) =>
              Effect.fail(new SharedControlStepRefused({ sessionId, userId, reason: "not-asked" })),
          },
        },
      },
    );
    try {
      const response = await world.request("alice", "POST", `${base}/people/carol/grant`);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        _tag: "SharedControlRefused",
        reason: "not-asked",
      });
    } finally {
      await world.dispose();
    }
  });
});
