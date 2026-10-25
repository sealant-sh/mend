import { AgentTurnSteerId } from "@mend/domain";
import {
  AgentTurnSteer,
  ConversationTurn,
  type AgentTurnSteerDelivery,
} from "@mend/domain/workbench";
import {
  ProtocolHostNotLiveError,
  SessionTurnRefusedError,
  TurnSteerForbiddenError,
  TurnSteerKeyConflictError,
  type SteerTurnInput,
} from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const shared = ids("shared-a");
const route = `/api/turns/${shared.turn}/steer`;
const key = "755a374b-d7a2-4704-a876-a476538d0cb0";

const receipt = (api: TenancyApi, delivery: AgentTurnSteerDelivery) => {
  const turn = api.world.turns.get(shared.turn);
  if (turn === undefined) throw new Error("missing turn");
  return new AgentTurnSteer({
    id: AgentTurnSteerId.make("1b9464d5-21ea-4e28-8571-5df22f8abce3"),
    turnId: turn.id,
    sessionId: turn.sessionId,
    processId: turn.processId,
    author: "alice",
    ordinal: 0,
    input: "  Keep the public shape.\n",
    delivery,
    queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
    clientSteerId: key,
    createdAt: new Date("2026-10-25T00:00:00Z"),
    updatedAt: new Date("2026-10-25T00:00:01Z"),
  });
};

describe("turn steering HTTP", () => {
  it.each([
    { _tag: "Sending" },
    { _tag: "Accepted", evidence: "provider-acknowledged" },
    { _tag: "Accepted", evidence: "transport-written" },
    { _tag: "Queued", turnId: shared.turn, reason: "turn-ended" },
    { _tag: "Unknown", reason: "uncertain" },
    { _tag: "NotSent", reason: "not-running" },
  ] satisfies ReadonlyArray<AgentTurnSteerDelivery>)(
    "returns 200 with a saved $_tag receipt",
    async (delivery) => {
      const submitted: Array<SteerTurnInput> = [];
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              steerTurn: (input) =>
                Effect.sync(() => {
                  submitted.push(input);
                  return receipt(api, delivery);
                }),
            },
          },
        },
      );
      try {
        const response = await api.request("alice", "POST", route, {
          input: "  Keep the public shape.\n",
          clientSteerId: key,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          delivery,
          input: "  Keep the public shape.\n",
          author: "alice",
          clientSteerId: key,
        });
        expect(submitted).toEqual([
          {
            turnId: shared.turn,
            sender: "alice",
            input: "  Keep the public shape.\n",
            clientSteerId: key,
          },
        ]);
        expect(api.world.calls).not.toContain("controlEvents.record");
      } finally {
        await api.dispose();
      }
    },
  );

  it.each([{ input: "" }, { input: " \n\t" }, { input: "words", clientSteerId: "not-a-uuid" }])(
    "rejects invalid payloads without calling the engine: %j",
    async (payload) => {
      const api = await createTenancyApi();
      try {
        const response = await api.request("alice", "POST", route, payload);
        expect(response.status).toBe(400);
        expect(api.world.calls).not.toContain("engine.steerTurn");
      } finally {
        await api.dispose();
      }
    },
  );

  it("conceals hidden and unknown turns, and refuses callers without session control", async () => {
    const api = await createTenancyApi();
    try {
      for (const path of [route, "/api/turns/unknown/steer"]) {
        const response = await api.request("bob", "POST", path, { input: "words" });
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ _tag: "NotFound" });
      }
      const response = await api.request("carol", "POST", route, { input: "words" });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ _tag: "SessionNotSteerable" });
      expect(api.world.calls).not.toContain("engine.steerTurn");
    } finally {
      await api.dispose();
    }
  });

  for (const reason of ["no-sender", "not-sender"] as const)
    it(`preserves the host's ${reason} refusal even for the owner`, async () => {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              steerTurn: () =>
                Effect.fail(
                  new TurnSteerForbiddenError({
                    turnId: shared.turn,
                    reason,
                    message: "Only this turn's sender may steer it.",
                  }),
                ),
            },
          },
        },
      );
      try {
        const response = await api.request("alice", "POST", route, { input: "words" });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          _tag: "TurnSteerForbidden",
          turnId: shared.turn,
          reason,
          message: "Only this turn's sender may steer it.",
        });
      } finally {
        await api.dispose();
      }
    });

  it("reports a missing live process as 409 and a retiring workspace as 403", async () => {
    for (const refusal of [
      new ProtocolHostNotLiveError({ processId: "stopped" }),
      new SessionTurnRefusedError({
        sessionId: shared.session,
        message: "The workspace is retiring.",
      }),
    ]) {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: { launchUnderWay: () => false, steerTurn: () => Effect.fail(refusal) },
          },
        },
      );
      try {
        const response = await api.request("alice", "POST", route, { input: "words" });
        expect(response.status).toBe(refusal._tag === "ProtocolHostNotLiveError" ? 409 : 403);
        expect(await response.json()).toMatchObject({
          _tag:
            refusal._tag === "ProtocolHostNotLiveError"
              ? "ProtocolSessionNotLive"
              : "SessionNotSteerable",
        });
      } finally {
        await api.dispose();
      }
    }
  });

  it("reports a steer key reused for other words or another turn as 409", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            steerTurn: () =>
              Effect.fail(
                new TurnSteerKeyConflictError({
                  clientSteerId: key,
                  message: "This steer key was already used for other words or another turn.",
                }),
              ),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, {
        input: "other words",
        clientSteerId: key,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        _tag: "TurnSteerKeyConflict",
        clientSteerId: key,
        message: "This steer key was already used for other words or another turn.",
      });
    } finally {
      await api.dispose();
    }
  });

  it("reads ordered steers and the domain sender on completed turns", async () => {
    const api = await createTenancyApi();
    try {
      const turn = api.world.turns.get(shared.turn);
      if (turn === undefined) throw new Error("missing turn");
      const steer = receipt(api, { _tag: "Unknown", reason: "restart" });
      api.world.turns.set(
        shared.turn,
        new ConversationTurn({
          ...turn,
          status: "completed",
          author: null,
          billedUserId: "carol",
          steerSender: "carol",
          steers: [steer],
        }),
      );
      const response = await api.request("alice", "GET", `/api/sessions/${shared.session}/turns`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: shared.turn,
            steerSender: "carol",
            status: "completed",
            steers: [
              expect.objectContaining({
                input: steer.input,
                delivery: { _tag: "Unknown", reason: "restart" },
              }),
            ],
          }),
        ]),
      );
    } finally {
      await api.dispose();
    }
  });
});
