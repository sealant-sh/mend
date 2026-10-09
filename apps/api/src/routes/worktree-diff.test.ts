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
 * `GET /api/worktrees/:id/diff?from=&to=` (ADR 0012, phase 3): a slice of a worktree's checkpoint
 * chain over the colocated `WorktreeReads` on a real repository, behind the worktree's visibility.
 * The last test prints its latency: median and 90th percentile of 40 requests.
 */

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
    cwd,
    stdio: "pipe",
  }).toString();

const WORKTREE = ids("private-alice").worktree;
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.orDie(effect));
const stamped = <A>(value: A) => ({ value, stamp: WORKTREE_STAMP });
let tmp = "";
let api: TenancyApi;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "mend-worktree-diff-"));
  const origin = join(tmp, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  for (let file = 0; file < 200; file++) {
    writeFileSync(join(origin, `file-${file}.ts`), `export const value${file} = ${file};\n`);
  }
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "base");
  const storeRoot = join(tmp, "store");
  const bare = join(storeRoot, "project", "repo.git");
  mkdirSync(join(storeRoot, "project"), { recursive: true });
  git(tmp, "clone", "-q", "--bare", origin, bare);

  const store = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Store;
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot))))),
  );
  const worktree = await run(
    store.createWorktree(bare, { directory: "wt", branch: "mend/wt" }, null, null),
  );
  // Turn one edits forty files; turn two adds one and renames another.
  for (let file = 0; file < 40; file++) {
    writeFileSync(
      join(worktree.path, `file-${file}.ts`),
      `export const value${file} = ${file * 2};\nexport const twice${file} = true;\n`,
    );
  }
  const one = await run(store.checkpoint(worktree.path, "test", 1, null));
  writeFileSync(join(worktree.path, "added.ts"), "export const added = true;\n");
  git(worktree.path, "mv", "file-199.ts", "renamed.ts");
  const two = await run(store.checkpoint(worktree.path, "test", 2, one.sha));

  const checkpoint = (ordinal: number, sha: string) =>
    new Checkpoint({
      id: CheckpointId.make(`checkpoint-${ordinal}`),
      worktreeId: WorktreeId.make(WORKTREE),
      sessionId: null,
      ordinal,
      ref: `refs/mend/checkpoints/${WORKTREE}/${ordinal}`,
      sha: Sha.make(sha),
      sealantRunId: null,
      seq: SequenceNumber.make(BigInt(ordinal)),
      trigger: "turn-boundary",
      createdAt: new Date(),
    });
  const chain = [checkpoint(0, worktree.baseSha), checkpoint(1, one.sha), checkpoint(2, two.sha)];
  api = await createTenancyApi(
    {},
    {
      implement: {
        checkpoints: { listForWorktree: () => Effect.succeed(chain) },
        // The colocated adapter's reads, on this repository.
        reads: {
          diffRange: (_project, _worktree, a, b, options) =>
            store.diffRange(worktree.path, a, b, options).pipe(Effect.map(stamped)),
          diffFileFacts: (_project, _worktree, a, b, options) =>
            store.diffFileFacts(worktree.path, a, b, options).pipe(Effect.map(stamped)),
        },
      },
    },
  );
});

afterAll(async () => {
  await api?.dispose();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const slice = (user: "alice" | "carol", query: string) =>
  api.request(user, "GET", `/api/worktrees/${WORKTREE}/diff?${query}`);

describe("a slice of a worktree's checkpoint chain", () => {
  it("renders one turn's work, file by file", async () => {
    const response = await slice("alice", "from=checkpoint-1&to=checkpoint-2");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.from.id).toBe("checkpoint-1");
    expect(body.to.id).toBe("checkpoint-2");
    expect(body.diff).toContain("added.ts");
    const files = body.files.map((file: { status: string; newPath: string }) => [
      file.status,
      file.newPath,
    ]);
    expect(files).toContainEqual(["added", "added.ts"]);
    expect(files).toContainEqual(["renamed", "renamed.ts"]);
    expect(files).toHaveLength(2);
  });

  it("is refused, as the worktree is, to whoever cannot see it, before any read", async () => {
    const response = await slice("carol", "from=checkpoint-1&to=checkpoint-2");
    expect(response.status).toBe(404);
    expect((await response.json()).id).toBe(WORKTREE);
  });

  it("names a checkpoint that is not in the chain, and refuses a slice that runs backward", async () => {
    const unknown = await slice("alice", "to=checkpoint-9");
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).id).toBe("checkpoint-9");
    const backward = await slice("alice", "from=checkpoint-2&to=checkpoint-1");
    expect(backward.status).toBe(422);
  });

  it("answers in time: median and p90 of 40 requests over a forty-file turn", async () => {
    const samples: Array<number> = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const response = await slice("alice", "from=checkpoint-0&to=checkpoint-1");
      expect((await response.json()).files).toHaveLength(40);
      samples.push(performance.now() - started);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    const median = sorted[20] ?? 0;
    const p90 = sorted[36] ?? 0;
    console.log(
      `GET /api/worktrees/:id/diff · median ${median.toFixed(1)} ms · p90 ${p90.toFixed(1)} ms`,
    );
    expect(p90).toBeLessThan(1_000);
  });
});
