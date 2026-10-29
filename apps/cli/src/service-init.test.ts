import { parseMendToml, resolveDeclarations } from "@mend/sessions/recipes";
import { Effect } from "effect";
import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isComposeFile,
  proposeForRepository,
  proposeFromCompose,
  proposeFromPackageJson,
  proposeFromWorkspacePackage,
  proposeSetup,
  renderMendToml,
  workspaceGlobs,
} from "./service-init.ts";

describe("proposeFromPackageJson", () => {
  it("reads an explicit --port from the dev script", () => {
    const proposals = proposeFromPackageJson(
      JSON.stringify({ scripts: { dev: "vite --port 3000" } }),
      ["pnpm-lock.yaml"],
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      name: "web",
      command: "pnpm run dev",
      port: 3000,
      guessed: false,
    });
  });

  it("falls back to the tool default, marked guessed", () => {
    const proposals = proposeFromPackageJson(JSON.stringify({ scripts: { dev: "vite" } }), [
      "yarn.lock",
    ]);
    expect(proposals[0]).toMatchObject({
      command: "yarn run dev",
      port: 5173,
      guessed: true,
      browserScheme: "http",
      cwd: null,
    });
  });

  it("declares no browser for a server it does not know", () => {
    const proposals = proposeFromPackageJson(
      JSON.stringify({ scripts: { start: "node server.js --port 8080" } }),
      [],
    );
    expect(proposals[0]).toMatchObject({ port: 8080, browserScheme: null });
  });

  it("proposes nothing when no port can be named", () => {
    expect(proposeFromPackageJson(JSON.stringify({ scripts: { dev: "tsc --watch" } }), [])).toEqual(
      [],
    );
    expect(proposeFromPackageJson("not json", [])).toEqual([]);
  });
});

describe("proposeFromCompose", () => {
  it("reads published ports per service", () => {
    const proposals = proposeFromCompose(`
services:
  mysql:
    image: mysql:8
    ports:
      - "3306:3306"
  redis:
    image: redis:7
    ports:
      - 6379:6379
  internal:
    image: worker:1
`);
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      name: "mysql",
      command: "docker compose up mysql",
      port: 3306,
    });
    expect(proposals[1]).toMatchObject({ name: "redis", port: 6379 });
    expect(proposals.every((proposal) => proposal.address === "docker")).toBe(true);
    expect(proposals.every((proposal) => proposal.browserScheme === null)).toBe(true);
  });
});

describe("compose flavors and env defaults", () => {
  it("recognizes every compose filename flavor", () => {
    expect(isComposeFile("compose.yaml")).toBe(true);
    expect(isComposeFile("compose.dev.yaml")).toBe(true);
    expect(isComposeFile("docker-compose.yml")).toBe(true);
    expect(isComposeFile("compose.json")).toBe(false);
    expect(isComposeFile("decompose.yaml")).toBe(false);
  });

  it("reads the declared default of an env-interpolated port", () => {
    const proposals = proposeFromCompose(
      'services:\n  mend:\n    ports:\n      - "${MEND_PORT:-3000}:3000"\n',
    );
    expect(proposals[0]).toMatchObject({ name: "mend", port: 3000, guessed: false });
  });
});

describe("workspace sweep", () => {
  it("collects globs from pnpm-workspace.yaml and package.json workspaces", () => {
    expect(
      workspaceGlobs('packages:\n  - "apps/*"\n  - packages/*\n  - "!**/test"\n', null),
    ).toEqual(["apps/*", "packages/*"]);
    expect(workspaceGlobs(null, JSON.stringify({ workspaces: ["apps/*"] }))).toEqual(["apps/*"]);
  });

  it("proposes a workspace package's server script in its own directory", () => {
    const proposals = proposeFromWorkspacePackage(
      "apps/marketing",
      JSON.stringify({ name: "@mend/marketing", scripts: { dev: "vite dev --port 3102" } }),
      ["pnpm-lock.yaml"],
    );
    expect(proposals[0]).toMatchObject({
      name: "marketing",
      command: "pnpm run dev",
      cwd: "apps/marketing",
      port: 3102,
      guessed: false,
      browserScheme: "http",
    });
  });
});

describe("proposeFromCompose udp", () => {
  it("proposes udp for a /udp published mapping and renders the protocol line", () => {
    const compose = [
      "services:",
      "  game:",
      "    image: factorio",
      "    ports:",
      '      - "34197:34197/udp"',
    ].join("\n");
    const proposals = proposeFromCompose(compose);
    expect(proposals[0]).toMatchObject({ name: "game", port: 34197, protocol: "udp" });
    const toml = renderMendToml(proposals);
    expect(toml).toContain('protocol = "udp"');
  });
});

describe("renderMendToml", () => {
  const web = {
    name: "web",
    command: "pnpm run dev",
    port: 5173,
    protocol: "tcp",
    guessed: true,
    browserScheme: "http",
    cwd: "apps/web",
    address: "loopback",
    source: "apps/web/package.json",
  } as const;
  const mysql = {
    name: "mysql",
    command: "docker compose up mysql",
    port: 3306,
    protocol: "tcp",
    guessed: false,
    browserScheme: null,
    cwd: null,
    address: "docker",
    source: "compose",
  } as const;

  it("renders a commented, committable file, with [preview] for its one browser Service", () => {
    expect(renderMendToml([web, mysql])).toBe(
      [
        "# apps/web/package.json",
        "[service.web]",
        'command = "pnpm run dev"',
        "port = 5173 # guessed — verify",
        'browserScheme = "http"',
        'cwd = "apps/web"',
        "",
        "# compose",
        "[service.mysql]",
        'command = "docker compose up mysql"',
        "port = 3306",
        'address = "docker"',
        "",
        "[preview]",
        'service = "web"',
        "",
      ].join("\n"),
    );
  });

  it("proposes no [preview] when none, or more than one, is a browser Service", () => {
    expect(renderMendToml([mysql])).not.toContain("[preview]");
    expect(renderMendToml([web, { ...web, name: "docs", cwd: "apps/docs" }])).not.toContain(
      "[preview]",
    );
  });
});

const parsedBack = (toml: string) =>
  Effect.runSync(
    Effect.map(parseMendToml(toml, "mend.toml"), (file) => resolveDeclarations(file, [])),
  );

describe("[setup] from a lockfile", () => {
  const api = {
    name: "api",
    command: "npm run dev",
    port: 4000,
    protocol: "tcp",
    guessed: false,
    browserScheme: null,
    cwd: null,
    address: "loopback",
    source: "package.json",
  } as const;
  it.each([
    [["pnpm-lock.yaml", "package.json"], "pnpm install --frozen-lockfile", "pnpm-lock.yaml"],
    [["yarn.lock"], "yarn install --immutable", "yarn.lock"],
    [["bun.lock"], "bun install --frozen-lockfile", "bun.lock"],
    [["bun.lockb"], "bun install --frozen-lockfile", "bun.lockb"],
    [["package-lock.json"], "npm ci", "package-lock.json"],
  ])("from %j: %s, with the lockfile as its input", (rootFiles, run, input) => {
    const declared = parsedBack(renderMendToml([api], proposeSetup(rootFiles)));
    expect(declared.refused).toEqual([]);
    expect(declared.setup).toMatchObject({ run: [run], inputs: [input] });
  });

  it("writes none without a lockfile", () => {
    expect(proposeSetup(["package.json", "README.md"])).toBeNull();
    expect(renderMendToml([api], proposeSetup(["package.json"]))).not.toContain("[setup]");
  });
});

describe("what init writes, read back by the server's parser", () => {
  it("refuses nothing in a compose file with UDP and TCP ports", () => {
    const proposals = proposeFromCompose(
      [
        "services:",
        "  statsd:",
        "    ports:",
        '      - "8125:8125/udp"',
        "  db:",
        "    ports:",
        '      - "5432:5432"',
      ].join("\n"),
    );
    const declared = parsedBack(renderMendToml(proposals));
    expect(declared.refused).toEqual([]);
    expect(
      declared.recipes.map((recipe) => [recipe.name, recipe.protocol, recipe.address]),
    ).toEqual([
      ["statsd", "udp", "loopback"],
      ["db", "tcp", "docker"],
    ]);
  });
});

const nameChars = FastCheck.constantFrom(..."abcXYZ019._- @".split(""));
/** A directory entry as `readdir` lists one: never `.` or `..`. */
const rawName = FastCheck.string({ unit: nameChars, minLength: 1, maxLength: 70 }).filter(
  (name) => name !== "." && name !== "..",
);
const script = FastCheck.constantFrom(
  "vite",
  "vite --port 3000",
  "next dev -p 4000",
  "astro dev",
  "node server.js --port 8080",
  'PORT=9000 node "x"\nnode y',
  "tsc --watch",
);
const packageJsonOf = (scripts: Readonly<Record<string, string>>) => JSON.stringify({ scripts });
const scriptsOf = FastCheck.dictionary(
  FastCheck.constantFrom("dev", "start", "serve", "preview", "build"),
  script,
);
const composeOf = FastCheck.array(
  FastCheck.record({
    name: FastCheck.string({ unit: nameChars, minLength: 1, maxLength: 70 }).map((name) =>
      name.replace(/[^A-Za-z0-9._-]/g, "x"),
    ),
    port: FastCheck.integer({ min: 1, max: 65535 }),
    udp: FastCheck.boolean(),
  }),
  { maxLength: 4 },
).map((services) =>
  [
    "services:",
    ...services.flatMap(({ name, port, udp }) => [
      `  ${name}:`,
      "    ports:",
      `      - "${port}:${port}${udp ? "/udp" : ""}"`,
    ]),
  ].join("\n"),
);

describe("every proposal init makes", () => {
  it("parses back with nothing refused or ignored, one recipe per proposal", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.option(scriptsOf, { nil: null }),
        FastCheck.array(FastCheck.record({ dir: rawName, scripts: scriptsOf }), { maxLength: 3 }),
        FastCheck.array(
          FastCheck.record({
            name: FastCheck.constantFrom("compose.yaml", "compose.dev.yaml", "docker-compose.yml"),
            text: composeOf,
          }),
          { maxLength: 2 },
        ),
        FastCheck.constantFrom<ReadonlyArray<string>>(
          ["pnpm-lock.yaml"],
          ["yarn.lock"],
          ["bun.lock"],
          ["package-lock.json"],
          [],
        ),
        (root, packages, composeFiles, rootFiles) => {
          const proposals = proposeForRepository({
            rootFiles,
            packageJson: root === null ? null : packageJsonOf(root),
            workspacePackages: packages.map(({ dir, scripts }) => ({
              dir: `apps/${dir}`,
              packageJson: packageJsonOf(scripts),
            })),
            composeFiles,
          });
          if (proposals.length === 0) return;
          const setup = proposeSetup(rootFiles);
          const declared = parsedBack(renderMendToml(proposals, setup));
          expect(declared.refused).toEqual([]);
          expect(declared.ignored).toEqual([]);
          expect(declared.setup?.inputs ?? []).toEqual(setup === null ? [] : [setup.input]);
          expect(declared.recipes.map((recipe) => recipe.name).toSorted()).toEqual(
            proposals.map((proposal) => proposal.name).toSorted(),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
