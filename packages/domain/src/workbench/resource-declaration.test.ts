import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId } from "../ids.ts";
import {
  resourceRestartRefusals,
  type ResourceRememberedState,
  type RememberedResourceSpec,
} from "./resource-declaration.ts";
import {
  presetDefinition,
  PresetVersion,
  ResourceDefinition,
  ResourceName,
  resourceSpecDigest,
} from "./resource.ts";

const PROJECT = ProjectId.make("p-declaration");
const decode = Schema.decodeUnknownSync(ResourceDefinition);

const mailpit = (overrides: Record<string, unknown> = {}): ResourceDefinition =>
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
});

const held = (spec: ResourceDefinition, owning = 0): RememberedResourceSpec => ({
  spec,
  digest: resourceSpecDigest(spec),
  owning,
});

const remembered = (
  ...definitions: ReadonlyArray<RememberedResourceSpec>
): ResourceRememberedState => ({
  projectId: PROJECT,
  definitions,
});

const keys = (refusals: ReadonlyArray<{ readonly key: string }>) => refusals.map(({ key }) => key);

describe("resourceRestartRefusals", () => {
  it("lets a valid spec in that nothing in remembered collides with", () => {
    expect(resourceRestartRefusals(remembered(), mailpit())).toEqual([]);
    expect(resourceRestartRefusals(remembered(held(db)), mailpit())).toEqual([]);
  });

  it("refuses a new preset while a worktree holds the definition as own, and counts them", () => {
    const mysql = presetDefinition({
      name: ResourceName.make("db"),
      preset: "mysql",
      version: PresetVersion.make("8"),
    });
    expect(resourceRestartRefusals(remembered(held(db, 2)), mysql)).toEqual([
      {
        key: "preset",
        message:
          "changes what own is, and 2 worktrees hold @db as own, with data of their own · keep its Postgres preset while own databases exist",
      },
    ]);
    // Nobody holds it as own, or the replacement keeps what own is.
    expect(resourceRestartRefusals(remembered(held(db)), mysql)).toEqual([]);
    const newer = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("18"),
    });
    expect(resourceRestartRefusals(remembered(held(db, 3)), newer)).toEqual([]);
  });

  it("refuses an env name another definition in remembered sets too, and never its own old spec", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const dbMain = mailpit({
      name: "db-main",
      exports: { URL: "smtp://{host}" },
    });
    expect(resourceRestartRefusals(remembered(held(main)), dbMain)).toEqual([
      { key: "exports.URL", message: "sets MEND_DB_MAIN_URL, as db does too" },
    ]);
    // The spec it replaces under its own name sets nothing beside it.
    const older = mailpit({ name: "db-main", scope: "project", exports: { URL: "smtp://old" } });
    expect(resourceRestartRefusals(remembered(held(older)), dbMain)).toEqual([]);
  });

  it("says the definition's own rules alone, before anything remembered would add", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const portless = mailpit({
      name: "db-main",
      ports: [],
      exports: { URL: "smtp://{host}" },
    });
    expect(keys(resourceRestartRefusals(remembered(held(main)), portless))).toEqual(["ports"]);
  });
});
