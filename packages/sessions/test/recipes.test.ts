import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  recipeRefusalLine,
  RepoRelativePath,
  ServiceRecipe,
  SetupDeclaration,
  setupRefusalsOf,
} from "@mend/domain/workbench";
import {
  type MendTomlFile,
  mergeRecipes,
  parseMendToml,
  planStart,
  readMendToml,
  RecipeFileError,
  resolveDeclarations,
} from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const worktreeWith = (toml: string | null): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-recipes-"));
  if (toml !== null) {
    fs.writeFileSync(path.join(dir, "mend.toml"), toml);
  }
  return dir;
};

const parse = (toml: string): MendTomlFile =>
  Effect.runSync(parseMendToml(toml, "/repo/mend.toml"));

const declare = (toml: string, project: ReadonlyArray<ServiceRecipe> = []) =>
  resolveDeclarations(parse(toml), project);

const projectRecipe = (name: string) =>
  new ServiceRecipe({
    name,
    command: "pnpm dev",
    port: 3000,
    protocol: "tcp",
    browserScheme: "http",
    source: "project",
    shadowedBy: null,
  });

const WEB = ["[service.web]", 'command = "pnpm dev"', "port = 3000", 'browserScheme = "http"'];

describe("parseMendToml", () => {
  it("reads a udp recipe and defaults protocol to tcp", () => {
    const file = parse(
      [
        "[service.game]",
        'command = "./server"',
        "port = 34197",
        'protocol = "udp"',
        "",
        "[service.web]",
        'command = "pnpm dev"',
        "port = 3000",
      ].join("\n"),
    );
    expect(file.recipes.find((r) => r.name === "game")?.protocol).toBe("udp");
    expect(file.recipes.find((r) => r.name === "web")?.protocol).toBe("tcp");
  });

  it("reads an explicit browser scheme without inferring one for raw TCP", () => {
    const file = parse(
      [
        "[service.web]",
        "port = 3000",
        'browserScheme = "https"',
        "",
        "[service.raw]",
        "port = 9000",
      ].join("\n"),
    );
    expect(file.recipes.find((recipe) => recipe.name === "web")?.browserScheme).toBe("https");
    expect(file.recipes.find((recipe) => recipe.name === "raw")?.browserScheme).toBeNull();
  });

  it("reads run and adopt recipes with the launch defaults", () => {
    const file = parse(`
[service.web]
command = "pnpm dev"
port = 3000

[service.db]
# an already-listening port to adopt
port = 5432
`);
    expect(file.recipes).toHaveLength(2);
    expect(file.recipes[0]).toMatchObject({
      name: "web",
      command: "pnpm dev",
      port: 3000,
      cwd: null,
      env: {},
      ready: { _tag: "Tcp", timeoutMs: 60_000 },
      host: "rewrite",
      address: "loopback",
      depends: [],
    });
    expect(file.recipes[1]).toMatchObject({ name: "db", command: null, port: 5432 });
  });

  it("reads every new key", () => {
    const file = parse(`
[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
cwd = "./apps//web/"
env = { NODE_ENV = "development", _x1 = "" }
ready = { http = "/health?deep=1", timeout = "2m" }
host = "preserve"
depends = ["db", "db"]

[service.db]
command = "docker compose up db"
port = 5432
address = "docker"
ready = { timeout = "90s" }

[preview]
service = "web"
`);
    expect(file.refused).toEqual([]);
    expect(file.recipes[0]).toMatchObject({
      cwd: "apps/web",
      env: { NODE_ENV: "development", _x1: "" },
      ready: { _tag: "Http", path: "/health?deep=1", timeoutMs: 120_000 },
      host: "preserve",
      depends: ["db"],
    });
    expect(file.recipes[1]).toMatchObject({
      address: "docker",
      ready: { _tag: "Tcp", timeoutMs: 90_000 },
    });
    expect(file.preview).toBe("web");
  });

  it.each([
    ['the root as ""', 'cwd = ""', null],
    ["the root as .", 'cwd = "."', null],
  ])("reads cwd %s as none", (_, line, expected) => {
    expect(parse([...WEB, line].join("\n")).recipes[0]?.cwd).toBe(expected);
  });

  it.each([
    ["cwd", 'cwd = "/abs"', "cwd", /absolute/],
    ["cwd", 'cwd = "a/../b"', "cwd", /\.\./],
    ["cwd", 'cwd = ".."', "cwd", /\.\./],
    ["cwd", 'cwd = "a\\u0000b"', "cwd", /NUL/],
    ["cwd", "cwd = 3", "cwd", /repository-relative/],
    ["env", 'env = { MEND_X = "1" }', "env.MEND_X", /MEND_\* names are Mend's/],
    [
      "env",
      'env = { MEND_SERVICE_DB_HOST = "db.local" }',
      "env.MEND_SERVICE_DB_HOST",
      /MEND_\* names are Mend's/,
    ],
    ["env", 'env = { PORT = "3000" }', "env.PORT", /PORT is Mend's/],
    ["env", "env = { X = 1 }", "env.X", /string/],
    ["env", 'env = { "1X" = "a" }', "env.1X", /not an environment variable name/],
    ["env", 'env = "X=1"', "env", /table/],
    ["ready", 'ready = { http = "x" }', "ready.http", /path/],
    ["ready", 'ready = { http = "/a b" }', "ready.http", /path/],
    ["ready", 'ready = { timeout = "0s" }', "ready.timeout", /duration/],
    ["ready", 'ready = { timeout = "120" , http = 3 }', "ready.http", /path/],
    ["ready", 'ready = { timeout = "11m" }', "ready.timeout", /between 1s and 10m/],
    ["ready", 'ready = { timeout = "500ms" }', "ready.timeout", /duration/],
    ["ready", "ready = { timeout = 120 }", "ready.timeout", /duration/],
    ["ready", 'ready = "/"', "ready", /table/],
    ["host", 'host = "keep"', "host", /"rewrite" or "preserve"/],
    ["address", 'address = "host"', "address", /"loopback" or "docker"/],
    ["depends", 'depends = "db"', "depends", /list/],
    ["depends", 'depends = ["Db App"]', "depends", /must name a Service/],
    ["port", "port = 70000", "port", /1\.\.65535/],
    ["command", 'command = " "', "command", /non-empty/],
    ["protocol", 'protocol = "sctp"', "protocol", /"tcp" or "udp"/],
  ])("refuses a bad %s and names %s", (_, line, key, message) => {
    const file = parse(
      [...WEB.filter((l) => !l.startsWith(line.split(" ")[0] ?? "")), line].join("\n"),
    );
    expect(file.recipes).toEqual([]);
    expect(file.refused).toContainEqual(
      expect.objectContaining({ name: "web", key, message: expect.stringMatching(message) }),
    );
  });

  it("refuses host without browserScheme = http", () => {
    const file = parse(
      ["[service.api]", 'command = "x"', "port = 1", 'host = "rewrite"'].join("\n"),
    );
    expect(file.refused).toEqual([
      expect.objectContaining({
        name: "api",
        key: "host",
        message: 'needs browserScheme = "http"',
      }),
    ]);
  });

  it("refuses an HTTP ready rule on UDP and on an adopted port", () => {
    const file = parse(`
[service.game]
command = "./server"
port = 34197
protocol = "udp"
ready = { http = "/" }

[service.db]
port = 5432
ready = { http = "/" }
`);
    expect(file.recipes).toEqual([]);
    expect(file.refused.map((refusal) => [refusal.name, refusal.key])).toEqual([
      ["game", "ready.http"],
      ["db", "ready.http"],
    ]);
  });

  it("refuses address = docker for UDP", () => {
    const file = parse(
      [
        "[service.game]",
        'command = "x"',
        "port = 1",
        'protocol = "udp"',
        'address = "docker"',
      ].join("\n"),
    );
    expect(file.refused).toEqual([expect.objectContaining({ name: "game", key: "address" })]);
  });

  it("refuses browser behavior for UDP", () => {
    const file = parse(
      ["[service.game]", "port = 34197", 'protocol = "udp"', 'browserScheme = "http"'].join("\n"),
    );
    expect(file.refused).toEqual([
      expect.objectContaining({
        name: "game",
        key: "browserScheme",
        message: "cannot be declared for UDP",
      }),
    ]);
  });

  it("reads resource dependencies separately from the Service graph", () => {
    const file = parse(
      [
        ...WEB,
        'depends = ["@db", { shared = "cache", env = { CACHE_URL = "url" } }, { resource = "queue" }]',
      ].join("\n"),
    );
    const declared = resolveDeclarations(file, []);
    expect(declared.refused).toEqual([]);
    expect(declared.recipes[0]?.depends).toEqual([
      { kind: "resource", name: "db", env: {} },
      { kind: "resource", name: "cache", env: { CACHE_URL: "url" } },
      { kind: "resource", name: "queue", env: {} },
    ]);
    expect(planStart(declared, "web").map((each) => each.name)).toEqual(["web"]);
  });

  it.each([
    ['["@"]', "must name"],
    ['[{ shared = "db", resource = "db" }]', "not both"],
    ['[{ shared = "db", env = { PORT = "port" } }]', "Mend owns"],
    ['[{ shared = "db", env = { MEND_X = "url" } }]', "Mend owns"],
    ['[{ shared = "db", env = { TEST_URL = 1 } }]', "must name an export"],
    [
      '[{ shared = "db", env = { TEST_URL = "url" } }, { resource = "cache", env = { TEST_URL = "url" } }]',
      "TEST_URL comes from @db and @cache",
    ],
  ])("refuses just the malformed resource binding %s", (depends, words) => {
    const file = parse(
      [...WEB, `depends = ${depends}`, "[service.other]", "port = 4000"].join("\n"),
    );
    expect(file.refused.map((refusal) => refusal.message).join(" ")).toContain(words);
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(["other"]);
  });

  it("refuses recipe env shadowing a mapped name", () => {
    const file = parse(
      [
        ...WEB,
        'depends = [{ shared = "db", env = { TEST_URL = "url" } }]',
        'env = { TEST_URL = "literal" }',
      ].join("\n"),
    );
    expect(file.refused).toEqual([
      expect.objectContaining({ key: "env.TEST_URL", message: "TEST_URL comes from @db" }),
    ]);
  });

  it("leaves the other recipes parsed when one is bad", () => {
    const file = parse(`
[service.web]
command = "pnpm dev"
port = 3000
cwd = "/etc"

[service.api]
command = "node api.js"
port = 4000

[service."Web App"]
port = 3001

[service.lonely]
command = "x"
`);
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(["api"]);
    expect(file.refused.map((refusal) => [refusal.name, refusal.key])).toEqual([
      ["web", "cwd"],
      ["Web App", "name"],
      ["lonely", "port"],
    ]);
  });

  it("lists unknown keys as ignored, never refused", () => {
    const file = parse(`
title = "x"

[setup]
run = ["pnpm install"]
retries = 2

[service.web]
command = "pnpm dev"
port = 3000
disposable = true
ready = { http = "/", every = "1s" }

[preview]
service = "web"
open = "/"
`);
    expect(file.refused).toEqual([]);
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(["web"]);
    expect(file.ignored.map((ignored) => [ignored.name, ignored.key])).toEqual([
      [null, "title"],
      ["web", "disposable"],
      ["web", "ready.every"],
      [null, "preview.open"],
      [null, "setup.retries"],
    ]);
  });

  it("keeps a TOML syntax error, and a service that is not a table, file-level", () => {
    for (const toml of ["[service.web\nport=", 'service = "web"']) {
      const error = Effect.runSync(parseMendToml(toml, "/repo/mend.toml").pipe(Effect.flip));
      expect(error).toBeInstanceOf(RecipeFileError);
    }
  });

  it("names a syntax error by its line, column and reason, never the lines around it", () => {
    const toml = [
      "[service.web]",
      'command = "pnpm dev"',
      "port = 3000",
      'env = { API_TOKEN = "fake-value-slnt384" BAD }',
    ].join("\n");
    const error = Effect.runSync(parseMendToml(toml, "/repo/mend.toml").pipe(Effect.flip));
    expect(error.message).toMatch(/^mend\.toml is not valid TOML: line 4, column \d+ · [^\n]+$/u);
    expect(error.message).not.toContain("fake-value-slnt384");
    expect(error.message).not.toContain("pnpm dev");
  });

  it("reads a missing file, and one without [service], as nothing declared", async () => {
    for (const toml of [null, `title = "x"\n`]) {
      const file = await Effect.runPromise(readMendToml(worktreeWith(toml)));
      expect(file.recipes).toEqual([]);
      expect(file.refused).toEqual([]);
    }
  });
});

describe("[setup]", () => {
  it("reads its commands in order and its inputs normalized, once each", () => {
    const declared = declare(
      [
        "[setup]",
        'run = ["pnpm install --frozen-lockfile", " pnpm build:deps "]',
        'inputs = ["./pnpm-lock.yaml", "apps/web/package.json", "pnpm-lock.yaml"]',
        "",
        ...WEB,
      ].join("\n"),
    );
    expect(declared.refused).toEqual([]);
    expect(declared.setup).toEqual(
      new SetupDeclaration({
        run: ["pnpm install --frozen-lockfile", "pnpm build:deps"],
        inputs: [
          RepoRelativePath.make("pnpm-lock.yaml"),
          RepoRelativePath.make("apps/web/package.json"),
        ],
      }),
    );
  });

  it("reads no inputs as an empty list, and a file without [setup] as none", () => {
    expect(declare('[setup]\nrun = ["make deps"]').setup?.inputs).toEqual([]);
    expect(declare(WEB.join("\n")).setup).toBeNull();
  });

  it.each([
    ["[setup] that is not a table", 'setup = "pnpm install"', "setup"],
    ["no run", '[setup]\ninputs = ["pnpm-lock.yaml"]', "setup.run"],
    ["an empty run", "[setup]\nrun = []", "setup.run"],
    ["a run that is a string", '[setup]\nrun = "pnpm install"', "setup.run"],
    ["a step that is not a string", '[setup]\nrun = ["pnpm install", 3]', "setup.run"],
    ["a blank step", '[setup]\nrun = ["  "]', "setup.run"],
    [
      "inputs that is not a list",
      '[setup]\nrun = ["x"]\ninputs = "pnpm-lock.yaml"',
      "setup.inputs",
    ],
    ["an absolute input", '[setup]\nrun = ["x"]\ninputs = ["/etc/passwd"]', "setup.inputs"],
    [
      "an input that leaves the repository",
      '[setup]\nrun = ["x"]\ninputs = ["a/../../b"]',
      "setup.inputs",
    ],
    ["the repository as an input", '[setup]\nrun = ["x"]\ninputs = ["."]', "setup.inputs"],
    ["an input that is not a string", '[setup]\nrun = ["x"]\ninputs = [1]', "setup.inputs"],
  ])("refuses %s at file level, naming the key, and every recipe still lists", (_, table, key) => {
    const declared = declare(`${table}\n\n${WEB.join("\n")}`);
    expect(declared.setup).toBeNull();
    expect(declared.refused.map((refusal) => [refusal.name, refusal.key])).toEqual([[null, key]]);
    expect(setupRefusalsOf(declared.refused)).toHaveLength(1);
    expect(declared.recipes.map((recipe) => recipe.name)).toEqual(["web"]);
  });

  it("says which step and which input it refuses", () => {
    const declared = declare('[setup]\nrun = ["ok", 3]\ninputs = ["/abs"]');
    expect(declared.refused.map(recipeRefusalLine)).toEqual([
      ".mend/mend.toml · setup.run · command 2 must be a non-empty shell command",
      '.mend/mend.toml · setup.inputs · "/abs" is absolute; name a path inside the repository',
    ]);
  });
});

describe("resolveDeclarations", () => {
  it("keeps a colliding project declaration visible but marks the file declaration authoritative", () => {
    const file = new ServiceRecipe({ ...projectRecipe("web"), source: "file" });
    expect(mergeRecipes([file], [projectRecipe("web")])).toMatchObject([
      { source: "file", shadowedBy: null },
      { source: "project", shadowedBy: "file" },
    ]);
  });

  it("shadows a project recipe even while the file's recipe of that name is refused", () => {
    const declared = declare('[service.web]\ncommand = "x"\nport = 3000\ncwd = "/abs"', [
      projectRecipe("web"),
    ]);
    expect(declared.recipes).toMatchObject([{ source: "project", shadowedBy: "file" }]);
  });

  it("lets depends name a project recipe", () => {
    const declared = declare('[service.app]\ncommand = "x"\nport = 1\ndepends = ["web"]', [
      projectRecipe("web"),
    ]);
    expect(declared.refused).toEqual([]);
  });

  it.each([
    [
      "an unknown recipe",
      '[service.a]\ncommand = "x"\nport = 1\ndepends = ["nope"]',
      ["a"],
      /no recipe declares/,
    ],
    ["itself", '[service.a]\ncommand = "x"\nport = 1\ndepends = ["a"]', ["a"], /itself/],
    [
      "a cycle, every recipe on it",
      '[service.a]\ncommand = "x"\nport = 1\ndepends = ["b"]\n[service.b]\ncommand = "x"\nport = 2\ndepends = ["a"]',
      ["a", "b"],
      /cycle: a → b → a/,
    ],
    [
      "a refused recipe, and whatever depends on that",
      '[service.a]\ncommand = "x"\nport = 1\ndepends = ["b"]\n[service.b]\ncommand = "x"\nport = 2\ndepends = ["c"]\n[service.c]\ncommand = "x"\nport = 70000',
      ["b", "a"],
      /which is refused/,
    ],
  ])("refuses depends on %s", (_, toml, names, message) => {
    const declared = declare(toml);
    const dependsRefusals = declared.refused.filter((refusal) => refusal.key === "depends");
    expect(dependsRefusals.map((refusal) => refusal.name)).toEqual(names);
    expect(dependsRefusals.every((refusal) => message.test(refusal.message))).toBe(true);
    for (const name of names)
      expect(declared.recipes.some((recipe) => recipe.name === name)).toBe(false);
  });

  it.each([
    ["an unknown recipe", 'service = "nope"', /not a runnable recipe/],
    ["a recipe without browserScheme = http", 'service = "api"', /browserScheme/],
    ["an https recipe", 'service = "secure"', /browserScheme/],
    ["a refused recipe", 'service = "broken"', /not a runnable recipe/],
  ])("refuses a [preview] naming %s", (_, line, message) => {
    const declared = declare(
      [
        ...WEB,
        '[service.api]\ncommand = "x"\nport = 2',
        '[service.secure]\ncommand = "x"\nport = 3\nbrowserScheme = "https"',
        '[service.broken]\ncommand = "x"\nport = 4\nbrowserScheme = "http"\ncwd = "/x"',
        "[preview]",
        line,
      ].join("\n"),
    );
    expect(declared.preview).toBeNull();
    expect(declared.refused).toContainEqual(
      expect.objectContaining({
        name: null,
        key: "preview.service",
        message: expect.stringMatching(message),
      }),
    );
  });

  it("keeps a [preview] naming a browser http recipe", () => {
    expect(declare([...WEB, "[preview]", 'service = "web"'].join("\n")).preview?.service).toBe(
      "web",
    );
  });
});

describe("planStart", () => {
  it("starts dependencies first, depth first in listed order, each once", () => {
    const declared = declare(`
[service.web]
command = "x"
port = 1
depends = ["api", "db"]

[service.api]
command = "x"
port = 2
depends = ["db", "cache"]

[service.db]
port = 3

[service.cache]
command = "x"
port = 4
`);
    expect(planStart(declared, "web").map((recipe) => recipe.name)).toEqual([
      "db",
      "cache",
      "api",
      "web",
    ]);
    expect(planStart(declared, "db").map((recipe) => recipe.name)).toEqual(["db"]);
    expect(planStart(declared, "nope")).toEqual([]);
  });
});
