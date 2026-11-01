import { NodeCrypto } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  ChangeLandingsRepoLive,
  ChangePassesRepoLive,
  ChangeToursRepoLive,
  MendDBLive,
  migrations,
  notifyEvent,
  openEvents,
  type PreviewPreparationClaim,
  PreviewPreparationsRepo,
  PreviewPreparationsRepoLive,
  PreviewsRepo,
  PreviewsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  ReviewCommentsRepoLive,
  ServiceObservationsRepo,
  ServiceObservationsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  SlackInstallsRepo,
  SlackInstallsRepoLive,
  SlackThreadsRepo,
  SlackThreadsRepoLive,
  SlackProofDeliveriesRepoLive,
  WorktreeChangesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  AgentTurnId,
  OrganizationId,
  PreviewId,
  ProjectId,
  ServiceForwardId,
  ServiceId,
  SessionId,
  WorktreeId,
} from "@mend/domain";
import { SlackReportsLive } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { ResourceStatusReadsNone } from "@mend/sessions";
import { WorktreeReads } from "@mend/sessions";
import { makeFakeSlack, type FakeSlackCall } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import {
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  Scope,
  Stream,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { EventBus, EventBusLive, makeEventBus } from "./events-bus.ts";
import { PreviewSetupConfig } from "./preview-config.ts";
import { PREVIEW_GATEWAY_DEFAULTS } from "./preview-gateway-settings.ts";
import { SlackPreviewReadsLive } from "./preview-reads.ts";
import { SlackReportEventsLive } from "./slack-report-events.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_slack_previews_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );

const APP_URL = "https://app.mend.test";
const ORG = OrganizationId.make("org-slack");
const PROJECT = ProjectId.make("p-billing");
const WORKTREE = WorktreeId.make("wt-billing");
const OTHER_WORKTREE = WorktreeId.make("wt-other");
const SERVICE_SESSION = SessionId.make("s-service");
const SERVICE = ServiceId.make("svc-web");
/** Two sessions in one worktree, each started from its own Slack thread. */
const THREADS = [
  {
    sessionId: SessionId.make("s-thread-a"),
    threadTs: "1700000100.000100",
    statusTs: "1700000100.000200",
  },
  {
    sessionId: SessionId.make("s-thread-b"),
    threadTs: "1700000200.000100",
    statusTs: "1700000200.000200",
  },
] as const;
const ELSEWHERE = {
  sessionId: SessionId.make("s-elsewhere"),
  threadTs: "1700000300.000100",
  statusTs: "1700000300.000200",
} as const;

const slack = makeFakeSlack([
  {
    teamId: "T-acme",
    teamName: "Acme",
    appId: "A-acme",
    botId: "B-acme",
    botUserId: "U-bot",
    botToken: "xoxb-acme",
    appToken: "xapp-acme",
  },
]);

const pg = PgClient.layer({
  url: Redacted.make(scratchUrl),
  transformResultNames: Str.snakeToCamel,
  maxConnections: 6,
});
const database = MendDBLive.pipe(Layer.provideMerge(pg));
const repos = Layer.mergeAll(
  AgentConversationRepoLive,
  ChangeLandingsRepoLive,
  ChangePassesRepoLive,
  ChangeToursRepoLive,
  PreviewPreparationsRepoLive,
  PreviewsRepoLive.pipe(Layer.provide(NodeCrypto.layer)),
  ProjectsRepoLive,
  ReviewCommentsRepoLive,
  ServiceObservationsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  SlackInstallsRepoLive,
  SlackThreadsRepoLive,
  SlackProofDeliveriesRepoLive,
  WorktreeChangesRepoLive,
).pipe(Layer.provideMerge(database));
const outside = Layer.mergeAll(
  slack.layer,
  Layer.succeed(SecretCipher, {
    encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
    decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/u, "")),
  }),
  Layer.mock(WorktreeReads, {}),
  Layer.succeed(PreviewSetupConfig, {
    setup: {
      _tag: "On",
      routing: { mode: "domain-https", domain: "preview.test", port: 443 },
      gateway: { bind: "127.0.0.1", port: 443, ...PREVIEW_GATEWAY_DEFAULTS },
    },
  }),
  Layer.succeed(
    NetworkConfig,
    makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(APP_URL), []),
  ),
);
/** The worker's half as main.ts composes it: the bus, the reporter, Slack's preview read. */
const worker = SlackReportEventsLive.pipe(
  Layer.provide(EventBusLive),
  Layer.provide(
    SlackReportsLive.pipe(
      Layer.provide(ResourceStatusReadsNone),
      Layer.provide(SlackPreviewReadsLive),
    ),
  ),
);
const runtime = ManagedRuntime.make(repos.pipe(Layer.provideMerge(outside)));
const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof repos> | SqlClient.SqlClient>,
) => runtime.runPromise(effect);

const editsOf = (statusTs: string) =>
  slack.calls.flatMap((call: FakeSlackCall) =>
    call.kind === "update" && call.input.ts === statusTs ? [call.input] : [],
  );
const linesOf = (statusTs: string) =>
  editsOf(statusTs).map((edit) => edit.text.split("\n").slice(1));
const opensOf = (statusTs: string) =>
  editsOf(statusTs).map((edit) =>
    [...JSON.stringify(edit.blocks).matchAll(/"url":"([^"]*preview-auth[^"]*)"/gu)].map(
      ([, url]) => url,
    ),
  );

const gapLine = (state: string) =>
  `billing-api · named in the request · claude · ${state} · mend/wt-gap`;

let turns = 0;
/** A turn of a thread session ended, and preparation claimed it, as the preparation job does. */
const claimTurn = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    turns += 1;
    const id = AgentTurnId.make(`turn-${turns}`);
    yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
      VALUES (${id}, ${sessionId}, ${`agent-${sessionId}`}, ${turns}, 'fix it', 'completed', now())`;
    const claim = yield* (yield* PreviewPreparationsRepo).claim(id, 60_000);
    if (claim === null) return yield* Effect.die("the turn was not claimed");
    return claim;
  });

describe.skipIf(postgres.skip)("Slack previews, from Postgres to the thread", () => {
  let previewId = PreviewId.make("unallocated");
  let preparation: PreviewPreparationClaim;
  let stopWorker: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    await admin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
          VALUES ('maria', 'Maria', 'maria@example.com', now())`;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG}, 'Acme')`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (${ORG}, 'maria', 'owner')`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
            visibility, created_by_user_id)
          VALUES (${PROJECT}, 'billing-api', '/store/p-billing', 'main', ${ORG}, 'shared', 'maria')`;
        for (const worktree of [WORKTREE, OTHER_WORKTREE]) {
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
            VALUES (${worktree}, ${PROJECT}, ${worktree}, ${worktree}, ${`mend/${worktree}`}, 'abc')`;
        }
        const session = (id: SessionId, worktree: WorktreeId, status: string) =>
          sql`INSERT INTO agent_sessions (id, project_id, worktree_id, owner_user_id, harness,
              worktree, branch, base_sha, status, origin)
            VALUES (${id}, ${PROJECT}, ${worktree}, 'maria', 'claude', ${worktree},
              ${`mend/${worktree}`}, 'abc', ${status}, 'slack')`;
        for (const { sessionId } of THREADS) yield* session(sessionId, WORKTREE, "completed");
        yield* session(ELSEWHERE.sessionId, OTHER_WORKTREE, "completed");
        // The Service runs in a sibling session of the worktree that has no thread.
        yield* session(SERVICE_SESSION, WORKTREE, "running");
        for (const id of [...THREADS.map((t) => t.sessionId), ELSEWHERE.sessionId]) {
          yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, status)
            VALUES (${`agent-${id}`}, ${id}, 'ws-1', 'agent-protocol', 'exited')`;
        }
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port,
            browser_scheme)
          VALUES (${SERVICE}, ${SERVICE_SESSION}, 'web', 'explicit-run', 5173, 'http')`;

        const installs = yield* SlackInstallsRepo;
        yield* installs.save({
          organizationId: ORG,
          teamId: "T-acme",
          teamName: "Acme",
          botUserId: "U-bot",
          appId: "A-acme",
          sealedAppToken: "sealed:xapp-acme",
          sealedBotToken: "sealed:xoxb-acme",
          webOrigin: "https://web.mend.test",
          installedByUserId: "maria",
        });
        const threads = yield* SlackThreadsRepo;
        for (const thread of [...THREADS, ELSEWHERE]) {
          yield* threads.record({
            sessionId: thread.sessionId,
            teamId: "T-acme",
            channelId: "C-general",
            threadTs: thread.threadTs,
            requestTs: thread.threadTs,
            slackUserId: "U-maria",
            projectSource: "message",
            external: false,
          });
          // A line an earlier release wrote: the first look compares it by its text.
          yield* sql`UPDATE slack_threads SET status_ts = ${thread.statusTs},
              reported_state = 'completed', reported_status = 'billing-api · named in the request'
            WHERE session_id = ${thread.sessionId}`;
        }
        // The worktree's preview, allocated as the web's first read allocates it.
        const [view] = yield* (yield* PreviewsRepo).ensureForWorktree(WORKTREE);
        if (view === undefined) return yield* Effect.die("no preview was allocated");
        previewId = view.preview.id;
      }),
    );
    const opened = await runtime.runPromise(Scope.make());
    await runtime.runPromise(Layer.buildWithScope(worker, opened));
    stopWorker = () => runtime.runPromise(Scope.close(opened, Exit.void));
    // The bus's LISTEN connects after the layer is built; a write before it would never be heard.
    await vi.waitFor(
      async () =>
        expect(
          await run(
            Effect.flatMap(
              SqlClient.SqlClient,
              (sql) =>
                sql<{ readonly listening: boolean }>`SELECT EXISTS (
                  SELECT 1 FROM pg_stat_activity
                  WHERE datname = current_database() AND query ILIKE 'LISTEN %'
                ) AS listening`,
            ),
          ),
        ).toEqual([{ listening: true }]),
      { timeout: 30_000 },
    );
  }, 120_000);

  afterAll(async () => {
    await stopWorker?.();
    await runtime.dispose();
    await admin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`,
        );
      }),
    );
  });

  it("keeps preview facts out of both status messages and releases the current Open with the turn", async () => {
    const both = (lines: ReadonlyArray<string>) => {
      for (const { statusTs } of THREADS) expect(linesOf(statusTs).at(-1)).toEqual(lines);
    };
    const open = `${APP_URL}/preview-auth?preview=${previewId}&path=%2F`;
    const pendingOpen = () =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{
              readonly context: { readonly previewUrl: string | null };
            }>`SELECT context FROM slack_proof_turns WHERE turn_id = ${preparation.turnId}`,
        ),
      );

    preparation = await run(claimTurn(THREADS[0].sessionId));
    await run(
      Effect.flatMap(PreviewPreparationsRepo, (repo) =>
        repo.progress(preparation, {
          service: "web",
          previewId: null,
          startId: `preview-turn:${preparation.turnId}`,
          phase: "setup",
          note: null,
        }),
      ),
    );
    await vi.waitFor(() => both([]), { timeout: 20_000 });

    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id,
              sealant_session_id, kind, status, service_id, attempt_ordinal, argv)
            VALUES ('att-web', ${SERVICE_SESSION}, 'ws-1', 'pty-web', 'service', 'running',
              ${SERVICE}, 1, '["npm", "run", "dev"]'::jsonb)`;
        yield* sql`UPDATE services SET current_attempt_id = 'att-web' WHERE id = ${SERVICE}`;
        yield* sql`INSERT INTO service_forwards (id, service_id, sealant_workspace_id, state)
            VALUES ('fwd-web', ${SERVICE}, 'ws-1', 'active')`;
        yield* (yield* PreviewPreparationsRepo).decide(preparation, {
          _tag: "Started",
          service: "web",
          previewId: null,
          note: null,
        });
        yield* (yield* ServiceObservationsRepo).record({
          serviceId: SERVICE,
          forwardId: ServiceForwardId.make("fwd-web"),
          state: "reachable",
          source: "probe",
          httpStatus: 200,
        });
      }),
    );
    await vi.waitFor(async () => expect((await pendingOpen())[0]?.context.previewUrl).toBe(open), {
      timeout: 30_000,
    });
    const answeredEdits = THREADS.map(({ statusTs }) => editsOf(statusTs).length);

    for (let check = 0; check < 6; check++) {
      await run(
        Effect.flatMap(ServiceObservationsRepo, (observations) =>
          observations.record({
            serviceId: SERVICE,
            forwardId: ServiceForwardId.make("fwd-web"),
            state: "reachable",
            source: "probe",
            httpStatus: 200,
          }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(THREADS.map(({ statusTs }) => editsOf(statusTs).length)).toEqual(answeredEdits);

    await run(
      Effect.gen(function* () {
        const previews = yield* PreviewsRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* previews.changeControl(previewId, {
          _tag: "Stop",
          by: "maria",
          at: new Date(),
        });
        yield* sql`UPDATE session_processes SET status = 'exited', exited_at = now()
            WHERE id = 'att-web'`;
        yield* notifyEvent(yield* PgClient.PgClient, {
          type: "session-process",
          sessionId: SERVICE_SESSION,
          projectId: PROJECT,
        });
      }),
    );
    await vi.waitFor(async () => expect((await pendingOpen())[0]?.context.previewUrl).toBeNull(), {
      timeout: 30_000,
    });

    for (const { statusTs } of THREADS) {
      expect(linesOf(statusTs)).toEqual([[]]);
      expect(opensOf(statusTs)).toEqual([[]]);
    }
    expect(JSON.stringify(slack.calls)).not.toMatch(/ticket|preview\.test|__mend/u);
    expect(editsOf(ELSEWHERE.statusTs)).toEqual([]);
  }, 120_000);

  it("brings a thread up to date with what changed while the events connection was down", async () => {
    const GAP = { sessionId: SessionId.make("s-gap"), statusTs: "1700000400.000200" } as const;
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-gap', ${PROJECT}, 'wt-gap', 'wt-gap', 'mend/wt-gap', 'abc')`;
        yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, owner_user_id, harness,
            worktree, branch, base_sha, status, origin)
          VALUES (${GAP.sessionId}, ${PROJECT}, 'wt-gap', 'maria', 'claude', 'wt-gap',
            'mend/wt-gap', 'abc', 'idle', 'slack')`;
        yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, status)
          VALUES ('agent-s-gap', ${GAP.sessionId}, 'ws-1', 'agent-protocol', 'running')`;
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status, ended_at)
          VALUES ('turn-gap-1', ${GAP.sessionId}, 'agent-s-gap', 1, 'fix it', 'completed', now())`;
        yield* (yield* SlackThreadsRepo).record({
          sessionId: GAP.sessionId,
          teamId: "T-acme",
          channelId: "C-general",
          threadTs: "1700000400.000100",
          requestTs: "1700000400.000100",
          slackUserId: "U-maria",
          projectSource: "message",
          external: false,
        });
        yield* sql`UPDATE slack_threads SET status_ts = ${GAP.statusTs},
            reported_state = 'completed', reported_status = 'billing-api · named in the request'
          WHERE session_id = ${GAP.sessionId}`;
      }),
    );
    const lose = Deferred.makeUnsafe<void>();
    const reconnect = Deferred.makeUnsafe<void>();
    let opens = 0;
    const gappedBus = Layer.effect(
      EventBus,
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        return yield* makeEventBus<SqlError | string, never>(
          Effect.gen(function* () {
            opens += 1;
            if (opens === 1) {
              const payloads = yield* openEvents(sql);
              return Stream.merge(
                payloads,
                Stream.fromEffect(Deferred.await(lose)).pipe(
                  Stream.flatMap(() => Stream.fail("connection lost")),
                ),
              );
            }
            yield* Deferred.await(reconnect);
            return yield* openEvents(sql);
          }),
        );
      }),
    );
    const gapped = await runtime.runPromise(Scope.make());
    await runtime.runPromise(
      Layer.buildWithScope(
        SlackReportEventsLive.pipe(
          Layer.provide(gappedBus),
          Layer.provide(
            SlackReportsLive.pipe(
              Layer.provide(ResourceStatusReadsNone),
              Layer.provide(SlackPreviewReadsLive),
            ),
          ),
        ),
        gapped,
      ),
    );
    try {
      await runtime.runPromise(Deferred.succeed(lose, undefined));
      await vi.waitFor(
        () =>
          expect(editsOf(GAP.statusTs).map((edit) => edit.text)).toEqual([gapLine("completed")]),
        { timeout: 20_000 },
      );
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status,
              ended_at)
            VALUES ('turn-gap-2', ${GAP.sessionId}, 'agent-s-gap', 2, 'and the docs', 'failed',
              now())`;
        }),
      );
      await runtime.runPromise(Deferred.succeed(reconnect, undefined));
      await vi.waitFor(() => expect(editsOf(GAP.statusTs).at(-1)?.text).toBe(gapLine("failed")), {
        timeout: 20_000,
      });
      expect(opens).toBe(2);
    } finally {
      await runtime.runPromise(Scope.close(gapped, Exit.void));
    }
  }, 120_000);

  it("keeps preparation failures quiet and hides status when the project turns private", async () => {
    const failed = await run(claimTurn(ELSEWHERE.sessionId));
    await run(
      Effect.flatMap(PreviewPreparationsRepo, (repo) =>
        repo.decide(failed, {
          _tag: "Refused",
          service: "web",
          previewId: null,
          reason: "mend.toml refuses web: setup · exited 1\nnpm ERR! missing script",
        }),
      ),
    );
    await vi.waitFor(() => expect(linesOf(ELSEWHERE.statusTs).at(-1)).toEqual([]), {
      timeout: 20_000,
    });

    await run(
      Effect.flatMap(ProjectsRepo, (projects) => projects.setVisibility(PROJECT, "private")),
    );
    await vi.waitFor(
      () => {
        for (const { statusTs } of [...THREADS, ELSEWHERE]) {
          expect(editsOf(statusTs).at(-1)?.text).toBe("not shown · the project is private");
          expect(opensOf(statusTs).at(-1)).toEqual([]);
        }
      },
      { timeout: 30_000 },
    );
  }, 120_000);
});
