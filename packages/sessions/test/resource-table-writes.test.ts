import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionsRepo, WorktreesRepo } from "@mend/db";
import { ProjectId, SealantWorkspaceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Session, Worktree } from "@mend/domain/workbench";
import { SealantClient, SealantPrincipal } from "@mend/sealant";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect } from "vitest";

import { ResourceTableWrites, ResourceTableWritesLive } from "../src/resources/append-table.ts";
import { ResourceTableReads, ResourceTableReadsLive } from "../src/resources/worktree-tables.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WorktreeReads, WORKTREE_STAMP } from "../src/worktree-reads.ts";
import { execAnswer, fakeWorkspace } from "./fake-workspace.ts";

/**
 * A PATH holding only coreutils, as a workspace image does: it has no `cmp`, which once made every
 * append into an existing file fail on the box.
 */
const WORKSPACE_TOOLS = [
  "base64",
  "cat",
  "head",
  "chmod",
  "chown",
  "cp",
  "dirname",
  "mkdir",
  "mktemp",
  "mv",
  "realpath",
  "rm",
  "tr",
];
const SH = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
let toolsDir: string | null = null;
const workspaceTools = (): string => {
  if (toolsDir !== null) return toolsDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-tools-"));
  for (const tool of WORKSPACE_TOOLS) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    if (found !== "") fs.symlinkSync(found, path.join(dir, tool));
  }
  toolsDir = dir;
  return dir;
};

const PROJECT = ProjectId.make("project-append");
const WORKTREE = WorktreeId.make("worktree-append");
const TABLE = '[resource.mail]\nimage = "axllent/mailpit:v1.21"\n';
const input = { projectId: PROJECT, worktreeId: WORKTREE, name: "mail", table: TABLE };
const date = new Date("2026-11-01T00:00:00Z");
const worktree = new Worktree({
  id: WORKTREE,
  projectId: PROJECT,
  name: "main",
  directory: "immutable-dir",
  branch: "main",
  baseSha: Sha.make("a".repeat(40)),
  baseRef: "main",
  handoff: null,
  createdAt: date,
  updatedAt: date,
});
const session = new Session({
  id: SessionId.make("session-append"),
  projectId: PROJECT,
  worktreeId: WORKTREE,
  harness: "claude",
  providerSessionId: null,
  label: null,
  worktree: "immutable-dir",
  branch: "main",
  baseSha: worktree.baseSha,
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: null,
  sealantWorkspaceId: SealantWorkspaceId.make("workspace-append"),
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: "workspace-owner",
  hasTranscript: null,
  status: "completed",
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: false,
  startedAt: date,
  settledAt: date,
  createdAt: date,
  updatedAt: date,
});
const roots: string[] = [];
const fresh = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-resource-append-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.readdirSync(root, { recursive: true });
    fs.rmSync(root, { recursive: true });
  }
});
const write = (root: string, relative: string, text: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
};
const read = (root: string, relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

const withWrites = <A, E>(
  root: string,
  program: Effect.Effect<A, E, ResourceTableWrites | ResourceTableReads>,
  options: {
    mode: "local" | "workspace" | "offline";
    status?: "ready" | "stopped";
    flushed?: boolean;
    changed?: boolean;
  } = { mode: "local" },
) => {
  let executions = 0;
  const platform = Layer.mock(SealantClient, {
    getWorkspace: () =>
      Effect.gen(function* () {
        expect(yield* SealantPrincipal).toEqual({ kind: "user", userId: "workspace-owner" });
        return {
          ...fakeWorkspace("workspace-append"),
          status: async () => options.status ?? "ready",
        };
      }),
    exec: (_workspace, argv) =>
      Effect.gen(function* () {
        expect(yield* SealantPrincipal).toEqual({ kind: "user", userId: "workspace-owner" });
        executions++;
        if (options.changed && executions === 2)
          write(root, ".mend/mend.toml", "# edit after read\n");
        const args = argv.slice(1).map((arg) => (arg === "/workspace/repo" ? root : arg));
        const result = spawnSync(SH, args, {
          encoding: "utf8",
          env: { PATH: workspaceTools() },
        });
        expect(result.error).toBeUndefined();
        return execAnswer(result.stdout, result.status ?? 1, result.stderr);
      }),
  });
  const capturedReads = Layer.mock(WorktreeReads, {
    readFile: () =>
      Effect.succeed({ value: null, stamp: { ...WORKTREE_STAMP, source: "capture", captureN: 1 } }),
  });
  const testLayer = Layer.merge(ResourceTableWritesLive, ResourceTableReadsLive).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(SessionRepository, {
          worktreeMount: (projectId, directory) => {
            expect(projectId).toBe(PROJECT);
            expect(directory).toBe("immutable-dir");
            return Effect.succeed(options.mode === "local" ? root : undefined);
          },
        }),
        Layer.mock(WorktreesRepo, { byId: () => Effect.succeed(worktree) }),
        Layer.mock(SessionsRepo, {
          listForWorktree: () => Effect.succeed(options.mode === "offline" ? [] : [session]),
          finalFlushedWorkspace: () =>
            Effect.succeed(options.flushed ? session.sealantWorkspaceId : null),
        }),
        platform,
        capturedReads,
      ),
    ),
  );
  return program.pipe(Effect.provide(testLayer));
};
const append = Effect.flatMap(ResourceTableWrites, (writes) => writes.appendResourceTable(input));
const cases = [
  { label: "neither file", preferred: null, legacy: null, chosen: ".mend/mend.toml" },
  { label: "preferred only", preferred: "# nested\n", legacy: null, chosen: ".mend/mend.toml" },
  {
    label: "legacy only",
    preferred: null,
    legacy: "[service.web]\nport = 3000\n",
    chosen: "mend.toml",
  },
  { label: "both", preferred: "# nested\n", legacy: "not TOML = [", chosen: ".mend/mend.toml" },
];

for (const mode of ["local", "workspace"] as const) {
  describe(`${mode} resource table writes`, () => {
    for (const test of cases) {
      it.effect(`uses precedence for ${test.label}`, () =>
        Effect.gen(function* () {
          const root = fresh();
          if (test.preferred !== null) write(root, ".mend/mend.toml", test.preferred);
          if (test.legacy !== null) write(root, "mend.toml", test.legacy);
          expect(yield* withWrites(root, append, { mode })).toEqual({
            kind: "written",
            path: test.chosen,
          });
          const original = test.preferred ?? test.legacy ?? "";
          expect(read(root, test.chosen)).toBe(`${original}${original === "" ? "" : "\n"}${TABLE}`);
          if (test.chosen === "mend.toml")
            expect(fs.existsSync(path.join(root, ".mend"))).toBe(false);
          if (test.preferred !== null && test.legacy !== null)
            expect(read(root, "mend.toml")).toBe(test.legacy);
        }),
      );
    }
    it.effect("refuses an existing declaration, even if its fields are invalid", () =>
      Effect.gen(function* () {
        const root = fresh();
        const original = "# keep this\n[resource.mail]\nstrange = true\n";
        write(root, "mend.toml", original);
        expect(yield* withWrites(root, append, { mode })).toEqual({
          kind: "declared",
          path: "mend.toml",
        });
        expect(read(root, "mend.toml")).toBe(original);
      }),
    );
    it.effect("refuses invalid preferred TOML without falling back or exposing values", () =>
      Effect.gen(function* () {
        const root = fresh();
        const original = 'env = { VALUE = "private-value" BAD }';
        write(root, ".mend/mend.toml", original);
        write(root, "mend.toml", "# fallback\n");
        const result = yield* withWrites(root, append, { mode });
        expect(result).toMatchObject({ kind: "unparsed", path: ".mend/mend.toml" });
        expect(JSON.stringify(result)).not.toContain("private-value");
        expect(read(root, ".mend/mend.toml")).toBe(original);
        expect(read(root, "mend.toml")).toBe("# fallback\n");
      }),
    );
    for (const ending of ["", "\n", "\n\n", "\n\n\n", "\r\n", "\r\n\r\n"]) {
      it.effect(`preserves every byte with ending ${JSON.stringify(ending)}`, () =>
        Effect.gen(function* () {
          const root = fresh();
          const original = `# café comment\r\n[service.web]  # odd spacing\r\nport    =    3000${ending}`;
          write(root, "mend.toml", original);
          expect(yield* withWrites(root, append, { mode })).toEqual({
            kind: "written",
            path: "mend.toml",
          });
          const bytes = fs.readFileSync(path.join(root, "mend.toml"));
          expect(bytes.subarray(0, Buffer.byteLength(original))).toEqual(Buffer.from(original));
          const separator =
            ending.endsWith("\n\n") || ending.endsWith("\r\n\r\n")
              ? ""
              : ending.endsWith("\n")
                ? "\n"
                : "\n\n";
          expect(bytes.toString()).toBe(`${original}${separator}${TABLE}`);
          expect(fs.readdirSync(root)).toEqual(["mend.toml"]);
        }),
      );
    }
    it.effect("refuses symlinks that escape the worktree", () =>
      Effect.gen(function* () {
        const root = fresh();
        const outside = fresh();
        write(outside, "mend.toml", "# untouched\n");
        fs.symlinkSync(outside, path.join(root, ".mend"));
        expect(yield* withWrites(root, append, { mode })).toMatchObject({
          kind: "unreachable",
          table: TABLE,
        });
        expect(read(outside, "mend.toml")).toBe("# untouched\n");
      }),
    );
    it.effect("refuses an escaping file symlink", () =>
      Effect.gen(function* () {
        const root = fresh();
        const outside = fresh();
        write(outside, "config.toml", "# untouched\n");
        fs.symlinkSync(path.join(outside, "config.toml"), path.join(root, "mend.toml"));
        expect(yield* withWrites(root, append, { mode })).toMatchObject({
          kind: "unreachable",
          table: TABLE,
        });
        expect(read(outside, "config.toml")).toBe("# untouched\n");
      }),
    );
    it.effect("supports an internal file symlink without replacing the link", () =>
      Effect.gen(function* () {
        const root = fresh();
        write(root, "config.toml", "# keep link\n");
        fs.symlinkSync("config.toml", path.join(root, "mend.toml"));
        expect(yield* withWrites(root, append, { mode })).toEqual({
          kind: "written",
          path: "mend.toml",
        });
        expect(read(root, "config.toml")).toBe(`# keep link\n\n${TABLE}`);
        expect(fs.readlinkSync(path.join(root, "mend.toml"))).toBe("config.toml");
      }),
    );
    it.effect("falls back to root when .mend is an ordinary file", () =>
      Effect.gen(function* () {
        const root = fresh();
        write(root, ".mend", "unrelated file");
        write(root, "mend.toml", "# recipes\n");
        expect(yield* withWrites(root, append, { mode })).toEqual({
          kind: "written",
          path: "mend.toml",
        });
        expect(read(root, ".mend")).toBe("unrelated file");
      }),
    );
    it.effect("refuses a scalar resource key that cannot contain a table", () =>
      Effect.gen(function* () {
        const root = fresh();
        const original = 'resource = "not a table"\n';
        write(root, "mend.toml", original);
        expect(yield* withWrites(root, append, { mode })).toMatchObject({
          kind: "unparsed",
          path: "mend.toml",
        });
        expect(read(root, "mend.toml")).toBe(original);
      }),
    );
    it.effect("adds the table's missing final newline", () =>
      Effect.gen(function* () {
        const root = fresh();
        const request = Effect.flatMap(ResourceTableWrites, (writes) =>
          writes.appendResourceTable({ ...input, table: TABLE.trimEnd() }),
        );
        expect(yield* withWrites(root, request, { mode })).toEqual({
          kind: "written",
          path: ".mend/mend.toml",
        });
        expect(read(root, ".mend/mend.toml")).toBe(TABLE);
      }),
    );
    it.effect("does not stage or commit", () =>
      Effect.gen(function* () {
        const root = fresh();
        spawnSync("git", ["init", "--quiet", root]);
        const before = fs.readFileSync(path.join(root, ".git/HEAD"));
        yield* withWrites(root, append, { mode });
        expect(fs.readFileSync(path.join(root, ".git/HEAD"))).toEqual(before);
        expect(fs.existsSync(path.join(root, ".git/index"))).toBe(false);
      }),
    );
  });
}

it.effect("offers the table to copy when no files or live workspace are reachable", () =>
  Effect.gen(function* () {
    expect(yield* withWrites(fresh(), append, { mode: "offline" })).toEqual({
      kind: "unreachable",
      reason: "The worktree has no co-located files or live workspace",
      table: TABLE,
    });
  }),
);
for (const options of [{ status: "stopped" as const }, { flushed: true }]) {
  it.effect(`does not write through a workspace that ended ${JSON.stringify(options)}`, () =>
    Effect.gen(function* () {
      const root = fresh();
      expect(yield* withWrites(root, append, { mode: "workspace", ...options })).toMatchObject({
        kind: "unreachable",
        table: TABLE,
      });
      expect(fs.readdirSync(root)).toEqual([]);
    }),
  );
}
it.effect("the workspace script makes a new file readable by everyone in the worktree", () =>
  Effect.gen(function* () {
    const root = fresh();
    yield* withWrites(root, append, { mode: "workspace" });
    expect(fs.statSync(path.join(root, ".mend/mend.toml")).mode & 0o777).toBe(0o644);
  }),
);
it.effect("the workspace script refuses a changed file between read and replace", () =>
  Effect.gen(function* () {
    const root = fresh();
    write(root, ".mend/mend.toml", "# before\n");
    expect(yield* withWrites(root, append, { mode: "workspace", changed: true })).toMatchObject({
      kind: "unreachable",
      table: TABLE,
    });
    expect(read(root, ".mend/mend.toml")).toBe("# edit after read\n");
    expect(fs.readdirSync(path.join(root, ".mend"))).toEqual(["mend.toml"]);
  }),
);

it.effect("reads an immediately added definition before the next workspace capture", () =>
  Effect.gen(function* () {
    const root = fresh();
    write(root, ".mend/mend.toml", '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n');
    const current = yield* withWrites(
      root,
      Effect.gen(function* () {
        const reads = yield* ResourceTableReads;
        return yield* reads.forWorktree(PROJECT, WORKTREE);
      }),
      { mode: "workspace" },
    );
    expect(current).toMatchObject({ kind: "read", tables: [{ name: "db", image: "postgres:17" }] });
  }),
);

const currentTables = Effect.flatMap(ResourceTableReads, (reads) =>
  reads.forWorktree(PROJECT, WORKTREE),
);
for (const entry of cases) {
  it.effect(`current workspace declarations keep file precedence: ${entry.label}`, () =>
    Effect.gen(function* () {
      const root = fresh();
      if (entry.preferred !== null) write(root, ".mend/mend.toml", entry.preferred);
      if (entry.legacy !== null) write(root, "mend.toml", entry.legacy);
      const result = yield* withWrites(root, currentTables, { mode: "workspace" });
      expect(result.kind).toBe(
        entry.preferred === null && entry.legacy === null ? "absent" : "read",
      );
      if (result.kind !== "unavailable")
        expect(result.observed).toBe(
          `${result.kind === "absent" ? "mend.toml" : entry.chosen} · observed on the worktree`,
        );
    }),
  );
}
it.effect("Add reads the workspace before writing and its result is readable before capture", () =>
  Effect.gen(function* () {
    const root = fresh();
    write(root, ".mend/mend.toml", "# freshly edited\n[service.web]\nport = 3000\n");
    const result = yield* withWrites(
      root,
      Effect.gen(function* () {
        yield* Effect.flatMap(ResourceTableWrites, (writes) =>
          writes.appendResourceTable({ ...input, table: `${TABLE}ports = { smtp = 1025 }\n` }),
        );
        return yield* currentTables;
      }),
      { mode: "workspace" },
    );
    expect(result).toMatchObject({ kind: "read", tables: [{ name: "mail" }] });
    expect(read(root, ".mend/mend.toml")).toContain("[service.web]\nport = 3000");
    expect(yield* withWrites(root, append, { mode: "workspace" })).toMatchObject({
      kind: "declared",
    });
  }),
);
it.effect("reads a subsequent image edit before capture", () =>
  Effect.gen(function* () {
    const root = fresh();
    write(root, ".mend/mend.toml", '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n');
    yield* withWrites(root, currentTables, { mode: "workspace" });
    write(root, ".mend/mend.toml", '[resource.db]\npreset = "postgres"\nimage = "postgres:16"\n');
    expect(yield* withWrites(root, currentTables, { mode: "workspace" })).toMatchObject({
      kind: "read",
      tables: [{ image: "postgres:16" }],
    });
  }),
);
for (const example of [
  { text: "#".repeat(256 * 1024 + 1), message: "over 256 KiB" },
  { text: "\0", message: "not text" },
  { text: "[resource.", message: ".mend/mend.toml" },
]) {
  it.effect(`refuses current workspace input that is ${example.message}`, () =>
    Effect.gen(function* () {
      const root = fresh();
      write(root, ".mend/mend.toml", example.text);
      expect(yield* withWrites(root, currentTables, { mode: "workspace" })).toMatchObject({
        kind: "unparsed",
        message: expect.stringContaining(example.message),
      });
    }),
  );
}
it.effect(
  "a live file outside the worktree is unavailable, never replaced by a stale capture",
  () =>
    Effect.gen(function* () {
      const root = fresh();
      const outside = fresh();
      write(outside, "mend.toml", TABLE);
      fs.mkdirSync(path.join(root, ".mend"));
      fs.symlinkSync(path.join(outside, "mend.toml"), path.join(root, ".mend/mend.toml"));
      expect(yield* withWrites(root, currentTables, { mode: "workspace" })).toMatchObject({
        kind: "unavailable",
      });
    }),
);
for (const options of [
  { mode: "offline" as const },
  { mode: "workspace" as const, status: "stopped" as const },
  { mode: "workspace" as const, flushed: true },
]) {
  it.effect(`uses the capture after the workspace ended: ${JSON.stringify(options)}`, () =>
    Effect.gen(function* () {
      const root = fresh();
      write(root, ".mend/mend.toml", TABLE);
      const observation = yield* withWrites(root, currentTables, options);
      expect(observation).toMatchObject({
        kind: "absent",
        observed: expect.stringContaining("observed at capture 1"),
      });
    }),
  );
}
