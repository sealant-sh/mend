import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  formatHandoffMessage,
  HANDOFF_SNAPSHOT_REF,
  HandoffCutAt,
  HandoffMachine,
  HandoffBranch,
  HexSha,
} from "@mend/domain/workbench";

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "mend",
  GIT_AUTHOR_EMAIL: "mend@localhost",
  GIT_COMMITTER_NAME: "mend",
  GIT_COMMITTER_EMAIL: "mend@localhost",
  GIT_AUTHOR_DATE: "2026-10-18T07:42:05Z",
  GIT_COMMITTER_DATE: "2026-10-18T07:42:05Z",
};

export const sh = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly input?: string | Uint8Array; readonly env?: Record<string, string> } = {},
): string =>
  execFileSync("git", [...args], {
    cwd,
    env: { ...gitEnv, ...options.env },
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString("utf8")
    .replace(/\n$/, "");

export interface HandoffWorld {
  readonly tmp: string;
  readonly origin: string;
  readonly storePath: string;
  readonly checkout: string;
  readonly mainTip: string;
  readonly mainRoot: string;
  readonly sideTip: string;
}

export const makeHandoffWorld = (tmp: string): HandoffWorld => {
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  sh(origin, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(origin, "README.md"), "# fixture\n");
  fs.writeFileSync(path.join(origin, "app.ts"), "export const answer = 41;\n");
  sh(origin, ["add", "-A"]);
  sh(origin, ["commit", "-q", "-m", "initial"]);
  const mainRoot = sh(origin, ["rev-parse", "HEAD"]);
  sh(origin, ["checkout", "-q", "-b", "side"]);
  fs.writeFileSync(path.join(origin, "side.txt"), "side\n");
  sh(origin, ["add", "-A"]);
  sh(origin, ["commit", "-q", "-m", "side work"]);
  const sideTip = sh(origin, ["rev-parse", "HEAD"]);
  sh(origin, ["checkout", "-q", "main"]);
  fs.writeFileSync(path.join(origin, "app.ts"), "export const answer = 42;\n");
  sh(origin, ["commit", "-q", "-am", "the answer"]);
  const mainTip = sh(origin, ["rev-parse", "HEAD"]);

  const storePath = path.join(tmp, "store-root", "project", "repo.git");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  sh(tmp, ["clone", "-q", "--bare", origin, storePath]);
  sh(storePath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  sh(storePath, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  const checkout = path.join(tmp, "checkout");
  sh(tmp, ["clone", "-q", origin, checkout]);
  sh(checkout, ["checkout", "-q", "-b", "fix/login"]);
  fs.writeFileSync(path.join(checkout, "login.ts"), "export const login = () => true;\n");
  sh(checkout, ["add", "-A"]);
  sh(checkout, ["commit", "-q", "-m", "login"]);
  fs.appendFileSync(path.join(checkout, "login.ts"), "export const logout = () => false;\n");
  sh(checkout, ["commit", "-q", "-am", "logout"]);
  fs.writeFileSync(path.join(checkout, "staged.ts"), "staged\n");
  sh(checkout, ["add", "staged.ts"]);
  fs.appendFileSync(path.join(checkout, "app.ts"), "// unstaged\n");
  fs.writeFileSync(path.join(checkout, "notes.txt"), "untracked\n");
  return { tmp, origin, storePath, checkout, mainTip, mainRoot, sideTip };
};

export type HandoffCut = { readonly kind: "at"; readonly sha: string } | { readonly kind: "none" };

export interface HandoffBundleKnobs {
  readonly machine?: string;
  readonly localBranch?: string | null;
  readonly cutAt?: string;
  readonly defaultTip?: string;
  readonly cut?: HandoffCut;
  readonly mergeBaseTrailer?: string;
  readonly message?: string;
  readonly shape?: "linear" | "merge" | "root";
  readonly extraRefs?: ReadonlyArray<string>;
}

export interface HandoffBundle {
  readonly bytes: Uint8Array;
  readonly head: string;
  readonly index: string;
  readonly checkpoint: string;
  readonly mergeBase: string;
  readonly cut: HandoffCut;
  readonly defaultTip: string;
  readonly worktreeTree: string;
  readonly indexTree: string;
}

export const buildHandoffBundle = (
  checkout: string,
  knobs: HandoffBundleKnobs = {},
): HandoffBundle => {
  const head = sh(checkout, ["rev-parse", "HEAD"]);
  const defaultTip = knobs.defaultTip ?? sh(checkout, ["rev-parse", "refs/remotes/origin/main"]);
  const mergeBase = sh(checkout, ["merge-base", "HEAD", "refs/remotes/origin/main"]);
  const cut: HandoffCut = knobs.cut ?? { kind: "at", sha: mergeBase };
  const scratch = fs.mkdtempSync(path.join(checkout, "..", "snapshot-"));
  const gitDir = sh(checkout, ["rev-parse", "--absolute-git-dir"]);
  const indexCopy = path.join(scratch, "index");
  fs.copyFileSync(path.join(gitDir, "index"), indexCopy);
  const indexTree = sh(checkout, ["write-tree"], { env: { GIT_INDEX_FILE: indexCopy } });
  const workIndex = path.join(scratch, "work-index");
  sh(checkout, ["add", "-A"], { env: { GIT_INDEX_FILE: workIndex } });
  const worktreeTree = sh(checkout, ["write-tree"], { env: { GIT_INDEX_FILE: workIndex } });
  const index = sh(checkout, ["commit-tree", indexTree, "-p", head], {
    input: "mend handoff index\n",
  });
  const parents =
    knobs.shape === "root"
      ? []
      : knobs.shape === "merge"
        ? ["-p", index, "-p", head]
        : ["-p", index];
  const message =
    knobs.message ??
    formatHandoffMessage({
      machine: HandoffMachine.make(knobs.machine ?? "dana-mbp"),
      localBranch:
        knobs.localBranch === null ? null : HandoffBranch.make(knobs.localBranch ?? "fix/login"),
      cutAt: HandoffCutAt.make(knobs.cutAt ?? "2026-10-18T07:42:05.000Z"),
      defaultTip: HexSha.make(defaultTip),
      mergeBase: HexSha.make(knobs.mergeBaseTrailer ?? mergeBase),
    });
  const checkpoint = sh(checkout, ["commit-tree", worktreeTree, ...parents], { input: message });
  sh(checkout, ["update-ref", HANDOFF_SNAPSHOT_REF, checkpoint]);
  const file = path.join(scratch, "handoff.bundle");
  sh(checkout, [
    "bundle",
    "create",
    "-q",
    file,
    HANDOFF_SNAPSHOT_REF,
    ...(knobs.extraRefs ?? []),
    ...(cut.kind === "at" ? [`^${cut.sha}`] : []),
  ]);
  const bytes = new Uint8Array(fs.readFileSync(file));
  fs.rmSync(scratch, { recursive: true, force: true });
  return { bytes, head, index, checkpoint, mergeBase, cut, defaultTip, worktreeTree, indexTree };
};

export const makeMergedMainCheckout = (world: HandoffWorld): string => {
  const checkout = path.join(world.tmp, "merged");
  sh(world.tmp, ["clone", "-q", world.origin, checkout]);
  sh(checkout, ["checkout", "-q", "-b", "fix/merge", world.mainRoot]);
  fs.writeFileSync(path.join(checkout, "merge.ts"), "export const merge = 1;\n");
  sh(checkout, ["add", "-A"]);
  sh(checkout, ["commit", "-q", "-m", "before the merge"]);
  sh(checkout, ["merge", "-q", "--no-edit", "origin/main"]);
  fs.appendFileSync(path.join(checkout, "merge.ts"), "export const after = 2;\n");
  sh(checkout, ["commit", "-q", "-am", "after the merge"]);
  fs.writeFileSync(path.join(checkout, "notes.txt"), "untracked\n");
  return checkout;
};

export const damage = (bytes: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(bytes);
  const headerEnd = Buffer.from(copy).indexOf("\n\n") + 2;
  const at = headerEnd + 12 + 8;
  copy[at] = (copy[at] ?? 0) ^ 0x55;
  return copy;
};

export const storeState = (storePath: string) => ({
  refs: sh(storePath, ["for-each-ref"]),
  objects: sh(storePath, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
    .split("\n")
    .toSorted(),
});
