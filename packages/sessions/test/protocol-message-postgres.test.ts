import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
  MendDB,
  MendDBLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  migrations,
  type MendDatabase,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ClientMessageId, SessionId, SessionProcessId } from "@mend/domain";
import { MessageInput, type SendMessageInput } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { ConnectionError, SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ProtocolHost, ProtocolHostLive } from "../src/protocol-host.ts";
import { makePipe } from "./support/codex-peer.ts";

const postgres = postgresTestConfig();
const database = `mend_message_host_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });

let loseNextAcknowledgement = false;
const lostAcknowledgement = Layer.effect(
  MendDB,
  Effect.gen(function* () {
    const client = yield* MendDB;
    return new Proxy(client, {
      get(target, property, receiver) {
        if (property !== "transaction") return Reflect.get(target, property, receiver);
        return (...args: Parameters<MendDatabase["transaction"]>) => {
          const committed = target.transaction(...args);
          if (!loseNextAcknowledgement) return committed;
          loseNextAcknowledgement = false;
          return committed.pipe(
            Effect.andThen(
              Effect.fail(
                new SqlError({
                  reason: new ConnectionError({
                    cause: new Error("connection dropped"),
                    message: "commit acknowledgement lost",
                  }),
                }),
              ),
            ),
          );
        };
      },
    });
  }),
);
const repos = Layer.mergeAll(
  AgentConversationRepoLive.pipe(Layer.provide(lostAcknowledgement)),
  SessionsRepoLive,
  SessionProcessesRepoLive,
);
const testLayer = Layer.mergeAll(ProtocolHostLive.pipe(Layer.provide(repos)), repos).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.toString()) }))),
  ),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ProtocolHost | AgentConversationRepo | SessionProcessesRepo | SqlClient.SqlClient
  >,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer), Effect.scoped));

const request = (sessionId: SessionId): SendMessageInput => ({
  sessionId,
  sender: "user-1",
  input: MessageInput.make("  exact words\n"),
  clientMessageId: ClientMessageId.make(crypto.randomUUID()),
  intent: "default",
});

/** A fresh session with one live agent process, attached to the host over `peer`. */
const attached = (name: string, peer: ReturnType<typeof makePipe>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionId = SessionId.make(`sess-${name}`);
    const processId = SessionProcessId.make(`p-${name}`);
    yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status)
      VALUES (${sessionId},'proj-1','wt-1','user-1','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
    yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind,harness,status)
      VALUES (${processId},${sessionId},'ws-1','agent-protocol','codex','running')`;
    const host = yield* ProtocolHost;
    const process = yield* (yield* SessionProcessesRepo).byId(processId);
    if (process === null) return yield* Effect.die("missing process");
    yield* host.attach({
      process,
      pipe: peer.pipe,
      cwd: "/workspace/repo",
      permissionMode: "bypass",
      launchedWithLoginOf: "user-1",
      hooks: { onRequestChanged: () => Effect.void, onTurnCompleted: () => Effect.void },
    });
    return { host, sessionId, processId };
  });

describe.skipIf(postgres.skip)("a message whose commit acknowledgement was lost", () => {
  let created = false;
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
          VALUES ('user-1', 'user-1', 'user-1@example.invalid', '2026-01-01T00:00:00Z')`;
        yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id)
          VALUES ('proj-1','fixture','/store/fixture/repo.git','main',(SELECT id FROM organizations LIMIT 1),'user-1')`;
        yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha)
          VALUES ('wt-1','proj-1','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
      }),
    );
  }, 120_000);
  beforeEach(() => {
    loseNextAcknowledgement = false;
  });
  afterAll(async () => {
    if (!created) return;
    created = false;
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      }),
    );
  }, 60_000);

  it("still dispatches the turn it admitted to an idle conversation", async () => {
    const peer = makePipe(["native"]);
    await run(
      Effect.gen(function* () {
        const { host, sessionId, processId } = yield* attached("turn", peer);
        const input = request(sessionId);
        loseNextAcknowledgement = true;
        const receipt = yield* host.sendMessage(input, {
          _tag: "Turn",
          reason: "no-own-running-turn",
        });
        expect(loseNextAcknowledgement).toBe(false);
        expect(receipt).toMatchObject({
          _tag: "Turn",
          turn: { input: input.input, status: "running", providerTurnId: "native" },
        });
        expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
        expect(yield* host.sendMessage(input, { _tag: "Turn", reason: "queue-requested" })).toEqual(
          receipt,
        );
        expect(peer.written.filter((frame) => frame.method === "turn/start")).toHaveLength(1);
        yield* host.detach(processId);
      }),
    );
  });

  it("still delivers the steer it admitted to the running turn", async () => {
    const peer = makePipe(["native"]);
    await run(
      Effect.gen(function* () {
        const { host, sessionId, processId } = yield* attached("steer", peer);
        const running = yield* host.submitTurn(sessionId, "start", "user-1");
        const input = request(sessionId);
        loseNextAcknowledgement = true;
        const receipt = yield* host.sendMessage(input, { _tag: "Steer", turnId: running.id });
        expect(loseNextAcknowledgement).toBe(false);
        expect(receipt).toMatchObject({
          _tag: "Steer",
          steer: {
            input: input.input,
            delivery: { _tag: "Accepted", evidence: "provider-acknowledged" },
          },
        });
        const steers = peer.written.filter((frame) => frame.method === "turn/steer");
        expect(steers).toHaveLength(1);
        expect(steers[0]?.params).toEqual({
          expectedTurnId: "native",
          input: [{ type: "text", text: input.input }],
        });
        yield* host.detach(processId);
      }),
    );
  });
});
