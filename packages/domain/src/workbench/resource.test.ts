import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  choicesFor,
  defaultChoiceFor,
  envNameCollisions,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  resourceEnvNames,
  resourceEnvPrefix,
  ResourceName,
  resourceNameIssue,
  WorktreeSelection,
} from "./resource.ts";

const decode = Schema.decodeUnknownSync(ResourceDefinitionInput);

const define = (overrides: Record<string, unknown> = {}): ResourceDefinitionInput =>
  decode({
    name: "queue",
    scope: "project",
    preset: null,
    image: "rabbitmq:4-management",
    command: null,
    ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
    env: {},
    volumes: [{ name: "data", mountPath: "/var/lib/rabbitmq" }],
    ready: { kind: "tcp" },
    exports: {},
    ...overrides,
  });

describe("resource names", () => {
  it.each(["db", "queue", "mail-catcher", "a", "a2", `a${"b".repeat(30)}`])(
    "accepts the DNS label %s",
    (name) => {
      expect(resourceNameIssue(name)).toBeNull();
      expect(Schema.is(ResourceName)(name)).toBe(true);
    },
  );

  it.each(["", "Db", "2db", "-db", "db_main", "db.main", `a${"b".repeat(31)}`])(
    "refuses %j, which is not one DNS label",
    (name) => {
      expect(resourceNameIssue(name)).toMatch(/DNS label/);
      expect(Schema.is(ResourceName)(name)).toBe(false);
    },
  );

  it.each(["docker", "localhost", "host", "mend", "garage", "postgres"])(
    "refuses %s, which a workspace already resolves",
    (name) => {
      expect(resourceNameIssue(name)).toMatch(/reserved/);
      expect(Schema.is(ResourceName)(name)).toBe(false);
    },
  );

  it("refuses a name ending in .internal by saying so", () => {
    expect(resourceNameIssue("db.mend.internal")).toMatch(/\.internal/);
  });
});

describe("a definition's shape", () => {
  it("fills decision G3's limits when they are absent", () => {
    expect(define().limits).toEqual({ cpu: 1, memoryMiB: 1024, diskGiB: 10 });
    expect(define({ limits: { memoryMiB: 4096 } }).limits).toEqual({
      cpu: 1,
      memoryMiB: 4096,
      diskGiB: 10,
    });
  });

  it.each([
    ["a port of 0", { ports: [{ name: "amqp", port: 0, protocol: "tcp" }] }],
    ["a port above 65535", { ports: [{ name: "amqp", port: 65536, protocol: "tcp" }] }],
    ["a relative mount path", { volumes: [{ name: "data", mountPath: "var/lib" }] }],
    ["a mount path that leaves /", { volumes: [{ name: "data", mountPath: "/var/../etc" }] }],
    ["the root as a mount path", { volumes: [{ name: "data", mountPath: "/" }] }],
    ["an empty probe command", { ready: { kind: "command", argv: [] } }],
    ["a reserved name", { name: "postgres" }],
  ])("refuses %s", (_, overrides) => {
    expect(() => define(overrides)).toThrow();
  });

  it("takes a literal env value or a project secret by name", () => {
    const def = define({ env: { USER: "app", PASS: { secret: "rabbitmq-password" } } });
    expect(def.env).toEqual({ USER: "app", PASS: { secret: "rabbitmq-password" } });
  });
});

describe("rules across a definition's fields", () => {
  it("accepts the ADR's queue", () => {
    const def = define({
      env: { RABBITMQ_DEFAULT_PASS: { secret: "rabbitmq-password" } },
      exports: { URL: "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" },
    });
    expect(resourceDefinitionRefusals(def)).toEqual([]);
  });

  it.each([
    [
      "two ports of one name",
      {
        ports: [
          { name: "http", port: 8025, protocol: "tcp" },
          { name: "http", port: 8026, protocol: "tcp" },
        ],
      },
      "ports.http",
    ],
    ["no port", { ports: [] }, "ports"],
    [
      "two volumes of one name",
      {
        volumes: [
          { name: "data", mountPath: "/a" },
          { name: "data", mountPath: "/b" },
        ],
      },
      "volumes.data",
    ],
    [
      "two volumes at one path",
      {
        volumes: [
          { name: "a", mountPath: "/data" },
          { name: "b", mountPath: "/data" },
        ],
      },
      "volumes",
    ],
    ["a preset's check without a preset", { ready: { kind: "preset" } }, "ready"],
    [
      "exports on a preset",
      { preset: "postgres", name: "db", exports: { URL: "postgres://{host}" } },
      "exports",
    ],
    ["an export Mend already sets", { exports: { HOST: "{host}" } }, "exports.HOST"],
    ["an export over a named port", { exports: { PORT_AMQP: "{port}" } }, "exports.PORT_AMQP"],
    ["an export of an unknown port", { exports: { URL: "{host}:{port.http}" } }, "exports.URL"],
    ["an export of an env the definition lacks", { exports: { URL: "{env.PASS}" } }, "exports.URL"],
    ["a worktree Redis", { preset: "redis", name: "cache", scope: "worktree" }, "scope"],
  ])("refuses %s by its key", (_, overrides, key) => {
    expect(resourceDefinitionRefusals(define(overrides)).map((refusal) => refusal.key)).toEqual([
      key,
    ]);
  });

  it("says why a worktree Redis waits", () => {
    const [refusal] = resourceDefinitionRefusals(
      define({ preset: "redis", name: "cache", scope: "worktree" }),
    );
    expect(refusal?.message).toMatch(/Redis/);
    expect(refusal?.message).toMatch(/project/);
  });
});

describe("the scope policy", () => {
  it.each([
    ["project", "postgres", ["shared", "own", "off"], "own"],
    ["project", "mysql", ["shared", "own", "off"], "own"],
    ["project", "redis", ["shared", "off"], "shared"],
    ["project", null, ["shared", "own", "off"], "shared"],
    ["worktree", "postgres", [], null],
    ["worktree", "mysql", [], null],
    ["worktree", null, [], null],
    ["worktree", "redis", [], null],
  ] as const)("%s %s offers %j and defaults to %s", (scope, preset, choices, chosen) => {
    expect(choicesFor({ scope, preset })).toEqual(choices);
    expect(defaultChoiceFor({ scope, preset })).toBe(chosen);
  });

  it("offers no own Redis at project scope", () => {
    expect(choicesFor({ scope: "project", preset: "redis" })).not.toContain("own");
  });

  it("lets every non-refused definition through validation", () => {
    for (const [scope, preset, name] of [
      ["project", "postgres", "db"],
      ["project", "mysql", "db"],
      ["project", "redis", "cache"],
      ["project", null, "queue"],
      ["worktree", "postgres", "db"],
      ["worktree", "mysql", "db"],
      ["worktree", null, "mail"],
    ] as const) {
      expect(resourceDefinitionRefusals(define({ scope, preset, name }))).toEqual([]);
    }
  });
});

describe("a worktree's selection", () => {
  const read = Schema.decodeUnknownSync(WorktreeSelection);

  it("reads each mode, with own naming a database or an instance", () => {
    expect(read({ mode: "off", revision: 1 }).mode).toBe("off");
    expect(read({ mode: "shared", revision: 2 }).mode).toBe("shared");
    expect(
      read({ mode: "own", revision: 3, target: { kind: "database", database: "d1" } }),
    ).toEqual({ mode: "own", revision: 3, target: { kind: "database", database: "d1" } });
    expect(
      read({ mode: "own", revision: 3, target: { kind: "instance", instance: "i1" } }),
    ).toEqual({ mode: "own", revision: 3, target: { kind: "instance", instance: "i1" } });
  });

  it.each([
    ["own without a target", { mode: "own", revision: 1 }],
    ["a negative revision", { mode: "shared", revision: -1 }],
    ["a mode outside off, shared and own", { mode: "copy", revision: 1 }],
    [
      "a database target carrying an instance",
      { mode: "own", revision: 1, target: { kind: "database", instance: "i1" } },
    ],
  ])("refuses %s", (_, raw) => {
    expect(() => read(raw)).toThrow();
  });
});

const postgres = (name = "db") =>
  define({
    name,
    preset: "postgres",
    image: "postgres:17",
    ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
    ready: { kind: "preset" },
  });

const redis = (name = "cache") =>
  define({
    name,
    preset: "redis",
    image: "redis:8",
    ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/data" }],
    ready: { kind: "preset" },
  });

describe("env names", () => {
  it("writes the name in upper case with - as _", () => {
    expect(resourceEnvPrefix(ResourceName.make("mail-catcher"))).toBe(
      "MEND_RESOURCE_MAIL_CATCHER_",
    );
  });

  it("gives the host, the first port, each named port and the exports", () => {
    const mail = define({
      name: "mail-catcher",
      image: "axllent/mailpit:v1.21",
      ports: [
        { name: "smtp", port: 1025, protocol: "tcp" },
        { name: "web-ui", port: 8025, protocol: "tcp" },
      ],
      exports: { SMTP_URL: "smtp://{host}:{port.smtp}" },
    });
    expect(resourceEnvNames(mail, { onlyOfItsEngine: true })).toEqual([
      "MEND_RESOURCE_MAIL_CATCHER_HOST",
      "MEND_RESOURCE_MAIL_CATCHER_PORT",
      "MEND_RESOURCE_MAIL_CATCHER_PORT_SMTP",
      "MEND_RESOURCE_MAIL_CATCHER_PORT_WEB_UI",
      "MEND_RESOURCE_MAIL_CATCHER_SMTP_URL",
    ]);
  });

  it("gives a Postgres preset its fixed exports, and DATABASE_URL and PG* only when it is the one Postgres", () => {
    const fixed = [
      "MEND_RESOURCE_DB_HOST",
      "MEND_RESOURCE_DB_PORT",
      "MEND_RESOURCE_DB_PORT_POSTGRES",
      "MEND_RESOURCE_DB_URL",
      "MEND_RESOURCE_DB_DATABASE",
      "MEND_RESOURCE_DB_USERNAME",
      "MEND_RESOURCE_DB_PASSWORD",
    ];
    expect(resourceEnvNames(postgres(), { onlyOfItsEngine: false })).toEqual(fixed);
    expect(resourceEnvNames(postgres(), { onlyOfItsEngine: true })).toEqual([
      ...fixed,
      "DATABASE_URL",
      "PGHOST",
      "PGPORT",
      "PGUSER",
      "PGPASSWORD",
      "PGDATABASE",
    ]);
  });

  it("gives Redis _URL, and REDIS_URL only when it is the one Redis", () => {
    expect(resourceEnvNames(redis(), { onlyOfItsEngine: false })).toContain(
      "MEND_RESOURCE_CACHE_URL",
    );
    expect(resourceEnvNames(redis(), { onlyOfItsEngine: false })).not.toContain("REDIS_URL");
    expect(resourceEnvNames(redis(), { onlyOfItsEngine: true })).toContain("REDIS_URL");
    expect(resourceEnvNames(redis(), { onlyOfItsEngine: true })).not.toContain("DATABASE_URL");
  });

  it("gives an image Mend does not know no conventional names", () => {
    expect(resourceEnvNames(define(), { onlyOfItsEngine: true })).toEqual([
      "MEND_RESOURCE_QUEUE_HOST",
      "MEND_RESOURCE_QUEUE_PORT",
      "MEND_RESOURCE_QUEUE_PORT_AMQP",
    ]);
  });
});

describe("env name collisions", () => {
  it("finds none between distinct resources", () => {
    expect(envNameCollisions([postgres(), redis(), define()])).toEqual([]);
  });

  it("reports an export that lands on another resource's name", () => {
    const db = define({ name: "db", exports: { MAIN_URL: "{host}" } });
    expect(envNameCollisions([db, postgres("db-main")])).toEqual([
      { name: "MEND_RESOURCE_DB_MAIN_URL", resources: ["db", "db-main"] },
    ]);
  });

  it("reports a named port that lands on another resource's host", () => {
    const db = define({ name: "db", ports: [{ name: "host", port: 1, protocol: "tcp" }] });
    const dbPort = define({ name: "db-port" });
    expect(envNameCollisions([db, dbPort])).toEqual([
      { name: "MEND_RESOURCE_DB_PORT_HOST", resources: ["db", "db-port"] },
    ]);
  });

  it("leaves the conventional names out when two of one engine are in use", () => {
    expect(envNameCollisions([postgres("db"), postgres("analytics")])).toEqual([]);
  });
});
