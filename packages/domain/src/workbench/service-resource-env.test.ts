import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { WorktreeId } from "../ids.ts";
import { presetDefinition, ResourceName, PresetVersion } from "./resource.ts";
import { ResourceDefinitionInput } from "./resource.ts";
import { serviceResourceEnv } from "./service-resource-env.ts";

const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
  scope: "project",
});
const worktreeId = WorktreeId.make("wt-resource-preview");
const resolve = (
  env: Readonly<Record<string, string>>,
  recipeEnv: Readonly<Record<string, string>> = {},
) =>
  serviceResourceEnv({
    dependencies: [{ kind: "resource", name: "db", env }],
    definitions: [{ spec: db, choice: "shared" }],
    worktreeId,
    projectEnvNames: new Set(),
    recipeEnv,
  });

describe("a Service's resource export mapping", () => {
  it.each([
    ["url", "postgres://postgres@db:5432/app"],
    ["host", "db"],
    ["port", "5432"],
    ["database", "app"],
    ["username", "postgres"],
  ])("maps %s", (source, value) => {
    expect(resolve({ TEST_VALUE: source })).toEqual({ env: { TEST_VALUE: value }, refusal: null });
  });
  it.each([
    [{ DATABASE_URL: "url" }, {}, "DATABASE_URL comes from @db"],
    [{ TEST_URL: "url" }, { TEST_URL: "literal" }, "TEST_URL comes from @db"],
    [{ TEST_URL: "nope" }, {}, "@db · no export nope"],
  ])("refuses collisions and missing exports by name", (env, recipe, words) => {
    expect(resolve(env, recipe).refusal).toContain(words);
  });
  it("maps named ports and the definition's own exports", () => {
    const queue = Schema.decodeUnknownSync(ResourceDefinitionInput)({
      ...db,
      name: "queue",
      preset: null,
      ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
      exports: { URL: "amqp://{host}:{port.amqp}/" },
    });
    expect(
      serviceResourceEnv({
        dependencies: [
          { kind: "resource", name: "queue", env: { AMQP_URL: "URL", AMQP_PORT: "port.amqp" } },
        ],
        definitions: [{ spec: queue, choice: "shared" }],
        worktreeId,
        projectEnvNames: new Set(),
        recipeEnv: {},
      }),
    ).toEqual({ env: { AMQP_URL: "amqp://queue:5672/", AMQP_PORT: "5672" }, refusal: null });
  });
  it("does not override a conventional name the project sets", () => {
    expect(
      serviceResourceEnv({
        dependencies: [{ kind: "resource", name: "db", env: {} }],
        definitions: [{ spec: db, choice: "shared" }],
        worktreeId,
        projectEnvNames: new Set(["DATABASE_URL"]),
        recipeEnv: { DATABASE_URL: "project" },
      }).refusal,
    ).toBeNull();
  });
});
