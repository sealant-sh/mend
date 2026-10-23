import { SessionAgentLiveError, SessionMovedOnError } from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/** The launch route's two refusals (SLNT-167) on the wire: 409, the tag, what the session reads. */
describe("POST /sessions/:id/launch refusals", () => {
  const shared = ids("shared-a");
  const settledAt = new Date("2026-10-19T08:00:00.123Z");

  it.each([
    {
      refusal: new SessionMovedOnError({
        sessionId: shared.session,
        status: "running",
        settledAt: null,
        message: "the session moved on · it reads running · nothing launched",
        reason: "agentLive",
      }),
      tag: "SessionMovedOn",
      body: { expected: { settledAt: settledAt.toISOString() } },
      over: { _tag: "Expected", settledAt },
      reason: { reason: "agentLive" },
    },
    {
      refusal: new SessionMovedOnError({
        sessionId: shared.session,
        status: "idle",
        settledAt: null,
        message: "an agent already ran in this session · it reads idle · nothing launched again",
        reason: "agentRan",
      }),
      tag: "SessionMovedOn",
      body: { expected: { settledAt: null } },
      over: { _tag: "Expected", settledAt: null },
      reason: { reason: "agentRan" },
    },
    {
      refusal: new SessionAgentLiveError({
        sessionId: shared.session,
        status: "running",
        settledAt,
        message:
          "the session's agent is live · nothing restarted · attach to it, or stop it and launch again",
      }),
      tag: "SessionAgentLive",
      body: {},
      over: { _tag: "NoLiveAgent" },
      reason: {},
    },
  ])("answers $tag with 409 ($refusal.message)", async ({ refusal, tag, body, over, reason }) => {
    const asked: Array<unknown> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            detach: (effect) => Effect.forkDetach(effect),
            launch: (_sessionId, _argv, admission) =>
              Effect.sync(() => void asked.push(admission?.over)).pipe(
                Effect.andThen(Effect.fail(refusal)),
              ),
          },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "POST",
        `/api/sessions/${shared.session}/launch`,
        { argv: ["codex"], ...body },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        _tag: tag,
        sessionId: shared.session,
        status: refusal.status,
        settledAt: refusal.settledAt === null ? null : refusal.settledAt.toISOString(),
        message: refusal.message,
        ...reason,
      });
      expect(asked).toEqual([over]);
    } finally {
      await api.dispose();
    }
  });
});
