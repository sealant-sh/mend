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
import { patchedPaths } from "./worktrees.ts";

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
/** A checkpoint of `owner`'s chain at `sha`. */
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
          diffFileFactsBounded: (_project, _worktree, a, b, options) =>
            Effect.suspend(() => {
              reads += 1;
              return store
                .diffFileFactsBounded(worktree.path, a, b, options)
                .pipe(Effect.map(stamped));
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
    // Every file of the slice was listed: only patches were left out.
    expect(body.listingCut).toBe(false);
  });

  it("says nothing was cut when nothing was", async () => {
    const body = await (await slice("alice", "from=checkpoint-1&to=checkpoint-2")).json();
    expect(body.truncated).toBe(false);
    expect(body.listingCut).toBe(false);
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

/** A 200-character file name of the wide slice. */
const leafName = (index: number) => `f${String(index).padStart(4, "0")}${"x".repeat(195)}`;

describe("a slice too wide to list whole (601-R2-1)", () => {
  it(
    "answers its first files, cut, and any one file by path: never 422",
    { timeout: 120_000 },
    async () => {
      // 400,000 tiny files with 200-character names, made of git objects alone (no checkout): the
      // listing alone is past any buffer. Before, the metadata pass failed with maxBuffer, 422.
      const root = mkdtempSync(join(tmpdir(), "mend-wide-slice-"));
      const plumbing = (args: ReadonlyArray<string>, input = "") =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
          cwd: root,
          input,
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 64 * 1024 * 1024,
        })
          .toString()
          .trim();
      let wide: TenancyApi | undefined;
      try {
        plumbing(["init", "-q", "-b", "main"]);
        const base = plumbing(["commit-tree", plumbing(["mktree"]), "-m", "base"]);
        const blob = plumbing(["hash-object", "-w", "--stdin"], "one\n");
        const leaf = plumbing(
          ["mktree"],
          Array.from({ length: 500 }, (_, i) => `100644 blob ${blob}\t${leafName(i)}\n`).join(""),
        );
        const tree = plumbing(
          ["mktree"],
          Array.from(
            { length: 800 },
            (_, i) => `040000 tree ${leaf}\td${String(i).padStart(4, "0")}\n`,
          ).join(""),
        );
        const top = plumbing(["commit-tree", tree, "-p", base, "-m", "wide"]);
        const store = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* Store;
          }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
        );
        const chain = [
          checkpoint(0, base, WORKTREE, "wide-0"),
          checkpoint(1, top, WORKTREE, "wide-1"),
        ];
        wide = await createTenancyApi(
          {},
          {
            implement: {
              checkpoints: { listForWorktree: () => Effect.succeed(chain) },
              reads: {
                diffRange: (_p, _w, a, b, options) =>
                  store.diffRange(root, a, b, options).pipe(Effect.map(stamped)),
                diffFileFactsBounded: (_p, _w, a, b, options) =>
                  store.diffFileFactsBounded(root, a, b, options).pipe(Effect.map(stamped)),
              },
            },
          },
        );
        const started = performance.now();
        const response = await wide.request(
          "alice",
          "GET",
          `/api/worktrees/${WORKTREE}/diff?from=wide-0&to=wide-1`,
        );
        const elapsed = performance.now() - started;
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.listingCut).toBe(true);
        expect(body.truncated).toBe(true);
        expect(body.files.length).toBeGreaterThan(200);
        expect(body.files.length).toBeLessThan(400_000);
        expect(body.files[0].newPath).toBe(`d0000/${leafName(0)}`);
        expect(body.diff.match(/^diff --git /gm)?.length).toBe(200);
        console.log(
          `wide slice · ${body.files.length} of 400000 files listed · ${elapsed.toFixed(0)} ms`,
        );
        expect(elapsed).toBeLessThan(25_000);

        // A file far past the listing, asked for by path: git lists that file alone.
        const far = `d0799/${leafName(499)}`;
        const one = await wide.request(
          "alice",
          "GET",
          `/api/worktrees/${WORKTREE}/diff?from=wide-0&to=wide-1&path=${encodeURIComponent(far)}`,
        );
        expect(one.status).toBe(200);
        const alone = await one.json();
        expect(alone.listingCut).toBe(false);
        expect(alone.files.map((file: { newPath: string }) => file.newPath)).toEqual([far]);
        expect(alone.diff).toContain(`b/${far}`);
      } finally {
        await wide?.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

/** A four-digit file number of the rename fixture. */
const name = (index: number) => String(index).padStart(4, "0");

describe("a slice past git's rename limit (601-R2-2)", () => {
  it(
    "names as omitted only files no patch names, however git paired them",
    { timeout: 120_000 },
    async () => {
      // 1,200 files moved with one line added each: the listing, past diff.renameLimit, shows each
      // as deleted and added; the 200-path page renders them as renames. Counting patches named
      // files whose patches were there as omitted.
      const root = mkdtempSync(join(tmpdir(), "mend-rename-limit-"));
      const inFixture = (args: ReadonlyArray<string>) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
          cwd: root,
          stdio: "pipe",
          maxBuffer: 64 * 1024 * 1024,
        })
          .toString()
          .trim();
      let moved: TenancyApi | undefined;
      try {
        inFixture(["init", "-q", "-b", "main"]);
        const body = (index: number) =>
          Array.from({ length: 40 }, (_, line) => `file ${name(index)} line ${line + 1}`).join(
            "\n",
          );
        for (let index = 0; index < 1_200; index++) {
          writeFileSync(join(root, `p${name(index)}-old`), `${body(index)}\n`);
        }
        inFixture(["add", "-A"]);
        inFixture(["commit", "-qm", "base"]);
        const base = inFixture(["rev-parse", "HEAD"]);
        for (let index = 0; index < 1_200; index++) {
          rmSync(join(root, `p${name(index)}-old`));
          writeFileSync(join(root, `p${name(index)}-new`), `${body(index)}\nextra\n`);
        }
        inFixture(["add", "-A"]);
        inFixture(["commit", "-qm", "moved"]);
        const top = inFixture(["rev-parse", "HEAD"]);
        const store = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* Store;
          }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
        );
        const chain = [
          checkpoint(0, base, WORKTREE, "moved-0"),
          checkpoint(1, top, WORKTREE, "moved-1"),
        ];
        moved = await createTenancyApi(
          {},
          {
            implement: {
              checkpoints: { listForWorktree: () => Effect.succeed(chain) },
              reads: {
                diffRange: (_p, _w, a, b, options) =>
                  store.diffRange(root, a, b, options).pipe(Effect.map(stamped)),
                diffFileFactsBounded: (_p, _w, a, b, options) =>
                  store.diffFileFactsBounded(root, a, b, options).pipe(Effect.map(stamped)),
              },
            },
          },
        );
        const response = await moved.request(
          "alice",
          "GET",
          `/api/worktrees/${WORKTREE}/diff?from=moved-0&to=moved-1`,
        );
        expect(response.status).toBe(200);
        const answer = await response.json();
        expect(answer.files).toHaveLength(2_400);
        const omitted = new Set<string>(answer.omitted);
        // Every path a patch names is not omitted, and every file is either patched or omitted.
        const patched = patchedPaths(answer.diff);
        expect(patched.size).toBeGreaterThan(0);
        for (const path of patched) expect(omitted.has(path)).toBe(false);
        for (const file of answer.files as ReadonlyArray<{
          newPath: string | null;
          oldPath: string | null;
        }>) {
          const path = file.newPath ?? file.oldPath ?? "";
          expect(patched.has(path) || omitted.has(path)).toBe(true);
        }
        expect(answer.truncated).toBe(true);
        // The fixture is the reviewer's case: counting patches, as before, named files with patches.
        const headers = answer.diff.match(/^diff --git /gm)?.length ?? 0;
        const counted = (
          answer.files as ReadonlyArray<{ newPath: string | null; oldPath: string | null }>
        )
          .slice(Math.min(200, headers))
          .map((file) => file.newPath ?? file.oldPath ?? "");
        expect(counted.some((path) => patched.has(path))).toBe(true);
      } finally {
        await moved?.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("reads the paths a patch names: renames, quoted names, binaries and mode changes", () => {
    const diff = [
      "diff --git a/old name.ts b/new name.ts",
      "similarity index 90%",
      "rename from old name.ts",
      "rename to new name.ts",
      "@@ -1 +1 @@",
      "--- not a header, a removed line",
      'diff --git "a/tab\\there" "b/tab\\there"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/tab\\there"',
      "@@ -0,0 +1 @@",
      "+x",
      "diff --git a/image.png b/image.png",
      "new file mode 100644",
      "Binary files /dev/null and b/image.png differ",
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
      "deleted file mode 100644",
      "",
    ].join("\n");
    expect([...patchedPaths(diff)].toSorted()).toEqual(
      ["café.md", "image.png", "new name.ts", "old name.ts", "run.sh", "tab\there"].toSorted(),
    );
  });
});
