import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ProjectId, WorktreeId } from "@mend/domain";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_MEND_TOML,
  MEND_TOML,
  parseWorkspaceMendToml,
  readMendToml,
  selectMendToml,
  WORKSPACE_MEND_TOML_SCRIPT,
} from "../src/recipes.ts";
import { readWorktreeTables } from "../src/resources/worktree-tables.ts";
import {
  WORKTREE_STAMP,
  WorktreeNotCapturedError,
  type WorktreeReads,
} from "../src/worktree-reads.ts";

const roots: string[] = [];
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-toml-location-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const write = (root: string, name: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
};
const preferred =
  '[service.web]\nport = 3000\n[preview]\nservice = "web"\n[setup]\nrun = ["pnpm install"]\n[resource.db]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025 }\n';
const legacy = "[service.legacy]\nport = 4000\n";

const cases = [
  { label: "only .mend", nested: preferred, root: null, chosen: MEND_TOML },
  { label: "only root", nested: null, root: legacy, chosen: LEGACY_MEND_TOML },
  {
    label: "both, with invalid root ignored",
    nested: preferred,
    root: "not valid = [",
    chosen: MEND_TOML,
  },
  { label: "neither", nested: null, root: null, chosen: null },
];

describe("repository configuration location", () => {
  it.each(cases)("selects $label without merging", ({ nested, root, chosen }) => {
    const selected = selectMendToml(nested, root);
    expect(selected?.path ?? null).toBe(chosen);
    expect(selected?.value ?? null).toBe(nested ?? root);
  });

  it.each(cases)("reads $label from a worktree", async ({ nested, root, chosen }) => {
    const directory = fresh();
    if (nested !== null) write(directory, MEND_TOML, nested);
    if (root !== null) write(directory, LEGACY_MEND_TOML, root);
    const file = await Effect.runPromise(readMendToml(directory));
    expect(file.path ?? null).toBe(chosen === null ? null : path.join(directory, chosen));
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(
      chosen === null ? [] : chosen === MEND_TOML ? ["web"] : ["legacy"],
    );
    if (chosen === MEND_TOML) {
      expect(file.preview).toBe("web");
      expect(file.setup?.run).toEqual(["pnpm install"]);
      expect(file.resources.map((resource) => resource.name)).toEqual(["db"]);
    }
  });

  it.each([MEND_TOML, LEGACY_MEND_TOML])("names %s in parse errors", async (name) => {
    const directory = fresh();
    write(directory, name, "not valid = [");
    if (name === MEND_TOML) write(directory, LEGACY_MEND_TOML, legacy);
    const error = await Effect.runPromise(readMendToml(directory).pipe(Effect.flip));
    expect(error.path).toBe(path.join(directory, name));
    expect(error.message).toContain(`${name} is not valid TOML`);
  });

  it("an empty preferred file hides every root declaration", async () => {
    const directory = fresh();
    write(directory, MEND_TOML, "");
    write(directory, LEGACY_MEND_TOML, preferred);
    expect(selectMendToml("", preferred)).toEqual({ path: MEND_TOML, value: "" });
    const file = await Effect.runPromise(readMendToml(directory));
    expect(file).toMatchObject({
      path: path.join(directory, MEND_TOML),
      recipes: [],
      resources: [],
      setup: null,
      preview: null,
    });
  });

  it("does not fall back when the preferred path cannot be read", async () => {
    const directory = fresh();
    fs.mkdirSync(path.join(directory, MEND_TOML), { recursive: true });
    write(directory, LEGACY_MEND_TOML, legacy);
    const error = await Effect.runPromise(readMendToml(directory).pipe(Effect.flip));
    expect(error.path).toBe(path.join(directory, MEND_TOML));
  });

  it.each(cases)("reads $label inside the workspace shell", async ({ nested, root, chosen }) => {
    const directory = fresh();
    if (nested !== null) write(directory, MEND_TOML, nested);
    if (root !== null) write(directory, LEGACY_MEND_TOML, root);
    const result = spawnSync("sh", ["-c", WORKSPACE_MEND_TOML_SCRIPT, "sh", directory], {
      encoding: "utf8",
    });
    const file = await Effect.runPromise(
      parseWorkspaceMendToml({ ...result, exitCode: result.status ?? 1 }, directory),
    );
    expect(file.path ?? null).toBe(chosen === null ? null : path.join(directory, chosen));
    expect(file.recipes.map((recipe) => recipe.name)).toEqual(
      chosen === null ? [] : chosen === MEND_TOML ? ["web"] : ["legacy"],
    );
  });

  it("reports a preferred workspace read failure without reading the root file", async () => {
    const directory = fresh();
    fs.mkdirSync(path.join(directory, MEND_TOML), { recursive: true });
    write(directory, LEGACY_MEND_TOML, legacy);
    const result = spawnSync("sh", ["-c", WORKSPACE_MEND_TOML_SCRIPT, "sh", directory], {
      encoding: "utf8",
    });
    const error = await Effect.runPromise(
      parseWorkspaceMendToml({ ...result, exitCode: result.status ?? 1 }, directory).pipe(
        Effect.flip,
      ),
    );
    expect(error.path).toBe(path.join(directory, MEND_TOML));
    expect(error.message).toContain(`${MEND_TOML} could not be read`);
  });
});

describe("resource tables through WorktreeReads", () => {
  const project = ProjectId.make("p-location");
  const worktree = WorktreeId.make("wt-location");
  const stamp = {
    ...WORKTREE_STAMP,
    source: "capture",
    captureN: 2,
    seq: "7",
    partial: true,
  } as const;
  const run = (files: Readonly<Record<string, string | null | "unavailable">>) => {
    const calls: string[] = [];
    const reads: Pick<WorktreeReads["Service"], "readFile"> = {
      readFile: (_project, _worktree, name) => {
        calls.push(name);
        const text = files[name] ?? null;
        return text === "unavailable"
          ? Effect.fail(
              new WorktreeNotCapturedError({ worktreeId: worktree, message: "read failed" }),
            )
          : Effect.succeed({
              value:
                text === null
                  ? null
                  : {
                      bytes: new TextEncoder().encode(text),
                      size: text.length,
                      binary: false,
                      truncated: false,
                    },
              stamp,
            });
      },
    };
    return { calls, read: Effect.runSync(readWorktreeTables(reads, project, worktree)) };
  };

  it("falls back only on absent and keeps the capture stamp and selected path", () => {
    const { calls, read } = run({ [LEGACY_MEND_TOML]: preferred });
    expect(calls).toEqual([MEND_TOML, LEGACY_MEND_TOML]);
    expect(read).toMatchObject({
      kind: "read",
      observed: "mend.toml · observed at capture 2 · seq 7 · partial",
    });
    if (read.kind === "read") expect(read.tables.map((table) => table.name)).toEqual(["db"]);
  });

  it("does not read root when the preferred file exists", () => {
    const { calls, read } = run({ [MEND_TOML]: preferred, [LEGACY_MEND_TOML]: "unavailable" });
    expect(calls).toEqual([MEND_TOML]);
    expect(read).toMatchObject({
      kind: "read",
      observed: ".mend/mend.toml · observed at capture 2 · seq 7 · partial",
    });
  });

  it("does not hide an unavailable preferred file behind root tables", () => {
    const { calls, read } = run({ [MEND_TOML]: "unavailable", [LEGACY_MEND_TOML]: preferred });
    expect(calls).toEqual([MEND_TOML]);
    expect(read).toEqual({ kind: "unavailable", message: ".mend/mend.toml could not be read" });
  });

  it("reports an unavailable root fallback by its own name", () => {
    const { calls, read } = run({ [LEGACY_MEND_TOML]: "unavailable" });
    expect(calls).toEqual([MEND_TOML, LEGACY_MEND_TOML]);
    expect(read).toEqual({ kind: "unavailable", message: "mend.toml could not be read" });
  });

  it("does not hide an invalid preferred file behind root tables", () => {
    const { calls, read } = run({ [MEND_TOML]: "bad = [", [LEGACY_MEND_TOML]: preferred });
    expect(calls).toEqual([MEND_TOML]);
    expect(read.kind).toBe("unparsed");
  });

  it("reports absence when neither file exists", () => {
    const { calls, read } = run({});
    expect(calls).toEqual([MEND_TOML, LEGACY_MEND_TOML]);
    expect(read).toMatchObject({
      kind: "absent",
      observed: "mend.toml · observed at capture 2 · seq 7 · partial",
    });
  });
});
