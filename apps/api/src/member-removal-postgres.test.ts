import { PgClient } from "@effect/sql-pg";
import {
  AgentConversationRepo,
  AgentConversationRepoLive,
  AuditEventsRepoLive,
  DevicesRepoLive,
  MendDBLive,
  MemberRevocationsRepoLive,
  MemberRevocationsRepo,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  PushDevicesRepoLive,
  PushDevicesRepo,
  SessionControlEventsRepoLive,
  SessionsRepoLive,
  SlackLinksRepoLive,
  UserEvents,
  UsersRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
  String as Str,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ConnectionRegistry } from "./connections.ts";
import { MemberRemoval, MemberRemovalLive } from "./member-removal.ts";
import { SshKeyRevoker } from "./ssh-key-revocation.ts";

const postgres = postgresTestConfig();
const database = `mend_member_removal_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
// A single connection exposes a helper that escapes the shared transaction context.
const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(
    PgClient.layer({
      url: Redacted.make(scratchUrl.toString()),
      maxConnections: 1,
      applicationName: database,
      transformResultNames: Str.snakeToCamel,
    }),
  ),
);
const observerLayer = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  transformResultNames: Str.snakeToCamel,
});
const reposLayer = Layer.mergeAll(
  AgentConversationRepoLive,
  AuditEventsRepoLive,
  DevicesRepoLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  PushDevicesRepoLive,
  SessionControlEventsRepoLive,
  SessionsRepoLive,
  SlackLinksRepoLive,
  UsersRepoLive,
).pipe(Layer.provideMerge(databaseLayer));

let notificationFails = true;
let notificationHold: Deferred.Deferred<void> | null = null;
let transactionHold: Deferred.Deferred<void> | null = null;
let commitHold: Deferred.Deferred<void> | null = null;
let notificationEntered = Effect.runSync(Deferred.make<void>());
let transactionEntered = Effect.runSync(Deferred.make<void>());
let committed = Effect.runSync(Deferred.make<void>());
let cleanupStarted = Effect.runSync(Deferred.make<void>());
const recordDispatch = (entry: string) =>
  Effect.sync(() => void dispatched.push(entry)).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        dispatched.length === 2
          ? Deferred.succeed(cleanupStarted, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
    ),
  );
const dispatched: string[] = [];
const externalLayer = Layer.mergeAll(
  Layer.mock(UserEvents, {
    changed: () =>
      Deferred.succeed(notificationEntered, undefined).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            notificationHold !== null
              ? Deferred.await(notificationHold)
              : notificationFails
                ? Effect.die("notification unavailable")
                : Effect.void,
          ),
        ),
      ),
  }),
  Layer.mock(ConnectionRegistry, {
    closeForUser: (userId) => recordDispatch(`close:${userId}`).pipe(Effect.as(0)),
  }),
  Layer.mock(SshKeyRevoker, { attempt: () => Effect.succeed({ removed: 0, outstanding: 0 }) }),
  Layer.unwrap(
    Effect.gen(function* () {
      const conversations = yield* AgentConversationRepo;
      return Layer.mock(SessionEngine, {
        launchUnderWay: () => false,
        cancelQueuedTurnsBy: (userId, sessionIds) =>
          Effect.forEach(sessionIds, (sessionId) =>
            Effect.gen(function* () {
              const turns = yield* conversations.openTurns(sessionId);
              const queued = turns.filter(
                (turn) => turn.author === userId && turn.status === "queued",
              );
              yield* Effect.forEach(queued, (turn) => conversations.cancelOpenForTurn(turn.id));
              return queued.length;
            }),
          ).pipe(Effect.map((counts) => counts.reduce((sum, count) => sum + count, 0))),
        windDownPerson: (userId) =>
          recordDispatch(`windDown:${userId}`).pipe(
            Effect.as({ stopped: 0, retired: [], remaining: 0 }),
          ),
        reconcileHotSessions: () => Effect.void,
      });
    }),
  ),
);
// Only readiness barriers wrap live implementations; the SQL mutations and transaction are real.
const controlledPush = Layer.effect(
  PushDevicesRepo,
  Effect.gen(function* () {
    const actual = yield* PushDevicesRepo;
    return {
      ...actual,
      removeAllForUser: (userId: string) =>
        actual
          .removeAllForUser(userId)
          .pipe(
            Effect.tap(() =>
              Effect.suspend(() =>
                transactionHold === null
                  ? Effect.void
                  : Deferred.succeed(transactionEntered, undefined).pipe(
                      Effect.andThen(Deferred.await(transactionHold)),
                    ),
              ),
            ),
          ),
    };
  }),
).pipe(Layer.provide(PushDevicesRepoLive));
const controlledRemoval = Layer.effect(
  MemberRevocationsRepo,
  Effect.gen(function* () {
    const actual = yield* MemberRevocationsRepo;
    return {
      ...actual,
      beginRemoval: (request: Parameters<typeof actual.beginRemoval>[0]) =>
        actual
          .beginRemoval(request)
          .pipe(
            Effect.tap(() =>
              Effect.suspend(() =>
                commitHold === null
                  ? Effect.void
                  : Deferred.succeed(committed, undefined).pipe(
                      Effect.andThen(Deferred.await(commitHold)),
                    ),
              ),
            ),
          ),
    };
  }),
).pipe(Layer.provide(MemberRevocationsRepoLive.pipe(Layer.provide(controlledPush))));
const layer = MemberRemovalLive.pipe(
  Layer.provide(controlledRemoval),
  Layer.provide(externalLayer),
  Layer.provideMerge(reposLayer),
);
const runtime = ManagedRuntime.make(layer);
const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const observe = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(observerLayer)));
const remove = Effect.flatMap(MemberRemoval, (removal) => removal.remove(input));
const input = {
  organizationId: OrganizationId.make("org-test"),
  userId: "removed",
  actorUserId: "owner",
};

const LocalState = Schema.Struct({
  membership: Schema.Number,
  sshDebt: Schema.Number,
  active: Schema.Boolean,
  auth: Schema.Number,
  devices: Schema.Number,
  push: Schema.Number,
  shared: Schema.Boolean,
  queued: Schema.Number,
  requests: Schema.Number,
  slack: Schema.Number,
});
const state = (userId = "removed") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`
      SELECT
        (SELECT count(*)::int FROM organization_members WHERE user_id = ${userId}) AS membership,
        (SELECT count(*)::int FROM ssh_key_revocations WHERE user_id = ${userId}) AS ssh_debt,
        (SELECT "deactivatedAt" IS NULL FROM "user" WHERE id = ${userId}) AS active,
        (SELECT count(*)::int FROM "session" WHERE "userId" = ${userId}) AS auth,
        (SELECT count(*)::int FROM device_tokens WHERE user_id = ${userId} AND revoked_at IS NULL) AS devices,
        (SELECT count(*)::int FROM push_devices WHERE user_id = ${userId}) AS push,
        (SELECT shared_control_enabled_at IS NOT NULL FROM agent_sessions WHERE id = ${`s-${userId}`}) AS shared,
        (SELECT count(*)::int FROM agent_turns WHERE author = ${userId} AND status = 'queued') AS queued,
        (SELECT count(*)::int FROM agent_requests r JOIN agent_turns t ON t.id = r.turn_id
          WHERE t.author = ${userId} AND r.status = 'pending') AS requests,
        (SELECT count(*)::int FROM slack_links WHERE user_id = ${userId}) AS slack`;
    return Schema.decodeUnknownSync(LocalState)(rows[0]);
  });

const admitted = {
  membership: 1,
  sshDebt: 0,
  active: true,
  auth: 1,
  devices: 1,
  push: 1,
  shared: true,
  queued: 1,
  requests: 1,
  slack: 1,
};
const targetAdmitted = { ...admitted, queued: 2, requests: 2 };
const revoked = {
  membership: 0,
  sshDebt: 1,
  active: false,
  auth: 0,
  devices: 0,
  push: 0,
  shared: false,
  queued: 0,
  requests: 0,
  slack: 0,
};

describe.skipIf(postgres.skip)("member removal with real PostgreSQL", () => {
  beforeAll(async () => {
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    await runtime.runPromise(
      Effect.forEach(
        Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
        ([, migration]) => migration,
      ),
    );
  });

  afterAll(async () => {
    await runtime.dispose();
    await admin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }),
    );
  });

  beforeEach(async () => {
    notificationFails = true;
    notificationHold = null;
    transactionHold = null;
    commitHold = null;
    notificationEntered = Effect.runSync(Deferred.make<void>());
    transactionEntered = Effect.runSync(Deferred.make<void>());
    committed = Effect.runSync(Deferred.make<void>());
    cleanupStarted = Effect.runSync(Deferred.make<void>());
    dispatched.length = 0;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DROP TRIGGER IF EXISTS fail_push_delete ON push_devices`;
        yield* sql`TRUNCATE "user", organizations CASCADE`;
        yield* sql`INSERT INTO "user" (id,name,email) VALUES
        ('owner','Owner','owner@test.invalid'),('removed','Removed','removed@test.invalid'),('other','Other','other@test.invalid')`;
        yield* sql`INSERT INTO organizations (id,name) VALUES ('org-test','Test'),('org-other','Other')`;
        yield* sql`INSERT INTO organization_members (organization_id,user_id,role) VALUES
        ('org-test','owner','owner'),('org-test','removed','member'),('org-other','other','owner')`;
        for (const [organizationId, teamId, installer] of [
          ["org-test", "T-target", "owner"],
          ["org-other", "T-other", "other"],
        ]) {
          yield* sql`INSERT INTO slack_installs
          (organization_id,team_id,team_name,bot_user_id,app_id,sealed_app_token,sealed_bot_token,web_origin,installed_by_user_id)
          VALUES (${organizationId},${teamId},'Test','B-test','A-test','synthetic-app','synthetic-bot','http://localhost',${installer})`;
        }
        for (const userId of ["removed", "other"]) {
          const organizationId = userId === "removed" ? "org-test" : "org-other";
          yield* sql`INSERT INTO "session" (id,"userId",token,"expiresAt") VALUES
          (${`auth-${userId}`},${userId},${`auth-token-${userId}`},now()+interval '1 day')`;
          yield* sql`INSERT INTO device_tokens (id,user_id,name,platform,token_hash) VALUES
          (${`device-${userId}`},${userId},'Test','cli',${`hash-${userId}`})`;
          yield* sql`INSERT INTO push_devices (token,user_id,platform) VALUES (${`push-${userId}`},${userId},'ios')`;
          yield* sql`INSERT INTO projects (id,name,store_path,default_branch,organization_id) VALUES
          (${`p-${userId}`},${userId},${`/store/${userId}`},'main',${organizationId})`;
          yield* sql`INSERT INTO worktrees (id,project_id,name,directory,branch,base_sha) VALUES
          (${`wt-${userId}`},${`p-${userId}`},'wt','wt','mend/wt','abc')`;
          yield* sql`INSERT INTO agent_sessions
          (id,project_id,worktree_id,harness,worktree,branch,base_sha,owner_user_id,shared_control_enabled_at,shared_control_enabled_by_user_id) VALUES
          (${`s-${userId}`},${`p-${userId}`},${`wt-${userId}`},'claude','wt','mend/wt','abc',${userId},now(),${userId})`;
          yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind) VALUES
          (${`proc-${userId}`},${`s-${userId}`},${`ws-${userId}`},'agent-protocol')`;
          yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,author,input) VALUES
          (${`turn-${userId}`},${`s-${userId}`},${`proc-${userId}`},1,${userId},'test')`;
          yield* sql`INSERT INTO agent_requests (id,session_id,process_id,turn_id,kind,provider_request_id) VALUES
          (${`req-${userId}`},${`s-${userId}`},${`proc-${userId}`},${`turn-${userId}`},'user-input','request')`;
          yield* sql`INSERT INTO slack_links (organization_id,team_id,slack_user_id,user_id)
          VALUES (${organizationId},${userId === "removed" ? "T-target" : "T-other"},${`U-${userId}`},${userId})`;
        }
        yield* sql`INSERT INTO agent_sessions
        (id,project_id,worktree_id,harness,worktree,branch,base_sha,owner_user_id,shared_control_enabled_at,shared_control_enabled_by_user_id)
        VALUES ('s-teammate','p-removed','wt-removed','claude','wt','mend/wt','abc','owner',now(),'owner')`;
        yield* sql`INSERT INTO session_processes (id,session_id,sealant_workspace_id,kind)
        VALUES ('proc-teammate','s-teammate','ws-teammate','agent-protocol')`;
        yield* sql`INSERT INTO agent_turns (id,session_id,process_id,ordinal,author,input)
        VALUES ('turn-teammate','s-teammate','proc-teammate',1,'removed','queued teammate prompt')`;
        yield* sql`INSERT INTO agent_requests (id,session_id,process_id,turn_id,kind,provider_request_id)
        VALUES ('req-teammate','s-teammate','proc-teammate','turn-teammate','user-input','teammate-request')`;
      }),
    );
  });

  it("commits every local revocation before a notification failure", async () => {
    const exit = await runtime.runPromise(
      Effect.flatMap(MemberRemoval, (removal) => removal.remove(input)).pipe(Effect.exit),
    );
    expect(exit).toEqual(Exit.succeed({ sshKeys: { removed: 0, outstanding: 0 } }));
    expect(await runtime.runPromise(state())).toEqual(revoked);
    expect(await runtime.runPromise(state("other"))).toEqual(admitted);
    const teammate = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT shared_control_enabled_at IS NOT NULL AS shared
        FROM agent_sessions WHERE id = 's-teammate'`;
        return Schema.decodeUnknownSync(Schema.Struct({ shared: Schema.Boolean }))(rows[0]);
      }),
    );
    expect(teammate.shared).toBe(true);
    await Effect.runPromise(Deferred.await(cleanupStarted));
    expect(dispatched).toContain("close:removed");
    expect(dispatched).toContain("windDown:removed");
  });

  it("rolls back every local change and SSH debt when a late deletion fails", async () => {
    notificationFails = false;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE OR REPLACE FUNCTION reject_push_delete() RETURNS trigger LANGUAGE plpgsql AS
        'BEGIN RAISE EXCEPTION ''push deletion unavailable''; END'`;
        yield* sql`CREATE TRIGGER fail_push_delete BEFORE DELETE ON push_devices
        FOR EACH ROW EXECUTE FUNCTION reject_push_delete()`;
        const exit = yield* (yield* MemberRemoval).remove(input).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
      }),
    );
    expect(await runtime.runPromise(state())).toEqual(targetAdmitted);
    expect(await runtime.runPromise(state("other"))).toEqual(admitted);
    expect(dispatched).toEqual([]);
  });

  it("rolls back an interrupted transaction before commit on its single connection", async () => {
    notificationFails = false;
    const hold = Effect.runSync(Deferred.make<void>());
    transactionHold = hold;
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(remove, { signal: controller.signal });
    try {
      await Effect.runPromise(Deferred.await(transactionEntered));
      expect(await observe(state())).toEqual(targetAdmitted);
      controller.abort();
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(await runtime.runPromise(state())).toEqual(targetAdmitted);
      expect(await runtime.runPromise(state("other"))).toEqual(admitted);
      expect(dispatched).toEqual([]);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(hold, undefined));
      await completion;
    }
  });

  it("dispatches both local cleanup jobs despite interruption between commit and handoff", async () => {
    notificationFails = false;
    const hold = Effect.runSync(Deferred.make<void>());
    commitHold = hold;
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(remove, { signal: controller.signal });
    try {
      await Effect.runPromise(Deferred.await(committed));
      expect(await observe(state())).toEqual(revoked);
      expect(dispatched).toEqual([]);
      controller.abort();
      Effect.runSync(Deferred.succeed(hold, undefined));
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      await Effect.runPromise(Deferred.await(cleanupStarted));
      expect(dispatched.toSorted()).toEqual(["close:removed", "windDown:removed"]);
      expect(await runtime.runPromise(state())).toEqual(revoked);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(hold, undefined));
      await completion;
    }
  });

  it("keeps committed revocations and dispatched cleanup when a notification is interrupted", async () => {
    const hold = Effect.runSync(Deferred.make<void>());
    notificationHold = hold;
    const controller = new AbortController();
    const completion = runtime.runPromiseExit(remove, { signal: controller.signal });
    try {
      await Effect.runPromise(Deferred.await(notificationEntered));
      expect(await observe(state())).toEqual(revoked);
      await Effect.runPromise(Deferred.await(cleanupStarted));
      expect(dispatched.toSorted()).toEqual(["close:removed", "windDown:removed"]);
      controller.abort();
      const exit = await completion;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(await runtime.runPromise(state())).toEqual(revoked);
      expect(await runtime.runPromise(state("other"))).toEqual(admitted);
    } finally {
      controller.abort();
      Effect.runSync(Deferred.succeed(hold, undefined));
      await completion;
    }
  });

  it("preserves the last owner and refuses a membership in another organization", async () => {
    for (const request of [
      { ...input, organizationId: OrganizationId.make("org-other"), userId: "other" },
      { ...input, userId: "other" },
    ]) {
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(MemberRemoval, (service) => service.remove(request)),
      );
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true);
      expect(await runtime.runPromise(state())).toEqual(targetAdmitted);
      expect(await runtime.runPromise(state("other"))).toEqual(admitted);
      expect(dispatched).toEqual([]);
    }
  });
});
