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
import { CAROL_WORKTREE_IN_SHARED_A, ids } from "../../test/support/tenancy-harness.ts";

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
const SHARED = ids("shared-a").worktree;
/** Files of the large turn: past the file cap, and past the byte budget well before it. */
const LARGE_FILES = 300;
const LARGE_LINES = 3_000;
/** Every git read the endpoint made, so a refusal can be checked to have read nothing. */
let reads = 0;
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
  // Turn three adds 300 large files: about 13 MB of patch.
  const body = Array.from({ length: LARGE_LINES }, (_, line) => `// chunk-data ${line}`).join("\n");
  for (let file = 0; file < LARGE_FILES; file++) {
    writeFileSync(join(worktree.path, `large-${String(file).padStart(3, "0")}.ts`), `${body}\n`);
  }
  const three = await run(store.checkpoint(worktree.path, "test", 3, two.sha));

  const checkpoint = (ordinal: number, sha: string, owner: string = WORKTREE, id?: string) =>
    new Checkpoint({
      id: CheckpointId.make(id ?? `checkpoint-${ordinal}`),
      worktreeId: WorktreeId.make(owner),
      sessionId: null,
      ordinal,
      ref: `refs/mend/checkpoints/${WORKTREE}/${ordinal}`,
      sha: Sha.make(sha),
      sealantRunId: null,
      seq: SequenceNumber.make(BigInt(ordinal)),
      trigger: "turn-boundary",
      createdAt: new Date(),
    });
  const chains = new Map<string, ReadonlyArray<Checkpoint>>([
    [
      WORKTREE,
      [
        checkpoint(0, worktree.baseSha),
        checkpoint(1, one.sha),
        checkpoint(2, two.sha),
        checkpoint(3, three.sha),
      ],
    ],
    // Alice's shared project: its own worktree, and carol's beside it (alice sees both).
    [SHARED, [checkpoint(1, one.sha, SHARED, "checkpoint-shared-a")]],
    [
      CAROL_WORKTREE_IN_SHARED_A,
      [checkpoint(1, one.sha, CAROL_WORKTREE_IN_SHARED_A, "checkpoint-carol-shared")],
    ],
    // Carol's private project: alice cannot see it.
    [
      ids("private-carol").worktree,
      [checkpoint(1, one.sha, ids("private-carol").worktree, "checkpoint-carol-private")],
    ],
  ]);
  api = await createTenancyApi(
    {},
    {
      implement: {
        checkpoints: {
          listForWorktree: (worktreeId) => Effect.succeed(chains.get(worktreeId) ?? []),
        },
        // The colocated adapter's reads, on this repository.
        reads: {
          diffRange: (_project, _worktree, a, b, options) =>
            Effect.suspend(() => {
              reads += 1;
              return store.diffRange(worktree.path, a, b, options).pipe(Effect.map(stamped));
            }),
          diffFileFacts: (_project, _worktree, a, b, options) =>
            Effect.suspend(() => {
              reads += 1;
              return store.diffFileFacts(worktree.path, a, b, options).pipe(Effect.map(stamped));
            }),
        },
      },
    },
  );
});

afterAll(async () => {
  await api?.dispose();
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
});

const slice = (user: "alice" | "carol", query: string, worktree: string = WORKTREE) =>
  api.request(user, "GET", `/api/worktrees/${worktree}/diff?${query}`);

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

  it("takes both ends from the worktree's own chain: another worktree's checkpoint is not found, before any read", async () => {
    const before = reads;
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      // Another worktree of the same project, which alice can see.
      [SHARED, "to=checkpoint-carol-shared", "checkpoint-carol-shared"],
      [SHARED, "from=checkpoint-carol-shared&to=checkpoint-shared-a", "checkpoint-carol-shared"],
      // A worktree alice cannot see at all.
      [WORKTREE, "to=checkpoint-carol-private", "checkpoint-carol-private"],
      [WORKTREE, "from=checkpoint-carol-private&to=checkpoint-2", "checkpoint-carol-private"],
    ];
    for (const [worktree, query, named] of cases) {
      const response = await slice("alice", query, worktree);
      expect(response.status).toBe(404);
      expect((await response.json()).id).toBe(named);
    }
    expect(reads).toBe(before);
  });

  it("answers a large slice bounded: the first files whole, the rest named, each one on its own", async () => {
    const response = await slice("alice", "from=checkpoint-2&to=checkpoint-3");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.files).toHaveLength(LARGE_FILES);
    expect(body.truncated).toBe(true);
    const whole = body.diff.match(/^diff --git /gm)?.length ?? 0;
    expect(whole).toBeGreaterThan(0);
    expect(whole).toBeLessThanOrEqual(200);
    expect(body.diff.length).toBeLessThanOrEqual(8 * 1024 * 1024);
    // The patches end whole, and every file without one is named.
    expect(body.diff.endsWith(`// chunk-data ${LARGE_LINES - 1}`)).toBe(true);
    expect(body.omitted).toHaveLength(LARGE_FILES - whole);
    expect(body.omitted.at(-1)).toBe(`large-${LARGE_FILES - 1}.ts`);

    const one = await slice("alice", `from=checkpoint-2&to=checkpoint-3&path=${body.omitted[0]}`);
    const alone = await one.json();
    expect(alone.files).toHaveLength(1);
    expect(alone.truncated).toBe(false);
    expect(alone.diff).toContain(`b/${body.omitted[0]}`);

    const missing = await slice("alice", "from=checkpoint-2&to=checkpoint-3&path=nowhere.ts");
    expect(missing.status).toBe(404);
  });

  it("says nothing was cut when nothing was", async () => {
    const body = await (await slice("alice", "from=checkpoint-1&to=checkpoint-2")).json();
    expect(body.truncated).toBe(false);
    expect(body.omitted).toEqual([]);
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
