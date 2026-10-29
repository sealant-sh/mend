import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  choicesFor,
  defaultChoiceFor,
  ResourceDefinitionInput,
  resourceDefinitionRefusals,
  ResourceName,
  resourceNameIssue,
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
