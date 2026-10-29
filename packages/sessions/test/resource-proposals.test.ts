import {
  recipeRefusalLine,
  type ResourceDefinitionInput,
  ServiceRecipe,
} from "@mend/domain/workbench";
import { type MendTomlFile, parseMendToml, resolveDeclarations } from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const parse = (lines: ReadonlyArray<string>): MendTomlFile =>
  Effect.runSync(parseMendToml(lines.join("\n"), "/repo/mend.toml"));

const ADR_QUEUE = [
  "[resource.queue]",
  'image = "rabbitmq:4-management"',
  'scope = "project"',
  "ports = { amqp = 5672 }",
  'volumes = { data = "/var/lib/rabbitmq" }',
  'env = { RABBITMQ_DEFAULT_USER = "app", RABBITMQ_DEFAULT_PASS = { secret = "RABBITMQ_PASSWORD" } }',
  'exports = { URL = "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" }',
];

const ADR_WEB = [
  "[service.web]",
  'command = "pnpm dev --port 3000"',
  "port = 3000",
  'browserScheme = "http"',
  'depends = ["@db", "@queue"]',
];

const MAIL = [
  "[resource.mail]",
  'image = "axllent/mailpit:v1.21"',
  'scope = "worktree"',
  "ports = { smtp = 1025, http = 8025 }",
];

const refusedKeys = (file: MendTomlFile) => file.refused.map((refusal) => refusal.key);
const proposed = (file: MendTomlFile) => file.resources.map((resource) => resource.name);

describe("[resource.*] proposals in mend.toml", () => {
  it("reads ADR 0019's queue as a definition, and still refuses @names in depends", () => {
    const file = parse([...ADR_QUEUE, "", ...ADR_WEB]);
    expect(file.resources).toEqual([
      {
        name: "queue",
        scope: "project",
        preset: null,
        image: "rabbitmq:4-management",
        command: null,
        ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
        env: {
          RABBITMQ_DEFAULT_USER: "app",
          RABBITMQ_DEFAULT_PASS: { secret: "RABBITMQ_PASSWORD" },
        },
        volumes: [{ name: "data", mountPath: "/var/lib/rabbitmq" }],
        limits: { cpu: 1, memoryMiB: 1024, diskGiB: 10 },
        ready: { kind: "tcp" },
        exports: { URL: "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" },
      },
    ]);
    expect(file.refused.map(recipeRefusalLine)).toEqual([
      "web · depends · @db · shared services are not available yet",
      "web · depends · @queue · shared services are not available yet",
    ]);
    expect(file.ignored).toEqual([]);
  });

  it("refuses the ADR's secret name as written, which no project secret can have", () => {
    const file = parse(
      ADR_QUEUE.map((line) => line.replace('"RABBITMQ_PASSWORD"', '"rabbitmq-password"')),
    );
    expect(file.resources).toEqual([]);
    expect(refusedKeys(file)).toEqual(["resource.queue.env.RABBITMQ_DEFAULT_PASS.secret"]);
  });

  it("fills ready from the preset, a TCP port, or neither", () => {
    const file = parse([
      "[resource.db]",
      'preset = "postgres"',
      'image = "postgres:17"',
      "ports = { postgres = 5432 }",
      "",
      "[resource.dns]",
      'image = "coredns/coredns:1.12"',
      'ports = { dns = { port = 53, protocol = "udp" } }',
      'command = ["/coredns", "-conf", "/etc/Corefile"]',
      "",
      "[resource.probe]",
      'image = "ghcr.io/acme/probe:1"',
      "ports = { http = 8080 }",
      'ready = { command = ["probe", "--once"] }',
      "limits = { cpu = 0.5, memoryMiB = 256 }",
    ]);
    expect(file.refused).toEqual([]);
    const byName = new Map<string, ResourceDefinitionInput>(
      file.resources.map((resource) => [resource.name, resource]),
    );
    expect(byName.get("db")?.ready).toEqual({ kind: "preset" });
    expect(byName.get("dns")?.ready).toEqual({ kind: "none" });
    expect(byName.get("dns")?.ports).toEqual([{ name: "dns", port: 53, protocol: "udp" }]);
    expect(byName.get("dns")?.command).toEqual(["/coredns", "-conf", "/etc/Corefile"]);
    expect(byName.get("probe")?.ready).toEqual({ kind: "command", argv: ["probe", "--once"] });
    expect(byName.get("probe")?.limits).toEqual({ cpu: 0.5, memoryMiB: 256, diskGiB: 10 });
  });

  it("refuses a preset with no image, since no preset names a default version", () => {
    const file = parse(["[resource.db]", 'preset = "postgres"', "ports = { postgres = 5432 }"]);
    expect(file.resources).toEqual([]);
    expect(file.refused).toEqual([
      expect.objectContaining({
        name: null,
        key: "resource.db.image",
        message:
          "is required, with its tag: the postgres preset runs postgres, pgvector/pgvector, postgis/postgis",
      }),
    ]);
  });

  it.each([
    [
      "a port out of range",
      ["[resource.queue]", 'image = "rabbitmq:4"', "ports = { amqp = 70000 }"],
      "resource.queue.ports.amqp",
    ],
    [
      "a port's protocol",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        'ports = { amqp = { port = 5672, protocol = "sctp" } }',
      ],
      "resource.queue.ports.amqp.protocol",
    ],
    [
      "a port name Kubernetes refuses",
      ["[resource.queue]", 'image = "rabbitmq:4"', "ports = { amqp_tls = 5671 }"],
      "resource.queue.ports.amqp_tls",
    ],
    [
      "a reserved name",
      ["[resource.postgres]", 'image = "postgres:17"', "ports = { pg = 5432 }"],
      "resource.postgres.name",
    ],
    [
      "a name that is not a label",
      ["[resource.Queue]", 'image = "rabbitmq:4"', "ports = { amqp = 5672 }"],
      "resource.Queue.name",
    ],
    [
      "a bad env key",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        "ports = { amqp = 5672 }",
        'env = { "1BAD" = "x" }',
      ],
      "resource.queue.env.1BAD",
    ],
    [
      "an env value that is neither",
      ["[resource.queue]", 'image = "rabbitmq:4"', "ports = { amqp = 5672 }", "env = { USER = 5 }"],
      "resource.queue.env.USER",
    ],
    [
      "a secret ref with an invalid name",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        "ports = { amqp = 5672 }",
        'env = { PASS = { secret = "MEND_PASS" } }',
      ],
      "resource.queue.env.PASS.secret",
    ],
    [
      "a preset with exports",
      [
        "[resource.cache]",
        'preset = "redis"',
        'image = "redis:7"',
        "ports = { redis = 6379 }",
        'exports = { ADDR = "{host}:{port}" }',
      ],
      "resource.cache.exports",
    ],
    [
      "Redis at worktree scope",
      [
        "[resource.cache]",
        'preset = "redis"',
        'scope = "worktree"',
        'image = "redis:7"',
        "ports = { redis = 6379 }",
      ],
      "resource.cache.scope",
    ],
    [
      "a command written as a string",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        "ports = { amqp = 5672 }",
        'command = "rabbitmq-server"',
      ],
      "resource.queue.command",
    ],
    [
      "a volume path",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        "ports = { amqp = 5672 }",
        'volumes = { data = "var/lib" }',
      ],
      "resource.queue.volumes.data",
    ],
    [
      "a limit",
      [
        "[resource.queue]",
        'image = "rabbitmq:4"',
        "ports = { amqp = 5672 }",
        "limits = { memoryMiB = 1.5 }",
      ],
      "resource.queue.limits.memoryMiB",
    ],
    ["no port", ["[resource.queue]", 'image = "rabbitmq:4"'], "resource.queue.ports"],
    ["a resource that is not a table", ["[resource]", "queue = 5"], "resource.queue"],
  ])("refuses %s by its full key, and the sibling still parses", (_, lines, key) => {
    const file = parse([...lines, "", ...MAIL]);
    expect(refusedKeys(file)).toContain(key);
    expect(file.refused.every((refusal) => refusal.name === null)).toBe(true);
    expect(proposed(file)).toEqual(["mail"]);
  });

  it("lists a key it does not read as ignored, by its full key, and still proposes the resource", () => {
    const file = parse([
      "[resource.queue]",
      'image = "rabbitmq:4"',
      "healthcheck = true",
      "ports = { amqp = { port = 5672, weight = 2 } }",
      'env = { PASS = { secret = "RABBITMQ_PASSWORD", rotate = true } }',
      'ready = { command = ["rabbitmq-diagnostics", "ping"], interval = "5s" }',
      "limits = { gpu = 1 }",
    ]);
    expect(file.refused).toEqual([]);
    expect(proposed(file)).toEqual(["queue"]);
    expect(file.ignored.map((ignored) => ignored.key).toSorted()).toEqual([
      "resource.queue.env.PASS.rotate",
      "resource.queue.healthcheck",
      "resource.queue.limits.gpu",
      "resource.queue.ports.amqp.weight",
      "resource.queue.ready.interval",
    ]);
  });

  it("refuses a resource key that is not a table, and reads the recipes beside it", () => {
    const file = parse([
      "resource = 5",
      "",
      "[service.web]",
      'command = "pnpm dev"',
      "port = 3000",
    ]);
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(["web"]);
    expect(file.resources).toEqual([]);
    expect(file.refused.map(recipeRefusalLine)).toEqual([
      "mend.toml · resource · must be a table of resources ([resource.<name>])",
    ]);
    expect(file.ignored).toEqual([]);
  });

  it("shows a resource's refusal with the file's, and never refuses a recipe of the same name", () => {
    const project = new ServiceRecipe({
      name: "web",
      command: "pnpm dev",
      port: 3000,
      protocol: "tcp",
      browserScheme: "http",
      source: "project",
      shadowedBy: null,
    });
    const declared = resolveDeclarations(
      parse(["[resource.web]", 'image = "nginx:1.27"', "ports = { http = 0 }"]),
      [project],
    );
    expect(declared.recipes).toEqual([project]);
    expect(declared.refused.map(recipeRefusalLine)).toEqual([
      "mend.toml · resource.web.ports.http · must be a port in 1..65535",
    ]);
  });

  it("reads a file with no [resource] table as before", () => {
    const file = parse(["future = 1", "", "[service.web]", 'command = "pnpm dev"', "port = 3000"]);
    expect(file.resources).toEqual([]);
    expect(file.refused).toEqual([]);
    expect(file.ignored).toEqual([{ name: null, key: "future" }]);
  });
});
