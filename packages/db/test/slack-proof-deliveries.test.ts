import { PgClient } from "@effect/sql-pg";
import { AgentTurnId, ProjectId, ProofArtifactId, SessionId } from "@mend/domain";
import { Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrations } from "../src/migrations.ts";
import {
  SlackProofDeliveriesRepo,
  SlackProofDeliveriesRepoLive,
} from "../src/repos/slack-proof-deliveries.ts";
import { postgresTestConfig } from "./postgres.ts";

const config = postgresTestConfig();
const database = `mend_slack_proof_${process.pid}_${Date.now()}`;
const url = new URL(config.adminUrl);
url.pathname = `/${database}`;
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const layer = SlackProofDeliveriesRepoLive.pipe(Layer.provideMerge(pg));
const admin = (query: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(query)).pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(config.adminUrl) })),
      Effect.scoped,
    ),
  );
const run = <A, E>(effect: Effect.Effect<A, E, SlackProofDeliveriesRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));
const key = { sessionId: SessionId.make("session"), artifactId: ProofArtifactId.make("artifact") };

describe.skipIf(config.skip)("0179 Slack proof delivery persistence", () => {
  beforeAll(async () => {
    await admin(`CREATE DATABASE ${database}`);
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO organizations(id,name) VALUES ('proof-org','Proof')`;
        yield* sql`INSERT INTO projects(id,name,store_path,default_branch,organization_id) VALUES ('proof-p','proof','/store/proof','main','proof-org')`;
        yield* sql`INSERT INTO worktrees(id,project_id,name,directory,branch,base_sha) VALUES ('proof-wt','proof-p','proof','proof','proof','abc')`;
        yield* sql`INSERT INTO agent_sessions(id,project_id,worktree_id,harness,worktree,branch,base_sha) VALUES ('session','proof-p','proof-wt','claude','proof','proof','abc')`;
        const tables =
          yield* sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'proof_artifacts'`;
        expect(tables).toEqual([{ tablename: "proof_artifacts" }]);
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  it("keeps a file identity committed when later work fails and resumes the same delivery", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SlackProofDeliveriesRepo;
        yield* repo
          .withDelivery(key, (store) =>
            Effect.gen(function* () {
              const row = yield* store.startAttempt();
              expect(row).toMatchObject({ state: "reserved", attempts: 1, slackFileId: null });
              yield* store.save({
                ...row,
                slackFileId: "F1",
                uploadUrl: "https://files.slack.com/upload/ticket",
              });
              return yield* Effect.fail("lost connection after reservation");
            }),
          )
          .pipe(Effect.flip);
        yield* repo.withDelivery(key, (store) =>
          Effect.gen(function* () {
            const row = yield* store.startAttempt();
            expect(row).toMatchObject({ state: "reserved", attempts: 2, slackFileId: "F1" });
            const result = yield* store.save({
              ...row,
              state: "shared",
              messageTs: "2.0",
              uploadUrl: null,
            });
            expect(result).toMatchObject({ state: "shared", messageTs: "2.0" });
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT * FROM slack_proof_deliveries WHERE session_id = 'session'`;
        expect(rows).toHaveLength(1);
      }),
    );
  });

  it("refuses a concurrent writer and releases its lock after failure", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SlackProofDeliveriesRepo;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const locked = repo.withDelivery(key, () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        );
        yield* Effect.all(
          [
            locked,
            Effect.gen(function* () {
              yield* Deferred.await(entered);
              const busy = yield* repo.withDelivery(key, (store) => store.read()).pipe(Effect.flip);
              expect(busy).toMatchObject({ operation: "busy" });
              yield* Deferred.succeed(release, undefined);
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect((yield* repo.withDelivery(key, (store) => store.read())).slackFileId).toBe("F1");
      }),
    );
  });

  it("persists turn release and batch membership across a failed writer", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* SlackProofDeliveriesRepo;
        const turnKey = { sessionId: key.sessionId, turnId: AgentTurnId.make("turn") };
        const context = {
          projectId: ProjectId.make("proof-p"),
          changeId: null,
          url: "https://mend.test/session",
          previewUrl: null,
          push: null,
        };
        expect(yield* repo.withTurn(turnKey, (store) => Effect.succeed(store.context))).toBeNull();
        yield* repo.readyTurn(key.sessionId, turnKey.turnId, context);
        yield* repo
          .withTurn(turnKey, (store) =>
            Effect.gen(function* () {
              expect(store.context).toEqual(context);
              yield* store.save({
                batches: [
                  {
                    artifactIds: [key.artifactId],
                    startedAt: 123,
                    finished: false,
                    messageTs: null,
                    replyStarted: false,
                  },
                ],
              });
              return yield* Effect.fail("worker stopped");
            }),
          )
          .pipe(Effect.flip);
        expect(yield* repo.withTurn(turnKey, (store) => store.read())).toMatchObject({
          batches: [{ artifactIds: [key.artifactId], startedAt: 123, finished: false }],
        });
        expect(yield* repo.pendingTurns(new Date(0))).toEqual([turnKey]);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.all(
          [
            repo.withTurn(turnKey, () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
            Effect.gen(function* () {
              yield* Deferred.await(entered);
              expect(
                yield* repo.withTurn(turnKey, (store) => store.read()).pipe(Effect.flip),
              ).toMatchObject({ operation: "busy" });
              yield* Deferred.succeed(release, undefined);
            }),
          ],
          { concurrency: "unbounded" },
        );
      }),
    );
  });

  it("restricts states and cascades when the contributing session is deleted", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect(
          yield* sql`UPDATE slack_proof_deliveries SET state = 'lost' WHERE session_id = 'session'`.pipe(
            Effect.flip,
          ),
        ).toBeDefined();
        yield* sql`DELETE FROM agent_sessions WHERE id = 'session'`;
        const rows = yield* sql`SELECT * FROM slack_proof_deliveries WHERE session_id = 'session'`;
        expect(Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(rows)).toHaveLength(0);
        expect(
          yield* sql`SELECT * FROM slack_proof_turns WHERE session_id = 'session'`,
        ).toHaveLength(0);
      }),
    );
  });
});
