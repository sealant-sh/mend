import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId, ResourceDefinitionId, WorktreeId } from "../ids.ts";
import {
  ownDatabaseName,
  baseDatabaseName,
  worktreeDatabaseName,
  WORKTREE_DATABASE,
  resourceBindings,
  reachAliases,
  type ResourceBindingRows,
  resourceInstanceKey,
  resourceInstanceSpec,
  resourceProcessEnv,
  resourceScopeKey,
  secretEnvLeftOut,
  shellExports,
} from "./resource-runtime.ts";
import { presetDefinition, PresetVersion, ResourceDefinition, ResourceName } from "./resource.ts";

const preset = (
  name: string,
  kind: "postgres" | "redis" | "mysql",
  _level: "project" | "worktree" = "project",
) =>
  presetDefinition({
    name: ResourceName.make(name),
    preset: kind,
    version: PresetVersion.make(kind === "postgres" ? "17" : "8"),
  });
const mail = Schema.decodeUnknownSync(ResourceDefinition)({
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
  it("uses the operator's resource idle bound", () => {
    expect(
      resourceInstanceSpec({
        definition: preset("db", "postgres"),
        image: "postgres:17",
        worktreeId: worktree,
        idleStopAfterSeconds: 3,
      }).idleStopAfterSeconds,
    ).toBe(3);
  });

  it("keeps base and own names distinct for the same worktree", () => {
    const base = baseDatabaseName(worktree);
    expect(base).toMatch(/^base_[0-9a-f]{12}$/);
    expect(base.slice(5)).toBe(own.slice(4));
    expect(base).not.toBe(own);
    expect(worktreeDatabaseName(worktree, "base")).toBe(base);
    expect(worktreeDatabaseName(worktree, "own")).toBe(own);
    expect(WORKTREE_DATABASE.test(base)).toBe(true);
    expect(WORKTREE_DATABASE.test("base_x; DROP DATABASE app")).toBe(false);
  });

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
    expect(spec.worktreeKey).toBe(worktree);
  });
});

describe("bindings, reach and current env", () => {
  const id = ResourceDefinitionId.make("resource");
  const envOf = (
    definition: ResourceDefinition,
    level: "project" | "worktree",
    database: string | null = null,
  ) =>
    resourceProcessEnv({
      bindings: [{ definition, level, database, resourceId: id, instanceKey: "resource" }],
      worktreeId: worktree,
      projectEnvNames: new Set(),
    }).env;
  it.each(["postgres", "redis", "mysql", null] as const)(
    "resolves the choice × rows truth table for %s",
    (kind) => {
      const spec = kind === null ? mail : preset("test", kind);
      for (const mode of ["project", "worktree", "off", null] as const)
        for (const visible of [true, false])
          for (const projectExists of [true, false])
            for (const ownExists of [true, false]) {
              const rows: ResourceBindingRows = {
                worktreeId: worktree,
                usesProjectResources: visible,
                resources: [{ id, name: spec.name }],
                instances: [
                  ...(projectExists ? [{ resourceId: id, worktreeId: null, spec }] : []),
                  ...(kind !== "postgres" && ownExists
                    ? [{ resourceId: id, worktreeId: worktree, spec }]
                    : []),
                ],
                selections: mode === null ? [] : [{ resourceId: id, mode }],
                ownDatabases: new Set(ownExists ? [id] : []),
              };
              const choice = mode ?? (visible ? "project" : "off");
              const available =
                choice === "project"
                  ? projectExists
                  : choice === "worktree"
                    ? ownExists && (kind !== "postgres" || projectExists)
                    : false;
              const bindings = resourceBindings(rows);
              expect(bindings.length).toBe(available ? 1 : 0);
              if (available) {
                expect(bindings[0]?.level).toBe(choice);
                expect(bindings[0]?.instanceKey).toBe(
                  choice === "worktree" && kind !== "postgres"
                    ? `resource@${worktree}`
                    : "resource",
                );
                expect(reachAliases(bindings)).toEqual({
                  [spec.name]: kind === "postgres" ? "project" : choice,
                });
              } else expect(reachAliases(bindings)).toEqual({});
            }
    },
  );
  it.each(["project", "worktree"] as const)(
    "gives Postgres only the specified exports at %s level",
    (level) => {
      const database = level === "project" ? "app" : own;
      expect(envOf(preset("db", "postgres"), level, database)).toEqual({
        MEND_DB_URL: `postgres://postgres@db:5432/${database}`,
        MEND_DB_HOST: "db",
        MEND_DB_PORT: "5432",
        MEND_DB_USER: "postgres",
        MEND_DB_PASSWORD: "",
        MEND_DB_DATABASE: database,
      });
    },
  );
  it.each(["project", "worktree"] as const)(
    "gives other presets and images URL, host, port and declared exports at %s level",
    (level) => {
      expect(envOf(preset("cache", "redis"), level)).toEqual({
        MEND_CACHE_URL: "redis://cache:6379",
        MEND_CACHE_HOST: "cache",
        MEND_CACHE_PORT: "6379",
      });
      expect(envOf(preset("db", "mysql"), level)).toEqual({
        MEND_DB_URL: "mysql://root@db:3306/app",
        MEND_DB_HOST: "db",
        MEND_DB_PORT: "3306",
      });
      expect(envOf(mail, level)).toEqual({
        MEND_MAIL_URL: "tcp://mail:1025",
        MEND_MAIL_HOST: "mail",
        MEND_MAIL_PORT: "1025",
        MEND_MAIL_SMTP_URL: "smtp://mail:1025",
      });
      expect(
        envOf({ ...mail, exports: { URL: "smtp://{host}:{port.smtp}" } }, level).MEND_MAIL_URL,
      ).toBe("smtp://mail:1025");
      expect(
        envOf({ ...mail, ports: [{ name: "dns", port: 53, protocol: "udp" }], exports: {} }, level)
          .MEND_MAIL_URL,
      ).toBe("udp://mail:53");
    },
  );
  it("leaves env and secret names the project already sets untouched", () => {
    const result = resourceProcessEnv({
      bindings: [
        {
          definition: preset("db", "postgres"),
          level: "project",
          resourceId: id,
          instanceKey: "resource",
          database: "app",
        },
      ],
      worktreeId: worktree,
      projectEnvNames: new Set(["MEND_DB_URL", "MEND_DB_HOST"]),
    });
    expect(result.env.MEND_DB_URL).toBeUndefined();
    expect(result.env.MEND_DB_HOST).toBeUndefined();
    expect(result.left).toEqual([{ resource: "db", names: ["MEND_DB_URL", "MEND_DB_HOST"] }]);
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
