import { assert, describe, it } from "@effect/vitest";
import { WS_METHODS } from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { entriesOf, listEntries, matchRangesOf, matchScore, searchEntries } from "../src/files.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * `@`-mentions and the file tree (ADR 0012, phase 2): `projects.searchEntries` and
 * `projects.listEntries` over Mend's `GET /api/projects/:id/files`, read as the person.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const FILES = ["README.md", "src/parser.ts", "src/lexer.ts", "src/deep/parse-tree.ts", "logo.png"];
const STORE = "/var/lib/mend/store/project-1/repo.git";
const WORKTREE = "/var/lib/mend/store/project-1/worktrees/wt-session-1";

const fileReads = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.method === "GET" && call.path.endsWith("/files"));

describe("project files for the composer", () => {
  it.live("searches the thread's worktree, reading Mend once while the listing is fresh", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.files.set("session-1", FILES);
        mend.workbench.files.set("project-1", ["README.md"]);
        const { rpc } = yield* pairAndConnect(mend, "FILES");

        const found = yield* rpc[WS_METHODS.projectsSearchEntries]({
          cwd: WORKTREE,
          query: "pars",
          limit: 80,
        });
        assert.deepStrictEqual(
          found.entries.map((entry) => entry.path),
          ["src/parser.ts", "src/deep/parse-tree.ts"],
        );
        yield* rpc[WS_METHODS.projectsSearchEntries]({ cwd: WORKTREE, query: "parse", limit: 80 });
        assert.strictEqual(fileReads(mend).length, 1);
        assert.strictEqual(fileReads(mend)[0]?.query, "?session=session-1");

        // The file tree: the root's children, then a directory's.
        const root = yield* rpc[WS_METHODS.projectsListEntries]({
          cwd: WORKTREE,
          directoryPath: "",
        });
        assert.deepStrictEqual(
          root.entries.map((entry) => `${entry.kind}:${entry.path}`),
          ["file:logo.png", "file:README.md", "directory:src"],
        );
        const src = yield* rpc[WS_METHODS.projectsListEntries]({
          cwd: WORKTREE,
          directoryPath: "src",
        });
        assert.deepStrictEqual(
          src.entries.map((entry) => entry.path),
          ["src/deep", "src/lexer.ts", "src/parser.ts"],
        );

        // The project's own root reads its default branch.
        const branch = yield* rpc[WS_METHODS.projectsSearchEntries]({
          cwd: STORE,
          query: "",
          limit: 10,
        });
        assert.deepStrictEqual(
          branch.entries.map((entry) => entry.path),
          ["README.md"],
        );
        assert.strictEqual(fileReads(mend)[1]?.query, "");

        // Anywhere else is not the person's.
        const elsewhere = yield* Effect.exit(
          rpc[WS_METHODS.projectsSearchEntries]({ cwd: "/etc", query: "passwd", limit: 10 }),
        );
        assert.isTrue(Exit.isFailure(elsewhere));
        if (Exit.isFailure(elsewhere)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(elsewhere.cause));
          assert.strictEqual(error?._tag, "ProjectSearchEntriesError");
        }
      }),
    ),
  );
});

describe("a listing Mend cut", () => {
  it.live("never makes a search look complete: what lies past the cut is said to be missing", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.fileListingLimit = 3;
        mend.workbench.files.set("session-1", ["a1.ts", "a2.ts", "a3.ts", "z/hidden.ts"]);
        const { rpc } = yield* pairAndConnect(mend, "CUT");
        const hidden = yield* rpc[WS_METHODS.projectsSearchEntries]({
          cwd: WORKTREE,
          query: "hidden",
          limit: 80,
        });
        assert.deepStrictEqual(hidden, { entries: [], truncated: true });
        const found = yield* rpc[WS_METHODS.projectsSearchEntries]({
          cwd: WORKTREE,
          query: "a1",
          limit: 80,
        });
        assert.deepStrictEqual(
          found.entries.map((entry) => entry.path),
          ["a1.ts"],
        );
        assert.isTrue(found.truncated);
        const tail = yield* rpc[WS_METHODS.projectsListEntries]({
          cwd: WORKTREE,
          directoryPath: "z",
        });
        assert.deepStrictEqual(tail, { entries: [], truncated: true });
      }),
    ),
  );
});

/** What a project file error says went wrong. */
const failureOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "failure" in error
    ? error.failure
    : undefined;
};

describe("reading and searching a worktree's files", () => {
  it.live("reads a file as the worktree stands, and searches its lines", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        const session = mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.fileContents.set(
          session.worktreeId,
          new Map([
            ["src/parser.ts", "export const parse = (input) => input;\nconst Parse = 1;\n"],
            ["README.md", "How to parse things\n"],
          ]),
        );
        const { rpc } = yield* pairAndConnect(mend, "CONTENTS");

        const file = yield* rpc[WS_METHODS.projectsReadFile]({
          cwd: WORKTREE,
          relativePath: "src/parser.ts",
        });
        assert.strictEqual(
          file.contents,
          "export const parse = (input) => input;\nconst Parse = 1;\n",
        );
        assert.isFalse(file.truncated);
        assert.strictEqual(
          failureOf(
            yield* Effect.exit(
              rpc[WS_METHODS.projectsReadFile]({ cwd: WORKTREE, relativePath: "src/missing.ts" }),
            ),
          ),
          "path_not_file",
        );
        assert.strictEqual(
          failureOf(
            yield* Effect.exit(
              rpc[WS_METHODS.projectsReadFile]({ cwd: WORKTREE, relativePath: "../secret" }),
            ),
          ),
          "workspace_path_outside_root",
        );
        // The project's root has no files of its own to read.
        assert.strictEqual(
          failureOf(
            yield* Effect.exit(
              rpc[WS_METHODS.projectsReadFile]({ cwd: STORE, relativePath: "README.md" }),
            ),
          ),
          "workspace_path_outside_root",
        );

        const found = yield* rpc[WS_METHODS.projectsSearchContents]({
          cwd: WORKTREE,
          query: "parse",
          limit: 20,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false,
        });
        const parser = found.matches.filter((match) => match.path === "src/parser.ts");
        assert.deepStrictEqual(
          parser.map((match) => [match.lineNumber, match.matchRanges]),
          [
            [1, [{ start: 13, end: 18 }]],
            [2, [{ start: 6, end: 11 }]],
          ],
        );
        assert.isUndefined(found.regexFallbackError);

        // A regex git cannot read is searched as text, and the client is told so.
        const fellBack = yield* rpc[WS_METHODS.projectsSearchContents]({
          cwd: WORKTREE,
          query: "(input",
          limit: 20,
          caseSensitive: true,
          wholeWord: false,
          useRegex: true,
        });
        assert.isDefined(fellBack.regexFallbackError);
        assert.deepStrictEqual(
          fellBack.matches.map((match) => match.lineNumber),
          [1],
        );
      }),
    ),
  );
});

describe("matching", () => {
  it("ranks the name's start, then the name, then the path, then the letters in order", () => {
    assert.strictEqual(matchScore("src/parser.ts", "pars"), 0);
    assert.strictEqual(matchScore("src/the-parser.ts", "pars"), 1);
    assert.strictEqual(matchScore("parsers/index.ts", "pars"), 2);
    assert.strictEqual(matchScore("src/p-a-r-s.ts", "pars"), 3);
    assert.isNull(matchScore("README.md", "pars"));
  });

  it("highlights what a search matched, as asked", () => {
    const query = { query: "pa.se", caseSensitive: false, wholeWord: false, useRegex: false };
    assert.deepStrictEqual(matchRangesOf("pa.se parse", query), [{ start: 0, end: 5 }]);
    assert.deepStrictEqual(matchRangesOf("pa.se parse", { ...query, useRegex: true }), [
      { start: 0, end: 5 },
      { start: 6, end: 11 },
    ]);
    assert.deepStrictEqual(
      matchRangesOf("parser parse", { ...query, query: "parse", wholeWord: true }),
      [{ start: 7, end: 12 }],
    );
    assert.deepStrictEqual(matchRangesOf("x", { ...query, query: "(", useRegex: true }), []);
  });

  it("filters by kind and images, and says when it cut the list", () => {
    const entries = entriesOf(FILES);
    const images = searchEntries(entries, { query: "", limit: 10, imageOnly: true });
    assert.deepStrictEqual(
      images.entries.map((entry) => entry.path),
      ["logo.png"],
    );
    const directories = searchEntries(entries, { query: "", limit: 1, kind: "directory" });
    assert.deepStrictEqual(
      directories.entries.map((entry) => entry.path),
      ["src"],
    );
    assert.isTrue(directories.truncated);
    assert.strictEqual(listEntries(entries, undefined).length, entries.length);
  });
});
