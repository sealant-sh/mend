import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";

import { WorktreeContents, WorktreeRangeDiff } from "@mend/api-contracts";
import { CheckpointId, SequenceNumber, Sha, WorktreeId } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Layer, Schema } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "./support/tenancy-api.ts";
import { ids } from "./support/tenancy-harness.ts";
import { createWideWorktreeDiff } from "./support/wide-worktree-diff.ts";

const execution = process.env["MEND_WORKTREE_PERF_CONTEXT"];
if (execution !== "local-serial" && execution !== "dedicated-ci")
  throw new Error(
    "Set MEND_WORKTREE_PERF_CONTEXT=local-serial or dedicated-ci for the explicit lane",
  );
if (process.env["GIT_CONFIG_NOSYSTEM"] !== "1" || process.env["GIT_CONFIG_GLOBAL"] !== "/dev/null")
  throw new Error("Run the lane with GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null");
const locationOverrides = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
];
const unsupported = locationOverrides.filter((key) => (process.env[key] ?? "") !== "");
if (unsupported.length > 0 || ![undefined, "", "0"].includes(process.env["GIT_CONFIG_COUNT"]))
  throw new Error(
    "Remove inherited Git location/config overrides before benchmarking owned fixtures",
  );

const WORKTREE = ids("private-alice").worktree;
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
    cwd,
    stdio: "pipe",
  })
    .toString()
    .trim();
const stamped = <A>(value: A) => ({ value, stamp: WORKTREE_STAMP });
const checkpoint = (ordinal: number, sha: string) =>
  new Checkpoint({
    id: CheckpointId.make(`perf-${ordinal}`),
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

const createReadFixture = async () => {
  const root = mkdtempSync(join(os.tmpdir(), "mend-worktree-reads-perf-"));
  let api: TenancyApi | undefined;
  const dispose = async () => {
    try {
      await api?.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const diffRepo = join(root, "diff");
    const contentsRepo = join(root, "contents");
    mkdirSync(diffRepo);
    mkdirSync(join(contentsRepo, "src"), { recursive: true });
    git(diffRepo, "init", "-q", "-b", "main", "--template=");
    for (let file = 0; file < 200; file++)
      writeFileSync(join(diffRepo, `file-${file}.ts`), `export const value${file} = ${file};\n`);
    git(diffRepo, "add", "-A");
    git(diffRepo, "commit", "-qm", "base");
    const base = git(diffRepo, "rev-parse", "HEAD");
    for (let file = 0; file < 40; file++)
      writeFileSync(
        join(diffRepo, `file-${file}.ts`),
        `export const value${file} = ${file * 2};\nexport const twice${file} = true;\n`,
      );
    git(diffRepo, "add", "-A");
    git(diffRepo, "commit", "-qm", "forty-file turn");
    const top = git(diffRepo, "rev-parse", "HEAD");
    git(contentsRepo, "init", "-q", "-b", "main", "--template=");
    for (let file = 0; file < 2_000; file++) {
      const lines = Array.from(
        { length: 40 },
        (_, line) => `export const value${file}_${line} = ${line};`,
      );
      writeFileSync(join(contentsRepo, "src", `file-${file}.ts`), `${lines.join("\n")}\n`);
    }
    writeFileSync(
      join(contentsRepo, "src", "parser.ts"),
      "export const parse = (input: string) => input.trim();\n",
    );
    git(contentsRepo, "add", "-A");
    git(contentsRepo, "commit", "-qm", "contents");
    const store = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Store;
      }).pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(join(root, "store"))))),
      ),
    );
    const chain = [checkpoint(0, base), checkpoint(1, top)];
    const ownedApi = await createTenancyApi(
      {},
      {
        implement: {
          checkpoints: { listForWorktree: () => Effect.succeed(chain) },
          reads: {
            diffRange: (_project, _worktree, from, to, options) =>
              store.diffRange(diffRepo, from, to, options).pipe(Effect.map(stamped)),
            diffFileFactsBounded: (_project, _worktree, from, to, options) =>
              store.diffFileFactsBounded(diffRepo, from, to, options).pipe(Effect.map(stamped)),
            readFile: (_project, _worktree, relative, _at, maxBytes) =>
              store.readWorktreeFile(contentsRepo, relative, maxBytes).pipe(Effect.map(stamped)),
            searchFiles: (_project, _worktree, query, limit) =>
              store.grep(contentsRepo, null, query, limit).pipe(Effect.map(stamped)),
          },
        },
      },
    );
    api = ownedApi;
    return {
      root,
      request: (query: string) =>
        ownedApi.request("alice", "GET", `/api/worktrees/${WORKTREE}/${query}`),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};

type QueryName = "diff" | "file" | "search";
const names: ReadonlyArray<QueryName> = ["diff", "file", "search"];
const budgets: Record<QueryName, number> = { diff: 1_000, file: 1_000, search: 2_000 };
const summarize = (samples: ReadonlyArray<number>) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];
  if (median === undefined || p90 === undefined) throw new Error("No latency samples recorded");
  return { count: sorted.length, median, p90 };
};

it("measures real Git worktree routes on a serial, explicitly described performance lane", async () => {
  const fixture = await createReadFixture();
  const rounds: Array<Record<QueryName, Array<number>>> = [];
  const loadBefore = os.loadavg();
  const measure = async (name: QueryName) => {
    const query =
      name === "diff"
        ? "diff?from=perf-0&to=perf-1"
        : name === "file"
          ? "contents?path=src/parser.ts"
          : "contents?query=value1999_39&limit=100";
    const started = performance.now();
    const response = await fixture.request(query);
    expect(response.status).toBe(200);
    if (name === "diff") {
      const raw = await response.json();
      const elapsed = performance.now() - started;
      const answer = Schema.decodeUnknownSync(WorktreeRangeDiff)(raw);
      expect(answer.files).toHaveLength(40);
      expect(answer.truncated).toBe(false);
      return elapsed;
    }
    const raw = await response.arrayBuffer();
    const elapsed = performance.now() - started;
    const answer = Schema.decodeUnknownSync(WorktreeContents)(
      JSON.parse(Buffer.from(raw).toString("utf8")),
    );
    if (name === "file")
      expect(answer.file?.contents).toBe("export const parse = (input: string) => input.trim();\n");
    else
      expect(answer.search?.matches).toEqual([
        { path: "src/file-1999.ts", line: 40, text: "export const value1999_39 = 39;" },
      ]);
    return elapsed;
  };
  let complete = false;
  let wideElapsed = 0;
  let wideListed = 0;
  try {
    for (let warmup = 0; warmup < 5; warmup++) for (const name of names) await measure(name);
    for (let round = 0; round < 3; round++) {
      const samples: Record<QueryName, Array<number>> = { diff: [], file: [], search: [] };
      rounds.push(samples);
      for (let sample = 0; sample < 40; sample++) {
        const first = (round + sample) % names.length;
        for (const name of [...names.slice(first), ...names.slice(0, first)])
          samples[name].push(await measure(name));
      }
    }
    const wide = await createWideWorktreeDiff();
    try {
      const started = performance.now();
      const response = await wide.request();
      wideElapsed = performance.now() - started;
      expect(response.status).toBe(200);
      const answer = Schema.decodeUnknownSync(WorktreeRangeDiff)(await response.json());
      wideListed = answer.files.length;
      expect(answer.listingCut).toBe(true);
      expect(answer.truncated).toBe(true);
      expect(wideListed).toBeGreaterThanOrEqual(200);
      expect(wideListed).toBeLessThan(400_000);
      expect(answer.diff.match(/^diff --git /gm)?.length).toBe(200);
    } finally {
      await wide.dispose();
    }
    complete = true;
  } finally {
    try {
      const filesystem = statfsSync(fixture.root);
      const summarizePartial = (samples: ReadonlyArray<number>) =>
        samples.length === 0 ? null : summarize(samples);
      const statistics = rounds.map((samples) => ({
        diff: summarizePartial(samples.diff),
        file: summarizePartial(samples.file),
        search: summarizePartial(samples.search),
      }));
      const report = {
        benchmark: "worktree-reads",
        units: "milliseconds",
        execution,
        complete,
        sourceHashes: Object.fromEntries(
          [
            "src/routes/worktrees.ts",
            "../../packages/store/src/store.ts",
            "../../pnpm-lock.yaml",
            "test/worktree-reads.perf.ts",
            "test/support/tenancy-api.ts",
            "test/support/wide-worktree-diff.ts",
          ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
        ),
        gitConfiguration:
          "global/system disabled; inherited location/counted/config overrides rejected; owned init uses empty template",
        budgets: { strictP90Ms: budgets, strictWideResponseMs: 25_000 },
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          osRelease: os.release(),
          cpu: os.cpus()[0]?.model,
          cpuThreads: os.cpus().length,
          memoryBytes: os.totalmem(),
          freeMemoryBytes: os.freemem(),
          loadBefore,
          loadAfter: os.loadavg(),
          git: git(fixture.root, "--version"),
          filesystem: {
            type: filesystem.type,
            blockSize: filesystem.bsize,
            freeBlocks: filesystem.bavail,
          },
          commit: git(process.cwd(), "rev-parse", "HEAD"),
          dirty: git(process.cwd(), "status", "--porcelain").length > 0,
        },
        fixture: {
          diffBaseFiles: 200,
          diffChangedFiles: 40,
          searchFiles: 2_000,
          linesPerSearchFile: 40,
          parserFiles: 1,
          wideFiles: 400_000,
        },
        measurement:
          "diff includes JSON body consumption; contents includes arrayBuffer body consumption, parsing/checks after timing; wide response only, as original budgets",
        warmupRounds: 5,
        samplesPerQueryPerRound: 40,
        rounds: statistics,
        samples: rounds,
        wide: { elapsed: wideElapsed, listed: wideListed },
      };
      const encoded = `${JSON.stringify(report, null, 2)}\n`;
      console.log(encoded);
      const output = process.env["MEND_WORKTREE_PERF_REPORT"];
      if (output !== undefined) {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, encoded);
      }
    } finally {
      await fixture.dispose();
    }
  }
  for (const [round, samples] of rounds.entries())
    for (const name of names)
      expect(summarize(samples[name]).p90, `round ${round + 1}: ${name} p90`).toBeLessThan(
        budgets[name],
      );
  expect(wideElapsed).toBeLessThan(25_000);
});
