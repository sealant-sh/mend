import { parseMendToml, recipeDigestsOf, resolveDeclarations } from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const declare = (toml: string) =>
  resolveDeclarations(Effect.runSync(parseMendToml(toml, "/repo/mend.toml")), []);

const digestsOf = (toml: string) => recipeDigestsOf(declare(toml));

const WEB_AND_DB = `
[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
cwd = "apps/web"
env = { NODE_ENV = "development", API_URL = "http://localhost:4000" }
depends = ["db"]

[service.db]
command = "docker compose up db"
port = 5432
env = { POSTGRES_PASSWORD = "local" }

[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]
`;

describe("the recipe digest", () => {
  // Each computed apart from Mend, over the canonical form:
  //   printf 'mend-recipe/v1\0{"command":"docker compose up db","cwd":null,"depends":[],
  //     "env":{"POSTGRES_PASSWORD":"local"},"setup":{"inputs":["pnpm-lock.yaml"],
  //     "run":["pnpm install --frozen-lockfile"]}}' | sha256sum
  // and web's the same with "depends":["<db's digest>"].
  it("is pinned: a later Mend reads an earlier approval the same", () => {
    const digests = digestsOf(WEB_AND_DB);
    expect(digests.get("db")).toBe(
      "7117c9f091d857144dec10e3de1d4eb204b11e661ceb029234435f71adb17f70",
    );
    expect(digests.get("web")).toBe(
      "cf1a61f1daf0e59a7b6db5344f0b63cb394192543e4e020307f838c634c867c1",
    );
    expect(digestsOf('[service.web]\ncommand = "pnpm dev"\nport = 3000\n').get("web")).toBe(
      "62db5b7a629e363bbc0bce91b1e463a11690347aed51a82cc8f0bcfc645b2f58",
    );
  });

  it("is the same however the file orders its tables and env", () => {
    const reordered = `
[setup]
inputs = ["pnpm-lock.yaml"]
run = ["pnpm install --frozen-lockfile"]

[service.db]
env = { POSTGRES_PASSWORD = "local" }
port = 5432
command = "docker compose up db"

[service.web]
depends = ["db"]
env = { API_URL = "http://localhost:4000", NODE_ENV = "development" }
cwd = "./apps/web/"
browserScheme = "http"
port = 3000
command = "pnpm dev"
`;
    expect(digestsOf(reordered)).toEqual(digestsOf(WEB_AND_DB));
  });

  it.each([
    ["command", 'command = "pnpm dev"', 'command = "pnpm dev --open"'],
    ["cwd", 'cwd = "apps/web"', 'cwd = "apps/site"'],
    ["env", 'NODE_ENV = "development"', 'NODE_ENV = "production"'],
    ["setup run", 'run = ["pnpm install --frozen-lockfile"]', 'run = ["pnpm install"]'],
    ["setup inputs", 'inputs = ["pnpm-lock.yaml"]', 'inputs = ["pnpm-lock.yaml", ".nvmrc"]'],
    ["a dependency's command", 'command = "docker compose up db"', 'command = "postgres -D ."'],
  ])("changes with %s", (_what, from, to) => {
    const changed = WEB_AND_DB.replace(from, to);
    expect(changed).not.toBe(WEB_AND_DB);
    expect(digestsOf(changed).get("web")).not.toBe(digestsOf(WEB_AND_DB).get("web"));
  });

  it.each([
    ["port", "port = 3000", "port = 3001"],
    [
      "ready",
      'browserScheme = "http"',
      'browserScheme = "http"\nready = { http = "/", timeout = "90s" }',
    ],
    ["host", 'browserScheme = "http"', 'browserScheme = "http"\nhost = "preserve"'],
    ["address", "port = 5432", 'port = 5432\naddress = "docker"'],
    ["browserScheme", 'browserScheme = "http"', 'browserScheme = "https"'],
  ])("stays with %s, which changes no command", (_what, from, to) => {
    const changed = WEB_AND_DB.replace(from, to);
    expect(changed).not.toBe(WEB_AND_DB);
    expect(digestsOf(changed)).toEqual(digestsOf(WEB_AND_DB));
  });
});
