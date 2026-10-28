import * as http from "node:http";

import { PreviewId, PreviewLabel } from "@mend/domain";
import type { Preview } from "@mend/domain/workbench";
import { SealantClient, SealantPlatformError, SealantPrincipal } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import {
  adapterLayer,
  echo,
  fakeForward,
  previewsRepoOf,
  refusal,
  scriptedSealant,
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  type World,
} from "@mend/sessions/testing";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Layer, Schedule } from "effect";
import { expect, it } from "vitest";

import { PreviewTargetsLive } from "../src/preview-targets.ts";
import { localForwards } from "./support/preview-forward.ts";
import { APP_PORT, gatewayWorld, PREVIEWS, send } from "./support/preview-gateway-world.ts";

const OWNER = "user-fixture";

const noPrincipal = new SealantPlatformError({
  code: "NO_PRINCIPAL",
  status: null,
  message: "no Sealant principal",
  cause: null,
});

const principalPlatform = (opened: Array<ReadonlyArray<string>> = []) =>
  Layer.effect(
    SealantClient,
    Effect.map(SealantClient, (client) => {
      const asSomeone = <A, E, R>(call: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const principal = yield* SealantPrincipal;
          return principal.kind === "user" ? yield* call : yield* noPrincipal;
        });
      return {
        ...client,
        getWorkspace: (workspaceId) => asSomeone(client.getWorkspace(workspaceId)),
        openSession: (workspace, argv, options) =>
          asSomeone(
            Effect.andThen(
              Effect.sync(() => opened.push(argv)),
              client.openSession(workspace, argv, options),
            ),
          ),
      };
    }),
  ).pipe(Layer.provide(sealantLaunchLayer(Array<CreateOptions>())));

const workspacePort = (world: { current: World | null }) =>
  adapterLayer(
    scriptedSealant(async () => {
      const live = [...(world.current?.processes.values() ?? [])].some(
        (process) =>
          process.kind === "service" &&
          process.exitedAt === null &&
          process.sealantSessionId !== null,
      );
      if (!live) throw refusal("connection-refused");
      return fakeForward(echo).forward;
    }).layer,
  );

const serveApp = Effect.acquireRelease(
  Effect.callback<http.Server>((resume) => {
    const server = http.createServer((_request, response) => response.end("started"));
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
  }),
  (server) =>
    Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
    }),
);

const stagePreview = (world: World, tmp: string) =>
  Effect.gen(function* () {
    const project = yield* setup(tmp, world);
    const engine = yield* SessionEngine;
    const session = yield* engine.provision({
      projectId: project.id,
      harness: "codex",
      label: null,
      name: null,
      ownerUserId: OWNER,
      start: { kind: "base", base: null },
    });
    yield* engine.launch(session.id, ["codex"]);
    const web = yield* engine.runService(
      session.id,
      ["pnpm", "dev"],
      APP_PORT,
      "web",
      "tcp",
      "http",
      { kind: "person", userId: OWNER },
    );
    const row = world.sessions.get(session.id);
    if (row?.sealantWorkspaceId == null) return yield* Effect.die("no live workspace");
    const preview: Preview = {
      id: PreviewId.make(PREVIEWS.web.id),
      label: PreviewLabel.make(PREVIEWS.web.label),
      projectId: project.id,
      worktreeId: row.worktreeId,
      serviceName: "web",
      state: "kept",
    };
    world.previews.set(preview.id, preview);

    const app = yield* serveApp;
    const address = app.address();
    if (address === null || typeof address === "string") return yield* Effect.die("no port");
    const forwards = localForwards([
      {
        workspaceId: row.sealantWorkspaceId,
        port: APP_PORT,
        entry: { kind: "listen", localPort: address.port },
      },
    ]);
    const gateway = yield* gatewayWorld({
      // Fresh: the engine built the forward adapter over its own platform in this memo map.
      forwards: Layer.fresh(forwards.layer),
      targets: PreviewTargetsLive.pipe(
        Layer.provide(previewsRepoOf(world)),
        Layer.provide(Layer.succeed(SessionEngine, engine)),
      ),
      settings: { startHoldMs: 20_000 },
    });
    const request = () =>
      Effect.promise(() =>
        send(gateway.port, {
          host: gateway.hostOf("web"),
          path: "/",
          headers: { cookie: gateway.cookieFor("carol", "web") },
        }),
      );
    return { engine, session, service: web.service, request };
  });

it("a request to a stopped preview starts it through the engine, as its session's owner", async () => {
  const known: { current: World | null } = { current: null };
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        known.current = world;
        const { engine, service, request } = yield* stagePreview(world, tmp);
        yield* engine.stopService(service.id, {
          kind: "system",
          reason: "idle",
        });
        const reply = yield* request();
        expect(reply.body, "the started Service answered").toBe("started");
        expect(reply.status).toBe(200);
      }),
    {
      sealantLayer: principalPlatform(),
      forwardAdapterLayer: workspacePort(known),
    },
  );
});

it("a person's Stop serves the agent's own run while it lasts, then starts nothing until a person's Start", async () => {
  const known: { current: World | null } = { current: null };
  const opened: Array<ReadonlyArray<string>> = [];
  await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        known.current = world;
        const { engine, session, service, request } = yield* stagePreview(world, tmp);
        yield* engine.stopService(service.id, {
          kind: "person",
          userId: OWNER,
        });
        expect((yield* request()).status, "the person's Stop holds").toBe(503);

        const agent = servedSocketApis.get(session.id);
        if (agent === undefined) return yield* Effect.die("the session serves no socket");
        yield* agent.runService(["pnpm", "dev"], APP_PORT, "web", "tcp", "http");
        const served = yield* request();
        expect(served.body, "the agent's run is served").toBe("started");
        expect(served.status).toBe(200);

        yield* agent.stopService(service.id);
        const opens = opened.length;
        const stopped = yield* request().pipe(
          Effect.repeat({
            until: (reply) => reply.status === 503,
            schedule: Schedule.spaced("100 millis"),
            times: 50,
          }),
        );
        expect(stopped.body, "the Stop holds again once the run ends").toContain(
          "stopped the preview",
        );
        expect(opened.length, "a request starts nothing").toBe(opens);

        yield* engine.runService(session.id, ["pnpm", "dev"], APP_PORT, "web", "tcp", "http", {
          kind: "person",
          userId: OWNER,
        });
        yield* engine.stopService(service.id, {
          kind: "system",
          reason: "idle",
        });
        const woken = yield* request().pipe(
          Effect.repeat({
            until: (reply) => reply.status === 200,
            schedule: Schedule.spaced("100 millis"),
            times: 50,
          }),
        );
        expect(woken.body, "a person's Start lets a request start it again").toBe("started");
      }),
    {
      sealantLayer: principalPlatform(opened),
      forwardAdapterLayer: workspacePort(known),
    },
  );
});
