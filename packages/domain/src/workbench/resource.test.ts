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
  resourceStatusLine,
  type ResourceStatusView,
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

const postgres = (overrides: Record<string, unknown> = {}) =>
  define({
    name: "db",
    preset: "postgres",
    image: "postgres:17",
    ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
    ready: { kind: "preset" },
    ...overrides,
  });

const mysql = (overrides: Record<string, unknown> = {}) =>
  define({
    name: "db",
    preset: "mysql",
    image: "mysql:8.4",
    ports: [{ name: "mysql", port: 3306, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/var/lib/mysql" }],
    ready: { kind: "preset" },
    ...overrides,
  });

const redis = (overrides: Record<string, unknown> = {}) =>
  define({
    name: "cache",
    preset: "redis",
    image: "redis:8",
    ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
    volumes: [{ name: "data", mountPath: "/data" }],
    ready: { kind: "preset" },
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

  it.each(["", "Db", "2db", "-db", "db-", "db_main", "db.main", `a${"b".repeat(31)}`])(
    "refuses %j, which is not one DNS label",
    (name) => {
      expect(resourceNameIssue(name)).toMatch(/DNS label/);
      expect(Schema.is(ResourceName)(name)).toBe(false);
    },
  );

  it.each(["docker", "localhost", "host", "mend", "garage", "postgres"])(
    "refuses to declare %s, which a workspace already resolves, and still reads a stored one",
    (name) => {
      expect(resourceNameIssue(name)).toMatch(/reserved/);
      expect(Schema.is(ResourceName)(name)).toBe(true);
      expect(resourceDefinitionRefusals(define({ name })).map((refusal) => refusal.key)).toEqual([
        "name",
      ]);
    },
  );

  it("refuses a dotted name such as one ending in .internal", () => {
    expect(resourceNameIssue("db.mend.internal")).toMatch(/one DNS label/);
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
    [
      "a port name over 15 characters",
      { ports: [{ name: `a${"b".repeat(15)}`, port: 1, protocol: "tcp" }] },
    ],
    ["a port name with two dashes in a row", { ports: [{ name: "a--b", port: 1, protocol: "tcp" }] }],
    ["a port name that ends in a dash", { ports: [{ name: "amqp-", port: 1, protocol: "tcp" }] }],
    ["a relative mount path", { volumes: [{ name: "data", mountPath: "var/lib" }] }],
    ["a mount path that leaves /", { volumes: [{ name: "data", mountPath: "/var/../etc" }] }],
    ["the root as a mount path", { volumes: [{ name: "data", mountPath: "/" }] }],
    ["an empty probe command", { ready: { kind: "command", argv: [] } }],
    ["a probe command with no executable", { ready: { kind: "command", argv: [""] } }],
    ["a probe argument with a NUL byte", { ready: { kind: "command", argv: ["check", "a\0b"] } }],
    ["a command with no executable", { command: [""] }],
    ["a command argument with a NUL byte", { command: ["rabbitmq-server", "a\0b"] }],
  ])("refuses %s", (_, overrides) => {
    expect(() => define(overrides)).toThrow();
  });

  it("takes a port name of 15 characters", () => {
    const name = `a${"b".repeat(14)}`;
    expect(define({ ports: [{ name, port: 1, protocol: "tcp" }] }).ports[0]?.name).toBe(name);
  });

  it("takes an empty argument after the executable", () => {
    expect(define({ ready: { kind: "command", argv: ["sh", "-c", ""] } }).ready).toEqual({
      kind: "command",
      argv: ["sh", "-c", ""],
    });
  });

  it("takes a literal env value or a project secret by name", () => {
    const def = define({ env: { USER: "app", PASS: { secret: "RABBITMQ_PASSWORD" } } });
    expect(def.env).toEqual({ USER: "app", PASS: { secret: "RABBITMQ_PASSWORD" } });
  });
});

describe("rules across a definition's fields", () => {
  it("accepts the ADR's queue", () => {
    const def = define({
      env: { RABBITMQ_DEFAULT_PASS: { secret: "RABBITMQ_PASSWORD" } },
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
    ["an export Mend already sets", { exports: { HOST: "{host}" } }, "exports.HOST"],
    ["an export over a named port", { exports: { PORT_AMQP: "{port}" } }, "exports.PORT_AMQP"],
    ["an export of an unknown port", { exports: { URL: "{host}:{port.http}" } }, "exports.URL"],
    ["an export of an env the definition lacks", { exports: { URL: "{env.PASS}" } }, "exports.URL"],
    ["a secret no project secret can be called", { env: { PASS: { secret: "rabbitmq-password" } } }, "env.PASS.secret"],
    ["an empty secret name", { env: { PASS: { secret: "" } } }, "env.PASS.secret"],
    ["a secret in Mend's own namespace", { env: { PASS: { secret: "MEND_TOKEN" } } }, "env.PASS.secret"],
    ["an export with a { never closed", { exports: { URL: "amqp://{host}:{port.amqp" } }, "exports.URL"],
    ["an export with a } never opened", { exports: { URL: "amqp://{host}}" } }, "exports.URL"],
    ["an export with nested braces", { exports: { URL: "amqp://{{host}}:{port.amqp}" } }, "exports.URL"],
    [
      "an env key that is not an env name",
      { env: { "discovery.type": "single-node" } },
      "env.discovery.type",
    ],
    ["an export key in lower case", { exports: { url: "{host}" } }, "exports.url"],
    ["an export key that starts with _", { exports: { _HOST: "{host}" } }, "exports._HOST"],
  ])("refuses %s by its key", (_, overrides, key) => {
    expect(resourceDefinitionRefusals(define(overrides)).map((refusal) => refusal.key)).toEqual([
      key,
    ]);
  });

  it.each([
    ["exports on a preset", postgres({ exports: { URL: "postgres://{host}" } }), "exports"],
    ["a worktree Redis", redis({ scope: "worktree" }), "scope"],
    ["a Postgres preset on a Redis image", postgres({ image: "redis:8" }), "image"],
    ["a Postgres preset on an image of another name", postgres({ image: "ghcr.io/x/custom-pg:17" }), "image"],
    ["a MySQL preset on a Postgres image", mysql({ image: "postgres:17" }), "image"],
    ["a Redis preset on a MySQL image", redis({ image: "mariadb:11" }), "image"],
    ["a preset with a probe command", postgres({ ready: { kind: "command", argv: ["true"] } }), "ready"],
    ["a preset with a TCP check", redis({ ready: { kind: "tcp" } }), "ready"],
  ])("refuses %s by its key", (_, def, key) => {
    expect(resourceDefinitionRefusals(def).map((refusal) => refusal.key)).toEqual([key]);
  });

  it.each([
    [postgres, "postgres:17"],
    [postgres, "docker.io/library/postgres:17"],
    [postgres, "mirror.example:5000/postgres:17"],
    [postgres, "pgvector/pgvector:pg17"],
    [postgres, "postgis/postgis:17-3.5@sha256:abc"],
    [mysql, "mysql:8.4"],
    [mysql, "mariadb:11.4"],
    [redis, "redis:8"],
    [redis, "valkey/valkey:8"],
  ])("accepts an image of the preset's family: %#", (preset, image) => {
    expect(resourceDefinitionRefusals(preset({ image }))).toEqual([]);
  });

  it("says which brace an export leaves open", () => {
    const [refusal] = resourceDefinitionRefusals(define({ exports: { URL: "{host}:{port" } }));
    expect(refusal?.message).toMatch(/\{ at 7/);
  });

  it("says why a worktree Redis waits", () => {
    const [refusal] = resourceDefinitionRefusals(redis({ scope: "worktree" }));
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
    for (const def of [
      postgres(),
      mysql(),
      redis(),
      define(),
      postgres({ scope: "worktree" }),
      mysql({ scope: "worktree" }),
      define({ name: "mail", scope: "worktree" }),
    ]) {
      expect(resourceDefinitionRefusals(def)).toEqual([]);
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
    expect(envNameCollisions([db, postgres({ name: "db-main" })])).toEqual([
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
    expect(envNameCollisions([postgres(), postgres({ name: "analytics" })])).toEqual([]);
  });
});

describe("the status line", () => {
  const now = new Date("2026-10-30T14:30:03Z");
  const at = { now, timeZone: "UTC" };
  const threeSecondsAgo = new Date("2026-10-30T14:30:00Z");
  const queue = define({
    env: { RABBITMQ_DEFAULT_USER: "app", RABBITMQ_DEFAULT_PASS: "hunter2-literal" },
    exports: { URL: "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" },
  });
  const mail = define({
    name: "mail",
    scope: "worktree",
    image: "axllent/mailpit:v1.21",
    ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
    env: { MP_UI_AUTH: { secret: "MAILPIT_UI_AUTH" } },
  });

  const ownCopy: ResourceStatusView = {
    kind: "observed",
    definition: postgres(),
    use: { kind: "own", start: { kind: "copied", at: new Date("2026-10-30T14:02:00Z") } },
    observedAt: threeSecondsAgo,
  };

  const lines: ReadonlyArray<readonly [string, ResourceStatusView, string]> = [
    [
      "a worktree's own database copied from shared",
      ownCopy,
      "@db · postgres 17 · project · its own database · copied from shared 14:02 · observed 3 s ago",
    ],
    [
      "a shared instance and how many worktrees reach it",
      {
        kind: "observed",
        definition: queue,
        use: { kind: "shared", worktrees: 3 },
        observedAt: threeSecondsAgo,
      },
      "@queue · rabbitmq 4 · project · shared · reached by 3 worktrees · observed 3 s ago",
    ],
    [
      "a worktree resource",
      {
        kind: "observed",
        definition: mail,
        use: { kind: "worktree", state: "running" },
        observedAt: threeSecondsAgo,
      },
      "@mail · mailpit · worktree · running · observed 3 s ago",
    ],
    [
      "an instance a person stopped",
      { kind: "stopped-by", definition: postgres(), by: "Maria" },
      "@db · stopped by Maria · this session starts without it",
    ],
    [
      "a switch to the shared database",
      {
        kind: "switched",
        definition: postgres(),
        use: { kind: "shared", worktrees: 2 },
        restarted: [],
        waitingFor: [],
      },
      "@db · shared database · any worktree on shared can change or drop its tables",
    ],
    [
      "a switch that restarted a Service",
      {
        kind: "switched",
        definition: postgres(),
        use: { kind: "shared", worktrees: 2 },
        restarted: ["web"],
        waitingFor: [],
      },
      "@db · shared database · restarted web · any worktree on shared can change or drop its tables",
    ],
    [
      "a switch waiting for a terminal",
      {
        kind: "switched",
        definition: queue,
        use: { kind: "own", start: { kind: "empty" } },
        restarted: [],
        waitingFor: ["mend claude, pid 4211"],
      },
      "@queue · its own instance · empty · waiting for mend claude, pid 4211 to restart",
    ],
    [
      "a shared database in the list, with its warning",
      {
        kind: "observed",
        definition: postgres(),
        use: { kind: "shared", worktrees: 1 },
        observedAt: threeSecondsAgo,
      },
      "@db · postgres 17 · project · shared database · reached by 1 worktree · any worktree on shared can change or drop its tables · observed 3 s ago",
    ],
    [
      "an own instance from a snapshot, labelled crash-consistent",
      {
        kind: "observed",
        definition: queue,
        use: { kind: "own", start: { kind: "snapshot", at: new Date("2026-10-30T09:15:00Z") } },
        observedAt: threeSecondsAgo,
      },
      "@queue · rabbitmq 4 · project · its own instance · snapshot of shared 09:15 · crash-consistent · observed 3 s ago",
    ],
    [
      "a worktree that runs its own infra",
      { kind: "observed", definition: redis(), use: { kind: "off" }, observedAt: threeSecondsAgo },
      "@cache · redis 8 · project · off · observed 3 s ago",
    ],
  ];

  it.each(lines)("says %s", (_, view, line) => {
    expect(resourceStatusLine(view, at)).toBe(line);
  });

  it("reads clock times in the reader's time zone", () => {
    expect(resourceStatusLine(ownCopy, { now, timeZone: "Europe/Athens" })).toContain(
      "copied from shared 16:02",
    );
  });

  it("never prints a credential or a verdict", () => {
    for (const [, view] of lines) {
      const line = resourceStatusLine(view, at);
      expect(line).not.toContain("hunter2-literal");
      expect(line).not.toContain("MAILPIT_UI_AUTH");
      expect(line).not.toMatch(/healthy|safe|ready to/i);
    }
  });
});
