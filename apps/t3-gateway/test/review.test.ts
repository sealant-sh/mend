import { assert, describe, it } from "@effect/vitest";
import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { splitPatch, unquoteGitPath } from "../src/review.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Phase 1's changes panel (ADR 0012, "Concepts"): the thread's change, from Mend's
 * `GET /api/changes/:id/diff`, for the worktree t3code names as its `cwd`.
 */

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# New",
  "+Written by the agent.",
  "",
].join("\n");

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const failureTag = <E extends { readonly _tag: string }>(exit: Exit.Exit<unknown, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag : undefined;

describe("review", () => {
  it.live("previews the thread's change and rebuilds the files the patch holds whole", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          changeId: "change-1",
        });
        mend.workbench.diffs.set("change-1", {
          diff: DIFF,
          files: [
            { path: "src/app.ts", additions: 1, deletions: 1 },
            { path: "docs/new.md", additions: 2, deletions: 0 },
          ],
        });
        const { rpc } = yield* pairAndConnect(mend, "REVIEW");

        // The thread's worktree is the cwd t3code asks about.
        const shell = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("5 seconds"),
        );
        const cwd = shell.kind === "snapshot" ? shell.snapshot.threads[0]?.worktreePath : null;
        assert.strictEqual(cwd, "/var/lib/mend/store/project-1/worktrees/wt-session-1");
        if (cwd === null || cwd === undefined) return;

        const preview = yield* rpc[WS_METHODS.reviewGetDiffPreview]({ cwd });
        assert.strictEqual(preview.cwd, cwd);
        assert.strictEqual(preview.sources.length, 1);
        const [source] = preview.sources;
        assert.strictEqual(source?.kind, "branch-range");
        assert.strictEqual(source?.title, "Changes · observed at capture 3 · seq 7");
        assert.strictEqual(source?.diff, DIFF);
        assert.strictEqual(source?.baseRef, "main");
        assert.isFalse(source?.truncated);
        assert.deepStrictEqual(
          source?.files?.map((file) => [file.path, file.additions, file.deletions]),
          [
            ["src/app.ts", 1, 1],
            ["docs/new.md", 2, 0],
          ],
        );
        // Read as the person who paired.
        const read = mend.workbench.calls.find(
          (call) => call.path === "/api/changes/change-1/diff",
        );
        assert.strictEqual(read?.authorization, `Bearer ${mend.claims[0]?.token}`);

        // One file's patch, as the panel asks for it.
        const one = yield* rpc[WS_METHODS.reviewGetDiffPreview]({
          cwd,
          file: { path: "docs/new.md", previousPath: null, sourceKind: "branch-range" },
        });
        assert.isTrue(one.sources[0]?.diff.startsWith("diff --git a/docs/new.md"));
        assert.notInclude(one.sources[0]?.diff ?? "", "src/app.ts");

        const added = yield* rpc[WS_METHODS.reviewGetDiffFileContents]({
          cwd,
          sourceKind: "branch-range",
          changeType: "new",
          baseRef: source?.baseRef ?? null,
          headRef: source?.headRef ?? null,
          oldPath: "docs/new.md",
          newPath: "docs/new.md",
        });
        assert.deepStrictEqual(added, {
          oldContents: "",
          newContents: "# New\nWritten by the agent.\n",
        });

        // A changed file's whole contents are not in a patch: a typed refusal, never a defect.
        const changed = yield* Effect.exit(
          rpc[WS_METHODS.reviewGetDiffFileContents]({
            cwd,
            sourceKind: "branch-range",
            changeType: "change",
            baseRef: null,
            headRef: null,
            oldPath: "src/app.ts",
            newPath: "src/app.ts",
          }),
        );
        assert.strictEqual(failureTag(changed), "VcsUnsupportedOperationError");

        // A directory no thread of theirs works in.
        const elsewhere = yield* Effect.exit(
          rpc[WS_METHODS.reviewGetDiffPreview]({ cwd: "/home/someone/else" }),
        );
        assert.strictEqual(failureTag(elsewhere), "VcsUnsupportedOperationError");
      }),
    ),
  );
});

describe("git-quoted paths", () => {
  const QUOTED = [
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    "new file mode 100644",
    "index 0000000..4444444",
    "--- /dev/null",
    '+++ "b/caf\\303\\251.txt"',
    "@@ -0,0 +1 @@",
    "+bonjour",
    "",
  ].join("\n");

  it("unquotes C escapes and decodes octal bytes as UTF-8", () => {
    assert.strictEqual(unquoteGitPath('"b/caf\\303\\251.txt"'), "b/café.txt");
    assert.strictEqual(unquoteGitPath('"tab\\there \\"q\\""'), 'tab\there "q"');
    assert.strictEqual(unquoteGitPath("plain.txt"), "plain.txt");
    assert.deepStrictEqual(
      splitPatch(QUOTED).map((file) => [file.oldPath, file.newPath]),
      [[null, "café.txt"]],
    );
  });

  it.live("previews and rebuilds a non-ASCII file by its real name", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({
          id: "session-1",
          projectId: "project-1",
          changeId: "change-1",
        });
        mend.workbench.diffs.set("change-1", {
          diff: QUOTED,
          files: [{ path: "café.txt", additions: 1, deletions: 0 }],
        });
        const { rpc } = yield* pairAndConnect(mend, "QUOTED");
        const cwd = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
        const one = yield* rpc[WS_METHODS.reviewGetDiffPreview]({
          cwd,
          file: { path: "café.txt", previousPath: null, sourceKind: "branch-range" },
        });
        assert.strictEqual(one.sources[0]?.diff, QUOTED);
        const contents = yield* rpc[WS_METHODS.reviewGetDiffFileContents]({
          cwd,
          sourceKind: "branch-range",
          changeType: "new",
          baseRef: null,
          headRef: null,
          oldPath: "café.txt",
          newPath: "café.txt",
        });
        assert.deepStrictEqual(contents, { oldContents: "", newContents: "bonjour\n" });
      }),
    ),
  );
});

describe("splitPatch", () => {
  it("splits a git diff by file, reading added and deleted paths", () => {
    const files = splitPatch(DIFF);
    assert.deepStrictEqual(
      files.map((file) => [file.oldPath, file.newPath]),
      [
        ["src/app.ts", "src/app.ts"],
        [null, "docs/new.md"],
      ],
    );
  });
});
