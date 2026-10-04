import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AgentTurnId, SessionId, SessionProcessId } from "../ids.ts";
import { AgentTurn } from "./agent-protocol.ts";

const json = Schema.toCodecJson(AgentTurn);

const turn = new AgentTurn({
  id: AgentTurnId.make("turn-1"),
  sessionId: SessionId.make("session-1"),
  processId: SessionProcessId.make("process-1"),
  ordinal: 0,
  author: "u-maria",
  input: "rename the flag",
  status: "completed",
  providerTurnId: "provider-1",
  error: null,
  usage: null,
  billedUserId: "u-yiannis",
  billedAccountName: "default",
  createdAt: new Date("2026-10-04T00:00:00.000Z"),
  startedAt: null,
  endedAt: null,
});

describe("AgentTurn payer", () => {
  it("carries whose login a turn ran on over the wire", () => {
    const wire = Schema.encodeUnknownSync(json)(turn);
    expect(wire).toMatchObject({
      author: "u-maria",
      billedUserId: "u-yiannis",
      billedAccountId: null,
      billedAccountName: "default",
    });
    expect(Schema.decodeUnknownSync(json)(wire)).toMatchObject({
      billedUserId: "u-yiannis",
      billedAccountName: "default",
    });
  });

  it("reads a turn from a server before payers as one with no payer recorded", () => {
    const wire = Schema.encodeUnknownSync(json)(turn);
    const older = Object.fromEntries(
      Object.entries(wire ?? {}).filter(([key]) => !key.startsWith("billed")),
    );
    expect(Object.keys(older)).toContain("author");
    expect(Schema.decodeUnknownSync(json)(older)).toMatchObject({
      billedUserId: null,
      billedAccountId: null,
      billedAccountName: null,
    });
  });
});
