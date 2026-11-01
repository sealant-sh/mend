import { describe, expect, it } from "vitest";

import { ResourceDefinitionId } from "../ids.ts";
import { resourceBindingEnv } from "./resource-runtime.ts";
import { presetDefinition, ResourceName, PresetVersion, type ResourceBinding } from "./resource.ts";
import { resolveResourceReferences, serviceResourceEnv } from "./service-resource-env.ts";
const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
});
const binding: ResourceBinding = {
  definition: db,
  resourceId: ResourceDefinitionId.make("db"),
  level: "project",
  instanceKey: "db",
  database: "app",
};
const resourceEnv = Object.fromEntries(resourceBindingEnv(binding));
const base = {
  service: "web",
  definitions: [db],
  bindings: [binding],
  resourceEnv,
  projectEnvNames: new Set<string>(),
  dependencies: [],
  recipeEnv: {},
};
describe("Service resource env", () => {
  it("resolves only braced Mend references in recipe values", () => {
    expect(
      resolveResourceReferences({
        ...base,
        recipeEnv: { DATABASE_URL: "${MEND_DB_URL}", RAW: "$MEND_DB_URL ${OTHER} $HOME" },
      }),
    ).toEqual({
      env: { DATABASE_URL: "postgres://postgres@db:5432/app", RAW: "$MEND_DB_URL ${OTHER} $HOME" },
      refusal: null,
    });
  });
  it("refuses missing references and dependencies exactly", () => {
    expect(
      resolveResourceReferences({
        ...base,
        resourceEnv: {},
        recipeEnv: { DATABASE_URL: "${MEND_DB_URL}" },
      }).refusal,
    ).toBe(
      "web needs MEND_DB_URL · @db is not running for this worktree · mend resource start db --project or --worktree",
    );
    expect(resolveResourceReferences({ ...base, recipeEnv: { X: "${MEND_X}" } }).refusal).toBe(
      "web needs MEND_X · no resource gives it to this worktree",
    );
    expect(
      serviceResourceEnv({
        ...base,
        bindings: [],
        dependencies: [{ kind: "resource", name: "db", env: {} }],
      }).refusal,
    ).toBe(
      "web needs @db · @db is not running for this worktree · mend resource start db --project or --worktree",
    );
  });
  it("never sets a recipe-owned Mend name", () => {
    expect(serviceResourceEnv({ ...base, recipeEnv: { MEND_DB_URL: "bad" } }).refusal).toBe(
      "web cannot set MEND_DB_URL: Mend owns MEND_*",
    );
  });
  it.each([
    ["url", "postgres://postgres@db:5432/app"],
    ["host", "db"],
    ["port", "5432"],
    ["port.postgres", "5432"],
    ["database", "app"],
    ["username", "postgres"],
  ])("keeps opt-in %s mappings", (source, value) => {
    expect(
      serviceResourceEnv({
        ...base,
        dependencies: [{ kind: "resource", name: "db", env: { DATABASE_URL: source } }],
      }),
    ).toEqual({ env: { DATABASE_URL: value }, refusal: null });
  });
  it("refuses mapping collisions and unknown exports", () => {
    expect(
      serviceResourceEnv({
        ...base,
        dependencies: [{ kind: "resource", name: "db", env: { MEND_DB_HOST: "url" } }],
      }).refusal,
    ).toContain("comes from @db");
    expect(
      serviceResourceEnv({
        ...base,
        dependencies: [{ kind: "resource", name: "db", env: { X: "nope" } }],
      }).refusal,
    ).toContain("no export nope");
    expect(
      serviceResourceEnv({
        ...base,
        dependencies: [{ kind: "resource", name: "db", env: { X: "url" } }],
        recipeEnv: { X: "set" },
      }).refusal,
    ).toBe("X comes from @db");
  });
  it("leaves project environment and secret names", () => {
    expect(
      serviceResourceEnv({
        ...base,
        projectEnvNames: new Set(["DATABASE_URL"]),
        dependencies: [{ kind: "resource", name: "db", env: { DATABASE_URL: "url" } }],
      }).env,
    ).toEqual({});
  });
});
