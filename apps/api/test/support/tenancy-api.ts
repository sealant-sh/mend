import {
  BriefCommentsRepo,
  BriefsRepo,
  ChangePassesRepo,
  ChangesRepo,
  ChangeToursRepo,
  CheckpointsRepo,
  DevicesRepo,
  FollowUpsRepo,
  HotWorkspacesRepo,
  IssuesRepo,
  ProjectClusterBindingsRepo,
  ProjectEnvironmentRepo,
  ProjectLinksRepo,
  ProjectMountsRepo,
  ProjectSecretsRepo,
  ProjectServiceRecipesRepo,
  PushDevicesRepo,
  ReferencesRepo,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  RunsRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  SettingsRepo,
  UserEvents,
  UserGitAccessRepo,
  UsersRepo,
} from "@mend/db";
import { JobRunner } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { SealantClient, SealantClients } from "@mend/sealant";
import { CaptureRuntime, FollowUpDelivery, SessionEngine, WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  DotfilesStore,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
} from "@mend/store";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ProjectAccessLive } from "../../src/access.ts";
import { MendApiLive } from "../../src/routes/api-live.ts";
import { Gh } from "../../src/routes/github.ts";
import { ServiceTunnelRoutes } from "../../src/routes/service-tunnel.ts";
import { TtyRoutes } from "../../src/routes/tty.ts";
import { HostEnvironment } from "../../src/services/host-environment.ts";
import { SessionSteeringLive } from "../../src/session-steering.ts";
import { TenancyConfig } from "../../src/tenancy.ts";
import { createTenancyWorld, type HarnessUser, type TenancyWorld } from "./tenancy-harness.ts";
import { recording } from "./tenancy-harness.ts";

export interface TenancyApi {
  readonly world: TenancyWorld;
  /** Send a request as `user` (null: no credentials) and return the response. */
  readonly request: (
    user: HarnessUser | null,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;
  /** Send a raw (WebSocket upgrade) route request: `/api/tty` and `/api/service-tunnel`. */
  readonly rawRequest: (user: HarnessUser, path: string) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

const network = makePublicNetwork(
  Schema.decodeUnknownSync(PublicOrigin)("http://api.internal"),
  [],
);

/**
 * The whole Mend API over the tenancy world. Every service outside the authorization reads is a
 * recording mock with no implementation, so a handler that gets past authorization records the
 * first thing it touches and then fails; a refused request must record nothing.
 */
export const createTenancyApi = async (): Promise<TenancyApi> => {
  const world = await createTenancyWorld();
  const calls = world.calls;
  const effects = Layer.mergeAll(
    Layer.mergeAll(
      recording(BriefCommentsRepo, "briefComments", {}, calls),
      recording(BriefsRepo, "briefs", {}, calls),
      recording(ChangePassesRepo, "changePasses", {}, calls),
      recording(ChangesRepo, "legacyChanges", {}, calls),
      recording(ChangeToursRepo, "changeTours", {}, calls),
      recording(CheckpointsRepo, "checkpoints", {}, calls),
      recording(DevicesRepo, "devices", {}, calls),
      recording(FollowUpsRepo, "followUps", {}, calls),
      recording(HotWorkspacesRepo, "hotWorkspaces", {}, calls),
      recording(IssuesRepo, "issues", {}, calls),
      recording(ProjectClusterBindingsRepo, "clusterBindings", {}, calls),
      recording(ProjectEnvironmentRepo, "environment", {}, calls),
      recording(ProjectLinksRepo, "links", {}, calls),
      recording(ProjectMountsRepo, "mounts", {}, calls),
      recording(ProjectSecretsRepo, "secrets", {}, calls),
      recording(ProjectServiceRecipesRepo, "recipes", {}, calls),
      recording(PushDevicesRepo, "pushDevices", {}, calls),
      recording(ReferencesRepo, "references", {}, calls),
      recording(ReviewCommentsRepo, "comments", {}, calls),
    ),
    Layer.mergeAll(
      recording(ReviewSlicesRepo, "slices", {}, calls),
      recording(RunsRepo, "runs", {}, calls),
      recording(ServiceForwardsRepo, "forwards", {}, calls),
      recording(ServiceObservationsRepo, "observations", {}, calls),
      recording(SettingsRepo, "settings", {}, calls),
      recording(UserEvents, "userEvents", {}, calls),
      recording(UserGitAccessRepo, "gitAccess", {}, calls),
      recording(UsersRepo, "users", {}, calls),
      recording(JobRunner, "jobs", {}, calls),
      recording(SealantClient, "sealant", {}, calls),
      recording(
        SealantClients,
        "sealantClients",
        {
          connectedAccounts: () => {
            throw new Error("the harness does not implement sealantClients.connectedAccounts");
          },
          sshKeys: () => {
            throw new Error("the harness does not implement sealantClients.sshKeys");
          },
        },
        calls,
      ),
      Layer.succeed(CaptureRuntime, { enabled: false }),
      recording(FollowUpDelivery, "followUpDelivery", {}, calls),
      recording(SessionEngine, "engine", {}, calls),
      recording(WorktreeReads, "reads", {}, calls),
      recording(AgentBridge, "agentBridge", { socketPath: () => "/unused/agent.sock" }, calls),
      recording(DotfilesStore, "dotfilesStore", {}, calls),
      recording(MendKeys, "keys", {}, calls),
      recording(SecretCipher, "cipher", {}, calls),
    ),
    Layer.mergeAll(
      recording(Store, "store", {}, calls),
      recording(Gh, "gh", {}, calls),
      recording(HostEnvironment, "hostEnvironment", {}, calls),
      Layer.succeed(NetworkConfig, network),
      Layer.succeed(DeploymentConfig, {
        mode: "local",
        sessionEndpoint: undefined,
        sessionStore: "captured",
      }),
      Layer.succeed(StoreConfig, { root: world.root }),
      Layer.succeed(TenancyConfig, { mode: "single" }),
    ),
  );
  const dependencies = Layer.mergeAll(world.authLayer, world.accessLayers, effects);
  const authorization = Layer.merge(ProjectAccessLive, SessionSteeringLive).pipe(
    Layer.provideMerge(ProjectAccessLive),
    Layer.provideMerge(dependencies),
  );
  const apiLayer = MendApiLive.pipe(
    Layer.provide(authorization),
    Layer.provide(HttpServer.layerServices),
  );
  const runtime = ManagedRuntime.make(authorization);
  const context = await runtime.runPromise(Effect.context<Layer.Success<typeof authorization>>());
  const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });
  const rawLayer = Layer.merge(TtyRoutes, ServiceTunnelRoutes).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(authorization),
  );
  const raw = HttpRouter.toWebHandler(rawLayer, { disableLogger: true });

  return {
    world,
    request: (user, method, path, body) => {
      const headers = new Headers();
      if (user !== null) headers.set("authorization", `Bearer ${user}`);
      if (body !== undefined) headers.set("content-type", "application/json");
      return handler(
        new Request(`http://api.internal${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        context,
      );
    },
    rawRequest: (user, path) =>
      raw.handler(
        new Request(`http://api.internal${path}`, {
          headers: { authorization: `Bearer ${user}` },
        }),
      ),
    dispose: async () => {
      await dispose();
      await raw.dispose();
      await runtime.dispose();
      await world.dispose();
    },
  };
};
