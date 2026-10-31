import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId, ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  ownDatabaseName,
  resourceBindings,
  resourceInstanceKey,
  resourceInstanceSpec,
  resourceProcessEnv,
  resourceScopeKey,
  secretEnvLeftOut,
  shellExports,
} from "./resource-runtime.ts";
import {
  presetDefinition,
  PresetVersion,
  ProjectResourceDefinition,
  ResourceName,
  WorktreeResourceDefinition,
} from "./resource.ts";

const preset = (
  name: string,
  kind: "postgres" | "redis" | "mysql",
  scope: "project" | "worktree" = "project",
) =>
  presetDefinition({
    name: ResourceName.make(name),
    preset: kind,
    version: PresetVersion.make(kind === "postgres" ? "17" : "8"),
    scope,
  });
const mail = Schema.decodeUnknownSync(WorktreeResourceDefinition)({
  name: "mail",
  scope: "worktree",
  preset: null,
  image: "axllent/mailpit:v1.21",
  command: null,
  ports: [
    { name: "smtp", port: 1025, protocol: "tcp" },
    { name: "http", port: 8025, protocol: "tcp" },
  ],
  env: { MP_MAX_MESSAGES: "500", MP_UI_AUTH: { secret: "MAILPIT_UI_AUTH" } },
  volumes: [],
  ready: { kind: "tcp" },
  exports: { SMTP_URL: "smtp://{host}:{port.smtp}", AUTH: "{env.MP_UI_AUTH}" },
});

const worktree = WorktreeId.make("wt-6f1c0e2a");
const own = ownDatabaseName(worktree);

describe("a worktree's own database", () => {
  it("is own_ and the first 12 hex of the sha256 of the worktree id", () => {
    const hex = createHash("sha256").update("wt-6f1c0e2a").digest("hex").slice(0, 12);
    expect(own).toBe(`own_${hex}`);
  });

  it("is the same name every time, and another worktree's is another", () => {
    expect(ownDatabaseName(worktree)).toBe(own);
    expect(ownDatabaseName(WorktreeId.make("wt-other"))).not.toBe(own);
  });
});

describe("keys", () => {
  const definition = ResourceDefinitionId.make("rdef_0b4e");
  it("keys the scope by project and an instance by definition, and worktree when it has one", () => {
    expect(resourceScopeKey(ProjectId.make("p1"))).toBe("mend:p1");
    expect(resourceInstanceKey(definition, null)).toBe("rdef_0b4e");
    expect(resourceInstanceKey(definition, worktree)).toBe("rdef_0b4e@wt-6f1c0e2a");
  });
});

describe("what Sealant runs", () => {
  const image = `postgres:17@sha256:${"a".repeat(64)}`;

  it("runs a Postgres with no password, the shared database, its dumps volume and pg_isready", () => {
    const spec = resourceInstanceSpec({
      definition: preset("db", "postgres"),
      image,
      worktreeId: null,
    });
    expect(spec).toMatchObject({
      alias: "db",
      worktreeKey: null,
      image,
      command: ["-c", "fsync=on", "-c", "synchronous_commit=on"],
      env: { POSTGRES_HOST_AUTH_METHOD: "trust", POSTGRES_DB: "app" },
      volumes: [
        { name: "data", mountPath: "/var/lib/postgresql/data" },
        { name: "dumps", mountPath: "/mend/dumps" },
      ],
      limits: { cpuMillicores: 1000, memoryBytes: 1024 * 1024 * 1024 },
      ready: {
        kind: "exec",
        argv: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "app"],
        user: "postgres",
      },
      idleStopAfterSeconds: 1800,
    });
  });

  it("runs a Redis with every write durable and nothing evicted, ready on its port", () => {
    const spec = resourceInstanceSpec({
      definition: preset("cache", "redis"),
      image,
      worktreeId: null,
    });
    expect(spec.command).toEqual([
      "--appendonly",
      "yes",
      "--appendfsync",
      "always",
      "--maxmemory-policy",
      "noeviction",
    ]);
    expect(spec.ready).toEqual({ kind: "tcp", port: 6379 });
  });

  it("runs another image with its literal env, ready on its first TCP port, for its worktree only", () => {
    const spec = resourceInstanceSpec({ definition: mail, image, worktreeId: worktree });
    expect(spec.worktreeKey).toBe(worktree);
    expect(spec.env).toEqual({ MP_MAX_MESSAGES: "500" });
    expect(spec.ready).toEqual({ kind: "tcp", port: 1025 });
    expect(secretEnvLeftOut(mail)).toEqual(["MP_UI_AUTH"]);
  });

  it("keys a project resource to no worktree, wherever it was read from", () => {
    const spec = resourceInstanceSpec({
      definition: preset("db", "postgres"),
      image,
      worktreeId: worktree,
    });
    expect(spec.worktreeKey).toBeNull();
  });
});

describe("how a worktree uses each resource", () => {
  const db = preset("db", "postgres");
  const cache = preset("cache", "redis");

  it("takes the stored choice, the default when none, and binds nothing for off", () => {
    expect(
      resourceBindings([
        { spec: db, choice: null },
        { spec: cache, choice: "off" },
        { spec: mail, choice: null },
      ]).map((binding) => [binding.definition.name, binding.mode]),
    ).toEqual([
      ["db", "own"],
      ["mail", "worktree"],
    ]);
  });

  it("falls back to the default for a choice the policy no longer offers", () => {
    const [binding] = resourceBindings([{ spec: cache, choice: "own" }]);
    expect(binding?.mode).toBe("shared");
  });

  it("binds a worktree Redis nowhere, since the policy refuses it", () => {
    expect(resourceBindings([{ spec: preset("q", "redis", "worktree"), choice: null }])).toEqual(
      [],
    );
  });
});

describe("the env every process in a worktree gets", () => {
  const project = Schema.decodeUnknownSync(ProjectResourceDefinition);
  const db = project(preset("db", "postgres"));
  const cache = project(preset("cache", "redis"));
  const none = new Set<string>();
  const envOf = (
    bindings: Parameters<typeof resourceProcessEnv>[0]["bindings"],
    projectEnvNames: ReadonlySet<string> = none,
  ) => resourceProcessEnv({ bindings, worktreeId: worktree, projectEnvNames });

  it.each([
    [
      "an own Postgres: its own database, and DATABASE_URL and PG* for the one Postgres",
      [{ definition: db, mode: "own" as const }],
      {
        MEND_RESOURCE_DB_HOST: "db",
        MEND_RESOURCE_DB_PORT: "5432",
        MEND_RESOURCE_DB_PORT_POSTGRES: "5432",
        MEND_RESOURCE_DB_URL: `postgres://postgres@db:5432/${own}`,
        MEND_RESOURCE_DB_DATABASE: own,
        MEND_RESOURCE_DB_USERNAME: "postgres",
        DATABASE_URL: `postgres://postgres@db:5432/${own}`,
        PGHOST: "db",
        PGPORT: "5432",
        PGUSER: "postgres",
        PGDATABASE: own,
      },
    ],
    [
      "a shared Postgres: the database app",
      [{ definition: db, mode: "shared" as const }],
      expect.objectContaining({
        DATABASE_URL: "postgres://postgres@db:5432/app",
        PGDATABASE: "app",
      }),
    ],
    [
      "a Redis: its URL, and REDIS_URL for the one Redis",
      [{ definition: cache, mode: "shared" as const }],
      {
        MEND_RESOURCE_CACHE_HOST: "cache",
        MEND_RESOURCE_CACHE_PORT: "6379",
        MEND_RESOURCE_CACHE_PORT_REDIS: "6379",
        MEND_RESOURCE_CACHE_URL: "redis://cache:6379",
        REDIS_URL: "redis://cache:6379",
      },
    ],
    [
      "another image: host, ports and the exports it can fill",
      [{ definition: mail, mode: "worktree" as const }],
      {
        MEND_RESOURCE_MAIL_HOST: "mail",
        MEND_RESOURCE_MAIL_PORT: "1025",
        MEND_RESOURCE_MAIL_PORT_SMTP: "1025",
        MEND_RESOURCE_MAIL_PORT_HTTP: "8025",
        MEND_RESOURCE_MAIL_SMTP_URL: "smtp://mail:1025",
      },
    ],
  ])("gives %s", (_, bindings, env) => {
    expect(envOf(bindings).env).toEqual(env);
  });

  it("gives two Postgres neither DATABASE_URL nor PG*", () => {
    const { env } = envOf([
      { definition: db, mode: "own" },
      { definition: project(preset("analytics", "postgres")), mode: "shared" },
    ]);
    expect(env["MEND_RESOURCE_ANALYTICS_URL"]).toBe("postgres://postgres@analytics:5432/app");
    expect(Object.keys(env).filter((name) => !name.startsWith("MEND_RESOURCE_"))).toEqual([]);
  });

  it("leaves a name the project sets as it is, and says which", () => {
    const { env, left } = envOf(
      [{ definition: db, mode: "own" }],
      new Set(["DATABASE_URL", "PGHOST"]),
    );
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["PGHOST"]).toBeUndefined();
    expect(env["PGDATABASE"]).toBe(own);
    expect(left).toEqual([{ resource: "db", names: ["DATABASE_URL", "PGHOST"] }]);
  });

  it("answers nothing for a worktree that uses nothing", () => {
    expect(envOf([])).toEqual({ env: {}, left: [] });
  });
});

describe("exports a shell reads back", () => {
  it("single-quotes each value, closing the quote around a quote, so a shell expands nothing", () => {
    const env = { B: "it's $HOME `x`", A: "postgres://postgres@db:5432/app" };
    const lines = shellExports(env);
    expect(lines).toEqual([
      "export A='postgres://postgres@db:5432/app'",
      `export B='it'\\''s $HOME \`x\`'`,
    ]);
  });
});
