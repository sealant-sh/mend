import { Auth } from "@mend/auth";
import {
  BriefCommentsRepo,
  BriefsRepo,
  ChangesRepo,
  IssuesRepo,
  PushDevicesRepo,
  RunsRepo,
} from "@mend/db";
import type { RunId } from "@mend/domain";
import { JobRunner } from "@mend/jobs";
import {
  asFirstSealantUser,
  SealantClient,
  SealantClients,
  SealantIdentity,
  SealantPlatformError,
  SealantPrincipal,
} from "@mend/sealant";
import { DeploymentConfig, StoreConfig } from "@mend/store";
import { Config, Effect, Layer, Option, Stream } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  AuthMiddleware,
  BriefDetail,
  AccountRejected,
  CurrentUser,
  SealantUnavailable,
  HealthStatus,
  IssueDetail,
  LossReportView,
  LossSpanView,
  MendApi,
  NotFound,
  RegisteredDevice,
  RunCommandView,
  RunDetail,
  RunSourceView,
  TraceEntryView,
  TracePage,
  Unauthorized,
} from "./contract.ts";
import { DevicePairingLive } from "./devices.ts";
import { GithubGroupLive } from "./github.ts";
import { MachineGroupLive } from "./machine.ts";
import {
  DotfilesGroupLive,
  GitKeysGroupLive,
  ProjectEnvironmentGroupLive,
  ProjectMountsGroupLive,
  ProjectSecretsGroupLive,
  ProjectRecipesGroupLive,
  ProjectsGroupLive,
  ReferencesGroupLive,
  SessionChangesGroupLive,
  SessionsGroupLive,
  SettingsGroupLive,
} from "./workbench.ts";

/** Resolves the better-auth session (cookie or bearer) and provides CurrentUser. */
export const AuthMiddlewareLive = Layer.effect(AuthMiddleware)(
  Effect.gen(function* () {
    const auth = yield* Auth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const headers = new Headers(Object.entries(request.headers));
        const session = yield* auth.getSession(headers);
        if (Option.isNone(session)) return yield* Effect.fail(new Unauthorized());
        // The request's platform principal is the caller; session-scoped handlers re-bind to
        // the session owner underneath (docs/SEALANT-IDENTITY.md).
        return yield* httpEffect.pipe(
          Effect.provideService(CurrentUser, session.value),
          Effect.provideService(SealantPrincipal, { kind: "user", userId: session.value.user.id }),
        );
      });
  }),
);

export const HealthGroupLive = HttpApiBuilder.group(MendApi, "health", (handlers) =>
  handlers.handle("status", () =>
    Effect.gen(function* () {
      const version = yield* Config.string("MEND_VERSION").pipe(
        Config.orElse(() => Config.succeed("dev")),
        Effect.orDie,
      );
      const deployment = yield* DeploymentConfig;
      const store = yield* StoreConfig;
      return new HealthStatus({
        status: "ok",
        version,
        deploymentMode: deployment.mode,
        storeRoot: store.root,
        sessionChannel:
          deployment.sessionEndpoint === undefined
            ? { mode: "unix-socket", endpoint: null }
            : { mode: "network", endpoint: deployment.sessionEndpoint.url },
      });
    }),
  ),
);

export const SealantGroupLive = HttpApiBuilder.group(MendApi, "sealant", (handlers) =>
  handlers.handle("connection", () =>
    Effect.gen(function* () {
      const sealant = yield* SealantClient;
      return yield* sealant.connectionCheck();
    }),
  ),
);

/** A platform failure as the accounts endpoints report it: the provider's own words for 4xx. */
const accountFailure = (error: SealantPlatformError) =>
  error.status !== null && error.status >= 400 && error.status < 500
    ? new AccountRejected({ message: error.message })
    : new SealantUnavailable({ code: error.code, message: error.message });

export const AccountsGroupLive = HttpApiBuilder.group(MendApi, "accounts", (handlers) =>
  handlers
    .handle("identity", () =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        const sealantUserId = yield* clients.sealantUserId(caller.user.id);
        const accounts = yield* clients.connectedAccounts(caller.user.id).list();
        return new SealantIdentity({ sealantUserId, accounts });
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.fail(new SealantUnavailable({ code: error.code, message: error.message })),
        ),
      ),
    )
    .handle("connect", ({ payload }) =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        return yield* clients.connectedAccounts(caller.user.id).connect(payload);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => Effect.fail(accountFailure(error))),
      ),
    )
    .handle("disconnect", ({ params }) =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        return yield* clients.connectedAccounts(caller.user.id).disconnect(params.id);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) => Effect.fail(accountFailure(error))),
      ),
    ),
);

export const IssuesGroupLive = HttpApiBuilder.group(MendApi, "issues", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const issues = yield* IssuesRepo;
        return yield* issues.list();
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const issues = yield* IssuesRepo;
        return yield* issues.create(payload);
      }),
    )
    .handle("detail", ({ params }) =>
      Effect.gen(function* () {
        const issues = yield* IssuesRepo;
        const runs = yield* RunsRepo;
        const issue = yield* issues
          .byId(params.id)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
        const issueRuns = yield* runs.listForIssue(params.id);
        return new IssueDetail({ issue, runs: issueRuns });
      }),
    )
    .handle("move", ({ params, payload }) =>
      Effect.gen(function* () {
        const issues = yield* IssuesRepo;
        return yield* issues
          .move(params.id, payload)
          .pipe(Effect.mapError(() => new NotFound({ id: params.id })));
      }),
    ),
);

/** issue → change → brief, or 404 — the spine of every brief endpoint. */
const briefOfIssue = (id: (typeof IssueDetail.Type)["issue"]["id"]) =>
  Effect.gen(function* () {
    const changes = yield* ChangesRepo;
    const briefs = yield* BriefsRepo;
    const change = yield* changes.byIssue(id).pipe(Effect.mapError(() => new NotFound({ id })));
    const brief = yield* briefs
      .byChange(change.id)
      .pipe(Effect.mapError(() => new NotFound({ id })));
    return { brief, change };
  });

export const BriefsGroupLive = HttpApiBuilder.group(MendApi, "briefs", (handlers) =>
  handlers
    .handle("byIssue", ({ params }) =>
      Effect.gen(function* () {
        const { brief, change } = yield* briefOfIssue(params.id);
        return new BriefDetail({ brief, change });
      }),
    )
    .handle("comments", ({ params }) =>
      Effect.gen(function* () {
        const comments = yield* BriefCommentsRepo;
        const { brief } = yield* briefOfIssue(params.id);
        return yield* comments.listForBrief(brief.id);
      }),
    )
    .handle("comment", ({ params, payload }) =>
      Effect.gen(function* () {
        const comments = yield* BriefCommentsRepo;
        const jobs = yield* JobRunner;
        const session = yield* CurrentUser;
        const { brief, change } = yield* briefOfIssue(params.id);

        const comment = yield* comments.create({
          briefId: brief.id,
          thread: payload.thread,
          authorKind: "reviewer",
          authorName: session.user.name === "" ? session.user.email : session.user.name,
          body: payload.body,
        });

        // Mend reads the comment and decides the next action — asynchronously,
        // exactly once per comment.
        yield* jobs
          .enqueue({
            name: "route-comment",
            payload: { commentId: comment.id, changeId: change.id, issueId: params.id },
            idempotencyKey: `route:${comment.id}`,
          })
          .pipe(Effect.orDie);

        return comment;
      }),
    )
    .handle("versions", ({ params }) =>
      Effect.gen(function* () {
        const briefs = yield* BriefsRepo;
        const { change } = yield* briefOfIssue(params.id);
        return yield* briefs.versions(change.id);
      }),
    ),
);

/** One trace page — big enough to read a phase, small enough to stay snappy. */
const TRACE_PAGE_SIZE = 200;

/** The record's source-trail kinds (typed taxonomy, SDK 0.5.0). */
const SOURCE_KINDS = new Set(["networkRequest", "networkSourceObserved"]);

/** Sources are aggregated over at most this many events — reported, not silent. */
const SOURCE_SCAN_LIMIT = 20_000;

/** The run's SDK handle, or NotFound — shared by every audit endpoint. */
// Legacy issue runs (the retired queue) were started as the operator; read them as the operator.
const openRecord = (id: RunId) =>
  Effect.gen(function* () {
    const runs = yield* RunsRepo;
    const sealant = yield* SealantClient;
    const run = yield* runs.byId(id).pipe(Effect.mapError(() => new NotFound({ id })));
    if (run.sealantRunId === null) return { run, sdkRun: null };
    const sdkRun = yield* sealant
      .getRun(run.sealantRunId)
      .pipe(Effect.mapError(() => new NotFound({ id })));
    return { run, sdkRun };
  });

export const RunsGroupLive = HttpApiBuilder.group(MendApi, "runs", (handlers) =>
  handlers
    .handle("detail", ({ params }) =>
      asFirstSealantUser(
        Effect.gen(function* () {
          const runs = yield* RunsRepo;
          const sealant = yield* SealantClient;
          const run = yield* runs
            .byId(params.id)
            .pipe(Effect.mapError(() => new NotFound({ id: params.id })));

          if (run.sealantRunId === null) {
            return new RunDetail({
              run,
              commands: [],
              transcript: null,
              loss: null,
              recordError: null,
            });
          }

          // The SDK read surface backs the view; a read failure is shown, not hidden.
          const record = yield* sealant.getRun(run.sealantRunId).pipe(
            Effect.flatMap((sdkRun) =>
              Effect.all({
                commands: Effect.tryPromise({
                  try: () => sdkRun.record.commands(),
                  catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
                }),
                transcript: Effect.tryPromise({
                  try: () => sdkRun.record.transcript(),
                  catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
                }),
                loss: Effect.tryPromise({
                  try: () => sdkRun.record.loss(),
                  catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
                }),
              }),
            ),
            Effect.mapError((error) => (typeof error === "string" ? error : error.message)),
            Effect.map(({ commands, transcript, loss }) => ({
              commands: commands.map(
                (command) =>
                  new RunCommandView({
                    command: command.command,
                    exitCode: command.exitCode ?? null,
                    durationMs: command.durationMs ?? null,
                  }),
              ),
              transcript,
              loss: new LossReportView({
                complete: loss.complete,
                spans: loss.spans.map(
                  (span) =>
                    new LossSpanView({
                      fromSequence:
                        span.fromSequence === undefined ? null : String(span.fromSequence),
                      toSequence: span.toSequence === undefined ? null : String(span.toSequence),
                    }),
                ),
              }) as LossReportView | null,
              recordError: null as string | null,
            })),
            Effect.catch((message) =>
              Effect.succeed({
                commands: [] as ReadonlyArray<RunCommandView>,
                transcript: null as string | null,
                loss: null as LossReportView | null,
                recordError: message,
              }),
            ),
          );

          return new RunDetail({ run, ...record });
        }),
      ),
    )
    .handle("trace", ({ params, query }) =>
      asFirstSealantUser(
        Effect.gen(function* () {
          const sealant = yield* SealantClient;
          const { sdkRun } = yield* openRecord(params.id);
          if (sdkRun === null) return new TracePage({ entries: [], nextFrom: null });

          const from = query.from === undefined ? 0n : BigInt(query.from);
          const entries = yield* sealant.recordTimeline(sdkRun, { from }).pipe(
            Stream.take(TRACE_PAGE_SIZE + 1),
            Stream.runCollect,
            Effect.mapError(() => new NotFound({ id: params.id })),
          );

          const page = entries.slice(0, TRACE_PAGE_SIZE);
          const overflow = entries[TRACE_PAGE_SIZE];
          return new TracePage({
            entries: page.map(
              (entry) =>
                new TraceEntryView({
                  sequence: String(entry.sequence),
                  occurredAt: entry.occurredAt,
                  kind: entry.kind,
                  summary: entry.summary,
                  processId: entry.processId ?? null,
                }),
            ),
            nextFrom: overflow === undefined ? null : String(overflow.sequence),
          });
        }),
      ),
    )
    .handle("sources", ({ params }) =>
      asFirstSealantUser(
        Effect.gen(function* () {
          const sealant = yield* SealantClient;
          const { sdkRun } = yield* openRecord(params.id);
          if (sdkRun === null) return [];

          const events = yield* sealant.recordTimeline(sdkRun).pipe(
            Stream.take(SOURCE_SCAN_LIMIT),
            Stream.filter((entry) => SOURCE_KINDS.has(entry.kind)),
            Stream.runCollect,
            Effect.mapError(() => new NotFound({ id: params.id })),
          );

          const sources = new Map<
            string,
            {
              host: string;
              method: string | null;
              path: string | null;
              status: number | null;
              count: number;
              firstSequence: bigint;
            }
          >();
          for (const entry of events) {
            if (entry.kind !== "networkRequest" && entry.kind !== "networkSourceObserved") continue;
            const data = entry.data;
            const method = data.method ?? null;
            const path = data.path ?? null;
            const status = data.status ?? null;
            const key = `${data.host} ${method ?? ""} ${path ?? ""} ${status ?? ""}`;
            const existing = sources.get(key);
            if (existing === undefined) {
              sources.set(key, {
                host: data.host,
                method,
                path,
                status,
                count: 1,
                firstSequence: entry.sequence,
              });
            } else {
              existing.count += 1;
            }
          }

          return [...sources.values()]
            .toSorted((a, b) => (a.firstSequence < b.firstSequence ? -1 : 1))
            .map(
              (source) =>
                new RunSourceView({
                  host: source.host,
                  method: source.method,
                  path: source.path,
                  status: source.status,
                  count: source.count,
                  firstSequence: String(source.firstSequence),
                }),
            );
        }),
      ),
    ),
);

export const DevicesGroupLive = HttpApiBuilder.group(MendApi, "devices", (handlers) =>
  handlers
    .handle("register", ({ payload }) =>
      Effect.gen(function* () {
        const devices = yield* PushDevicesRepo;
        const device = yield* devices.register(payload.token, payload.platform);
        return new RegisteredDevice({ token: device.token, platform: device.platform });
      }),
    )
    .handle("unregister", ({ params }) =>
      Effect.gen(function* () {
        const devices = yield* PushDevicesRepo;
        yield* devices.remove(params.token);
      }),
    ),
);

/** Every group implementation plus the API registration, ready for the boundary. */
export const MendApiLive = HttpApiBuilder.layer(MendApi).pipe(
  // `pipe` takes at most twenty steps; the identity groups ride one merged layer.
  Layer.provide(
    Layer.mergeAll(HealthGroupLive, MachineGroupLive, SealantGroupLive, AccountsGroupLive),
  ),
  Layer.provide(SettingsGroupLive),
  Layer.provide(DotfilesGroupLive),
  Layer.provide(IssuesGroupLive),
  Layer.provide(BriefsGroupLive),
  Layer.provide(RunsGroupLive),
  Layer.provide(ProjectsGroupLive),
  Layer.provide(GitKeysGroupLive),
  Layer.provide(ProjectEnvironmentGroupLive),
  Layer.provide(ProjectSecretsGroupLive),
  Layer.provide(ProjectMountsGroupLive),
  Layer.provide(ProjectRecipesGroupLive),
  Layer.provide(ReferencesGroupLive),
  Layer.provide(SessionsGroupLive),
  Layer.provide(SessionChangesGroupLive),
  Layer.provide(GithubGroupLive),
  Layer.provide(DevicesGroupLive),
  Layer.provide(DevicePairingLive),
  Layer.provide(AuthMiddlewareLive),
);
