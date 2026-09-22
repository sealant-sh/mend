import {
  AuditEventsRepo,
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
  PushDevice,
  PushDevicesRepo,
  ReviewCommentsRepo,
  ReviewSlicesRepo,
  RunsRepo,
  ServiceForwardsRepo,
  ServiceObservationsRepo,
  SessionControlEventsRepo,
  SettingsRepo,
  SlackDefaultsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  UserDotfilesRepo,
  UserEvents,
  UserGitAccessRepo,
  UsersRepo,
  type MendEvent,
  makeUpgradeTicketsMemory,
  UpgradeTicketsRepo,
} from "@mend/db";
import { JobRunner } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { SealantClient, SealantClients } from "@mend/sealant";
import { CaptureRuntime, FollowUpDelivery, SessionEngine, WorktreeReads } from "@mend/sessions";
import { SlackApi } from "@mend/slack/client";
import {
  AgentBridge,
  DeploymentConfig,
  DotfilesStore,
  FolderStore,
  MendKeys,
  SecretCipher,
  Store,
  StoreConfig,
  makeSourcePolicy,
  SourcePolicy,
} from "@mend/store";
import { Effect, Layer, ManagedRuntime, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { ProjectAccessLive } from "../../src/access.ts";
import {
  Budgets,
  DEFAULT_BUDGET_LIMITS,
  makeBudgets,
  type BudgetLimits,
} from "../../src/budgets.ts";
import {
  ConnectionRegistry,
  makeConnectionRegistry,
  type ConnectionKind,
} from "../../src/connections.ts";
import { EventBus, makeEventBus } from "../../src/events-bus.ts";
import { ExposureConfig } from "../../src/exposure.ts";
import { GithubIdentityLive } from "../../src/github-identity.ts";
import { MemberRemovalLive } from "../../src/member-removal.ts";
import { MendApiLive } from "../../src/routes/api-live.ts";
import { EventsRoutes } from "../../src/routes/events.ts";
import { Gh } from "../../src/routes/github.ts";
import { ServiceTunnelRoutes } from "../../src/routes/service-tunnel.ts";
import { TtyRoutes } from "../../src/routes/tty.ts";
import { UrlBearers } from "../../src/routes/upgrade-tickets.ts";
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
  /** Publish one NOTIFY payload into the in-memory event bus, as Postgres would. */
  readonly notify: (event: MendEvent) => Promise<void>;
  /** Open `/api/events` as `user`; frames are read one at a time, `null` after the timeout. */
  readonly events: (user: HarnessUser | null) => Promise<{
    readonly status: number;
    readonly next: (timeoutMs?: number) => Promise<string | null>;
    readonly close: () => Promise<void>;
  }>;
  /** Send a raw (WebSocket upgrade) route request: `/api/tty` and `/api/service-tunnel`. */
  readonly rawRequest: (user: HarnessUser | null, path: string) => Promise<Response>;
  /** How often the shared listen stream behind the event bus was started and ended. */
  readonly listen: { readonly starts: number; readonly ends: number };
  /** Long-lived connections of one kind the registry holds for `user` right now. */
  readonly openConnections: (user: HarnessUser, kind: ConnectionKind) => Promise<number>;
  /** What removing a member does to their connections: close every one this process holds. */
  readonly closeConnectionsOf: (user: HarnessUser) => Promise<number>;
  /** Push-device writes as `method:userId:token`, to prove the caller's id reaches the repo. */
  readonly deviceWrites: ReadonlyArray<string>;
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
export const createTenancyApi = async (
  /** Budgets for this world; the defaults unless a test wants one tight enough to reach. */
  limits: Partial<BudgetLimits> = {},
  options: {
    readonly urlBearers?: "accept" | "refuse";
    readonly clock?: () => number;
    /** `MEND_EXPOSURE` and its gate as this world reports them; loopback and empty unless stated. */
    readonly exposure?: ExposureConfig["Service"];
    /** Credentials that no longer stand (`session:<account>`): add one to sign that account out. */
    readonly revokedCredentials?: ReadonlySet<string>;
  } = {},
): Promise<TenancyApi> => {
  const world = await createTenancyWorld();
  const ticketsLayer = Layer.mergeAll(
    Layer.succeed(
      UpgradeTicketsRepo,
      makeUpgradeTicketsMemory(options.clock, options.revokedCredentials),
    ),
    Layer.succeed(UrlBearers, { mode: options.urlBearers ?? "accept" }),
  );
  const budgetsLayer = Layer.succeed(Budgets, makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...limits }));
  const calls = world.calls;
  const deviceWrites: Array<string> = [];
  const effects = Layer.mergeAll(
    Layer.mergeAll(
      recording(AuditEventsRepo, "audit", { record: () => Effect.void }, calls),
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
      recording(
        PushDevicesRepo,
        "pushDevices",
        {
          register: (userId, token, platform) =>
            Effect.sync(() => {
              deviceWrites.push(`register:${userId}:${token}`);
              return new PushDevice({ token, platform, userId });
            }),
          removeOwned: (userId, token) =>
            Effect.sync(() => {
              deviceWrites.push(`removeOwned:${userId}:${token}`);
            }),
        },
        calls,
      ),
      recording(ReviewCommentsRepo, "comments", {}, calls),
      recording(UserDotfilesRepo, "userDotfiles", {}, calls),
    ),
    Layer.mergeAll(
      recording(ReviewSlicesRepo, "slices", {}, calls),
      recording(SessionControlEventsRepo, "controlEvents", { record: () => Effect.void }, calls),
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
      recording(FolderStore, "folderStore", {}, calls),
      recording(MendKeys, "keys", {}, calls),
      recording(SecretCipher, "cipher", {}, calls),
    ),
    Layer.mergeAll(
      recording(Store, "store", {}, calls),
      recording(Gh, "gh", {}, calls),
      recording(SlackApi, "slackApi", {}, calls),
      recording(SlackDefaultsRepo, "slackDefaults", {}, calls),
      recording(SlackInstallsRepo, "slackInstalls", {}, calls),
      recording(
        SlackLinksRepo,
        "slackLinks",
        // Removing a member reads their links first; nobody in this world has one.
        { listForUser: () => Effect.succeed([]) },
        calls,
      ),
      recording(HostEnvironment, "hostEnvironment", {}, calls),
      Layer.succeed(NetworkConfig, network),
      Layer.succeed(DeploymentConfig, {
        mode: "local",
        sessionEndpoint: undefined,
        sessionStore: "captured",
      }),
      Layer.succeed(StoreConfig, { root: world.root }),
      Layer.succeed(TenancyConfig, { mode: "single", gate: [] }),
      Layer.succeed(ExposureConfig, options.exposure ?? { exposure: "loopback", gate: [] }),
      // Every remote in the harness is public; the policy's own tests cover the refusals.
      Layer.succeed(
        SourcePolicy,
        makeSourcePolicy({
          profile: "operator",
          allowedHosts: [],
          resolve: async () => ["140.82.112.3"],
        }),
      ),
    ),
  );
  const dependencies = Layer.mergeAll(world.authLayer, world.accessLayers, effects);
  // One registry for the whole world. The API, the socket routes and the event route are separate
  // web handlers here, each building its own layers; they must still see each other's connections,
  // as they do in the one production process.
  const registry = Effect.runSync(makeConnectionRegistry);
  const connections = Layer.succeed(ConnectionRegistry, {
    register: registry.register,
    closeForUser: registry.closeForUser,
    closeForSession: registry.closeForSession,
    countFor: registry.countFor,
  });
  const authorization = Layer.mergeAll(
    ProjectAccessLive,
    SessionSteeringLive,
    GithubIdentityLive,
    MemberRemovalLive,
  ).pipe(
    Layer.provideMerge(ProjectAccessLive),
    Layer.provideMerge(connections),
    Layer.provideMerge(budgetsLayer),
    Layer.provideMerge(ticketsLayer),
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
  const source = Effect.runSync(Queue.unbounded<string>());
  // The stand-in for the one LISTEN: how often it was started and ended is what a lifecycle test
  // reads, since a stream tearing down must never end it for the others.
  const listen = { starts: 0, ends: 0 };
  // Subscriptions taken from the bus so far: how `events()` knows a stream is really listening,
  // observed instead of slept for.
  const subscriptions = { taken: 0 };
  const busLayer = Layer.effect(
    EventBus,
    Effect.map(
      makeEventBus(
        Stream.fromQueue(source).pipe(
          Stream.onStart(
            Effect.sync(() => {
              listen.starts += 1;
            }),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              listen.ends += 1;
            }),
          ),
        ),
      ),
      (bus) => ({
        subscribe: Effect.tap(bus.subscribe, () =>
          Effect.sync(() => {
            subscriptions.taken += 1;
          }),
        ),
      }),
    ),
  );
  const eventsLayer = EventsRoutes.pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(busLayer),
    Layer.provide(authorization),
  );
  const eventRoutes = HttpRouter.toWebHandler(eventsLayer, { disableLogger: true });

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
    notify: (event) =>
      Effect.runPromise(
        Queue.offer(source, JSON.stringify(event)).pipe(Effect.andThen(Effect.sleep("20 millis"))),
      ),
    events: async (user) => {
      const before = subscriptions.taken;
      const controller = new AbortController();
      const response = await eventRoutes.handler(
        new Request("http://api.internal/api/events", {
          headers: user === null ? {} : { authorization: `Bearer ${user}` },
          signal: controller.signal,
        }),
        context,
      );
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      // One read at a time: a read that loses the timeout race stays in flight and is awaited
      // by the next call instead of being replaced (which would drop its chunk).
      let inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
      const next = async (timeoutMs = 200): Promise<string | null> => {
        while (!pending.includes("\n\n")) {
          if (reader === undefined) return null;
          inFlight ??= reader.read();
          const chunk = await Promise.race([
            inFlight,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
          ]);
          if (chunk === null) return null;
          inFlight = null;
          if (chunk.done) return null;
          pending += decoder.decode(chunk.value);
        }
        const end = pending.indexOf("\n\n");
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        return frame;
      };
      // The subscription starts when the body is first pulled. Pull, then wait until the bus has
      // handed this stream its subscription, so nothing published after `events()` returns can
      // be missed. A refused stream never subscribes and is not waited for.
      await next(1);
      if (response.status === 200) {
        const listening = () => subscriptions.taken > before;
        const deadline = Date.now() + 5_000;
        while (!listening() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (!listening()) throw new Error("the event stream never subscribed");
      }
      return {
        status: response.status,
        next,
        close: async () => {
          controller.abort();
          await reader?.cancel().catch(() => undefined);
        },
      };
    },
    deviceWrites,
    listen,
    openConnections: (user, kind) => Effect.runPromise(registry.countFor(user, kind)),
    closeConnectionsOf: (user) => Effect.runPromise(registry.closeForUser(user)),
    rawRequest: (user, path) =>
      raw.handler(
        new Request(`http://api.internal${path}`, {
          headers: user === null ? {} : { authorization: `Bearer ${user}` },
        }),
        context,
      ),
    dispose: async () => {
      await dispose();
      await raw.dispose();
      await eventRoutes.dispose();
      await runtime.dispose();
      await world.dispose();
    },
  };
};
