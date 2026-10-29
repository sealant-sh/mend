import { AgentTurnSteerId, ClientMessageId, SessionMessageId } from "@mend/domain";
import {
  AgentTurnSteerDelivery,
  AgentTurnSteer,
  AgentTurn,
  MessageKeyConflictError,
  MessageTargetAmbiguousError,
  TurnSteerQueueReason,
  messageOutcome,
  type SendMessageInput,
} from "@mend/domain/workbench";
import { ProtocolHostNotLiveError, SessionTurnRefusedError } from "@mend/sessions";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const shared = ids("shared-a");
const route = `/api/sessions/${shared.session}/messages`;
const key = ClientMessageId.make("755a374b-d7a2-4704-a876-a476538d0cb0");
const messageId = SessionMessageId.make("6717b687-c3e9-4ed2-bc73-e2da60e4d83a");
const saved = (api: TenancyApi, delivery: AgentTurnSteerDelivery) => {
  const turn = api.world.turns.get(shared.turn);
  if (turn === undefined) throw new Error("missing turn");
  return messageOutcome(
    {
      _tag: "Steer",
      messageId,
      steer: new AgentTurnSteer({
        id: AgentTurnSteerId.make("1b9464d5-21ea-4e28-8571-5df22f8abce3"),
        turnId: turn.id,
        sessionId: turn.sessionId,
        processId: turn.processId,
        author: "alice",
        ordinal: 0,
        input: "  Keep the public shape.\n",
        delivery,
        queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
        clientSteerId: null,
        createdAt: new Date("2026-10-25T00:00:00Z"),
        updatedAt: new Date("2026-10-25T00:00:01Z"),
      }),
    },
    null,
  );
};

describe("session messages HTTP", () => {
  const deliveries: ReadonlyArray<AgentTurnSteerDelivery> = [
    { _tag: "Sending" },
    { _tag: "Accepted", evidence: "provider-acknowledged" },
    { _tag: "Accepted", evidence: "transport-written" },
    ...TurnSteerQueueReason.literals.flatMap(
      (reason): Array<AgentTurnSteerDelivery> => [
        { _tag: "Queued", turnId: shared.turn, reason },
        { _tag: "NotSent", reason },
      ],
    ),
    ...["uncertain", "failed", "restart"].map((reason) =>
      Schema.decodeUnknownSync(AgentTurnSteerDelivery)({ _tag: "Unknown", reason }),
    ),
  ];
  it.each(deliveries)("returns the admitted $_tag evidence with 200", async (delivery) => {
    const submitted: Array<SendMessageInput> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: (input) =>
              Effect.sync(() => {
                submitted.push(input);
                return saved(api, delivery);
              }),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, {
        input: "  Keep the public shape.\n",
        clientMessageId: key.toUpperCase(),
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).not.toHaveProperty("clientMessageId");
      expect(body).toMatchObject({
        _tag: "Steer",
        messageId,
        explanation: saved(api, delivery).explanation,
        steer: { delivery, input: submitted[0]?.input, author: "alice", clientSteerId: null },
      });
      expect(submitted).toEqual([
        {
          sessionId: shared.session,
          sender: "alice",
          input: "  Keep the public shape.\n",
          clientMessageId: key,
          intent: "default",
        },
      ]);
      expect(api.world.calls).not.toContain("engine.submitTurn");
    } finally {
      await api.dispose();
    }
  });

  it.each(["queued", "running", "completed", "cancelled", "failed", "interrupted"] as const)(
    "returns the recorded turn observed %s",
    async (status) => {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            engine: {
              launchUnderWay: () => false,
              sendMessage: (input) =>
                Effect.sync(() => {
                  const turn = api.world.turns.get(shared.turn);
                  if (turn === undefined) throw new Error("missing turn");
                  expect(input.intent).toBe("queue");
                  return messageOutcome(
                    {
                      _tag: "Turn",
                      messageId,
                      turn: new AgentTurn({ ...turn, input: input.input, status }),
                    },
                    "queue-requested",
                  );
                }),
            },
          },
        },
      );
      try {
        const response = await api.request("alice", "POST", route, {
          input: "exact words",
          queue: true,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          _tag: "Turn",
          messageId,
          turn: { status, input: "exact words" },
        });
      } finally {
        await api.dispose();
      }
    },
  );

  it.each([
    { input: "" },
    { input: " \n\t" },
    { input: "words", clientMessageId: "wrong" },
    { input: "words", queue: false },
    { input: "words", author: "carol" },
    { input: "words", turnId: shared.turn },
    { input: "words", sendSteersRunningTurn: false },
  ])("rejects invalid payload before admission: %j", async (payload) => {
    const api = await createTenancyApi();
    try {
      expect((await api.request("alice", "POST", route, payload)).status).toBe(400);
      expect(api.world.calls).not.toContain("engine.sendMessage");
    } finally {
      await api.dispose();
    }
  });

  it("conceals hidden sessions, refuses control and operator non-access, and authenticates", async () => {
    const api = await createTenancyApi();
    try {
      expect((await api.request(null, "POST", route, { input: "words" })).status).toBe(401);
      expect((await api.request("bob", "POST", route, { input: "words" })).status).toBe(404);
      expect(
        (
          await api.request(
            "alice",
            "POST",
            `/api/sessions/${ids("private-carol").session}/messages`,
            { input: "words" },
          )
        ).status,
      ).toBe(404);
      expect((await api.request("carol", "POST", route, { input: "words" })).status).toBe(403);
      expect(
        (await api.request("alice", "POST", "/api/sessions/unknown/messages", { input: "words" }))
          .status,
      ).toBe(404);
      expect(api.world.calls).not.toContain("engine.sendMessage");
    } finally {
      await api.dispose();
    }
  });

  it.each([
    [new ProtocolHostNotLiveError({ processId: shared.process }), 409, "ProtocolSessionNotLive"],
    [
      new SessionTurnRefusedError({
        sessionId: shared.session,
        message: "The workspace is retiring.",
      }),
      403,
      "SessionNotSteerable",
    ],
    [
      new MessageKeyConflictError({
        clientMessageId: key,
        message: "This message key was already used for another request.",
      }),
      409,
      "MessageKeyConflict",
    ],
    [
      new MessageTargetAmbiguousError({
        sessionId: shared.session,
        message: "Several of your turns are running.",
      }),
      409,
      "MessageTargetAmbiguous",
    ],
  ] as const)("translates the pre-admission refusal %s", async (error, status, tag) => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: () => Effect.fail(error),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, { input: "words" });
      expect(response.status).toBe(status);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ _tag: tag });
      expect(body).not.toHaveProperty("clientMessageId");
      if (tag === "ProtocolSessionNotLive")
        expect(body).toMatchObject({
          message: "This session has no live conversation; resume it first.",
        });
    } finally {
      await api.dispose();
    }
  });

  it("lets the engine replay a keyed retry from someone who can no longer steer", async () => {
    const submitted: Array<SendMessageInput> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: (input) =>
              Effect.sync(() => {
                submitted.push(input);
                return saved(api, { _tag: "Accepted", evidence: "provider-acknowledged" });
              }),
          },
        },
      },
    );
    try {
      const response = await api.request("carol", "POST", route, {
        input: "  Keep the public shape.\n",
        clientMessageId: key,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ _tag: "Steer", messageId });
      expect(submitted).toMatchObject([{ sender: "carol", clientMessageId: key }]);
    } finally {
      await api.dispose();
    }
  });
});
