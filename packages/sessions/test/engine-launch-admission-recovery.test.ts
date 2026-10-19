import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SessionId } from "@mend/domain";
import type { SessionProcess } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError } from "@mend/sealant";
import {
  NoLiveAgent,
  ProtocolHost,
  SessionEngine,
  WorkspaceHostUserNamespaces,
} from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import type { CreateOptions } from "@sealant/sdk";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { LAUNCH_UNDER_WAY_WORDS } from "../src/launch-gate.ts";
import {
  makeWorld,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withPreparedEngineEffect,
  type World,
} from "./engine/fixture.ts";

/**
 * SLNT-167, review 2 of mend#1094: Mend's own recovery of a protocol agent after a restart starts
 * agents too. A public launch admitted while it ran tore down the agent it brought up.
 */

const agentRows = (world: World, sessionId: SessionId) =>
  [...world.processes.values()].filter(
    (row) => row.sessionId === sessionId && row.kind.startsWith("agent-"),
  );
const liveAgents = (world: World, sessionId: SessionId) =>
  agentRows(world, sessionId).filter((row) => row.exitedAt === null);

/** Whose adapter never comes back after the restart: Mend relaunches the agent by provider id. */
const unrecoverableHost = (attached: Array<SessionProcess>) =>
  Layer.succeed(ProtocolHost, {
    attach: (input) => Effect.sync(() => void attached.push(input.process)),
    rehydrate: () =>
      Effect.fail(
        new SealantPlatformError({
          code: "adapter_failed",
          status: null,
          message: "the adapter did not start",
          cause: null,
        }),
      ),
    submitTurn: () => Effect.die("not in test"),
    interruptTurn: () => Effect.void,
    respondRequest: () => Effect.die("not in test"),
    detach: () => Effect.void,
    has: () => Effect.succeed(false),
    quiescence: () => Effect.succeed(null),
    awaitQuiescent: () => Effect.void,
    endWork: () => Effect.void,
    detachForHandOver: () => Effect.void,
  });

/** Holds the first launch past admission, before it replaces anything, until released. */
const holdFirstLaunch = (held: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => {
  let first = true;
  return Layer.succeed(WorkspaceHostUserNamespaces, {
    observe: () =>
      Effect.suspend(() => {
        if (!first) return Effect.succeed(null);
        first = false;
        return Deferred.succeed(held, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(null),
        );
      }),
  });
};

/** A world whose protocol agent was live when Mend went down: the platform outlives it. */
const restartedWorld = async () => {
  const world = makeWorld();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-launch-recovery-"));
  const created: Array<CreateOptions> = [];
  const stopped: Array<string> = [];
  const platform = sealantLaunchLayer(
    created,
    undefined,
    stopped,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
  );
  const sessionId = await Effect.runPromise(
    withPreparedEngineEffect(
      (w, dir) => setup(dir, w),
      (_world, _tmp, project) =>
        Effect.gen(function* () {
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            base: null,
          });
          yield* engine.launchProtocol(
            session.id,
            { mode: "protocol", permissionMode: "bypass" },
            "user-fixture",
          );
          return session.id;
        }),
      {
        fixture: { world, tmp },
        sealantLayer: platform,
        protocolHostLayer: recordingProtocolHostLayer([], []),
      },
    ),
  );
  const storePath = [...world.projects.values()][0]?.storePath;
  if (storePath === undefined) throw new Error("no project");
  // What a settle harvests: a PTY relaunch of a session that ran continues from it.
  const stateDir = sessionStatePathOf(storePath, sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "");
  fs.writeFileSync(
    path.join(stateDir, "manifest.json"),
    JSON.stringify({
      harness: "claude",
      providerSessionId: "claude-session-1",
      capturedAt: "2026-10-19T08:00:00.000Z",
    }),
  );
  const [survivor] = liveAgents(world, sessionId);
  if (survivor === undefined) throw new Error("no protocol agent survived the restart");
  return { world, tmp, platform, stopped, sessionId, survivor };
};

const until = (done: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400; tries += 1) {
      if (done()) return;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`));
  });

describe("SessionEngine launch admission against recovery (SLNT-167)", () => {
  it("refuses a launch while Mend relaunches a protocol agent after a restart, and keeps the agent it brought up", async () => {
    const { world, tmp, platform, stopped, sessionId, survivor } = await restartedWorld();
    const attached: Array<SessionProcess> = [];
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const relaunchHeld = yield* Deferred.make<void>();
          const releaseRelaunch = yield* Deferred.make<void>();
          yield* withPreparedEngineEffect(
            () => Effect.void,
            () =>
              Effect.gen(function* () {
                const engine = yield* SessionEngine;
                yield* Deferred.await(relaunchHeld);
                // Recovery ended the old agent and is starting its replacement: nothing is live.
                expect(world.processes.get(survivor.id)?.exitedAt).not.toBeNull();
                expect(liveAgents(world, sessionId)).toEqual([]);

                const refused = yield* engine
                  .launch(sessionId, ["claude"], { over: NoLiveAgent })
                  .pipe(Effect.flip);

                expect(refused).toMatchObject({
                  _tag: "SessionAgentLiveError",
                  message: LAUNCH_UNDER_WAY_WORDS,
                });
                yield* Deferred.succeed(releaseRelaunch, undefined);
                yield* until(
                  () => liveAgents(world, sessionId).length === 1,
                  "the recovered agent",
                );
                const stopsOnceRecovered = [...stopped];
                yield* Effect.sleep("50 millis");
                const [recovered] = liveAgents(world, sessionId);
                expect(liveAgents(world, sessionId)).toHaveLength(1);
                expect(recovered?.kind).toBe("agent-protocol");
                expect(attached.map((row) => row.id)).toEqual([recovered?.id]);
                expect(stopped).toEqual(stopsOnceRecovered);
              }),
            {
              fixture: { world, tmp },
              sealantLayer: platform,
              protocolHostLayer: unrecoverableHost(attached),
              hostUserNamespaces: holdFirstLaunch(relaunchHeld, releaseRelaunch),
            },
          );
        }),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("recovers nothing a launch admitted first has replaced: one agent, and none torn down", async () => {
    const { world, tmp, platform, sessionId, survivor } = await restartedWorld();
    const attached: Array<SessionProcess> = [];
    const logs: Array<string> = [];
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const probeHeld = yield* Deferred.make<void>();
          const releaseProbe = yield* Deferred.make<void>();
          const launchHeld = yield* Deferred.make<void>();
          const releaseLaunch = yield* Deferred.make<void>();
          let probing = true;
          /** The recovery's first look at the surviving pipe waits until released. */
          const heldProbe = Layer.effect(
            SealantClient,
            Effect.map(SealantClient, (inner) => ({
              ...inner,
              getSession: (workspace, id) =>
                Effect.suspend(() => {
                  if (!probing || id !== survivor.sealantSessionId) {
                    return inner.getSession(workspace, id);
                  }
                  probing = false;
                  return Deferred.succeed(probeHeld, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseProbe)),
                    Effect.andThen(inner.getSession(workspace, id)),
                  );
                }),
            })),
          ).pipe(Layer.provide(platform));
          yield* withPreparedEngineEffect(
            () => Effect.void,
            () =>
              Effect.gen(function* () {
                const engine = yield* SessionEngine;
                yield* Deferred.await(probeHeld);
                // An explicit restart, admitted while the old agent still reads live, held before
                // it replaces the workspace.
                const launching = yield* engine
                  .launch(sessionId, ["claude"])
                  .pipe(Effect.forkChild);
                yield* Deferred.await(launchHeld);
                yield* Deferred.succeed(releaseProbe, undefined);
                yield* Effect.sleep("100 millis");
                expect(attached).toEqual([]);
                yield* Deferred.succeed(releaseLaunch, undefined);
                yield* Fiber.join(launching);
                yield* until(
                  () => logs.some((line) => line.includes("protocol process not restored")),
                  "the recovery's second look",
                );

                expect(attached).toEqual([]);
                expect(world.processes.get(survivor.id)?.exitedAt).not.toBeNull();
                const live = liveAgents(world, sessionId);
                expect(live).toHaveLength(1);
                expect(live[0]?.kind).toBe("agent-pty");
              }),
            {
              fixture: { world, tmp },
              sealantLayer: heldProbe,
              protocolHostLayer: unrecoverableHost(attached),
              hostUserNamespaces: holdFirstLaunch(launchHeld, releaseLaunch),
              logs,
            },
          );
        }),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
