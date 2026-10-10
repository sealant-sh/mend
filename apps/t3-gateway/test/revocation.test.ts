import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentAuthInvalidError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WS_METHODS,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * A device revoked in Mend ends the gateway bearers that stand for it (the box check, 2026-10-10):
 * the bearer gets no new ticket, its row records the revocation, and a gateway that was not
 * running when the device went finds it on its next start.
 */

const statePathFor = () => join(mkdtempSync(join(tmpdir(), "t3-gateway-revoke-")), "state.sqlite");

/** When the gateway's state file says the bearers of a Mend device were revoked; null if live. */
const revokedAtOf = (statePath: string, mendDeviceId: string): ReadonlyArray<number | null> => {
  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    return database
      .prepare("SELECT revoked_at FROM bearer_sessions WHERE mend_device_id = ?")
      .all(mendDeviceId)
      .map((row) => (typeof row["revoked_at"] === "number" ? row["revoked_at"] : null));
  } finally {
    database.close();
  }
};

/** The device Mend minted for the n-th claim. */
const deviceIdOf = (mend: FakeMend, claim: number): string => {
  const id = mend.claims[claim]?.deviceId;
  if (id === undefined) throw new Error(`no claim ${claim}`);
  return id;
};

const decodeAuthInvalid = Schema.decodeUnknownEffect(EnvironmentAuthInvalidError);

/** `POST /api/auth/websocket-ticket` with a bearer, raw: its status and body as t3code reads them. */
const ticketRequest = (accessToken: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
        HttpClientRequest.setHeaders(bearer(accessToken)),
      ),
    );
    return { status: response.status, body: yield* response.json };
  });

/** Polls until `check` holds, for at most ten seconds. */
const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, check: (value: A) => boolean) =>
  read.pipe(
    Effect.flatMap((value) =>
      check(value) ? Effect.succeed(value) : Effect.fail("not yet" as const),
    ),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
  );

describe("a device revoked in Mend", () => {
  it.live("ends its bearer when the hub's own reads find it, during an open socket", () => {
    const statePath = statePathFor();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { access, rpc } = yield* pairAndConnect(mend, "REVOKEOPEN");
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});
        // The hub reads Mend's event stream while the socket is open.
        yield* eventually(
          Effect.sync(() => mend.workbench.eventStreams),
          (streams) => streams > 0,
        );

        // Revoked with no call of the client's in flight: the hub's reconnecting stream finds it.
        mend.revoke(mend.claims[0]?.token ?? "");
        mend.workbench.dropStreams();

        // The hub's finding alone revokes the bearer: nothing has asked for a ticket yet.
        yield* eventually(
          Effect.sync(() => revokedAtOf(statePath, deviceIdOf(mend, 0))),
          ([revokedAt]) => typeof revokedAt === "number",
        );
        const refused = yield* ticketRequest(access.access_token);
        assert.strictEqual(refused.status, 401);
        assert.strictEqual((yield* decodeAuthInvalid(refused.body)).reason, "invalid_credential");

        // The open socket is closed too.
        const probe = yield* Effect.exit(
          rpc[WS_METHODS.serverProbe]({}).pipe(Effect.timeout("5 seconds")),
        );
        assert.isTrue(Exit.isFailure(probe));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

  it.live("gets no ticket though the gateway has not noticed yet", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        mend.addPairingCode("REVOKEQUIET", PERSON);
        const client = yield* t3Client;
        const access = yield* client.auth.token(tokenRequest("REVOKEQUIET"));
        // No socket ever opened: nothing in the gateway has read Mend with the token since.
        mend.revoke(mend.claims[0]?.token ?? "");
        const answer = yield* ticketRequest(access.access_token);
        assert.strictEqual(answer.status, 401);
        assert.strictEqual((yield* decodeAuthInvalid(answer.body)).reason, "invalid_credential");
        // Every other bearer-accepting route refuses it as well.
        const shell = yield* Effect.exit(
          client.orchestration.shellSnapshot({
            headers: {
              ...bearer(access.access_token),
              [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
            },
          }),
        );
        assert.isTrue(Exit.isFailure(shell));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("is found on the gateway's next start, before any client asks", () => {
    const statePath = statePathFor();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const access = yield* Effect.gen(function* () {
        mend.addPairingCode("REVOKEDOWN", PERSON);
        mend.addPairingCode("STILLLIVE", PERSON);
        const client = yield* t3Client;
        const revokedLater = yield* client.auth.token(tokenRequest("REVOKEDOWN"));
        const kept = yield* client.auth.token(tokenRequest("STILLLIVE"));
        return { revokedLater, kept };
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      // Revoked while the gateway was not running.
      mend.revoke(mend.claims[0]?.token ?? "");
      assert.deepStrictEqual(revokedAtOf(statePath, deviceIdOf(mend, 0)), [null]);

      yield* Effect.gen(function* () {
        // Nothing asks: the start alone reconciles the state file with Mend.
        yield* eventually(
          Effect.sync(() => revokedAtOf(statePath, deviceIdOf(mend, 0))),
          ([revokedAt]) => typeof revokedAt === "number",
        );
        assert.deepStrictEqual(revokedAtOf(statePath, deviceIdOf(mend, 1)), [null]);
        assert.strictEqual((yield* ticketRequest(access.revokedLater.access_token)).status, 401);
        assert.strictEqual((yield* ticketRequest(access.kept.access_token)).status, 200);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});
