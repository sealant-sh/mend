import * as os from "node:os";

import { SessionId } from "@mend/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, expect, it } from "vitest";

import { SessionsRepo } from "../src/repos/agent-sessions.ts";
import { createLivePeopleFixture, PROJECT, WORKTREE } from "./session-live-people-fixture.ts";

const { postgres, run, setup, teardown } = createLivePeopleFixture();
if (postgres.skip)
  throw new Error(
    "The session latency benchmark requires PostgreSQL; remove MEND_SKIP_POSTGRES_TESTS",
  );
if (process.env["MEND_TEST_DATABASE_URL"] === undefined)
  throw new Error("Set MEND_TEST_DATABASE_URL to a disposable PostgreSQL server for the benchmark");

beforeAll(setup);
afterAll(teardown);

type QueryName = "list" | "listView" | "byId" | "view";
const queryNames: ReadonlyArray<QueryName> = ["list", "listView", "byId", "view"];
const rounds = 3;
const samplesPerRound = 40;
const warmupRounds = 5;
const emptySamples = (): Record<QueryName, Array<number>> => ({
  list: [],
  listView: [],
  byId: [],
  view: [],
});

const summarize = (samples: ReadonlyArray<number>) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  if (median === undefined || p90 === undefined)
    throw new Error("The benchmark recorded no samples");
  return { samples: sorted.length, median, p90 };
};

/** The existing budget: +5% or +20 ms over the plain read, whichever is larger. */
const within = (before: number, after: number) => after <= Math.max(before * 1.05, before + 20);

it("reads the list and the view within the budget of the plain reads (+5% or +20 ms)", async () => {
  const report = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* SessionsRepo;
      // Preserve the original busy-instance fixture: 300 live sessions and processes.
      yield* sql`
        INSERT INTO agent_sessions
          (id, project_id, worktree_id, harness, worktree, branch, base_sha, status,
           owner_user_id, sealant_workspace_id)
        SELECT 'bulk-' || g, ${PROJECT}, ${WORKTREE}, 'claude', 'wt-1', 'mend/wt-1', 'abc',
               'running', 'alice', 'ws-bulk-' || (g / 2)
        FROM generate_series(1, 300) g`;
      yield* sql`
        INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, sealant_session_id, kind, status, runs_as)
        SELECT 'bulk-p-' || g, 'bulk-' || g, 'ws-bulk-' || (g / 2), 'pty-b-' || g,
               'agent-pty', 'running', CASE WHEN g % 2 = 0 THEN 'alice' ELSE 'maria' END
        FROM generate_series(1, 300) g`;
      yield* sql`ANALYZE`;

      const postgresContext = yield* sql<{ version: string; server_version: string }>`
        SELECT version() AS version, current_setting('server_version') AS server_version`;
      const fixture = yield* sql<{ sessions: number; live_processes: number }>`
        SELECT (SELECT count(*)::int FROM agent_sessions WHERE status = 'running') AS sessions,
               (SELECT count(*)::int FROM session_processes WHERE exited_at IS NULL) AS live_processes`;
      expect(fixture[0]).toEqual({ sessions: 303, live_processes: 304 });
      const id = SessionId.make("bulk-17");
      const queries = {
        list: sessions.listActive().pipe(Effect.asVoid),
        listView: sessions.listActiveView().pipe(Effect.asVoid),
        byId: sessions.byId(id).pipe(Effect.asVoid),
        view: sessions.viewById(id).pipe(Effect.asVoid),
      };

      for (let warmup = 0; warmup < warmupRounds; warmup++) {
        for (const name of queryNames) yield* queries[name];
      }
      const measured: Array<Record<QueryName, Array<number>>> = [];
      for (let round = 0; round < rounds; round++) {
        const samples = emptySamples();
        for (let sample = 0; sample < samplesPerRound; sample++) {
          // Rotate the first query each sample and round, sharing cache/load changes between reads.
          const first = (sample + round) % queryNames.length;
          const order = [...queryNames.slice(first), ...queryNames.slice(0, first)];
          for (const name of order) {
            const started = performance.now();
            yield* queries[name];
            samples[name].push(performance.now() - started);
          }
        }
        measured.push(samples);
      }
      return { postgres: postgresContext[0], fixture: fixture[0], measured };
    }),
  );
  const statistics = report.measured.map((samples) => ({
    list: summarize(samples.list),
    listView: summarize(samples.listView),
    byId: summarize(samples.byId),
    view: summarize(samples.view),
  }));
  const combined = {
    list: summarize(report.measured.flatMap((samples) => samples.list)),
    listView: summarize(report.measured.flatMap((samples) => samples.listView)),
    byId: summarize(report.measured.flatMap((samples) => samples.byId)),
    view: summarize(report.measured.flatMap((samples) => samples.view)),
  };
  console.log(
    JSON.stringify({
      benchmark: "session-live-people",
      units: "milliseconds",
      budget: "+5% or +20 ms, whichever is larger",
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        cpu: os.cpus()[0]?.model,
        cpuThreads: os.cpus().length,
      },
      postgres: report.postgres,
      fixture: report.fixture,
      warmupRounds,
      rounds: statistics,
      combined,
      samples: report.measured,
    }),
  );
  for (const [round, timings] of statistics.entries()) {
    expect(
      within(timings.list.median, timings.listView.median),
      `round ${round + 1}: list median`,
    ).toBe(true);
    expect(within(timings.list.p90, timings.listView.p90), `round ${round + 1}: list p90`).toBe(
      true,
    );
    expect(
      within(timings.byId.median, timings.view.median),
      `round ${round + 1}: view median`,
    ).toBe(true);
    expect(within(timings.byId.p90, timings.view.p90), `round ${round + 1}: view p90`).toBe(true);
  }
});
