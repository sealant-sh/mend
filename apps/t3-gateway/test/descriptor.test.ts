import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@mend/t3-contracts";
import pin from "@mend/t3-contracts/pin" with { type: "json" };
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schema from "effect/Schema";

import { GatewayState, openGatewayState } from "../src/state.ts";
import { SERVER_VERSION } from "../src/version.ts";
import { orchestrationProtocolCompatibilityError } from "./support/compatibility.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer, t3Client } from "./support/gateway.ts";

describe("GET /.well-known/t3/environment", () => {
  it.live("answers a descriptor the vendored schema decodes and the client accepts", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.get("/.well-known/t3/environment");
        assert.strictEqual(response.status, 200);
        const descriptor = yield* Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor)(
          yield* response.json,
        );

        assert.strictEqual(descriptor.orchestrationProtocolVersion, 2);
        assert.strictEqual(descriptor.orchestrationProtocolVersion, ORCHESTRATION_PROTOCOL_VERSION);
        assert.isNull(orchestrationProtocolCompatibilityError(descriptor));
        assert.strictEqual(descriptor.serverVersion, `${pin.tag}+mend.1`);
        assert.strictEqual(descriptor.serverVersion, SERVER_VERSION);
        assert.strictEqual(descriptor.label, "Mend under test");

        // The same descriptor through t3code's own HTTP client derivation.
        const client = yield* t3Client;
        const viaClient = yield* client.metadata.descriptor();
        assert.deepStrictEqual(viaClient, descriptor);

        const state = yield* GatewayState;
        assert.strictEqual(descriptor.environmentId, state.environmentId);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it("refuses a client on another protocol, as t3code's check does", () => {
    const base = {
      environmentId: "e",
      label: "Mend",
      platform: { os: "linux", arch: "x64" },
      serverVersion: SERVER_VERSION,
      capabilities: { repositoryIdentity: false },
    } as const;
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
    assert.strictEqual(
      orchestrationProtocolCompatibilityError(decode({ ...base, orchestrationProtocolVersion: 1 })),
      "server-too-old",
    );
    assert.strictEqual(orchestrationProtocolCompatibilityError(decode(base)), "server-too-old");
    assert.strictEqual(
      orchestrationProtocolCompatibilityError(decode({ ...base, orchestrationProtocolVersion: 3 })),
      "client-too-old",
    );
  });

  it.live("keeps the environment id across restarts of the same state file", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "t3-gateway-"));
      const path = join(directory, "nested", "state.sqlite");
      const first = yield* Effect.scoped(
        Effect.map(openGatewayState(path), (state) => state.environmentId),
      );
      const second = yield* Effect.scoped(
        Effect.map(openGatewayState(path), (state) => state.environmentId),
      );
      const other = yield* Effect.scoped(
        Effect.map(
          openGatewayState(join(directory, "other.sqlite")),
          (state) => state.environmentId,
        ),
      );
      assert.strictEqual(first, second);
      assert.notStrictEqual(first, other);
    }),
  );
});
