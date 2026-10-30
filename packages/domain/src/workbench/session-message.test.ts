import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  AgentTurnId,
  AgentTurnSteerId,
  SessionId,
  SessionMessageId,
  SessionProcessId,
} from "../ids.ts";
import { AgentTurn } from "./agent-protocol.ts";
import {
  AgentTurnSteer,
  TurnSteerQueueReason,
  type AgentTurnSteerDelivery,
} from "./agent-steer.ts";
import {
  MessageInput,
  MessageTurnReason,
  SessionMessageResult,
  messageOutcome,
} from "./session-message.ts";

const messageId = SessionMessageId.make("6033c3ad-0831-4536-8c32-3714f11681ec");
const turn = new AgentTurn({
  id: AgentTurnId.make("turn"),
  sessionId: SessionId.make("session"),
  processId: SessionProcessId.make("process"),
  ordinal: 0,
  author: "alice",
  input: "words",
  status: "queued",
  providerTurnId: null,
  error: null,
  usage: null,
  createdAt: new Date(),
  startedAt: null,
  endedAt: null,
});
const steer = (delivery: AgentTurnSteerDelivery) =>
  new AgentTurnSteer({
    id: AgentTurnSteerId.make("6dd5c2a6-0a8c-4980-8b24-bfb298ecf18f"),
    sessionId: turn.sessionId,
    processId: turn.processId,
    turnId: turn.id,
    author: "alice",
    ordinal: 0,
    input: "words",
    delivery,
    queuedTurnId: delivery._tag === "Queued" ? delivery.turnId : null,
    clientSteerId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

describe("message outcomes", () => {
  it("preserves every valid input byte and refuses whitespace alone", () => {
    fc.assert(
      fc.property(
        fc.string().filter((text) => /\S/.test(text)),
        (text) => {
          expect(Schema.decodeUnknownSync(MessageInput)(text)).toBe(text);
        },
      ),
    );
    for (const text of ["", " \t\n", "\u00a0"])
      expect(() => Schema.decodeUnknownSync(MessageInput)(text)).toThrow();
  });

  const deliveryCases: ReadonlyArray<readonly [AgentTurnSteerDelivery, string]> = [
    [{ _tag: "Accepted", evidence: "provider-acknowledged" }, "sent · the agent acknowledged it"],
    [{ _tag: "Accepted", evidence: "transport-written" }, "sent · written to the agent"],
    [{ _tag: "Sending" }, "sending"],
    ...(["restart", "uncertain", "failed"] as const).map(
      (reason) =>
        [{ _tag: "Unknown", reason }, "delivery not confirmed · Mend will not resend"] as const,
    ),
  ];
  it.each(deliveryCases)("formats and round-trips %j", (delivery, explanation) => {
    const receipt = messageOutcome({ _tag: "Steer", messageId, steer: steer(delivery) }, null);
    expect(receipt.explanation).toBe(explanation);
    expect(
      Schema.decodeUnknownSync(SessionMessageResult)(
        Schema.encodeSync(SessionMessageResult)(receipt),
      ),
    ).toEqual(receipt);
  });

  const explanations: Record<TurnSteerQueueReason, string> = {
    "no-active-turn": "the agent had no active turn",
    "target-changed": "the agent's active turn changed",
    "review-turn": "the agent was reviewing",
    "compact-turn": "the agent was compacting its conversation",
    "output-schema": "the turn required structured output",
    "invalid-input": "the agent refused this input as a steer",
    "server-draining": "the agent was shutting down",
    unsupported: "the agent does not support steering",
    "in-continuation": "the agent was continuing its turn",
    "not-written": "the words were not written to the running turn",
    "turn-ended": "the running turn ended",
    "not-acknowledged": "the running turn was not acknowledged",
    "not-running": "the selected turn was not running",
    replaying: "Mend was replaying the conversation",
    "handing-over": "the conversation was changing processes",
  };

  it.each(TurnSteerQueueReason.literals)("explains %s with readable words", (reason) => {
    for (const tag of ["Queued", "NotSent"] as const) {
      const receipt = messageOutcome(
        {
          _tag: "Steer",
          messageId,
          steer: steer(
            tag === "Queued" ? { _tag: tag, reason, turnId: turn.id } : { _tag: tag, reason },
          ),
        },
        null,
      );
      expect(receipt.explanation).toBe(
        tag === "Queued"
          ? `sent as your next turn · ${explanations[reason]}`
          : `not sent · ${explanations[reason]}; the session could not take a next turn`,
      );
      expect(
        Schema.decodeUnknownSync(SessionMessageResult)(
          Schema.encodeSync(SessionMessageResult)(receipt),
        ),
      ).toEqual(receipt);
    }
  });

  it.each([
    ["queue-requested", "you asked for a new turn"],
    ["steering-off", "Send steers the running turn is off"],
    ["no-own-running-turn", "you had no running turn in this session"],
  ] as const)("explains a new turn selected for %s", (reason, words) => {
    expect(messageOutcome({ _tag: "Turn", messageId, turn }, reason).explanation).toBe(
      `sent as your next turn · ${words}`,
    );
  });

  it.each(["queued", "running", "completed", "failed", "cancelled", "interrupted"] as const)(
    "reports a recorded turn observed %s",
    (status) => {
      const startedAt = status === "queued" ? null : new Date();
      const receipt = messageOutcome(
        { _tag: "Turn", messageId, turn: new AgentTurn({ ...turn, status, startedAt }) },
        "queue-requested",
      );
      expect(receipt.explanation).toBe(
        `sent as your next turn · you asked for a new turn${status === "queued" ? "" : ` · turn ${status} · observed`}`,
      );
      expect(
        Schema.decodeUnknownSync(SessionMessageResult)(
          Schema.encodeSync(SessionMessageResult)(receipt),
        ),
      ).toEqual(receipt);
    },
  );

  it.each([
    ["cancelled", "not sent · the turn was cancelled before it started"],
    ["failed", "not sent · the turn failed before it started"],
    ["interrupted", "not sent · the turn was interrupted before it started"],
  ] as const)("reports a turn %s before it started as not sent", (status, explanation) => {
    for (const reason of MessageTurnReason.literals)
      expect(
        messageOutcome(
          { _tag: "Turn", messageId, turn: new AgentTurn({ ...turn, status }) },
          reason,
        ).explanation,
      ).toBe(explanation);
  });
});
