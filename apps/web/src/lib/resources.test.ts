import { ResourceDefinitionId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  choiceInUse,
  choiceWords,
  additionOf,
  EMPTY_DRAFT,
  fieldOf,
  type ResourceDraft,
  type ResourceSettingView,
} from "./resources.ts";

const digest = ResourceSpecDigest.make("a".repeat(64));
const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
  scope: "project",
});
const mail = Schema.decodeUnknownSync(ResourceDefinitionInput)({
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
});

const setting = (overrides: Partial<ResourceSettingView> = {}): ResourceSettingView => ({
  id: ResourceDefinitionId.make("rdef_db"),
  digest,
  spec: db,
  image: `postgres:17@sha256:${"c".repeat(64)}`,
  addedBy: "maria",
  choice: null,
  canRemove: true,
  canChoose: false,
  statusLine: "@db · postgres 17 · project · added by Maria · not started",
  ...overrides,
});

describe("adding a resource from the form", () => {
  it("sends a preset at its version, as the CLI does", () => {
    expect(additionOf({ ...EMPTY_DRAFT, name: " db ", version: "17" })).toEqual({
      ok: true,
      addition: { kind: "preset", name: "db", preset: "postgres", version: "17", scope: "project" },
    });
  });

  it("sends an image with its ports, volumes, a literal and a secret by name", () => {
    const sent = additionOf({
      ...EMPTY_DRAFT,
      kind: "image",
      name: "mail",
      scope: "worktree",
      image: "axllent/mailpit:v1.21",
      ports: "smtp=1025\nhttp=8025\n",
      volumes: "data=/data",
      env: [
        { key: "MP_MAX_MESSAGES", from: "literal", value: "500" },
        { key: "MP_UI_AUTH", from: "secret", value: "MAILPIT_AUTH" },
      ],
    });
    expect(sent).toMatchObject({
      ok: true,
      addition: {
        kind: "definition",
        spec: {
          scope: "worktree",
          ports: [
            { name: "smtp", port: 1025, protocol: "tcp" },
            { name: "http", port: 8025, protocol: "tcp" },
          ],
          volumes: [{ name: "data", mountPath: "/data" }],
          env: { MP_MAX_MESSAGES: "500", MP_UI_AUTH: { secret: "MAILPIT_AUTH" } },
          ready: { kind: "tcp" },
        },
      },
    });
  });

  it("refuses a shape the rules cannot read, keyed by the field it names", () => {
    const refused = additionOf({
      ...EMPTY_DRAFT,
      kind: "image",
      name: "mail",
      image: "not an image",
      ports: "smtp=1025",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusals.map((refusal) => [fieldOf(refusal.key), refusal.message])).toEqual([
      ["image", "is not an image reference, such as postgres:17 or ghcr.io/acme/mail:v1"],
    ]);
  });

  it("refuses two env rows of one name, by that name, before anything is sent", () => {
    const refused = additionOf({
      ...EMPTY_DRAFT,
      kind: "image",
      name: "mail",
      image: "axllent/mailpit:v1.21",
      ports: "smtp=1025",
      env: [
        { key: "AUTH", from: "secret", value: "AUTH_SECRET" },
        { key: " AUTH ", from: "literal", value: "disabled" },
      ],
    });
    expect(refused).toEqual({
      ok: false,
      refusals: [{ key: "env.AUTH", message: "is named by two rows" }],
    });
  });

  it("refuses an env row with a value and no name, and skips one left wholly blank", () => {
    const draft: ResourceDraft = {
      ...EMPTY_DRAFT,
      kind: "image",
      name: "mail",
      image: "axllent/mailpit:v1.21",
      ports: "smtp=1025",
    };
    expect(
      additionOf({ ...draft, env: [{ key: "   ", from: "literal", value: "must-not-disappear" }] }),
    ).toEqual({ ok: false, refusals: [{ key: "env", message: "has a value with no name" }] });
    const blank = additionOf({ ...draft, env: [{ key: " ", from: "literal", value: " " }] });
    expect(blank.ok && blank.addition.kind === "definition" && blank.addition.spec.env).toEqual({});
  });

  it("puts each server key under its field, and the rest under the form", () => {
    expect(
      ["ports", "ports.http", "env.MP_UI_AUTH", "volumes.data", "exports.URL", "version"].map(
        fieldOf,
      ),
    ).toEqual(["ports", "ports", "env", "volumes", null, "version"]);
  });
});

describe("choosing how a worktree uses a resource", () => {
  it("names the stored choice, else the default at the worktree's first launch", () => {
    expect(choiceInUse(setting({ choice: "shared" }))).toEqual({ choice: "shared", stored: true });
    expect(choiceInUse(setting())).toEqual({ choice: "own", stored: false });
    expect(choiceInUse(setting({ spec: mail }))).toBeNull();
  });

  it("says what each mode reaches, and warns of shared tables only for a database", () => {
    expect(choiceWords(db, "shared").meaning).toContain("change or drop its tables");
    expect(choiceWords(db, "own").meaning).toBe(
      "Gets a database of its own on the project instance.",
    );
    expect(choiceWords(mail, "own").meaning).toBe(
      "Gets an instance of its own, of the same definition.",
    );
    expect(choiceWords(db, "off").meaning).toBe(
      "Gets nothing from this resource; the worktree runs its own.",
    );
  });
});
