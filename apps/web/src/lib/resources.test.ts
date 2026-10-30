import { ResourceDefinitionId, ResourceProposalId, WorktreeId } from "@mend/domain";
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
  approvalRequest,
  awaitsApproval,
  choiceInUse,
  choiceWords,
  EMPTY_DRAFT,
  fieldOf,
  proposalOf,
  type ResourceSettingView,
  type ResourcesPageView,
} from "./resources.ts";

const digest = ResourceSpecDigest.make("a".repeat(64));
const worktree = WorktreeId.make("wt_1");
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
  approval: null,
  choice: null,
  canRemove: true,
  canApprove: true,
  canChoose: false,
  statusLine: "@db · postgres 17 · project · waiting for approval",
  ...overrides,
});

const page = (settings: ReadonlyArray<ResourceSettingView>): ResourcesPageView => ({
  settings,
  proposals: [],
  file: { kind: "not-selected" },
  canPropose: true,
});

describe("proposing a resource from the form", () => {
  it("sends a preset at its version, as the CLI does", () => {
    expect(proposalOf({ ...EMPTY_DRAFT, name: " db ", version: "17" })).toEqual({
      ok: true,
      proposal: { kind: "preset", name: "db", preset: "postgres", version: "17", scope: "project" },
    });
  });

  it("sends an image with its ports, volumes, a literal and a secret by name", () => {
    const sent = proposalOf({
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
      proposal: {
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
    const refused = proposalOf({
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

describe("approving", () => {
  it("offers approval only where the flag allows it and the target still waits", () => {
    expect(awaitsApproval(setting(), null)).toBe(true);
    expect(awaitsApproval(setting({ canApprove: false }), null)).toBe(false);
    expect(awaitsApproval(setting({ approval: { by: "alice", for: "project" } }), null)).toBe(
      false,
    );
    // A worktree resource approved for the project still waits for the worktree's own.
    const box = setting({ spec: mail, approval: { by: "alice", for: "project" } });
    expect(awaitsApproval(box, worktree)).toBe(true);
    expect(awaitsApproval({ ...box, approval: { by: "carol", for: "worktree" } }, worktree)).toBe(
      false,
    );
  });

  it("approves what was read, by its digest, for the target its scope names", () => {
    const held = setting();
    expect(approvalRequest(page([held]), { kind: "settings", entry: held }, worktree)).toEqual({
      source: { kind: "settings", id: held.id, digest },
      worktreeId: null,
    });
    const proposal = {
      id: ResourceProposalId.make("rprop_1"),
      digest: ResourceSpecDigest.make("b".repeat(64)),
      spec: db,
      proposedBy: "carol",
      canRemove: true,
      canApprove: true,
      statusLine: "@db · postgres 17 · project · proposed by Carol · waiting for approval",
    };
    expect(approvalRequest(page([held]), { kind: "proposal", entry: proposal }, null)).toEqual({
      source: {
        kind: "proposal",
        id: proposal.id,
        digest: proposal.digest,
        settings: { id: held.id, digest },
      },
      worktreeId: null,
    });
    const table = { digest, spec: mail, canApprove: true, statusLine: "@mail" };
    expect(
      approvalRequest(page([]), { kind: "file", entry: table, worktreeId: worktree }, worktree),
    ).toEqual({
      source: { kind: "file", worktreeId: worktree, name: "mail", digest, settings: null },
      worktreeId: worktree,
    });
  });
});
