import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepoLive,
  ExecutorRepo,
  ExecutorRepoLive,
  MendDBLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, SessionId } from "@mend/domain";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { MendKeysConfig, SecretCipher, SecretCipherLive } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import { McpSchema } from "effect/ai";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  executorObservations,
  OrganizationExecutor,
  OrganizationExecutorLive,
} from "../src/executor/executor.ts";
import {
  ExecutorCredentials,
  ExecutorFailure,
  ExecutorTransport,
  type ExecutorGrant,
} from "../src/executor/transport.ts";
import type { Caller } from "../src/mend-mcp/caller.ts";

const pg = postgresTestConfig();
const database = `mend_executor_${process.pid}_${Date.now()}`;
const url = new URL(pg.adminUrl);
url.pathname = `/${database}`;
const root = mkdtempSync(join(tmpdir(), "exbuild-executor-test-"));
const admin = PgClient.layer({ url: Redacted.make(pg.adminUrl) });
const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.href), maxConnections: 6 })),
);
const repos = Layer.mergeAll(
  ExecutorRepoLive,
  SessionsRepoLive,
  ProjectsRepoLive,
  OrganizationsRepoLive,
  AgentConversationRepoLive,
).pipe(Layer.provideMerge(databaseLayer));
const cipher = SecretCipherLive.pipe(Layer.provide(MendKeysConfig.layerFor(root)));
const ORG = OrganizationId.make("org-executor");
const SESSION = SessionId.make("session-executor");
const caller = (accountId: string | null, key: string | null = null): Caller => ({
  sessionId: SESSION,
  accountId,
  agentProcess: null,
  callKey: key,
});
const result = (value: unknown) =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  });

it.each([
  ["router.observe", 'tools["approval-probe"].router.observe'],
  ["read-file", 'tools["approval-probe"]["read-file"]'],
  ["constructor", 'tools["approval-probe"]["%constructor"]'],
  ["router..observe", 'tools["approval-probe"].router["%00"].observe'],
  ["a%name", 'tools["approval-probe"]["a%25name"]'],
  ['a"name', 'tools["approval-probe"]["a\\"name"]'],
])("labels held input requests for %s with the catalog's exact path", (tool, path) => {
  expect(
    executorObservations(result({ status: "input-required", tool: { app: "app_probe", tool } }), {
      name: "Approval probe",
      slug: "approval-probe",
    }),
  ).toEqual([{ service: "Approval probe", tool: path, outcome: "input-required" }]);
});

const completed = result({
  status: "completed",
  execution: {
    ok: true,
    value: "observed",
    toolCalls: [{ name: "tools.probe.observe", outcome: "success" }],
  },
});
const held = () =>
  result({
    status: "approval-required",
    requestId: "apr-upstream",
    expiresAt: Date.now() + 900000,
    invocation: {
      app: "app_6f9ac95a-74dd-4a80-b2d2-dcd65b525d5d",
      tool: "observe",
      input: { message: "hello" },
    },
    elicitation: {
      message: "Approve the probe?",
      requestedSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  });
const grant = (subject: string, kind: string, expiresAt = Date.now() + 3600000): ExecutorGrant => ({
  subject,
  expiresAt,
  accessToken: Redacted.make(`${subject}-${kind}-access`),
  refreshToken: Redacted.make(`${subject}-${kind}-refresh`),
});
let calls: Array<{ subject: string; params: unknown }>;
let refreshes: string[];
let revocations: string[];
let failRefresh: boolean;
let failService: boolean;
let serviceSubjects: string[];
let answer: McpSchema.CallToolResult;
const transport = Layer.succeed(ExecutorTransport, {
  service: (_origin, token, app) => {
    serviceSubjects.push(token.subject);
    expect(Redacted.value(token.accessToken)).toContain("service-access");
    expect(app).toBe("app_6f9ac95a-74dd-4a80-b2d2-dcd65b525d5d");
    return failService
      ? Effect.fail(new ExecutorFailure({ kind: "unavailable", message: "Service unavailable" }))
      : Effect.succeed({ name: "Approval probe", slug: "approval-probe" });
  },
  register: () =>
    Effect.succeed({
      client_id: "fixture-client",
      client_secret: Redacted.make("registration-secret"),
    }),
  grant: (_origin, _registration, kind, input) =>
    Effect.gen(function* () {
      if (input.grant_type === "refresh_token") {
        refreshes.push(input.refresh_token ?? "");
        yield* Effect.sleep("5 millis");
        if (failRefresh)
          return yield* new ExecutorFailure({ kind: "refused", message: "refresh refused" });
        return grant((input.refresh_token ?? "").split("-")[0] ?? "unknown", `${kind}-rotated`);
      }
      return grant(input.code ?? "alice", kind);
    }),
  revoke: (_origin, _registration, token) =>
    Effect.sync(() => {
      revocations.push(Redacted.value(token.accessToken));
    }),
  mcp: (_origin, token, _method, params) =>
    Effect.sync(() => {
      calls.push({ subject: token.subject, params });
      return answer;
    }),
});
const services = OrganizationExecutorLive.pipe(
  Layer.provide(transport),
  Layer.provideMerge(repos),
  Layer.provideMerge(cipher),
  Layer.provide(
    Layer.succeed(NetworkConfig, makePublicNetwork(PublicOrigin.make("http://localhost:3445"), [])),
  ),
);
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    OrganizationExecutor | ExecutorRepo | SqlClient.SqlClient | SecretCipher
  >,
) => Effect.runPromise(program.pipe(Effect.provide(services), Effect.scoped));
const sqlRun = <A, E>(program: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(program.pipe(Effect.provide(databaseLayer), Effect.scoped));
let created = false;
const addLink = (subject: string, expiresAt?: number) =>
  Effect.gen(function* () {
    const executor = yield* OrganizationExecutor;
    yield* executor.configure(ORG, { mode: "own", url: "http://executor.localhost:4400" });
    const repo = yield* ExecutorRepo;
    const config = yield* repo.configuration(ORG);
    if (config === null) return yield* Effect.die("no fixture config");
    const name = subject === "member" ? "member" : subject;
    const credentials = {
      registration: {
        client_id: "fixture-client",
        client_secret: Redacted.make("registration-secret"),
      },
      tool: grant(name, "tool", expiresAt),
      service: grant(name, "service", expiresAt),
    };
    const sealed = yield* (yield* SecretCipher).encrypt(
      Schema.encodeSync(Schema.fromJsonString(ExecutorCredentials))(credentials),
    );
    yield* repo.saveLink({
      id: `link-${subject}`,
      configurationId: config.id,
      subject: subject === "member" ? "member" : `person:${subject}`,
      userId: subject === "member" ? null : subject,
      state: "active",
      sealedCredentials: sealed,
      observedAt: new Date(),
    });
  });

describe.skipIf(pg.skip)(
  "organization's Executor through migrated PostgreSQL and SecretCipher",
  () => {
    beforeAll(async () => {
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`CREATE DATABASE ${database}`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
      created = true;
      await sqlRun(
        Effect.gen(function* () {
          for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migration;
          const sql = yield* SqlClient.SqlClient;
          for (const user of ["alice", "bob", "carol"])
            yield* sql`INSERT INTO "user" (id,name,email,"createdAt") VALUES (${user},${user},${user + "@example.invalid"},now())`;
          yield* sql`INSERT INTO organizations (id,name) VALUES (${ORG},'Executor fixture')`;
          for (const user of ["alice", "bob", "carol"])
            yield* sql`INSERT INTO organization_members (organization_id,user_id,role) VALUES (${ORG},${user},${user === "alice" ? "owner" : "member"})`;
          yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id,created_by_user_id,visibility) VALUES ('project-executor','fixture','/fixture','main',${ORG},'alice','shared')`;
          yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES ('tree-executor','project-executor','fixture','fixture','mend/fixture',${"a".repeat(40)})`;
          yield* sql`INSERT INTO agent_sessions (id,project_id,worktree_id,owner_user_id,harness,worktree,branch,base_sha,status) VALUES (${SESSION},'project-executor','tree-executor','alice','codex','fixture','mend/fixture',${"a".repeat(40)},'running')`;
        }),
      );
    });
    beforeEach(async () => {
      calls = [];
      refreshes = [];
      revocations = [];
      failRefresh = false;
      failService = false;
      serviceSubjects = [];
      answer = completed;
      await sqlRun(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`TRUNCATE executor_calls,executor_link_flows,executor_links,organization_executors`,
        ),
      );
    });
    afterAll(async () => {
      if (created)
        await Effect.runPromise(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
          ).pipe(Effect.provide(admin), Effect.scoped),
        );
      readdirSync(root);
      rmSync(root, { recursive: true, force: true });
    });

    it("uses the channel's person under shared control, or Mend's member, never the owner", async () => {
      await run(
        Effect.gen(function* () {
          yield* addLink("alice");
          yield* addLink("bob");
          yield* addLink("member");
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob"), "call", {});
          yield* ex.relay(caller("carol"), "call", {});
          yield* ex.relay(caller(null), "call", {});
          expect(
            (yield* (yield* ExecutorRepo).calls(SESSION)).calls.map((row) => row.asMember),
          ).toEqual([true, true, false]);
        }),
      );
      expect(calls.map((call) => call.subject)).toEqual(["bob", "member", "member"]);
    });
    it("seals both PKCE consents, binds callbacks to the actor, and revokes on unlink", async () => {
      await run(
        Effect.gen(function* () {
          const ex = yield* OrganizationExecutor;
          yield* ex.configure(ORG, { mode: "own", url: "http://executor.localhost:4400" });
          const start = new URL(yield* ex.begin(ORG, "bob", "person"));
          const state = start.searchParams.get("state") ?? "";
          expect(start.searchParams.get("scope")).toBe("mcp offline_access");
          expect(start.searchParams.get("resource")).toBe("http://executor.localhost:4400/mcp");
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            sealedFlow: string;
            stateHash: string;
          }>`SELECT sealed_flow AS "sealedFlow",state_hash AS "stateHash" FROM executor_link_flows`;
          expect(rows[0]?.sealedFlow).toMatch(/^v1\./);
          expect(rows[0]?.stateHash).toBe(createHash("sha256").update(state).digest("hex"));
          expect((yield* Effect.result(ex.finish(ORG, "alice", true, state, "bob")))._tag).toBe(
            "Failure",
          );
          const next = yield* ex.finish(ORG, "bob", false, state, "bob");
          if (next.url === null) return yield* Effect.die("missing second consent");
          const service = new URL(next.url);
          expect(service.searchParams.get("scope")).toBe("executor offline_access");
          expect(service.searchParams.get("code_challenge")).not.toBe(
            start.searchParams.get("code_challenge"),
          );
          yield* ex.finish(ORG, "bob", false, service.searchParams.get("state") ?? "", "bob");
          expect((yield* ex.personalStatus(ORG, "bob")).link.state).toBe("active");
          yield* ex.unlink(ORG, "bob", "person");
          expect((yield* ex.personalStatus(ORG, "bob")).link.state).toBe("unlinked");
        }),
      );
      expect(revocations.toSorted()).toEqual(["bob-service-access", "bob-tool-access"]);
    });
    it("serializes rotation across independently built runtimes and commits each rotated grant", async () => {
      await run(addLink("bob", 0));
      const request = Effect.flatMap(OrganizationExecutor, (ex) =>
        ex.relay(caller("bob"), "call", {}),
      );
      await Promise.all([run(request), run(request)]);
      expect(refreshes.toSorted()).toEqual(["bob-service-refresh", "bob-tool-refresh"]);
      expect(calls.map((call) => call.subject)).toEqual(["bob", "bob"]);
    });
    it("marks an uncertain refresh refused, never replays it, and uses only Mend's member", async () => {
      await run(
        Effect.gen(function* () {
          yield* addLink("bob", 0);
          yield* addLink("member");
        }),
      );
      failRefresh = true;
      await run(
        Effect.gen(function* () {
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob"), "call", {});
          yield* ex.relay(caller("bob"), "call", {});
          expect((yield* ex.personalStatus(ORG, "bob")).link.state).toBe("refused");
        }),
      );
      expect(refreshes).toEqual(["bob-tool-refresh"]);
      expect(calls.map((call) => call.subject)).toEqual(["member", "member"]);
    });
    it("refuses agent approval and another person's answer, then resumes with the original link", async () => {
      answer = held();
      await run(
        Effect.gen(function* () {
          yield* addLink("alice");
          yield* addLink("bob");
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob", "held"), "call", {});
          const row = (yield* (yield* ExecutorRepo).calls(SESSION)).calls[0];
          if (row === undefined) return yield* Effect.die("missing call");
          expect(row.approverId).toBe("bob");
          const refused = yield* ex.relay(caller("bob"), "resume", {
            requestId: row.id,
            response: { action: "accept", content: {} },
          });
          expect(refused.isError).toBe(true);
          expect(
            (yield* Effect.result(
              ex.approve(SESSION, row.id, "alice", { action: "accept", content: {} }),
            ))._tag,
          ).toBe("Failure");
          expect((yield* ex.approval(SESSION, row.id, "bob")).arguments).toEqual({
            message: "hello",
          });
          answer = completed;
          yield* ex.approve(SESSION, row.id, "bob", { action: "accept", content: {} });
          expect((yield* (yield* ExecutorRepo).call(row.id))?.outcome).toBe("completed");
        }),
      );
      expect(calls.map((call) => call.subject)).toEqual(["bob", "bob"]);
      expect(calls[1]?.params).toEqual({
        name: "resume",
        arguments: { requestId: "apr-upstream", response: { action: "accept", content: {} } },
      });
    });
    it("records missing links and expires approvals without dispatching an answer", async () => {
      await run(
        Effect.gen(function* () {
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob"), "call", {});
          expect((yield* (yield* ExecutorRepo).calls(SESSION)).calls[0]?.outcome).toBe("refused");
          yield* addLink("member");
          answer = held();
          yield* ex.relay(caller("carol"), "call", {});
          const repo = yield* ExecutorRepo;
          const row = (yield* repo.calls(SESSION)).calls[0];
          if (row === undefined) return yield* Effect.die("missing held call");
          expect(row.approverId).toBe("carol");
          const saved = yield* repo.call(row.id);
          if (saved === null) return yield* Effect.die("missing row");
          yield* repo.saveCall({ ...saved, expiresAt: new Date(0) });
          expect(
            (yield* ex.approve(SESSION, row.id, "carol", { action: "accept", content: {} }))
              .outcome,
          ).toBe("expired");
        }),
      );
      expect(calls).toHaveLength(1);
    });
    it("does not dispatch a repeated call key twice, and retains nested failure outcomes", async () => {
      answer = result({
        status: "completed",
        execution: { ok: false, toolCalls: [{ name: "tools.probe.observe", outcome: "error" }] },
      });
      await run(
        Effect.gen(function* () {
          yield* addLink("bob");
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob", "same"), "call", {});
          yield* ex.relay(caller("bob", "same"), "call", {});
          expect((yield* (yield* ExecutorRepo).calls(SESSION)).calls[0]?.outcome).toBe("refused");
        }),
      );
      expect(calls).toHaveLength(1);
    });
    it.each(["accept", "decline", "expire"] as const)(
      "keeps a held service's name and exact path after %s",
      async (action) => {
        answer = held();
        await run(
          Effect.gen(function* () {
            yield* addLink("bob");
            const ex = yield* OrganizationExecutor;
            yield* ex.relay(caller("bob"), "call", {
              calls: { path: 'tools["approval-probe"].observe', input: { message: "hello" } },
            });
            const repo = yield* ExecutorRepo;
            const row = (yield* repo.calls(SESSION)).calls[0];
            if (row === undefined) return yield* Effect.die("missing call");
            const label = {
              service: "Approval probe",
              tool: 'tools["approval-probe"].observe',
            };
            expect(row).toMatchObject({ ...label, outcome: "held" });
            expect(row.observations).toEqual([{ ...label, outcome: "approval-required" }]);
            expect((yield* ex.approval(SESSION, row.id, "bob")).call).toMatchObject(label);
            answer = result({
              status: "completed",
              execution: {
                ok: action !== "decline",
                toolCalls: [
                  {
                    name: 'tools["approval-probe"].observe',
                    outcome: action === "decline" ? "error" : "success",
                  },
                ],
              },
            });
            if (action === "expire") {
              const saved = yield* repo.call(row.id);
              if (saved === null) return yield* Effect.die("missing held call");
              yield* repo.saveCall({ ...saved, expiresAt: new Date(0) });
            }
            const settled = yield* ex.approve(SESSION, row.id, "bob", {
              action: action === "decline" ? "decline" : "accept",
              content: {},
            });
            expect(settled).toMatchObject({
              ...label,
              outcome:
                action === "expire" ? "expired" : action === "decline" ? "denied" : "completed",
            });
            expect(settled.observations).toEqual([
              { ...label, outcome: "approval-required" },
              ...(action === "expire"
                ? []
                : [{ ...label, outcome: action === "decline" ? "error" : "success" }]),
            ]);
            expect((yield* repo.calls(SESSION)).calls[0]).toMatchObject(settled);
          }),
        );
        expect(serviceSubjects).toEqual(["bob"]);
      },
    );
    it("says when the held service cannot be resolved instead of showing its internal id", async () => {
      answer = held();
      failService = true;
      await run(
        Effect.gen(function* () {
          yield* addLink("bob");
          const ex = yield* OrganizationExecutor;
          yield* ex.relay(caller("bob"), "execute", { code: "await tools.probe.observe({})" });
          const row = (yield* (yield* ExecutorRepo).calls(SESSION)).calls[0];
          expect(row).toMatchObject({
            outcome: "held",
            service: "Service name unavailable",
            tool: "observe (exact path unavailable)",
            observations: [
              {
                service: "Service name unavailable",
                tool: "observe (exact path unavailable)",
                outcome: "approval-required",
              },
            ],
          });
          expect(JSON.stringify(row)).not.toContain("app_6f9ac95a");
        }),
      );
    });
  },
);
