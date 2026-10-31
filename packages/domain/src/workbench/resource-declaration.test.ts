import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId } from "../ids.ts";
import {
  resourceDeclarationRefusals,
  type ResourceSettingsState,
  type SettingsDefinition,
} from "./resource-declaration.ts";
import {
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
  resourceSpecDigest,
} from "./resource.ts";

const PROJECT = ProjectId.make("p-declaration");
const decode = Schema.decodeUnknownSync(ResourceDefinitionInput);

const mailpit = (overrides: Record<string, unknown> = {}): ResourceDefinitionInput =>
  decode({
    name: "mail",
    scope: "worktree",
    preset: null,
    image: "axllent/mailpit:v1.21",
    command: null,
    ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
    env: {},
    volumes: [],
    ready: { kind: "tcp" },
    exports: {},
    ...overrides,
  });

const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
  scope: "project",
});

const held = (spec: ResourceDefinitionInput, owning = 0): SettingsDefinition => ({
  spec,
  digest: resourceSpecDigest(spec),
  owning,
});

const settings = (...definitions: ReadonlyArray<SettingsDefinition>): ResourceSettingsState => ({
  projectId: PROJECT,
  definitions,
});

const keys = (refusals: ReadonlyArray<{ readonly key: string }>) => refusals.map(({ key }) => key);

describe("resourceDeclarationRefusals", () => {
  it("lets a valid spec in that nothing in settings collides with", () => {
    expect(resourceDeclarationRefusals(settings(), mailpit())).toEqual([]);
    expect(resourceDeclarationRefusals(settings(held(db)), mailpit())).toEqual([]);
  });

  it("refuses a new scope or preset while a worktree holds the definition as own, and counts them", () => {
    const toWorktree = { ...db, scope: "worktree" } as const;
    expect(resourceDeclarationRefusals(settings(held(db, 1)), toWorktree)).toEqual([
      {
        key: "scope",
        message:
          "changes what own is, and 1 worktree holds @db as own, with data of its own · switch it to shared or off first",
      },
    ]);
    const mysql = presetDefinition({
      name: ResourceName.make("db"),
      preset: "mysql",
      version: PresetVersion.make("8"),
      scope: "project",
    });
    expect(resourceDeclarationRefusals(settings(held(db, 2)), mysql)).toEqual([
      {
        key: "preset",
        message:
          "changes what own is, and 2 worktrees hold @db as own, with data of their own · switch them to shared or off first",
      },
    ]);
    // Nobody holds it as own, or the replacement keeps what own is.
    expect(resourceDeclarationRefusals(settings(held(db)), toWorktree)).toEqual([]);
    const newer = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("18"),
      scope: "project",
    });
    expect(resourceDeclarationRefusals(settings(held(db, 3)), newer)).toEqual([]);
  });

  it("refuses an env name another definition in settings sets too, and never its own old spec", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const dbMain = mailpit({
      name: "db-main",
      scope: "project",
      exports: { URL: "smtp://{host}" },
    });
    expect(resourceDeclarationRefusals(settings(held(main)), dbMain)).toEqual([
      { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
    ]);
    // The spec it replaces under its own name sets nothing beside it.
    const older = mailpit({ name: "db-main", scope: "project", exports: { URL: "smtp://old" } });
    expect(resourceDeclarationRefusals(settings(held(older)), dbMain)).toEqual([]);
  });

  it("says the definition's own rules alone, before anything settings would add", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const portless = mailpit({
      name: "db-main",
      scope: "project",
      ports: [],
      exports: { URL: "smtp://{host}" },
    });
    expect(keys(resourceDeclarationRefusals(settings(held(main)), portless))).toEqual(["ports"]);
  });
});
