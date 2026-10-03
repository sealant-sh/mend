import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { describe, expect, it } from "vitest";

import { DEFAULT_KEYBINDINGS, DEFAULT_RESOLVED_KEYBINDINGS } from "../shared/keybindings.ts";
import {
  ExecutionEnvironmentDescriptor,
  KeybindingsConfig,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2RpcSchemas,
  WsRpcGroup,
} from "../src/index.ts";

// Smoke test of the copy on Mend's `t3` catalog (effect 4.0.0-rc.115): the RPC group the t3code
// gateway serves loads, and its schemas build wire codecs and decode real frames.

const rpcs = [...WsRpcGroup.requests.values()];

const rpc = (tag: string) => {
  const found = WsRpcGroup.requests.get(tag);
  if (found === undefined) throw new Error(`${tag} is not in WsRpcGroup`);
  return found;
};

describe("WsRpcGroup", () => {
  it("has the pinned tag's 173 methods, 27 of them streams", () => {
    // ADR 0012 counts these at v0.0.46-nightly.20261003.2623. A pin bump that moves them is a
    // protocol change the gateway has to follow.
    expect(rpcs.length).toBe(173);
    expect(rpcs.filter((r) => RpcSchema.isStreamSchema(r.successSchema)).length).toBe(27);
  });

  it("carries the methods a client needs before it is connected", () => {
    const methods = [...WsRpcGroup.requests.keys()];
    expect(methods).toEqual(
      expect.arrayContaining([
        "server.getConfig",
        "subscribeServerConfig",
        "subscribeServerLifecycle",
        ...Object.values(ORCHESTRATION_V2_WS_METHODS),
      ]),
    );
  });

  it("builds a JSON codec for every payload, success and error schema", () => {
    for (const r of rpcs) {
      const success = r.successSchema;
      const schemas = RpcSchema.isStreamSchema(success)
        ? [r.payloadSchema, success.success, success.error, r.errorSchema]
        : [r.payloadSchema, success, r.errorSchema];
      for (const schema of schemas) {
        expect(() => Schema.toCodecJson(schema), r._tag).not.toThrow();
      }
    }
  });

  it("decodes a subscribeServerConfig request payload", () => {
    const decode = Schema.decodeUnknownSync(rpc("subscribeServerConfig").payloadSchema);
    expect(decode({ environmentThemes: true })).toEqual({ environmentThemes: true });
    expect(decode({})).toEqual({});
  });

  it("decodes a synchronized item from the shell subscription", () => {
    const success = rpc("orchestration.subscribeShell").successSchema;
    if (!RpcSchema.isStreamSchema(success)) throw new Error("subscribeShell is not a stream");
    const item = OrchestrationV2RpcSchemas.subscribeShell.output;
    expect(success.success).toBe(item);
    const decode = Schema.decodeUnknownSync(Schema.toCodecJson(item));
    expect(decode({ kind: "synchronized" })).toEqual({ kind: "synchronized" });
  });
});

describe("environment descriptor", () => {
  it("round-trips the descriptor a gateway serves", () => {
    const codec = Schema.toCodecJson(ExecutionEnvironmentDescriptor);
    const wire = {
      environmentId: "mend-environment",
      label: "Mend",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "v0.0.46-nightly.20261003.2623+mend.1",
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      capabilities: { repositoryIdentity: false },
    };
    const decoded = Schema.decodeUnknownSync(codec)(wire);
    expect(decoded.orchestrationProtocolVersion).toBe(2);
    expect(Schema.encodeSync(codec)(decoded)).toEqual(wire);
  });
});

describe("default keybindings", () => {
  it("are a valid keybindings config that compiles whole", () => {
    expect(DEFAULT_KEYBINDINGS.length).toBeGreaterThan(0);
    expect(Schema.decodeUnknownSync(KeybindingsConfig)(DEFAULT_KEYBINDINGS)).toEqual(
      DEFAULT_KEYBINDINGS,
    );
    expect(DEFAULT_RESOLVED_KEYBINDINGS.length).toBe(DEFAULT_KEYBINDINGS.length);
  });
});
