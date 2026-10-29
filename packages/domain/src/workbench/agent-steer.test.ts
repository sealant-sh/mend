import { Effect, Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { AgentTurnId, SessionId, SessionProcessId } from "../ids.ts";
import { AgentTurn } from "./agent-protocol.ts";
import { ConversationTurn, turnSteerSender } from "./agent-steer.ts";

describe("turn sender", () => {
  it("uses the author, otherwise the recorded payer, with no owner exception", () => {
    fc.assert(
      fc.property(
        fc.option(fc.string(), { nil: null }),
        fc.option(fc.string(), { nil: null }),
        (author, billedUserId) => {
          const sender = turnSteerSender({ author, billedUserId });
          expect(sender).toBe(author === null ? billedUserId : author);
        },
      ),
    );
  });

  it("decodes turns without steers as an empty collection", async () => {
    const turn = new AgentTurn({
      id: AgentTurnId.make("turn"),
      sessionId: SessionId.make("session"),
      processId: SessionProcessId.make("process"),
      ordinal: 0,
      author: "alice",
      input: "start",
      status: "running",
      providerTurnId: "provider",
      error: null,
      usage: null,
      createdAt: new Date(),
      startedAt: null,
      endedAt: null,
    });
    const encoded = await Effect.runPromise(Schema.encodeEffect(AgentTurn)(turn));
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(ConversationTurn)({ ...encoded, steerSender: "alice" }),
    );
    expect(decoded.steers).toEqual([]);
    expect(decoded.fromSteer).toBeNull();
    expect(decoded.steerSender).toBe("alice");
  });
});
