import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";

import { NotFound } from "@mend/api-contracts";
import {
  makeUpgradeTicketsMemory,
  PreviewGrantsRepo,
  type PreviewGrantStanding,
  type PreviewGrantSubject,
  PreviewsRepo,
  UpgradeTicketsRepo,
} from "@mend/db";
import {
  OrganizationId,
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  canSeeProject,
  type Preview,
  type PreviewBoundAttempt,
  previewGatewayResolution,
  type PreviewGatewayResolution,
  type PreviewStartRequest,
  Service,
  SessionProcess,
  type Viewer,
} from "@mend/domain/workbench";
import { SealantPlatformError, SealantPrincipal } from "@mend/sealant";
import { type ForwardAdapter, WorkspaceCaller } from "@mend/sessions";
import { Deferred, Effect, Layer, PubSub, Redacted } from "effect";

import { ProjectAccess } from "../../src/access.ts";
import {
  Budgets,
  DEFAULT_BUDGET_LIMITS,
  makeBudgets,
  type BudgetLimits,
} from "../../src/budgets.ts";
import { ConnectionRegistry, makeConnectionRegistry } from "../../src/connections.ts";
import { type BusSignal, EventBus } from "../../src/events-bus.ts";
import {
  PREVIEW_GATEWAY_DEFAULTS,
  type PreviewGatewaySettings,
} from "../../src/preview-gateway-settings.ts";
import { makePreviewGatewayLayer } from "../../src/preview-gateway.ts";
import {
  makePreviewIdentityLayer,
  PREVIEW_TIMING,
  PreviewConfig,
} from "../../src/preview-identity.ts";
import {
  grantCookieOf,
  previewOriginOf,
  type PreviewPlace,
  type PreviewRouting,
} from "../../src/preview-routing.ts";
import { type PreviewStartFailed, PreviewTargets } from "../../src/preview-targets.ts";
import { makeProject } from "./tenancy-harness.ts";

const ORG = OrganizationId.make("org-a");
const PROJECT = ProjectId.make("p-shared");

export const WORKSPACE = SealantWorkspaceId.make("ws-preview");
export const APP_PORT = 5173;
export const PLATFORM_SESSION = "sealant-session-1";

type KeptPreview = Extract<Preview, { readonly state: "kept" }>;

const keptPreview = (id: string, label: string, serviceName: string): KeptPreview => ({
  id: PreviewId.make(id),
  label: PreviewLabel.make(label),
  serviceName,
  projectId: PROJECT,
  worktreeId: WorktreeId.make("wt-1"),
  state: "kept",
});

export const PREVIEWS = {
  web: keptPreview("pv-web", `w${"a".repeat(25)}`, "web"),
  docs: keptPreview("pv-docs", `d${"a".repeat(25)}`, "docs"),
} as const;
export type PreviewKey = keyof typeof PREVIEWS;

export const MEMBERS: ReadonlyArray<Viewer> = [
  { userId: "alice", organizationId: ORG, role: "owner" },
  { userId: "carol", organizationId: ORG, role: "member" },
  { userId: "dave", organizationId: ORG, role: "member" },
];

const PREVIEW_KEYS: ReadonlyArray<PreviewKey> = ["web", "docs"];
const keyOf = (id: string) => PREVIEW_KEYS.find((key) => PREVIEWS[key].id === id);

/** The port each preview holds on the tailnet, as the pool would have given them. */
export const TAILNET_PORTS: Record<PreviewKey, number> = { web: 20001, docs: 20002 };

export const placeOf = (key: PreviewKey): PreviewPlace => ({
  label: PREVIEWS[key].label,
  tailnetPort: TAILNET_PORTS[key],
});

export const ROUTINGS = {
  domain: { mode: "domain-https", domain: "preview.test", port: 443 },
  tailnet: {
    mode: "tailnet-https",
    hostname: "mend-preview.tail.ts.net",
    ports: [TAILNET_PORTS.web, TAILNET_PORTS.docs],
  },
} as const satisfies Record<string, PreviewRouting>;

export const attemptOf = (overrides: Partial<PreviewBoundAttempt> = {}): PreviewBoundAttempt => ({
  serviceId: ServiceId.make("svc-web"),
  attemptId: SessionProcessId.make("attempt-1"),
  sessionId: SessionId.make("session-1"),
  workspaceId: WORKSPACE,
  port: APP_PORT,
  platformSessionId: PLATFORM_SESSION,
  host: "rewrite",
  dial: "session-bound",
  ...overrides,
});

export const bound = (
  overrides: Partial<PreviewBoundAttempt> = {},
  revision = 0,
): PreviewGatewayResolution => ({ _tag: "Bound", revision, attempt: attemptOf(overrides) });

export const opening = (attemptId: string, revision = 0): PreviewGatewayResolution => {
  const at = new Date("2026-10-25T10:00:00Z");
  const service = new Service({
    id: ServiceId.make("svc-web"),
    sessionId: SessionId.make("session-1"),
    name: "web",
    declarationSource: "explicit-run",
    workspacePort: APP_PORT,
    transport: "tcp",
    browserScheme: "http",
    bindAddresses: [],
    preferredHostPort: null,
    currentAttemptId: SessionProcessId.make(attemptId),
    currentForwardId: null,
    attemptHistoryComplete: true,
    forwardHistoryComplete: true,
    observationHistoryComplete: true,
    createdAt: at,
    updatedAt: at,
  });
  const attempt = new SessionProcess({
    id: SessionProcessId.make(attemptId),
    serviceId: service.id,
    sessionId: service.sessionId,
    sealantWorkspaceId: WORKSPACE,
    sealantSessionId: null,
    sealantRunId: null,
    launchCorrelationId: null,
    attemptOrdinal: 2,
    kind: "service",
    harness: null,
    providerSessionId: null,
    protocolOptions: null,
    label: "web",
    argv: ["pnpm", "dev"],
    status: "starting",
    exitCode: null,
    workspacePort: APP_PORT,
    protocol: "tcp",
    hostPort: null,
    createdAt: at,
    updatedAt: at,
    exitedAt: null,
  });
  return previewGatewayResolution(
    { _tag: "Automatic", revision },
    { _tag: "Bound", service, attempt },
    [],
  );
};

export const dormant = (revision = 0): PreviewGatewayResolution => ({
  _tag: "Dormant",
  revision,
  source: {
    serviceId: ServiceId.make("svc-web"),
    sourceAttemptId: SessionProcessId.make("attempt-0"),
  },
  workspaceId: WORKSPACE,
});

export interface GatewayWorldOptions {
  readonly routing?: keyof typeof ROUTINGS;
  readonly forwards: Layer.Layer<ForwardAdapter>;
  readonly targets?: Layer.Layer<PreviewTargets>;
  readonly settings?: Partial<Omit<PreviewGatewaySettings, "bind" | "port" | "trustedProxies">> & {
    readonly trustedProxies?: ReadonlyArray<string>;
  };
  readonly budgets?: Partial<BudgetLimits>;
}

const noGate = (): Deferred.Deferred<void> | null => null;

export const freePort = async (): Promise<number> => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
};

const platformRefusal = () =>
  new SealantPlatformError({
    code: "creator_no_access",
    status: 403,
    message: "the person who started this workspace is no longer a member",
    cause: null,
  });

export const gatewayWorld = (options: GatewayWorldOptions) =>
  Effect.gen(function* () {
    const routing: PreviewRouting = ROUTINGS[options.routing ?? "domain"];
    const port = yield* Effect.promise(freePort);
    const grants = new Map<
      string,
      { readonly previewId: string; readonly origin: string; readonly subject: PreviewGrantSubject }
    >();
    const revoked = new Set<string>();
    const standingHeld: { current: Deferred.Deferred<void> | null } = { current: null };
    const members = new Map(MEMBERS.map((member) => [member.userId, member]));
    let minted = 0;

    const originOf = (key: PreviewKey): string => {
      const origin = previewOriginOf(routing, placeOf(key));
      if (origin === null) throw new Error(`the routing addresses ${key}`);
      return origin;
    };
    const hostOf = (key: PreviewKey) => new URL(originOf(key)).host;

    const cookieFor = (userId: string, key: PreviewKey): string => {
      const secret = `mpg_${String(++minted).padStart(43, "0")}`;
      const preview = PREVIEWS[key];
      const origin = previewOriginOf(routing, placeOf(key));
      if (origin === null) throw new Error(`the routing addresses ${key}`);
      grants.set(secret, {
        previewId: preview.id,
        origin,
        subject: { userId, credential: `session:${userId}-${minted}` },
      });
      return `${grantCookieOf(routing, origin).name}=${secret}`;
    };

    const grantsRepo: PreviewGrantsRepo["Service"] = {
      create: ({ subject, previewId, origin }) =>
        Effect.sync(() => {
          const secret = `mpg_${String(++minted).padStart(43, "0")}`;
          grants.set(secret, { previewId, origin, subject });
          return Redacted.make(secret);
        }),
      standing: (keys) =>
        Effect.andThen(
          Effect.suspend(() =>
            standingHeld.current === null ? Effect.void : Deferred.await(standingHeld.current),
          ),
          Effect.sync(
            (): ReadonlyArray<PreviewGrantStanding | null> =>
              keys.map((key) => {
                const found = grants.get(Redacted.value(key.grant));
                if (
                  found === undefined ||
                  found.previewId !== key.previewId ||
                  found.origin !== key.origin ||
                  revoked.has(found.subject.userId)
                ) {
                  return null;
                }
                const member = members.get(found.subject.userId);
                return {
                  subject: found.subject,
                  previewKept: true,
                  membership:
                    member === undefined
                      ? null
                      : { organizationId: member.organizationId, role: member.role },
                  project: { organizationId: ORG, visibility: "shared", createdByUserId: "alice" },
                };
              }),
          ),
        ),
      cleanup: () => Effect.succeed(0),
    };

    const byId = (id: string): Preview | null =>
      Object.values(PREVIEWS).find((preview) => preview.id === id) ?? null;
    const previewsRepo: PreviewsRepo["Service"] = {
      ensureForWorktree: () => Effect.die("unused"),
      ensureNamed: () => Effect.die("unused"),
      resolveByLabel: () => Effect.die("unused"),
      byLabel: (label) =>
        Effect.succeed(Object.values(PREVIEWS).find((preview) => preview.label === label) ?? null),
      byId: (id) => Effect.succeed(byId(id)),
      controlOf: () => Effect.die("unused"),
      changeControl: () => Effect.die("unused"),
      nextControlSeq: () => Effect.die("unused"),
      previewOfService: () => Effect.die("unused"),
      gatewaySnapshot: () => Effect.die("unused"),
      gatewaySnapshots: () => Effect.die("unused"),
      assignTailnetPort: (id) => {
        const key = keyOf(id);
        return Effect.succeed(
          key === undefined ? { _tag: "Removed" } : { _tag: "Assigned", port: TAILNET_PORTS[key] },
        );
      },
      tailnetPorts: (ids) =>
        Effect.succeed(
          new Map(
            ids.flatMap((id): Array<[PreviewId, number]> => {
              const key = keyOf(id);
              return key === undefined ? [] : [[id, TAILNET_PORTS[key]]];
            }),
          ),
        ),
      byTailnetPort: (held) => {
        const key = PREVIEW_KEYS.find((candidate) => TAILNET_PORTS[candidate] === held);
        return Effect.succeed(
          key === undefined ? null : { preview: PREVIEWS[key], renewDue: false },
        );
      },
      renewTailnetPort: () => Effect.succeed("Renewed"),
      touchTailnetPorts: () => Effect.void,
      tailnetPortReused: () => Effect.succeed(false),
    };

    const access = Layer.mock(ProjectAccess, {
      projectAs: (userId, id) =>
        Effect.suspend(() => {
          const viewer = members.get(userId);
          const row = makeProject({
            id: PROJECT,
            organizationId: ORG,
            visibility: "shared",
            createdByUserId: "alice",
            storePath: "/store/p-shared",
          });
          return viewer !== undefined && id === PROJECT && canSeeProject(row, viewer)
            ? Effect.succeed(row)
            : Effect.fail(new NotFound({ id }));
        }),
    });

    const targets = {
      resolutions: new Map<string, PreviewGatewayResolution | null>([
        [PREVIEWS.web.id, bound()],
        [PREVIEWS.docs.id, bound({ serviceId: ServiceId.make("svc-docs") })],
      ]),
      starts: new Array<PreviewStartRequest>(),
      failReads: false,
      beforeClaim: noGate(),
      launches: new Array<PreviewStartRequest>(),
      snapshotReads: 0,
      batchReads: new Array<ReadonlyArray<string>>(),
      ensureRunning: (
        _request: PreviewStartRequest,
      ): Effect.Effect<SessionProcessId, PreviewStartFailed> => Effect.die("no start expected"),
    };
    const targetsLayer = Layer.succeed(PreviewTargets, {
      snapshot: (id) =>
        Effect.suspend(() => {
          targets.snapshotReads += 1;
          return targets.failReads
            ? Effect.die("the database did not answer")
            : Effect.succeed(targets.resolutions.get(id) ?? null);
        }),
      snapshots: (ids) =>
        Effect.suspend(() => {
          targets.batchReads.push(ids);
          if (targets.failReads) return Effect.die("the database did not answer");
          const read = new Map<PreviewId, PreviewGatewayResolution>();
          for (const id of ids) {
            const resolution = targets.resolutions.get(id) ?? null;
            if (resolution !== null) read.set(id, resolution);
          }
          return Effect.succeed(read);
        }),
      ensureRunning: (request, claim) =>
        Effect.suspend(() => {
          targets.starts.push(request);
          return Effect.scoped(
            Effect.andThen(
              Effect.andThen(
                Effect.suspend(() =>
                  targets.beforeClaim === null ? Effect.void : Deferred.await(targets.beforeClaim),
                ),
                claim,
              ),
              Effect.suspend(() => {
                targets.launches.push(request);
                return targets.ensureRunning(request);
              }),
            ),
          );
        }),
    });

    const lending = { askers: new Array<string>(), refused: new Set<string>() };
    const callerLayer = Layer.mock(WorkspaceCaller, {
      observe: () => (self) => self,
      act: () => (self) => self,
      observeRun: () => (self) => self,
      observeRunStream: () => (self) => self,
      mayAct: () =>
        Effect.gen(function* () {
          const principal = yield* SealantPrincipal;
          const asker = principal.kind === "user" ? principal.userId : "none";
          lending.askers.push(asker);
          if (asker === "none" || lending.refused.has(asker)) return yield* platformRefusal();
        }),
    });

    const connections = yield* makeConnectionRegistry;
    const pubsub = yield* PubSub.unbounded<BusSignal>();
    const bus = Layer.succeed(EventBus, { subscribe: PubSub.subscribe(pubsub) });
    const config = Layer.succeed(PreviewConfig, { appUrl: "https://mend.test", routing });
    const identity = makePreviewIdentityLayer(PREVIEW_TIMING).pipe(
      Layer.provide(
        Layer.mergeAll(
          config,
          Layer.succeed(PreviewGrantsRepo, grantsRepo),
          Layer.succeed(PreviewsRepo, previewsRepo),
          Layer.succeed(
            UpgradeTicketsRepo,
            makeUpgradeTicketsMemory(() => 0, new Set()),
          ),
          bus,
          access,
        ),
      ),
    );
    const budgets = makeBudgets({ ...DEFAULT_BUDGET_LIMITS, ...options.budgets });
    const settings: PreviewGatewaySettings = {
      bind: "127.0.0.1",
      port,
      trustedProxies: [],
      ...PREVIEW_GATEWAY_DEFAULTS,
      ...options.settings,
    };
    yield* Layer.build(
      makePreviewGatewayLayer(settings).pipe(
        Layer.provide(
          Layer.mergeAll(
            identity,
            config,
            options.targets ?? targetsLayer,
            callerLayer,
            options.forwards,
            bus,
            Layer.succeed(Budgets, budgets),
            Layer.succeed(ConnectionRegistry, connections),
          ),
        ),
      ),
    );

    return {
      port,
      settings,
      originOf,
      hostOf,
      cookieFor,
      targets,
      lending,
      connections,
      budgets,
      standingHeld,
      revokeGrants: (userId: string) => revoked.add(userId),
      publish: (signal: BusSignal) => PubSub.publish(pubsub, signal),
    };
  });

export type GatewayWorld = Effect.Success<ReturnType<typeof gatewayWorld>>;

export interface Reply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawHeaders: ReadonlyArray<string>;
  readonly body: string;
}

export interface SendOptions {
  readonly host: string;
  readonly path?: string;
  readonly method?: string;
  readonly headers?: Record<string, string | ReadonlyArray<string>>;
  readonly body?: string | Buffer;
  readonly agent?: http.Agent | false;
}

export const send = (port: number, options: SendOptions): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: "127.0.0.1",
      port,
      path: options.path ?? "/",
      method: options.method ?? "GET",
      headers: { host: options.host, ...options.headers },
      agent: options.agent ?? false,
    });
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      const parts: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => parts.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          body: Buffer.concat(parts).toString("utf8"),
        }),
      );
    });
    outgoing.end(options.body);
  });

export const rawExchange = (port: number, text: string, waitMs = 2_000): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const parts: Array<Buffer> = [];
    const done = () => resolve(Buffer.concat(parts).toString("latin1"));
    const timer = setTimeout(() => {
      socket.destroy();
      done();
    }, waitMs);
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      clearTimeout(timer);
      done();
    });
    socket.write(text);
  });

export const watchGatewayRequests = (port: number) => {
  const seen: Array<{ readonly path: string; readonly socket: net.Socket }> = [];
  const onStart = (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if (!("request" in message && "socket" in message && "server" in message)) return;
    const { request, socket, server } = message;
    if (!(request instanceof http.IncomingMessage) || !(socket instanceof net.Socket)) return;
    if (!(server instanceof http.Server)) return;
    const address = server.address();
    if (address === null || typeof address === "string" || address.port !== port) return;
    seen.push({ path: request.url ?? "", socket });
  };
  subscribe("http.server.request.start", onStart);
  return { seen, stop: () => unsubscribe("http.server.request.start", onStart) };
};
