import { createHash } from "node:crypto";

import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ResourceDefinitionId } from "../ids.ts";
import {
  choicesFor,
  choiceInEffect,
  envCollisionRefusals,
  resourceRefusalWords,
  envNameCollisions,
  ImageDigest,
  imageDigestOf,
  imageReference,
  parseImageReference,
  pinImage,
  presetDefinition,
  PresetVersion,
  type ResourceBinding,
  ResourceDefinition,
  resourceDefinitionRefusals,
  resourceEnvNames,
  resourceEnvPrefix,
  ResourceName,
  resourceNameIssue,
  resourceSpecDigest,
  withPresetCommand,
} from "./resource.ts";

const decode = Schema.decodeUnknownSync(ResourceDefinition);

const define = (overrides: Record<string, unknown> = {}): ResourceDefinition =>
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
  withPresetCommand(
    define({
      name: "db",
      preset: "postgres",
      image: "postgres:17",
      ports: [{ name: "postgres", port: 5432, protocol: "tcp" }],
      volumes: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
      ready: { kind: "preset" },
      ...overrides,
    }),
  );

const mysql = (overrides: Record<string, unknown> = {}) =>
  withPresetCommand(
    define({
      name: "db",
      preset: "mysql",
      image: "mysql:8.4",
      ports: [{ name: "mysql", port: 3306, protocol: "tcp" }],
      volumes: [{ name: "data", mountPath: "/var/lib/mysql" }],
      ready: { kind: "preset" },
      ...overrides,
    }),
  );

const redis = (overrides: Record<string, unknown> = {}) =>
  withPresetCommand(
    define({
      name: "cache",
      preset: "redis",
      image: "redis:8",
      ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
      volumes: [{ name: "data", mountPath: "/data" }],
      ready: { kind: "preset" },
      ...overrides,
    }),
  );

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

  it("accepts old JSON with scope while discarding the key", () => {
    const def = define({ scope: "worktree" });
    expect("scope" in def).toBe(false);
    expect(resourceSpecDigest(def)).toBe(resourceSpecDigest(define()));
  });
});

describe("choices and Mend's env namespace", () => {
  it.each([postgres(), mysql(), redis(), define()])("offers both levels and off", (def) => {
    expect(choicesFor(def)).toEqual(["project", "worktree", "off"]);
  });
  it("uses the worktree's stored visibility default", () => {
    expect(choiceInEffect(null)).toBe("project");
    expect(choiceInEffect(null, false)).toBe("off");
    expect(choiceInEffect("worktree", false)).toBe("worktree");
  });
  it.each([
    "preview",
    "session",
    "session-token",
    "service",
    "service-web",
    "agent",
    "agent-process",
    "setup",
  ])("refuses %s because Mend supplies that env name or family", (name) => {
    expect(resourceDefinitionRefusals(define({ name }))).toContainEqual({
      key: "name",
      message: "generates env names Mend owns",
    });
  });
});

const bind = (definition: ResourceDefinition): ResourceBinding => ({
  definition,
  level: "project",
  resourceId: ResourceDefinitionId.make("names"),
  instanceKey: "names",
  database: definition.preset === "postgres" ? "app" : null,
});
describe("env names", () => {
  it("uses the short prefix and only Mend names", () => {
    expect(resourceEnvPrefix(ResourceName.make("mail-catcher"))).toBe("MEND_MAIL_CATCHER_");
    expect(resourceEnvNames([bind(postgres())]).get(ResourceName.make("db"))).toEqual([
      "MEND_DB_URL",
      "MEND_DB_HOST",
      "MEND_DB_PORT",
      "MEND_DB_USER",
      "MEND_DB_PASSWORD",
      "MEND_DB_DATABASE",
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
      { name: "MEND_DB_MAIN_URL", resources: ["db", "db-main"] },
    ]);
  });

  it("does not export per-port env names automatically", () => {
    const db = define({ name: "db", ports: [{ name: "host", port: 1, protocol: "tcp" }] });
    expect(envNameCollisions([db, define({ name: "db-port" })])).toEqual([]);
  });

  it("leaves the conventional names out when two of one engine are in use", () => {
    expect(envNameCollisions([postgres(), postgres({ name: "analytics" })])).toEqual([]);
  });

  it("words a refusal by its key, and one of the resource itself by its reason alone", () => {
    expect(resourceRefusalWords({ key: "exports.MAIN_URL", message: "sets X" })).toBe(
      "exports.MAIN_URL sets X",
    );
    expect(resourceRefusalWords({ key: "", message: "sets MEND_DB_MAIN_URL" })).toBe(
      "sets MEND_DB_MAIN_URL",
    );
  });

  it("refuses each resource in a collision, keyed by the export that sets the name", () => {
    const db = define({ name: "db", exports: { MAIN_URL: "{host}" } });
    expect(envCollisionRefusals([db, postgres({ name: "db-main" })])).toEqual([
      {
        resource: "db",
        refusal: {
          key: "exports.MAIN_URL",
          message: "sets MEND_DB_MAIN_URL, as db-main does too",
        },
      },
      {
        resource: "db-main",
        refusal: { key: "", message: "sets MEND_DB_MAIN_URL, as db does too" },
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

describe("an image reference's parts", () => {
  it.each([
    ["postgres:17", { host: null, repository: "postgres", tag: "17", digest: null }],
    [
      "docker.io/library/postgres:17",
      { host: "docker.io", repository: "library/postgres", tag: "17", digest: null },
    ],
    [
      "mirror.example:5000/library/postgres",
      { host: "mirror.example:5000", repository: "library/postgres", tag: null, digest: null },
    ],
    ["localhost/acme/app:1", { host: "localhost", repository: "acme/app", tag: "1", digest: null }],
    ["[::1]:5000/mail:v1", { host: "[::1]:5000", repository: "mail", tag: "v1", digest: null }],
    ["localhost:5000", { host: null, repository: "localhost", tag: "5000", digest: null }],
    [
      `ghcr.io/acme/mail:v1@sha256:${"a".repeat(64)}`,
      { host: "ghcr.io", repository: "acme/mail", tag: "v1", digest: `sha256:${"a".repeat(64)}` },
    ],
  ])("reads %s as its host, repository, tag and digest", (image, parts) => {
    expect(parseImageReference(image)).toEqual(parts);
  });
});

describe("a definition's digest", () => {
  it("is the sha256 of its JSON with sorted keys and no whitespace, limits defaulted", () => {
    const spec = define({ env: { B: "2", A: { secret: "TOKEN" } } });
    const canonical =
      '{"command":null,"env":{"A":{"secret":"TOKEN"},"B":"2"},"exports":{},' +
      '"image":"rabbitmq:4-management","limits":{"cpu":1,"diskGiB":10,"memoryMiB":1024},' +
      '"name":"queue","ports":[{"name":"amqp","port":5672,"protocol":"tcp"}],"preset":null,' +
      '"ready":{"kind":"tcp"},' +
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
      name: "queue",
    });
    expect(resourceSpecDigest(written)).toBe(
      resourceSpecDigest(define({ env: { B: "2", A: { secret: "TOKEN" } } })),
    );
  });

  it.each([
    ["name", { name: "mq" }],
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
    });
    expect(db.volumes).toEqual([{ name: "data", mountPath: "/var/lib/postgresql" }]);
    expect("scope" in db).toBe(false);
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
    "runs %s with its durable engine settings as flags, which every image of the preset hands to its own server, inside the pinned digest",
    (preset, version, command) => {
      const input = {
        name: ResourceName.make("db"),
        preset,
        version: PresetVersion.make(version),
      } as const;
      const def = presetDefinition(input);
      expect(def.command).toEqual(command);
      expect(resourceSpecDigest(def)).not.toBe(resourceSpecDigest({ ...def, command: null }));
    },
  );

  it("gives a preset definition that names no command its engine settings, so a table and --preset declare one spec", () => {
    const declared = presetDefinition({
      name: ResourceName.make("cache"),
      preset: "redis",
      version: PresetVersion.make("8"),
    });
    const table = withPresetCommand({ ...declared, command: null });
    expect(resourceSpecDigest(table)).toBe(resourceSpecDigest(declared));
    expect(withPresetCommand(define()).command).toBeNull();
  });

  it("refuses a preset definition whose command is not its engine settings, by key", () => {
    const fixed = {
      key: "command",
      message:
        "is fixed by the redis preset to --appendonly yes --appendfsync always --maxmemory-policy noeviction",
    };
    expect(resourceDefinitionRefusals(redis({ command: ["--appendonly", "no"] }))).toEqual([fixed]);
    expect(resourceDefinitionRefusals({ ...redis(), command: null })).toEqual([fixed]);
    expect(resourceDefinitionRefusals(redis())).toEqual([]);
  });
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
