import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  choicesFor,
  defaultChoiceFor,
  envCollisionRefusals,
  envNameCollisions,
  ImageDigest,
  imageDigestOf,
  imageReference,
  onlyOfItsEngine,
  pinImage,
  presetDefinition,
  PresetVersion,
  type ResourceBinding,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  resourceEnvNames,
  resourceEnvPrefix,
  ResourceName,
  resourceNameIssue,
  resourceSpecDigest,
  secretEnvNames,
  selectionRefusal,
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
    [
      "a port name with two dashes in a row",
      { ports: [{ name: "a--b", port: 1, protocol: "tcp" }] },
    ],
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
    [
      "a TCP check on a resource with no TCP port",
      { ports: [{ name: "dns", port: 53, protocol: "udp" }], ready: { kind: "tcp" } },
      "ready",
    ],
    ["no check on a resource with a TCP port", { ready: { kind: "none" } }, "ready"],
    [
      "a secret no project secret can be called",
      { env: { PASS: { secret: "rabbitmq-password" } } },
      "env.PASS.secret",
    ],
    ["an empty secret name", { env: { PASS: { secret: "" } } }, "env.PASS.secret"],
    [
      "a secret in Mend's own namespace",
      { env: { PASS: { secret: "MEND_TOKEN" } } },
      "env.PASS.secret",
    ],
    [
      "an export with a { never closed",
      { exports: { URL: "amqp://{host}:{port.amqp" } },
      "exports.URL",
    ],
    ["an export with a } never opened", { exports: { URL: "amqp://{host}}" } }, "exports.URL"],
    [
      "an export with nested braces",
      { exports: { URL: "amqp://{{host}}:{port.amqp}" } },
      "exports.URL",
    ],
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
    [
      "a Postgres preset on an image of another name",
      postgres({ image: "ghcr.io/x/custom-pg:17" }),
      "image",
    ],
    ["a MySQL preset on a Postgres image", mysql({ image: "postgres:17" }), "image"],
    ["a Redis preset on a MySQL image", redis({ image: "mariadb:11" }), "image"],
    [
      "a preset with a probe command",
      postgres({ ready: { kind: "command", argv: ["true"] } }),
      "ready",
    ],
    ["a preset with a TCP check", redis({ ready: { kind: "tcp" } }), "ready"],
  ])("refuses %s by its key", (_, def, key) => {
    expect(resourceDefinitionRefusals(def).map((refusal) => refusal.key)).toEqual([key]);
  });

  it.each([
    [postgres, "postgres:17"],
    [postgres, "docker.io/library/postgres:17"],
    [postgres, "mirror.example:5000/postgres:17"],
    [postgres, "pgvector/pgvector:pg17"],
    [postgres, `postgis/postgis:17-3.5@sha256:${"a".repeat(64)}`],
    [mysql, "mysql:8.4"],
    [mysql, "mariadb:11.4"],
    [redis, "redis:8"],
    [redis, "valkey/valkey:8"],
  ])("accepts an image of the preset's family: %#", (preset, image) => {
    expect(resourceDefinitionRefusals(preset({ image }))).toEqual([]);
  });

  it.each([
    ["no check", { kind: "none" }],
    ["a probe command", { kind: "command", argv: ["dig", "@localhost"] }],
  ])("takes %s on a UDP-only resource", (_, ready) => {
    const def = define({ ports: [{ name: "dns", port: 53, protocol: "udp" }], ready });
    expect(resourceDefinitionRefusals(def)).toEqual([]);
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

  const database = { kind: "database", database: "d1" };
  const instance = { kind: "instance", instance: "i1" };

  it.each([
    ["shared on a Postgres preset", postgres(), { mode: "shared", revision: 1 }],
    ["off on a Redis preset", redis(), { mode: "off", revision: 1 }],
    [
      "own as a database on a Postgres preset",
      postgres(),
      { mode: "own", revision: 1, target: database },
    ],
    [
      "own as a database on a MySQL preset",
      mysql(),
      { mode: "own", revision: 1, target: database },
    ],
    [
      "own as an instance of another image",
      define(),
      { mode: "own", revision: 1, target: instance },
    ],
  ])("takes %s", (_, def, raw) => {
    expect(selectionRefusal(def, read(raw))).toBeNull();
  });

  it.each([
    [
      "own on Redis, which offers shared and off",
      redis(),
      { mode: "own", revision: 1, target: instance },
      "mode",
    ],
    [
      "own as an instance on a Postgres preset",
      postgres(),
      { mode: "own", revision: 1, target: instance },
      "target",
    ],
    [
      "own as a database on another image",
      define(),
      { mode: "own", revision: 1, target: database },
      "target",
    ],
    [
      "any selection of a worktree resource",
      define({ scope: "worktree" }),
      { mode: "shared", revision: 1 },
      "selection",
    ],
    [
      "any selection of a refused worktree Redis",
      redis({ scope: "worktree" }),
      { mode: "off", revision: 1 },
      "selection",
    ],
  ])("refuses %s by its key", (_, def, raw, key) => {
    expect(selectionRefusal(def, read(raw))?.key).toBe(key);
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

const bind = (
  definition: ResourceDefinitionInput,
  mode: "shared" | "own" = "shared",
): ResourceBinding =>
  definition.scope === "worktree" ? { definition, mode: "worktree" } : { definition, mode };

const namesOf = (bound: ReadonlyArray<ResourceBinding>, name: string) =>
  [...resourceEnvNames(bound)].find(([resource]) => resource === name)?.[1];

describe("env names", () => {
  it("writes the name in upper case with - as _", () => {
    expect(resourceEnvPrefix(ResourceName.make("mail-catcher"))).toBe(
      "MEND_RESOURCE_MAIL_CATCHER_",
    );
  });

  it("gives the host, the first port, each named port and the exports", () => {
    const mail = define({
      name: "mail-catcher",
      scope: "worktree",
      image: "axllent/mailpit:v1.21",
      ports: [
        { name: "smtp", port: 1025, protocol: "tcp" },
        { name: "web-ui", port: 8025, protocol: "tcp" },
      ],
      exports: { SMTP_URL: "smtp://{host}:{port.smtp}" },
    });
    expect(namesOf([bind(mail)], "mail-catcher")).toEqual([
      "MEND_RESOURCE_MAIL_CATCHER_HOST",
      "MEND_RESOURCE_MAIL_CATCHER_PORT",
      "MEND_RESOURCE_MAIL_CATCHER_PORT_SMTP",
      "MEND_RESOURCE_MAIL_CATCHER_PORT_WEB_UI",
      "MEND_RESOURCE_MAIL_CATCHER_SMTP_URL",
    ]);
  });

  const fixed = [
    "MEND_RESOURCE_DB_HOST",
    "MEND_RESOURCE_DB_PORT",
    "MEND_RESOURCE_DB_PORT_POSTGRES",
    "MEND_RESOURCE_DB_URL",
    "MEND_RESOURCE_DB_DATABASE",
    "MEND_RESOURCE_DB_USERNAME",
    "MEND_RESOURCE_DB_PASSWORD",
  ];
  const conventional = ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];

  it("gives the one Postgres in use DATABASE_URL and PG*", () => {
    expect(namesOf([bind(postgres())], "db")).toEqual([...fixed, ...conventional]);
  });

  it("gives neither of two Postgres in use DATABASE_URL or PG*", () => {
    const bound = [bind(postgres()), bind(postgres({ name: "analytics" }))];
    expect(namesOf(bound, "db")).toEqual(fixed);
  });

  it("counts only the resources in use as the engine's", () => {
    const bound = [bind(postgres()), bind(redis()), bind(define())];
    expect(namesOf(bound, "db")).toEqual([...fixed, ...conventional]);
  });

  it("gives a database preset's own database MEND_RESOURCE_<NAME>_SUFFIX, and shared none", () => {
    expect(namesOf([bind(postgres(), "own")], "db")).toEqual([
      ...fixed,
      "MEND_RESOURCE_DB_SUFFIX",
      ...conventional,
    ]);
    expect(namesOf([bind(mysql(), "own")], "db")).toContain("MEND_RESOURCE_DB_SUFFIX");
    expect(namesOf([bind(postgres({ scope: "worktree" }))], "db")).not.toContain(
      "MEND_RESOURCE_DB_SUFFIX",
    );
    expect(namesOf([bind(define(), "own")], "queue")).not.toContain("MEND_RESOURCE_QUEUE_SUFFIX");
  });

  it("gives Redis _URL, and REDIS_URL only when it is the one Redis", () => {
    expect(namesOf([bind(redis())], "cache")).toContain("MEND_RESOURCE_CACHE_URL");
    expect(namesOf([bind(redis())], "cache")).toContain("REDIS_URL");
    expect(namesOf([bind(redis())], "cache")).not.toContain("DATABASE_URL");
    const two = [bind(redis()), bind(redis({ name: "sessions" }))];
    expect(namesOf(two, "cache")).not.toContain("REDIS_URL");
  });

  it("gives an image Mend does not know no conventional names", () => {
    expect(namesOf([bind(define())], "queue")).toEqual([
      "MEND_RESOURCE_QUEUE_HOST",
      "MEND_RESOURCE_QUEUE_PORT",
      "MEND_RESOURCE_QUEUE_PORT_AMQP",
    ]);
  });

  it("counts no image Mend does not know as the one of its engine", () => {
    expect(onlyOfItsEngine(define(), [define()])).toBe(false);
    expect(onlyOfItsEngine(postgres(), [postgres(), define()])).toBe(true);
  });
});

describe("secret env names", () => {
  it("marks an export built from a secret, and not one built from a literal", () => {
    const queue = define({
      env: { RABBITMQ_DEFAULT_USER: "app", RABBITMQ_DEFAULT_PASS: { secret: "RABBITMQ_PASSWORD" } },
      exports: {
        URL: "amqp://{env.RABBITMQ_DEFAULT_USER}:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/",
        USER: "{env.RABBITMQ_DEFAULT_USER}",
      },
    });
    expect([...secretEnvNames([bind(queue)])]).toEqual(["MEND_RESOURCE_QUEUE_URL"]);
  });

  it("marks an export it cannot parse, which approval refuses anyway", () => {
    const queue = define({
      env: { PASS: { secret: "RABBITMQ_PASSWORD" } },
      exports: { URL: "amqp://{env.PASS" },
    });
    expect([...secretEnvNames([bind(queue)])]).toEqual(["MEND_RESOURCE_QUEUE_URL"]);
  });

  it("marks a preset's URL and password, and the conventional names that carry them", () => {
    expect([...secretEnvNames([bind(postgres())])]).toEqual([
      "MEND_RESOURCE_DB_URL",
      "MEND_RESOURCE_DB_PASSWORD",
      "DATABASE_URL",
      "PGPASSWORD",
    ]);
    expect([...secretEnvNames([bind(redis())])]).toEqual(["MEND_RESOURCE_CACHE_URL", "REDIS_URL"]);
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

  it("reports an export that lands on a database's suffix, which only own sets", () => {
    const a = define({ name: "a", exports: { B_SUFFIX: "{host}" } });
    expect(envNameCollisions([a, postgres({ name: "a-b" })])).toEqual([
      { name: "MEND_RESOURCE_A_B_SUFFIX", resources: ["a", "a-b"] },
    ]);
  });

  it("leaves the conventional names out when two of one engine are in use", () => {
    expect(envNameCollisions([postgres(), postgres({ name: "analytics" })])).toEqual([]);
  });

  it("refuses each resource in a collision, keyed by the export that sets the name", () => {
    const db = define({ name: "db", exports: { MAIN_URL: "{host}" } });
    expect(envCollisionRefusals([db, postgres({ name: "db-main" })])).toEqual([
      {
        resource: "db",
        refusal: {
          key: "exports.MAIN_URL",
          message: "sets MEND_RESOURCE_DB_MAIN_URL, as db-main does too",
        },
      },
      {
        resource: "db-main",
        refusal: { key: "", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
      },
    ]);
  });
});

describe("an image pinned to its digest", () => {
  const digest = ImageDigest.make(`sha256:${"a".repeat(64)}`);
  const other = ImageDigest.make(`sha256:${"b".repeat(64)}`);

  it("keeps the tag it was resolved from", () => {
    expect(pinImage("postgres:17", digest)).toBe(`postgres:17@${digest}`);
    expect(pinImage("ghcr.io/acme/db", digest)).toBe(`ghcr.io/acme/db@${digest}`);
  });

  it("is the image itself when it already names that digest, and null when it names another", () => {
    expect(pinImage(`postgres:17@${digest}`, digest)).toBe(`postgres:17@${digest}`);
    expect(pinImage(`postgres:17@${other}`, digest)).toBeNull();
  });

  it("reads the digest back, and none from a bare tag or a malformed one", () => {
    expect(imageDigestOf(`postgres:17@${digest}`)).toBe(digest);
    expect(imageDigestOf("postgres:17")).toBeNull();
    expect(imageDigestOf("postgres@sha256:ABC")).toBeNull();
    expect(imageReference(`postgres:17@${digest}`)).toEqual({ repository: "postgres", tag: "17" });
  });
});

describe("a definition's digest", () => {
  it("is the sha256 of its JSON with sorted keys and no whitespace, limits defaulted", () => {
    const spec = define({ env: { B: "2", A: { secret: "TOKEN" } } });
    const canonical =
      '{"command":null,"env":{"A":{"secret":"TOKEN"},"B":"2"},"exports":{},' +
      '"image":"rabbitmq:4-management","limits":{"cpu":1,"diskGiB":10,"memoryMiB":1024},' +
      '"name":"queue","ports":[{"name":"amqp","port":5672,"protocol":"tcp"}],"preset":null,' +
      '"ready":{"kind":"tcp"},"scope":"project",' +
      '"volumes":[{"mountPath":"/var/lib/rabbitmq","name":"data"}]}';
    expect(resourceSpecDigest(spec)).toBe(createHash("sha256").update(canonical).digest("hex"));
  });

  it("is the same whatever order the keys were written in", () => {
    const written = decode({
      exports: {},
      ready: { kind: "tcp" },
      volumes: [{ mountPath: "/var/lib/rabbitmq", name: "data" }],
      env: { A: { secret: "TOKEN" }, B: "2" },
      ports: [{ protocol: "tcp", port: 5672, name: "amqp" }],
      limits: { diskGiB: 10, memoryMiB: 1024, cpu: 1 },
      command: null,
      image: "rabbitmq:4-management",
      preset: null,
      scope: "project",
      name: "queue",
    });
    expect(resourceSpecDigest(written)).toBe(
      resourceSpecDigest(define({ env: { B: "2", A: { secret: "TOKEN" } } })),
    );
  });

  it.each([
    ["name", { name: "mq" }],
    ["scope", { scope: "worktree" }],
    ["preset", { preset: "redis" }],
    ["image", { image: "rabbitmq:4" }],
    ["command", { command: ["rabbitmq-server"] }],
    ["a port", { ports: [{ name: "amqp", port: 5673, protocol: "tcp" }] }],
    ["an env value", { env: { A: "1" } }],
    ["an env value's kind", { env: { A: { secret: "A" } } }],
    ["a volume", { volumes: [{ name: "data", mountPath: "/data" }] }],
    ["a limit", { limits: { cpu: 2 } }],
    ["the ready check", { ready: { kind: "command", argv: ["true"] } }],
    ["an export", { exports: { URL: "amqp://{host}" } }],
  ])("changes with %s", (_, change) => {
    const base = define({ env: { A: "0" } });
    expect(resourceSpecDigest(define({ env: { A: "0" }, ...change }))).not.toBe(
      resourceSpecDigest(base),
    );
  });

  it("orders port and volume lists as written, since their order is part of the definition", () => {
    const two = [
      { name: "amqp", port: 5672, protocol: "tcp" },
      { name: "admin", port: 15672, protocol: "tcp" },
    ];
    expect(resourceSpecDigest(define({ ports: two.toReversed() }))).not.toBe(
      resourceSpecDigest(define({ ports: two })),
    );
  });
});

describe("a preset's definition", () => {
  it("runs the preset's own image at the version named, with its port, data and ready check", () => {
    const db = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("17"),
      scope: "project",
    });
    expect(db).toMatchObject({
      image: "postgres:17",
      ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
      ready: { kind: "preset" },
    });
    expect(resourceDefinitionRefusals(db)).toEqual([]);
  });

  it("keeps Postgres 18's data where its image does", () => {
    const db = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("18"),
      scope: "worktree",
    });
    expect(db.volumes).toEqual([{ name: "data", mountPath: "/var/lib/postgresql" }]);
    expect(db.scope).toBe("worktree");
  });

  it.each([
    ["postgres", "17", ["-c", "fsync=on", "-c", "synchronous_commit=on"]],
    ["mysql", "8.4", ["--innodb-flush-log-at-trx-commit=1"]],
    [
      "redis",
      "8",
      ["--appendonly", "yes", "--appendfsync", "always", "--maxmemory-policy", "noeviction"],
    ],
  ] as const)(
    "runs %s with its durable engine settings as flags, which every image of the preset hands to its own server, inside the approved digest",
    (preset, version, command) => {
      const input = {
        name: ResourceName.make("db"),
        preset,
        version: PresetVersion.make(version),
        scope: "project",
      } as const;
      const def = presetDefinition(input);
      expect(def.command).toEqual(command);
      expect(resourceSpecDigest(def)).not.toBe(resourceSpecDigest({ ...def, command: null }));
    },
  );
});

describe("a definition's free text and image", () => {
  it.each([
    ["an escape in the repository", "mail\u001b[2J\u001b[H:1"],
    ["a space in the tag", "postgres:17 x"],
    ["an upper-case repository", "Postgres:17"],
    ["an empty tag", "postgres:"],
  ])("refuses %s as no image reference", (_, image) => {
    expect(() => define({ image })).toThrow(/is not an image reference/);
  });

  it.each([
    "postgres:17",
    "mirror.example:5000/library/postgres:17",
    "[::1]:5000/mail:v1",
    `ghcr.io/acme/mail@sha256:${"a".repeat(64)}`,
  ])("reads %s as an image reference", (image) => {
    expect(define({ image }).image).toBe(image);
  });

  it("refuses a control character in every free-text field, keyed", () => {
    const def = define({
      command: ["rabbitmq-server", "\u001b]0;owned\u0007"],
      env: { MOTD: "hi\nthere", PASS: { secret: "RABBIT_PASS" } },
      volumes: [{ name: "data", mountPath: "/var/lib/\u001b[2Jrabbit" }],
      exports: { URL: "amqp://{host}\r" },
      ready: { kind: "command", argv: ["ping\u009b"] },
    });
    expect(
      resourceDefinitionRefusals(def).filter((refusal) => refusal.message.includes("control")),
    ).toEqual(
      ["command", "ready.command", "env.MOTD", "volumes.data", "exports.URL"].map((key) => ({
        key,
        message: "has a control character, such as an escape or a newline",
      })),
    );
  });
});

describe("a preset's version", () => {
  it("refuses a preset image with no tag or digest, wherever it was declared", () => {
    expect(resourceDefinitionRefusals(postgres({ image: "postgres" }))).toEqual([
      {
        key: "image",
        message:
          'has no tag or digest, and the postgres preset runs the version its image names, such as "postgres:<tag>"',
      },
    ]);
    expect(resourceDefinitionRefusals(define({ image: "axllent/mailpit" }))).toEqual([]);
  });

  it.each(["latest", "alpine", "pg17", "17 x", ""])("refuses %j, which names no major", (raw) => {
    expect(Schema.is(PresetVersion)(raw)).toBe(false);
  });

  it.each(["17", "16.4-bookworm", "8.0"])("takes %j", (raw) => {
    expect(Schema.is(PresetVersion)(raw)).toBe(true);
  });
});
