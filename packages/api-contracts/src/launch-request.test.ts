import { SessionId } from "@mend/domain";
import {
  AgentLaunchMode,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  SPEED_MODES,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { LaunchRequest, MendApi, SessionAgentLive, SessionMovedOn } from "./index.ts";

/** `LaunchRequest` as servers before SLNT-167 declare it. */
class OldLaunchRequest extends Schema.Class<OldLaunchRequest>("LaunchRequest")({
  mode: Schema.optional(AgentLaunchMode),
  argv: Schema.optional(Schema.Array(Schema.String)),
  prompt: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.optional(Schema.Literals(PERMISSION_MODES)),
  speed: Schema.optional(Schema.Literals(SPEED_MODES)),
}) {}

const settledAt = "2026-10-19T08:15:30.123Z";

describe("LaunchRequest across versions (SLNT-167)", () => {
  it("decodes an older client's payload, which names neither field", () => {
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(LaunchRequest))({
      mode: "protocol",
      prompt: "go",
    });
    expect(decoded.expected).toBeUndefined();
    expect(decoded.restart).toBeUndefined();
    expect(decoded.prompt).toBe("go");
  });

  it("decodes a newer client's payload on an older server, dropping the fields it does not know", () => {
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(OldLaunchRequest))({
      mode: "protocol",
      prompt: "go",
      expected: { settledAt },
      restart: true,
    });
    expect(decoded.prompt).toBe("go");
    expect(Object.keys(decoded).toSorted()).toEqual(["mode", "prompt"]);
  });

  it("decodes the attempt a client saw, settled or never settled", () => {
    const codec = Schema.toCodecJson(LaunchRequest);
    const settled = Schema.decodeUnknownSync(codec)({ expected: { settledAt }, restart: false });
    expect(settled.expected?.settledAt?.toISOString()).toBe(settledAt);
    expect(settled.restart).toBe(false);
    const never = Schema.decodeUnknownSync(codec)({ expected: { settledAt: null } });
    expect(never.expected).toEqual({ settledAt: null });
  });

  it.each([
    { tag: "SessionMovedOn", Refusal: SessionMovedOn },
    { tag: "SessionAgentLive", Refusal: SessionAgentLive },
  ] as const)(
    "$tag round-trips the wire with settledAt as an ISO string, or null",
    ({ tag, Refusal }) => {
      const codec = Schema.toCodecJson(Refusal);
      const encoded = Schema.encodeSync(codec)(
        new Refusal({
          sessionId: SessionId.make("sess-1"),
          status: "failed",
          settledAt: new Date(settledAt),
          message: "words",
        }),
      );
      expect(encoded).toMatchObject({
        _tag: tag,
        sessionId: "sess-1",
        status: "failed",
        settledAt,
      });
      const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)));
      expect(decoded.settledAt?.getTime()).toBe(Date.parse(settledAt));
      expect(decoded.status).toBe("failed");

      const unsettled = Schema.decodeUnknownSync(codec)({
        _tag: tag,
        sessionId: "sess-1",
        status: "running",
        settledAt: null,
        message: "words",
      });
      expect(unsettled.settledAt).toBeNull();
    },
  );

  it("answers both refusals of the launch route with 409, not a collapsed 500", () => {
    let statuses: ReadonlySet<number> = new Set();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        if (endpoint.identifier === "launch") statuses = new Set(errors.keys());
      },
    });
    expect(statuses.has(409)).toBe(true);
    expect(statuses.has(500)).toBe(false);
  });
});
