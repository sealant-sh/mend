import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CheckpointId, SequenceNumber, Sha, WorktreeId } from "@mend/domain";
import { Checkpoint } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Store, StoreConfig } from "@mend/store";
import { Effect, Layer } from "effect";

import { createTenancyApi, type TenancyApi } from "./tenancy-api.ts";
import { ids } from "./tenancy-harness.ts";

export const wideLeafName = (index: number): string =>
  `f${String(index).padStart(4, "0")}${"x".repeat(195)}`;

interface WideWorktreeDiff {
  readonly root: string;
  readonly request: (path?: string) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

const stamped = <A>(value: A) => ({ value, stamp: WORKTREE_STAMP });

/** Owned Git objects for 400,000 tiny files, shared by correctness and the explicit perf lane. */
export const createWideWorktreeDiff = async (): Promise<WideWorktreeDiff> => {
  const root = mkdtempSync(join(tmpdir(), "mend-wide-slice-"));
  const worktreeId = ids("private-alice").worktree;
  let api: TenancyApi | undefined;
  const plumbing = (args: ReadonlyArray<string>, input = "") =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
      cwd: root,
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString()
      .trim();
  const dispose = async () => {
    try {
      await api?.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    plumbing(["init", "-q", "-b", "main", "--template="]);
    const base = plumbing(["commit-tree", plumbing(["mktree"]), "-m", "base"]);
    const blob = plumbing(["hash-object", "-w", "--stdin"], "one\n");
    const leaf = plumbing(
      ["mktree"],
      Array.from(
        { length: 500 },
        (_, index) => `100644 blob ${blob}\t${wideLeafName(index)}\n`,
      ).join(""),
    );
    const tree = plumbing(
      ["mktree"],
      Array.from(
        { length: 800 },
        (_, index) => `040000 tree ${leaf}\td${String(index).padStart(4, "0")}\n`,
      ).join(""),
    );
    const top = plumbing(["commit-tree", tree, "-p", base, "-m", "wide"]);
    const store = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Store;
      }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(root))))),
    );
    const checkpoint = (ordinal: number, sha: string) =>
      new Checkpoint({
        id: CheckpointId.make(`wide-${ordinal}`),
        worktreeId: WorktreeId.make(worktreeId),
        sessionId: null,
        ordinal,
        ref: `refs/mend/checkpoints/${worktreeId}/${ordinal}`,
        sha: Sha.make(sha),
        sealantRunId: null,
        seq: SequenceNumber.make(BigInt(ordinal)),
        trigger: "turn-boundary",
        createdAt: new Date(),
      });
    const chain = [checkpoint(0, base), checkpoint(1, top)];
    const ownedApi = await createTenancyApi(
      {},
      {
        implement: {
          checkpoints: { listForWorktree: () => Effect.succeed(chain) },
          reads: {
            diffRange: (_project, _worktree, from, to, options) =>
              store.diffRange(root, from, to, options).pipe(Effect.map(stamped)),
            diffFileFactsBounded: (_project, _worktree, from, to, options) =>
              store.diffFileFactsBounded(root, from, to, options).pipe(Effect.map(stamped)),
          },
        },
      },
    );
    api = ownedApi;
    return {
      root,
      request: (path) =>
        ownedApi.request(
          "alice",
          "GET",
          `/api/worktrees/${worktreeId}/diff?from=wide-0&to=wide-1${path === undefined ? "" : `&path=${encodeURIComponent(path)}`}`,
        ),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
};
