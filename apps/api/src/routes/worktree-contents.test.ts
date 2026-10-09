import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointId, SequenceNumber, Sha, WorktreeId } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * `GET /api/worktrees/:id/contents` (ADR 0012, phase 3): one file of a worktree, as it stands or at
 * a checkpoint, or the lines matching a search, over the colocated `WorktreeReads` on a real
 * repository, behind the worktree's visibility. The last tests print their latency: median and
 * 90th percentile of 40 requests.
 */

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
    cwd,
    stdio: "pipe",
  }).toString();

const WORKTREE = ids("private-alice").worktree;
const stamped = <A>(value: A) => ({ value, stamp: WORKTREE_STAMP });
let tmp = "";
let api: TenancyApi;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "mend-worktree-contents-api-"));
  const repo = join(tmp, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  // A repository of a realistic size for a search: 2,000 files of 40 lines.
  for (let file = 0; file < 2_000; file++) {
    const lines = Array.from(
      { length: 40 },
      (_, line) => `export const value${file}_${line} = ${line};`,
    );
    writeFileSync(join(repo, "src", `file-${file}.ts`), `${lines.join("\n")}\n`);
  }
  writeFileSync(join(repo, "src", "parser.ts"), "export const parse = (input: string) => input;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").trim();
  writeFileSync(
    join(repo, "src", "parser.ts"),
    "export const parse = (input: string) => input.trim();\n",
  );

  const store = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Store;
    }).pipe(
      Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(join(tmp, "store"))))),
    ),
  );
  const checkpoint = new Checkpoint({
    id: CheckpointId.make("checkpoint-0"),
    worktreeId: WorktreeId.make(WORKTREE),
    sessionId: null,
    ordinal: 0,
    ref: `refs/mend/checkpoints/${WORKTREE}/0`,
    sha: Sha.make(base),
    sealantRunId: null,
    seq: SequenceNumber.make(0n),
    trigger: "session-start",
    createdAt: new Date(),
  });
  api = await createTenancyApi(
    {},
    {
      implement: {
        checkpoints: { listForWorktree: () => Effect.succeed([checkpoint]) },
        // The colocated adapter's reads, on this repository.
        reads: {
          readFile: (_project, _worktree, relative, at, maxBytes) =>
            (at === null
              ? store.readWorktreeFile(repo, relative, maxBytes)
              : store.readBlob(repo, at, relative, maxBytes)
            ).pipe(Effect.map(stamped)),
          searchFiles: (_project, _worktree, query, limit) =>
            store.grep(repo, null, query, limit).pipe(Effect.map(stamped)),
        },
      },
    },
  );
});

afterAll(async () => {
  await api?.dispose();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const contents = (user: "alice" | "carol", query: string) =>
  api.request(user, "GET", `/api/worktrees/${WORKTREE}/contents?${query}`);

const timed = async (query: string) => {
  const samples: Array<number> = [];
  for (let i = 0; i < 40; i++) {
    const started = performance.now();
    const response = await contents("alice", query);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    samples.push(performance.now() - started);
  }
  const sorted = samples.toSorted((a, b) => a - b);
  return { median: sorted[20] ?? 0, p90: sorted[36] ?? 0 };
};

describe("a worktree's files", () => {
  it("reads one file as it stands, and at a checkpoint", async () => {
    const now = await (await contents("alice", "path=src/parser.ts")).json();
    expect(now.file.contents).toContain("input.trim()");
    expect(now.file.at).toBeNull();
    expect(now.search).toBeNull();
    const then = await (await contents("alice", "path=src/parser.ts&at=checkpoint-0")).json();
    expect(then.file.contents).not.toContain("trim");
    expect(then.file.at).toBe("checkpoint-0");
  });

  it("finds the lines a search names", async () => {
    const found = await (await contents("alice", "query=input.trim&limit=10")).json();
    expect(found.search.matches).toEqual([
      {
        path: "src/parser.ts",
        line: 1,
        text: "export const parse = (input: string) => input.trim();",
      },
    ]);
    const many = await (await contents("alice", "query=export&limit=5")).json();
    expect(many.search.matches).toHaveLength(5);
    expect(many.search.truncated).toBe(true);
  });

  it("is refused to whoever cannot see the worktree, and keeps a path inside it", async () => {
    const carol = await contents("carol", "path=src/parser.ts");
    expect(carol.status).toBe(404);
    expect((await carol.json()).id).toBe(WORKTREE);
    expect((await contents("alice", "path=../outside.txt")).status).toBe(422);
    expect((await contents("alice", "path=.git/config")).status).toBe(422);
    expect((await contents("alice", "path=src/missing.ts")).status).toBe(404);
    expect((await contents("alice", "")).status).toBe(422);
    expect((await contents("alice", "path=a&query=b")).status).toBe(422);
  });

  it("answers in time: one file, and a search of 2,000 files", async () => {
    const read = await timed("path=src/parser.ts");
    const search = await timed("query=value1999_39&limit=100");
    console.log(
      `GET /api/worktrees/:id/contents · file median ${read.median.toFixed(1)} ms · p90 ${read.p90.toFixed(1)} ms · search median ${search.median.toFixed(1)} ms · p90 ${search.p90.toFixed(1)} ms`,
    );
    expect(read.p90).toBeLessThan(1_000);
    expect(search.p90).toBeLessThan(2_000);
  });
});
