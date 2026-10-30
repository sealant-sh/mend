import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectId } from "../ids.ts";
import {
  resourceApprovalRefusals,
  resourceDeclarationRefusals,
  type ResourceSettingsState,
  type SettingsDefinition,
  worktreeApprovalImage,
} from "./resource-approval.ts";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
  resourceSpecDigest,
} from "./resource.ts";

const PROJECT = ProjectId.make("p-approval");
const IMAGE = ImageDigest.make(`sha256:${"a".repeat(64)}`);
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

const held = (
  spec: ResourceDefinitionInput,
  facts: Partial<Omit<SettingsDefinition, "spec" | "digest">> = {},
): SettingsDefinition => ({
  spec,
  digest: resourceSpecDigest(spec),
  projectImage: null,
  owning: 0,
  ...facts,
});

const settings = (...definitions: ReadonlyArray<SettingsDefinition>): ResourceSettingsState => ({
  projectId: PROJECT,
  definitions,
});

const FOR_PROJECT = { kind: "project" } as const;
const FOR_WORKTREE = { kind: "worktree", projectId: PROJECT } as const;
const keys = (refusals: ReadonlyArray<{ readonly key: string }>) => refusals.map(({ key }) => key);

describe("resourceApprovalRefusals", () => {
  it("lets a manager approve for the project a valid spec nothing in settings collides with", () => {
    expect(resourceApprovalRefusals(settings(), mailpit(), FOR_PROJECT)).toEqual([]);
    expect(resourceApprovalRefusals(settings(held(db)), mailpit(), FOR_PROJECT)).toEqual([]);
  });

  it("approves a project resource for the project, never one worktree", () => {
    expect(resourceApprovalRefusals(settings(held(db)), db, FOR_WORKTREE)).toEqual([
      {
        key: "worktree",
        message: "is one worktree, and @db is a project resource, approved for the project",
      },
    ]);
  });

  it("refuses a worktree another project holds", () => {
    const spec = mailpit();
    const state = settings(held(spec, { projectImage: IMAGE }));
    expect(
      resourceApprovalRefusals(state, spec, {
        kind: "worktree",
        projectId: ProjectId.make("p-elsewhere"),
      }),
    ).toEqual([
      { key: "worktree", message: "is not a worktree of the project that declares @mail" },
    ]);
    expect(resourceApprovalRefusals(state, spec, { kind: "worktree", projectId: null })).toEqual([
      { key: "worktree", message: "is not a worktree of the project that declares @mail" },
    ]);
  });

  it("approves a worktree resource for a worktree only once a manager approved this exact spec for the project", () => {
    const spec = mailpit();
    const image = [
      {
        key: "image",
        message:
          "is not one a manager approved for this project · a manager approves @mail for the project first",
      },
    ];
    // Not in settings; in settings, unapproved; another spec approved under its name; another
    // definition approved with the same image.
    expect(resourceApprovalRefusals(settings(), spec, FOR_WORKTREE)).toEqual(image);
    expect(resourceApprovalRefusals(settings(held(spec)), spec, FOR_WORKTREE)).toEqual(image);
    const older = mailpit({ image: "axllent/mailpit:v1.20" });
    expect(
      resourceApprovalRefusals(settings(held(older, { projectImage: IMAGE })), spec, FOR_WORKTREE),
    ).toEqual(image);
    const box = mailpit({ name: "box", scope: "project" });
    expect(
      resourceApprovalRefusals(
        settings(held(box, { projectImage: IMAGE }), held(spec)),
        spec,
        FOR_WORKTREE,
      ),
    ).toEqual(image);

    const approved = settings(held(spec, { projectImage: IMAGE }));
    expect(resourceApprovalRefusals(approved, spec, FOR_WORKTREE)).toEqual([]);
    expect(worktreeApprovalImage(approved, spec)).toBe(IMAGE);
    expect(worktreeApprovalImage(settings(held(older, { projectImage: IMAGE })), spec)).toBeNull();
  });

  it("refuses a new scope or preset while a worktree holds the definition as own, and counts them", () => {
    const toWorktree = { ...db, scope: "worktree" } as const;
    expect(
      resourceApprovalRefusals(settings(held(db, { owning: 1 })), toWorktree, FOR_PROJECT),
    ).toEqual([
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
    expect(resourceApprovalRefusals(settings(held(db, { owning: 2 })), mysql, FOR_PROJECT)).toEqual(
      [
        {
          key: "preset",
          message:
            "changes what own is, and 2 worktrees hold @db as own, with data of their own · switch them to shared or off first",
        },
      ],
    );
    // Nobody holds it as own, or the replacement keeps what own is.
    expect(resourceApprovalRefusals(settings(held(db)), toWorktree, FOR_PROJECT)).toEqual([]);
    const newer = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("18"),
      scope: "project",
    });
    expect(resourceApprovalRefusals(settings(held(db, { owning: 3 })), newer, FOR_PROJECT)).toEqual(
      [],
    );
  });

  it("refuses an env name another definition in settings sets too, and never its own old spec", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const dbMain = mailpit({
      name: "db-main",
      scope: "project",
      exports: { URL: "smtp://{host}" },
    });
    expect(resourceApprovalRefusals(settings(held(main)), dbMain, FOR_PROJECT)).toEqual([
      { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
    ]);
    // The spec it replaces under its own name sets nothing beside it.
    const older = mailpit({ name: "db-main", scope: "project", exports: { URL: "smtp://old" } });
    expect(resourceApprovalRefusals(settings(held(older)), dbMain, FOR_PROJECT)).toEqual([]);
  });

  it("says the definition's own rules alone, before anything settings would add", () => {
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    const portless = mailpit({
      name: "db-main",
      scope: "project",
      ports: [],
      exports: { URL: "smtp://{host}" },
    });
    expect(keys(resourceApprovalRefusals(settings(held(main)), portless, FOR_PROJECT))).toEqual([
      "ports",
    ]);
  });

  it("says every refusal of a worktree's approval at once", () => {
    const dbMain = mailpit({ name: "db-main", exports: { URL: "smtp://{host}" } });
    const main = mailpit({ name: "db", scope: "project", exports: { MAIN_URL: "smtp://{host}" } });
    expect(resourceApprovalRefusals(settings(held(main)), dbMain, FOR_WORKTREE)).toEqual([
      {
        key: "image",
        message:
          "is not one a manager approved for this project · a manager approves @db-main for the project first",
      },
      { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
    ]);
  });
});

describe("resourceDeclarationRefusals", () => {
  it("is the approval's refusals without a target's", () => {
    const toWorktree = { ...db, scope: "worktree" } as const;
    const state = settings(held(db, { owning: 1 }));
    expect(resourceDeclarationRefusals(state, toWorktree)).toEqual(
      resourceApprovalRefusals(state, toWorktree, FOR_PROJECT),
    );
  });
});
