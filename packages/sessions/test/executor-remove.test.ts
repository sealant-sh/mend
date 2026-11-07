import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgClient } from "@effect/sql-pg";
import { ExecutorIdentity } from "@mend/auth";
import {
  ExecutorInstancesRepo,
  ExecutorInstancesRepoLive,
  ExecutorRepo,
  ExecutorRepoLive,
  MendDBLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId } from "@mend/domain";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { CallerServices, SealantPlatformError, type ScopeInstance } from "@mend/sealant";
import { MendKeysConfig, SecretCipher, SecretCipherLive, StoreConfig } from "@mend/store";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MendRunExecutor, MendRunExecutorLive } from "../src/executor/mend-run.ts";
import { ExecutorTransport } from "../src/executor/transport.ts";

const pg = postgresTestConfig();
const database = `mend_executor_remove_${process.pid}_${Date.now()}`;
const url = new URL(pg.adminUrl);
url.pathname = `/${database}`;
const root = await fs.mkdtemp(join(tmpdir(), "exrun-remove-test-"));
const org = OrganizationId.make("remove-fixture");
const scopeKey = "mend:remove-fixture";
const backupDirectory = join(
  root,
  "executor-backups",
  createHash("sha256").update(scopeKey).digest("hex"),
);
const admin = PgClient.layer({ url: Redacted.make(pg.adminUrl) });
const databaseLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url.href), maxConnections: 6 })),
);
const repos = Layer.mergeAll(ExecutorInstancesRepoLive, ExecutorRepoLive).pipe(
  Layer.provideMerge(databaseLayer),
);
const cipher = SecretCipherLive.pipe(Layer.provide(MendKeysConfig.layerFor(join(root, "keys"))));
const observed = (id: string): ScopeInstance => ({
  id,
  key: "executor",
  alias: "executor",
  worktreeKey: null,
  specDigest: "fixture",
  desired: "running",
  stopReason: null,
  state: { kind: "running", since: new Date() },
  observedAt: new Date(),
  startedAt: new Date(),
  lastReachedAt: null,
  volumes: [{ name: "data", dockerName: "fixture-volume" }],
});
let instance: ScopeInstance | null;
let trace: string[];
let losePurgeReply: boolean;
const caller = Layer.succeed(CallerServices, {
  organization: () =>
    Effect.succeed({
      get: () => Effect.sync(() => instance),
      up: () => Effect.die("Remove must not start Executor"),
      backup: () => Effect.die("Remove must not create a backup"),
      stop: () =>
        Effect.sync(() => {
          trace.push("stop");
          if (instance === null) throw new Error("No instance to stop");
          instance = {
            ...instance,
            desired: "stopped",
            state: { kind: "stopped", at: new Date(), reason: { kind: "person", by: "fixture" } },
          };
          return instance;
        }),
      purge: (id) =>
        Effect.gen(function* () {
          trace.push(`purge:${id}`);
          if (instance !== null && (instance.id !== id || instance.desired !== "stopped"))
            return yield* Effect.die("Purge requires the observed identity, stopped first");
          instance = null;
          if (losePurgeReply) {
            losePurgeReply = false;
            return yield* new SealantPlatformError({
              code: "ConnectionLost",
              status: null,
              message: "reply lost",
              cause: null,
            });
          }
        }),
    }),
});
const transport = Layer.succeed(ExecutorTransport, {
  service: () => Effect.die("Remove must not read services"),
  register: () => Effect.die("Remove must not register"),
  grant: () => Effect.die("Remove must not issue grants"),
  revoke: () => Effect.die("Purge deletes grants with the volume"),
  mcp: () => Effect.die("Remove must not call tools"),
});
const services = MendRunExecutorLive.pipe(
  Layer.provide(
    Layer.succeed(ExecutorIdentity, {
      prepare: () => Effect.die("Remove must not prepare SSO"),
      authorize: () => Effect.die("Remove must not authorize"),
      remove: () => Effect.void,
      handle: () => Effect.die("Remove must not serve identity requests"),
      listen: Effect.void,
    }),
  ),
  Layer.provide(caller),
  Layer.provide(transport),
  Layer.provideMerge(repos),
  Layer.provideMerge(cipher),
  Layer.provide(StoreConfig.layerFor(root)),
  Layer.provide(
    Layer.succeed(NetworkConfig, makePublicNetwork(PublicOrigin.make("http://localhost:3445"), [])),
  ),
);
const run = <A, E>(
  program: Effect.Effect<
    A,
    E,
    MendRunExecutor | ExecutorInstancesRepo | ExecutorRepo | SecretCipher | SqlClient.SqlClient
  >,
) =>
  Effect.runPromise(
    program.pipe(
      Effect.provide(services),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { MEND_EXECUTOR_RUNTIME: "docker" } }),
      ),
      Effect.scoped,
    ),
  );
const act = (action: "remove" | "start") =>
  run(Effect.flatMap(MendRunExecutor, (service) => service.act(org, action)));
const retained = () =>
  run(
    Effect.gen(function* () {
      const row = yield* (yield* ExecutorInstancesRepo).get(org);
      const config = yield* (yield* ExecutorRepo).configuration(org);
      return {
        instance: row !== null,
        config: config !== null,
        links: config === null ? 0 : (yield* (yield* ExecutorRepo).links(config.id)).length,
      };
    }),
  );
let created = false;

describe.skipIf(pg.skip)(
  "Mend-run Executor removal through migrated PostgreSQL and sealed state",
  () => {
    beforeAll(async () => {
      await Effect.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`CREATE DATABASE ${database}`),
        ).pipe(Effect.provide(admin), Effect.scoped),
      );
      created = true;
      await Effect.runPromise(
        Effect.gen(function* () {
          for (const [, migrate] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migrate;
          yield* (yield* SqlClient.SqlClient)`INSERT INTO organizations (id,name) VALUES (${org},'Remove fixture')`;
        }).pipe(Effect.provide(databaseLayer), Effect.scoped),
      );
    });
    beforeEach(async () => {
      instance = observed("rin:original");
      trace = [];
      losePurgeReply = false;
      await fs.mkdir(backupDirectory, { recursive: true });
      await fs.writeFile(join(backupDirectory, "old.tar"), "saved service logins", { mode: 0o600 });
      await run(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient)`TRUNCATE executor_service_connections,executor_instances,executor_calls,executor_link_flows,executor_links,organization_executors`;
          const sealedState = yield* (yield* SecretCipher).encrypt(
            JSON.stringify({
              betterAuthSecret: "auth",
              encryptionKey: "encryption",
              ownerPassword: "password",
              ssoClientSecret: "sso",
            }),
          );
          yield* (yield* ExecutorInstancesRepo).save({
            organizationId: org,
            scopeKey,
            sealedState,
            appliedSpec: null,
            image: null,
            backupAt: new Date(),
            executorOrganizationId: "fixture-org",
          });
          const repo = yield* ExecutorRepo;
          yield* repo.saveConfiguration({
            id: "fixture-config",
            organizationId: org,
            mode: "mend-run",
            url: "http://executor.localhost:4400",
          });
          yield* repo.saveLink({
            id: "fixture-member",
            configurationId: "fixture-config",
            subject: "member",
            userId: null,
            state: "active",
            sealedCredentials: "sealed fixture grants",
            observedAt: new Date(),
          });
          yield* repo.saveFlow({
            stateHash: "fixture-flow",
            configurationId: "fixture-config",
            actorId: "fixture-person",
            subject: "person:fixture-person",
            sealedFlow: "sealed fixture flow",
            expiresAt: new Date(Date.now() + 60_000),
          });
        }),
      );
    });
    afterAll(async () => {
      if (created)
        await Effect.runPromise(
          Effect.flatMap(SqlClient.SqlClient, (sql) =>
            sql.unsafe(`DROP DATABASE ${database} WITH (FORCE)`),
          ).pipe(Effect.provide(admin), Effect.scoped),
        );
      await fs.readdir(root);
      await fs.rm(root, { recursive: true, force: true });
    });

    it("stops and purges the observed instance, deletes saved backups and grants, and repeats without effects", async () => {
      await act("remove");
      expect(trace).toEqual(["stop", "purge:rin:original"]);
      expect(await retained()).toEqual({ instance: false, config: false, links: 0 });
      await expect(fs.stat(backupDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await run(Effect.flatMap(ExecutorRepo, (repo) => repo.flows("fixture-config"))),
      ).toEqual([]);
      await act("remove");
      expect(trace).toHaveLength(2);
    });

    it("keeps the original identity after a lost purge reply and resumes across new service layers", async () => {
      losePurgeReply = true;
      await expect(act("remove")).rejects.toThrow("Sealant refused");
      expect(await retained()).toEqual({ instance: true, config: true, links: 1 });
      expect(await fs.readFile(join(backupDirectory, "old.tar"), "utf8")).toBe(
        "saved service logins",
      );
      await expect(act("start")).rejects.toThrow("removal has started");
      await act("remove");
      expect(trace).toEqual(["stop", "purge:rin:original", "purge:rin:original"]);
      expect(await retained()).toEqual({ instance: false, config: false, links: 0 });
    });

    it("refuses to purge a replacement with the same key after an interrupted removal", async () => {
      losePurgeReply = true;
      await expect(act("remove")).rejects.toThrow("Sealant refused");
      instance = observed("rin:replacement");
      await expect(act("remove")).rejects.toThrow("identity changed");
      expect(instance.id).toBe("rin:replacement");
      expect(trace).toEqual(["stop", "purge:rin:original"]);
      expect((await retained()).links).toBe(1);
    });

    it("keeps its sealed removal record until Mend-held backup cleanup finishes", async () => {
      await fs.readdir(backupDirectory);
      await fs.rm(backupDirectory, { recursive: true });
      await fs.writeFile(backupDirectory, "unreadable backup directory");
      await expect(act("remove")).rejects.toThrow("could not delete its saved backups");
      expect(instance).toBeNull();
      expect((await retained()).instance).toBe(true);
      expect(
        (await run(Effect.flatMap(MendRunExecutor, (service) => service.status(org)))).retained,
      ).toBe(true);
      await fs.readdir(join(root, "executor-backups"));
      await fs.unlink(backupDirectory);
      await act("remove");
      expect(trace).toEqual(["stop", "purge:rin:original", "purge:rin:original"]);
      expect((await retained()).instance).toBe(false);
    });
  },
);
