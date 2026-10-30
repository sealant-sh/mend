import { SessionChannelTokensRepo, SessionChannelTokensRepoMemory } from "@mend/db";
import {
  SessionChannelNetworkHost,
  SessionChannelNetworkHostLive,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
  SessionEngine,
} from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { servedSocketApis } from "./engine/fixture.ts";
import { withScreens } from "./engine/screen-fixture.ts";

const channelLayer = Layer.mergeAll(
  SessionChannelRegistryLive,
  SessionChannelTokensRepoMemory,
  SessionChannelNetworkHostLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionChannelRegistryLive,
        SessionChannelTokensRepoMemory,
        Layer.succeed(DeploymentConfig, {
          mode: "kubernetes",
          sessionEndpoint: { listen: "127.0.0.1:0", url: "http://127.0.0.1:0" },
          sessionStore: "captured",
        }),
      ),
    ),
  ),
);

describe("the screen's secret over the session channel (ADR 0020)", () => {
  it.live("answers only the person a screen runs as, never a workspace's own token", () =>
    Effect.gen(function* () {
      const registry = yield* SessionChannelRegistry;
      const network = yield* SessionChannelNetworkHost;
      const tokens = yield* SessionChannelTokensRepo;
      for (const layout of ["shared", "person"] as const) {
        yield* withScreens(
          (world) =>
            Effect.gen(function* () {
              const engine = yield* SessionEngine;
              const [project] = [...world.projects.values()];
              if (project === undefined) throw new Error("no project");
              const session = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: `screen-${layout}`,
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(session.id, ["claude"]);
              const socket = servedSocketApis.get(session.id);
              const launchId = world.executorLaunches.get(session.id)?.launchId;
              if (socket === undefined || launchId === undefined) throw new Error("not launched");
              registry.register(session.id, socket);
              yield* Effect.ignore(engine.startScreen(session.id));
              const ask = (token: string) =>
                Effect.promise(() =>
                  fetch(`http://${network.address}/session/screen-secret`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "x-mend-session-id": session.id },
                  }).then((response) => response.status),
                );
              expect([layout, yield* ask(yield* tokens.issue(session.id, launchId))]).toEqual([
                layout,
                409,
              ]);
              expect([layout, socket.screenSecret]).toEqual([layout, undefined]);
              const person = yield* tokens.issuePerson(launchId, "user-fixture");
              expect([layout, yield* ask(person)]).toEqual([
                layout,
                layout === "person" ? 200 : 401,
              ]);
            }),
          { layout, tokensLayer: Layer.succeed(SessionChannelTokensRepo, tokens) },
        );
      }
    }).pipe(Effect.provide(channelLayer)),
  );
});
