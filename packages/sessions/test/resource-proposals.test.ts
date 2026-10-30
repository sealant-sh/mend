import {
  presetDefinition,
  PresetVersion,
  recipeRefusalLine,
  type ResourceDefinitionInput,
  ResourceName,
  resourceSpecDigest,
  ServiceRecipe,
} from "@mend/domain/workbench";
import {
  declarationsNote,
  type MendTomlFile,
  parseMendToml,
  readResourceProposals,
  resolveDeclarations,
} from "@mend/sessions";
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
      "web · depends · @db · resources need a newer Sealant on this runtime · this session can run its own [service.db]",
      "web · depends · @queue · resources need a newer Sealant on this runtime · this session can run its own [service.queue]",
    ]);
    expect(file.ignored).toEqual([]);
  });

  it("refuses a lower-case secret name", () => {
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

  it("gives a preset table its engine settings, so it proposes what --preset proposes", () => {
    const file = parse([
      "[resource.cache]",
      'preset = "redis"',
      'image = "redis:8"',
      "ports = { redis = 6379 }",
      'volumes = { data = "/data" }',
    ]);
    expect(file.refused).toEqual([]);
    const preset = presetDefinition({
      name: ResourceName.make("cache"),
      preset: "redis",
      version: PresetVersion.make("8"),
      scope: "project",
    });
    expect(file.resources.map(resourceSpecDigest)).toEqual([resourceSpecDigest(preset)]);
  });

  it("refuses a preset table's own command by its key", () => {
    const file = parse([
      "[resource.cache]",
      'preset = "redis"',
      'image = "redis:8"',
      "ports = { redis = 6379 }",
      'command = ["--appendonly", "no"]',
    ]);
    expect(file.resources).toEqual([]);
    expect(refusedKeys(file)).toEqual(["resource.cache.command"]);
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
      "resource.postgres",
    ],
    [
      "a name that is not a label",
      ["[resource.Queue]", 'image = "rabbitmq:4"', "ports = { amqp = 5672 }"],
      "resource.Queue",
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

  it("names the table, not a name key, when the table's name is refused", () => {
    const file = parse([
      "[resource.Queue]",
      'name = "queue"',
      'image = "rabbitmq:4"',
      "ports = { amqp = 5672 }",
    ]);
    expect(file.refused.map(recipeRefusalLine)).toEqual([
      "mend.toml · resource.Queue · is not one DNS label (a lowercase letter, then up to 30 lowercase letters, digits or -, not ending in -)",
    ]);
    expect(file.ignored.map((ignored) => ignored.key)).toEqual(["resource.Queue.name"]);
  });

  it("lists unknown keys in a ready or secret table that also lacks its required key", () => {
    const file = parse([
      "[resource.queue]",
      'image = "rabbitmq:4"',
      "ports = { amqp = 5672 }",
      'ready = { cmd = ["probe"], interval = "5s" }',
      'env = { PASS = { secrt = "PASSWORD", rotate = true } }',
    ]);
    expect(refusedKeys(file).toSorted()).toEqual([
      "resource.queue.env.PASS",
      "resource.queue.ready",
    ]);
    expect(file.ignored.map((ignored) => ignored.key).toSorted()).toEqual([
      "resource.queue.env.PASS.rotate",
      "resource.queue.env.PASS.secrt",
      "resource.queue.ready.cmd",
      "resource.queue.ready.interval",
    ]);
  });

  it("reports every rule a table breaks in one read, when a rule's fields read", () => {
    expect(refusedKeys(parse(["[resource.q]"]))).toEqual(["resource.q.image", "resource.q.ports"]);
    expect(
      refusedKeys(
        parse([
          "[resource.cache]",
          'preset = "redis"',
          'scope = "worktree"',
          'image = "redis:7"',
          "ports = { redis = 6379 }",
          'exports = { ADDR = "{host}:{port}" }',
          "limits = { memoryMiB = 1.5 }",
        ]),
      ).toSorted(),
    ).toEqual([
      "resource.cache.exports",
      "resource.cache.limits.memoryMiB",
      "resource.cache.scope",
    ]);
  });

  it("does not refuse an export for naming a port that is itself refused", () => {
    const file = parse([
      "[resource.queue]",
      'image = "rabbitmq:4"',
      "ports = { amqp = 70000 }",
      'exports = { URL = "amqp://{host}:{port.amqp}/" }',
    ]);
    expect(refusedKeys(file)).toEqual(["resource.queue.ports.amqp"]);
  });

  it("refuses a volume name with the domain's own rule", () => {
    const file = parse([
      "[resource.queue]",
      'image = "rabbitmq:4"',
      "ports = { amqp = 5672 }",
      'volumes = { data- = "/data" }',
    ]);
    expect(file.refused.map(recipeRefusalLine)).toEqual([
      "mend.toml · resource.queue.volumes.data- · is not one DNS label (a lowercase letter, then up to 30 lowercase letters, digits or -, not ending in -)",
    ]);
  });

  it("refuses a preset image with no tag or digest, and reads one pinned by digest", () => {
    const untagged = parse([
      "[resource.db]",
      'preset = "postgres"',
      'image = "postgres"',
      "ports = { pg = 5432 }",
    ]);
    expect(untagged.resources).toEqual([]);
    expect(untagged.refused.map(recipeRefusalLine)).toEqual([
      'mend.toml · resource.db.image · has no tag or digest, and the postgres preset runs the version its image names, such as "postgres:<tag>"',
    ]);
    const pinned = parse([
      "[resource.db]",
      'preset = "postgres"',
      `image = "postgres@sha256:${"a".repeat(64)}"`,
      "ports = { pg = 5432 }",
    ]);
    expect(pinned.refused).toEqual([]);
    expect(proposed(pinned)).toEqual(["db"]);
  });

  it("refuses both proposals that would set the same env name, each at its own key", () => {
    const file = parse([
      "[resource.db]",
      'image = "ghcr.io/acme/db:1"',
      "ports = { pg = 5432 }",
      'exports = { MAIN_URL = "pg://{host}:{port}/main" }',
      "",
      "[resource.db-main]",
      'image = "ghcr.io/acme/db:1"',
      "ports = { pg = 5432 }",
      'exports = { URL = "pg://{host}:{port}/" }',
      "",
      ...MAIL,
    ]);
    expect(proposed(file)).toEqual(["mail"]);
    expect(file.refused.map(recipeRefusalLine)).toEqual([
      "mend.toml · resource.db.exports.MAIN_URL · sets MEND_RESOURCE_DB_MAIN_URL, as db-main does too",
      "mend.toml · resource.db-main.exports.URL · sets MEND_RESOURCE_DB_MAIN_URL, as db does too",
    ]);
  });
});

describe("readResourceProposals", () => {
  it("returns each refusal and ignored key by its full key alone, which names the resource", () => {
    expect(
      readResourceProposals({ web: { image: "nginx:1.27", ports: { http: 0 }, weight: 2 } }),
    ).toEqual({
      proposals: [],
      refused: [{ key: "resource.web.ports.http", message: "must be a port in 1..65535" }],
      ignored: [{ key: "resource.web.weight" }],
    });
  });
});

describe("the workspace note on mend.toml", () => {
  it("lists recipes to fix, then resource proposals' refusals and ignored keys under their own heading", () => {
    const declared = resolveDeclarations(
      parse([
        "future = 1",
        "",
        "[service.api]",
        'command = "node api.js"',
        "port = 4000",
        'cwd = "/srv/api"',
        "",
        "[resource.web]",
        'image = "nginx:1.27"',
        "ports = { http = 0 }",
        "healthcheck = true",
      ]),
      [],
    );
    expect(declarationsNote(declared)).toBe(
      "Refused in mend.toml (fix these before running them):\n\n" +
        "- api · cwd · is absolute; name a path inside the repository\n\n" +
        "Resource proposals in mend.toml (none runs from the file; a manager approves each in project settings):\n\n" +
        "- resource.web.ports.http · must be a port in 1..65535\n" +
        "- resource.web.healthcheck · is ignored: this Mend does not read it\n\n",
    );
  });

  it("says nothing of proposals when the file has none to report", () => {
    expect(
      declarationsNote(
        resolveDeclarations(parse(["[service.web]", 'command = "pnpm dev"', "port = 3000"]), []),
      ),
    ).toBe("");
  });
});
