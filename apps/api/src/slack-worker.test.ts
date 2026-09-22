import { SlackInstallsRepo, type SealedSlackInstall } from "@mend/db";
import { OrganizationId } from "@mend/domain";
import { makeFakeSlackSocket } from "@mend/slack/socket";
import { SecretCipher } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { SlackRunner } from "./slack-runner.ts";
import { makeSlackSockets, reconnectDelayMs } from "./slack-worker.ts";

const NOW = new Date("2026-09-23T10:00:00.000Z");

const installOf = (organization: string, appToken: string): SealedSlackInstall => ({
  organizationId: OrganizationId.make(`org-${organization}`),
  teamId: `T-${organization}`,
  teamName: organization,
  botUserId: "U-bot",
  appId: "A",
  sealedAppToken: `sealed:${appToken}`,
  sealedBotToken: "sealed:xoxb",
  webOrigin: "https://mend.test",
  settings: {
    defaultHarness: "claude",
    showAgentMessages: true,
    showDiffs: false,
    externalChannels: false,
  },
  installedByUserId: "alice",
  createdAt: NOW,
  updatedAt: NOW,
});

/** Sockets over a fake Socket Mode, with a runner that acknowledges and records. */
const sockets = () => {
  const socket = makeFakeSlackSocket();
  const installs: Array<SealedSlackInstall> = [];
  const received: Array<string> = [];
  const layer = Layer.mergeAll(
    socket.layer,
    Layer.mock(SlackInstallsRepo, { list: () => Effect.sync(() => [...installs]) }),
    Layer.succeed(SecretCipher, {
      encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
      decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
    }),
    Layer.mock(SlackRunner, {
      receive: (organizationId, envelope) =>
        envelope.ack.pipe(
          Effect.andThen(
            Effect.sync(() => received.push(`${organizationId}:${envelope.envelopeId}`)),
          ),
          Effect.as(null),
        ),
    }),
  );
  return { socket, installs, received, layer };
};

/** Let forked fibers run: the fake socket opens within a few scheduler turns. */
const settle = Effect.sleep("20 millis");

describe("the worker's Slack sockets", () => {
  it("opens one socket per install, routes its envelopes, and follows replacement and removal", async () => {
    const world = sockets();
    world.installs.push(installOf("acme", "xapp-acme"), installOf("globex", "xapp-globex"));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeSlackSockets;
          yield* manager.reconcile;
          yield* settle;
          expect(world.socket.open().toSorted()).toEqual(["xapp-acme", "xapp-globex"]);

          // A second reconcile with nothing changed opens nothing more.
          yield* manager.reconcile;
          yield* settle;
          expect(world.socket.attempts).toHaveLength(2);

          expect(
            world.socket.deliver("xapp-acme", { type: "events_api", envelopeId: "e1", body: {} }),
          ).toBe(true);
          yield* settle;
          expect(world.received).toEqual(["org-acme:e1"]);
          expect(world.socket.acks).toEqual(["e1"]);

          // The owner replaces Acme's tokens and removes Globex's app.
          world.installs.splice(0, 2, installOf("acme", "xapp-acme-2"));
          yield* manager.reconcile;
          yield* settle;
          expect(world.socket.open()).toEqual(["xapp-acme-2"]);
          expect(manager.open()).toEqual([OrganizationId.make("org-acme")]);
        }),
      ).pipe(Effect.provide(world.layer)),
    );
    // Closing the worker closes every socket.
    expect(world.socket.open()).toEqual([]);
  });

  it("reconnects after Slack closes a socket", async () => {
    const world = sockets();
    world.installs.push(installOf("acme", "xapp-acme"));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeSlackSockets;
          yield* manager.reconcile;
          yield* settle;
          world.socket.drop("xapp-acme");
          yield* settle;
          expect(world.socket.open()).toEqual([]);
          // The first reconnect waits a second.
          yield* Effect.sleep("1100 millis");
          expect(world.socket.open()).toEqual(["xapp-acme"]);
          expect(world.socket.attempts).toEqual(["xapp-acme", "xapp-acme"]);
        }),
      ).pipe(Effect.provide(world.layer)),
    );
  });

  it("does not retry a refused token in a loop", async () => {
    const world = sockets();
    world.installs.push(installOf("acme", "xapp-revoked"));
    world.socket.refuse("xapp-revoked");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* makeSlackSockets;
          yield* manager.reconcile;
          yield* Effect.sleep("200 millis");
          expect(world.socket.attempts).toEqual(["xapp-revoked"]);
          expect(manager.open()).toEqual([OrganizationId.make("org-acme")]);
        }),
      ).pipe(Effect.provide(world.layer)),
    );
  });

  it("backs off doubling to five minutes, and waits longest on a refused token", () => {
    expect([1, 2, 3, 4].map((failures) => reconnectDelayMs(failures, false))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
    expect(reconnectDelayMs(20, false)).toBe(5 * 60_000);
    expect(reconnectDelayMs(1, true)).toBe(5 * 60_000);
  });
});
