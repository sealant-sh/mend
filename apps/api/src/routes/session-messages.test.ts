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
import { SealantPlatformError } from "@mend/sealant";
import {
  ProtocolHostNotLiveError,
  SessionNotLiveError,
  SessionTurnRefusedError,
  checkPastedImage,
} from "@mend/sessions";
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
  it("accepts a 10 MiB image through /images and explains a refusal one byte over", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            storePastedImage: (_id, bytes) =>
              checkPastedImage(bytes).pipe(
                Effect.map(({ mediaType }) => ({
                  path: "/workspace/paste/retina.png",
                  mediaType,
                  bytes: bytes.byteLength,
                })),
              ),
          },
        },
      },
    );
    try {
      const bytes = Buffer.alloc(10 * 1024 * 1024 + 1);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const accepted = await api.request(
        "alice",
        "POST",
        `/api/sessions/${shared.session}/images`,
        {
          contentsBase64: bytes.subarray(0, -1).toString("base64"),
        },
      );
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        bytes: 10 * 1024 * 1024,
        path: "/workspace/paste/retina.png",
      });
      const refused = await api.request("alice", "POST", `/api/sessions/${shared.session}/images`, {
        contentsBase64: bytes.toString("base64"),
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({
        _tag: "PastedImageRejected",
        message: "The image is 11 MB; the limit is 10 MB.",
      });
    } finally {
      await api.dispose();
    }
  });

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

  it("resumes a stopped conversation for a message that asks, then delivers it", async () => {
    let live = false;
    const order: Array<string> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: () =>
              Effect.suspend(() => {
                order.push(live ? "send" : "send refused: not live");
                return live
                  ? Effect.succeed(saved(api, { _tag: "Accepted", evidence: "transport-written" }))
                  : Effect.fail(new ProtocolHostNotLiveError({ processId: shared.session }));
              }),
            resumeSession: () =>
              Effect.suspend(() => {
                order.push("resume");
                live = true;
                const session = api.world.sessions.get(shared.session);
                return session === undefined
                  ? Effect.die("missing session")
                  : Effect.succeed(session);
              }),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, {
        input: "pick up where you left off",
        clientMessageId: key,
        resume: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ _tag: "Steer", messageId });
      expect(order).toEqual(["send refused: not live", "resume", "send"]);
    } finally {
      await api.dispose();
    }
  });

  it.each([
    [
      "delivers once into the resume another request started",
      true,
      ["send refused: not live", "resume refused: starting", "wait for the launch", "send"],
    ],
    [
      "resumes itself when the launch it waited for left nothing live",
      false,
      [
        "send refused: not live",
        "resume refused: starting",
        "wait for the launch",
        "send refused: not live",
        "resume",
        "send",
      ],
    ],
  ])("a keyed retry during a cold resume %s", async (_, launchBringsItBack, expected) => {
    let live = false;
    let resumes = 0;
    const order: Array<string> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: () =>
              Effect.suspend(() => {
                order.push(live ? "send" : "send refused: not live");
                return live
                  ? Effect.succeed(saved(api, { _tag: "Accepted", evidence: "transport-written" }))
                  : Effect.fail(new ProtocolHostNotLiveError({ processId: shared.session }));
              }),
            resumeSession: () =>
              Effect.suspend(() => {
                resumes += 1;
                if (resumes === 1) {
                  order.push("resume refused: starting");
                  return Effect.fail(
                    new SealantPlatformError({
                      code: "session_starting",
                      status: 409,
                      message:
                        "starting · a launch of this session is already under way · nothing new started",
                      cause: null,
                    }),
                  );
                }
                order.push("resume");
                live = true;
                const session = api.world.sessions.get(shared.session);
                return session === undefined
                  ? Effect.die("missing session")
                  : Effect.succeed(session);
              }),
            awaitLaunch: () =>
              Effect.sync(() => {
                order.push("wait for the launch");
                live = launchBringsItBack;
              }),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, {
        input: "pick up where you left off",
        clientMessageId: key,
        resume: true,
      });
      expect(response.status).toBe(200);
      expect(order).toEqual(expected);
    } finally {
      await api.dispose();
    }
  });

  it("resumes a stopped conversation for an image that asks, then stores it", async () => {
    let live = false;
    const order: Array<string> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            storePastedImage: () =>
              Effect.suspend(() => {
                order.push(live ? "store" : "store refused: not live");
                return live
                  ? Effect.succeed({
                      path: "/workspace/paste/shot.png",
                      mediaType: "image/png",
                      bytes: 8,
                    })
                  : Effect.fail(new SessionNotLiveError({ sessionId: shared.session }));
              }),
            resumeSession: () =>
              Effect.suspend(() => {
                order.push("resume");
                live = true;
                const session = api.world.sessions.get(shared.session);
                return session === undefined
                  ? Effect.die("missing session")
                  : Effect.succeed(session);
              }),
          },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "POST",
        `/api/sessions/${shared.session}/images`,
        {
          contentsBase64: "iVBORw0KGgo=",
          resume: true,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ path: "/workspace/paste/shot.png" });
      expect(order).toEqual(["store refused: not live", "resume", "store"]);
    } finally {
      await api.dispose();
    }
  });

  it("refuses a stopped conversation's message that does not ask to resume, resuming nothing", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: () =>
              Effect.fail(new ProtocolHostNotLiveError({ processId: shared.session })),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, { input: "words" });
      expect(response.status).toBe(409);
      expect(api.world.calls).not.toContain("engine.resumeSession");
    } finally {
      await api.dispose();
    }
  });

  it("says why in words when the resume a message asked for fails", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            sendMessage: () =>
              Effect.fail(new ProtocolHostNotLiveError({ processId: shared.session })),
            resumeSession: () =>
              Effect.fail(
                new SealantPlatformError({
                  code: "capture_not_saved",
                  status: 409,
                  message: "not saved · executor kept for recovery · nothing started",
                  cause: null,
                }),
              ),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, { input: "words", resume: true });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        _tag: "StoreFailure",
        message: "not saved · executor kept for recovery · nothing started",
      });
    } finally {
      await api.dispose();
    }
  });

  it("replays a keyed retry of a message that resumed the session, resuming nothing", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          engine: {
            launchUnderWay: () => false,
            // The engine replays the keyed message before it looks for a live conversation.
            sendMessage: () =>
              Effect.succeed(saved(api, { _tag: "Accepted", evidence: "transport-written" })),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "POST", route, {
        input: "words",
        clientMessageId: key,
        resume: true,
      });
      expect(response.status).toBe(200);
      expect(api.world.calls).not.toContain("engine.resumeSession");
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
