import * as fs from "node:fs";
import * as path from "node:path";

import { formatFactLine, HANDOFF_SNAPSHOT_REF, parseHandoffMessage } from "@mend/domain/workbench";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  committedEnvCheckout,
  countedCheckout,
  detachedCheckout,
  dirToFileCheckout,
  evilMergeCheckout,
  fingerprint,
  type HandoffWorld,
  handoffWorlds,
  hiddenEditsCheckout,
  ignoredEnvCheckout,
  linkedWorktree,
  mergedMainCheckout,
  mixedCheckout,
  noOriginMainCheckout,
  nonUtf8Checkout,
  partialClone,
  replacedCheckout,
  SAME_TICKS,
  sameTickCheckout,
  signedCheckout,
  sparseIndexCheckout,
  unmergedCheckout,
} from "../test/testing.ts";
import {
  type HandoffSnapshot,
  machineName,
  snapshotCheckout,
  type SnapshotOutcome,
} from "./handoff.ts";

const world = handoffWorlds();
const CUT = new Date("2026-10-18T07:42:05.000Z");

const outcomeOf = (w: HandoffWorld, checkout: string): SnapshotOutcome =>
  snapshotCheckout({
    checkout,
    defaultBranch: "main",
    machine: "dana-mbp",
    maxFileBytes: w.fileBytes,
    scratch: fs.mkdtempSync(path.join(w.root, "scratch-")),
    cutAt: CUT,
    env: w.hostileEnv,
  });

const snapshotOf = (w: HandoffWorld, checkout: string): HandoffSnapshot => {
  const outcome = outcomeOf(w, checkout);
  if (outcome._tag === "refused") throw new Error(outcome.message);
  return outcome.snapshot;
};

const splitNul = (bytes: Buffer): ReadonlyArray<Buffer> => {
  const fields: Array<Buffer> = [];
  for (let at = 0; at < bytes.length; ) {
    const end = bytes.indexOf(0, at);
    fields.push(bytes.subarray(at, end === -1 ? bytes.length : end));
    at = end === -1 ? bytes.length : end + 1;
  }
  return fields;
};

const entriesOf = (w: HandoffWorld, repo: string, commit: string): ReadonlyArray<Buffer> =>
  splitNul(w.gitBytes(repo, ["ls-tree", "-r", "-z", "--full-tree", commit]));

const blobAt = (w: HandoffWorld, repo: string, commit: string, name: Buffer): string => {
  const entry = entriesOf(w, repo, commit).find((line) =>
    line.subarray(line.indexOf(0x09) + 1).equals(name),
  );
  if (entry === undefined) throw new Error(`no ${name.toString("hex")} in ${commit}`);
  const sha = entry.subarray(0, entry.indexOf(0x09)).toString().split(" ")[2] ?? "";
  return w.git(repo, ["cat-file", "blob", sha]);
};

const prerequisitesOf = (bundle: string): ReadonlyArray<string> => {
  const bytes = fs.readFileSync(bundle);
  return bytes
    .subarray(0, bytes.indexOf("\n\n"))
    .toString()
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1).split(" ")[0] ?? "")
    .toSorted();
};

const treeFiles = (w: HandoffWorld, repo: string, tree: string): Record<string, string> =>
  Object.fromEntries(
    w
      .git(repo, ["ls-tree", "-r", "--name-only", "-z", tree])
      .split("\0")
      .filter((file) => file !== "")
      .map((file) => [file, w.git(repo, ["cat-file", "blob", `${tree}:${file}`]) + "\n"]),
  );

const without = (
  files: Readonly<Record<string, string>>,
  ...gone: ReadonlyArray<string>
): Record<string, string> =>
  Object.fromEntries(Object.entries(files).filter(([file]) => !gone.includes(file)));

const storeWithBundle = (w: HandoffWorld, snapshot: HandoffSnapshot): string => {
  const store = path.join(w.root, `store-${snapshot.worktree.slice(0, 7)}`);
  w.git(w.root, ["clone", "-q", "--bare", w.origin, store]);
  w.git(store, ["bundle", "verify", "-q", snapshot.bundlePath]);
  w.git(store, [
    "fetch",
    "-q",
    "--no-write-fetch-head",
    snapshot.bundlePath,
    `${HANDOFF_SNAPSHOT_REF}:${HANDOFF_SNAPSHOT_REF}`,
  ]);
  return store;
};

describe("snapshotCheckout", () => {
  it("leaves the checkout byte-identical under a hostile environment, a split index, signing and a clean filter", () => {
    const w = world();
    const { checkout: dana, marker } = mixedCheckout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(fs.existsSync(marker)).toBe(false);
    for (const nowhere of ["nowhere", "nowhere-index", "nowhere-objects", "nowhere-hooks"]) {
      expect(fs.existsSync(path.join(w.root, nowhere))).toBe(false);
    }
    expect(snapshot.localBranch).toBe("fix/login");
  });

  it("names what stays behind and why", () => {
    const w = world();
    const { checkout: dana } = mixedCheckout(w);
    const snapshot = snapshotOf(w, dana);
    expect(snapshot.leftOut.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: ".env.defaults", reason: "env" },
      { path: ".env.example", reason: "env" },
      { path: ".env.local", reason: "env" },
      { path: "assets/two.dat", reason: "filter", filter: "marker" },
      { path: "big.bin", reason: "over-limit", bytes: w.fileBytes + 1 },
      { path: "config/.env.shared", reason: "env" },
      { path: "huge-staged.bin", reason: "over-limit", bytes: w.fileBytes + 1 },
    ]);
    expect(snapshot.facts).toEqual({ commitsAhead: 2, uncommitted: 6, untracked: 2 });
  });

  it("cuts a bundle a store verifies, whose index and working trees are the checkout's, left-out files at HEAD", () => {
    const w = world();
    const { checkout: dana } = mixedCheckout(w);
    const snapshot = snapshotOf(w, dana);
    const store = storeWithBundle(w, snapshot);
    const W = snapshot.worktree;
    expect(w.git(store, ["rev-parse", `${W}^@`])).toBe(snapshot.index);
    expect(w.git(store, ["rev-parse", `${snapshot.index}^@`])).toBe(snapshot.head);
    expect(w.git(store, ["rev-parse", "main"])).toBe(snapshot.mergeBase);
    const head = {
      ...w.seedFiles,
      "a.txt": "one\ntwo\n",
      "c.txt": "three\n",
    };
    expect(treeFiles(w, store, `${snapshot.head}^{tree}`)).toEqual(head);
    expect(treeFiles(w, store, `${snapshot.index}^{tree}`)).toEqual({
      ...without(head, "b.txt"),
      "a.txt": "one\ntwo\nstaged-a\n",
      "s.txt": "staged\n",
    });
    expect(treeFiles(w, store, `${W}^{tree}`)).toEqual({
      ...without(head, "b.txt", "d.txt"),
      "a.txt": "one\ntwo\nstaged-a\nunstaged-a\n",
      "s.txt": "staged\n",
      "c.txt": "unstaged\n",
      "u.txt": "new\n",
      "reuses-main-blob.txt": "one\n",
      "ita.txt": "ita\n",
    });
  });

  it("keeps staged and unstaged apart in a checkout made from the bundle", () => {
    const w = world();
    const { checkout: dana } = mixedCheckout(w);
    const snapshot = snapshotOf(w, dana);
    storeWithBundle(w, snapshot);
    const session = w.clone("session");
    w.git(session, ["fetch", "-q", snapshot.bundlePath, HANDOFF_SNAPSHOT_REF]);
    w.git(session, ["checkout", "-q", "--detach", snapshot.head]);
    w.git(session, ["read-tree", "-u", "--reset", `${snapshot.worktree}^{tree}`]);
    w.git(session, ["read-tree", `${snapshot.index}^{tree}`]);
    const status = w
      .git(session, ["status", "--porcelain=v1", "-uall", "-z"])
      .split("\0")
      .filter((line) => line !== "")
      .toSorted();
    expect(status).toEqual(
      [
        "MM a.txt",
        "D  b.txt",
        " M c.txt",
        "?? reuses-main-blob.txt",
        " D d.txt",
        "?? ita.txt",
        "A  s.txt",
        "?? u.txt",
      ].toSorted(),
    );
  });

  it("writes W's trailers: machine, branch, cut time, the default tip and the merge base", () => {
    const w = world();
    const { checkout: dana } = mixedCheckout(w);
    const snapshot = snapshotOf(w, dana);
    const store = storeWithBundle(w, snapshot);
    const body = w.git(store, ["log", "-1", "--format=%B", snapshot.worktree]);
    const author = w.git(store, [
      "log",
      "-1",
      "--format=%an <%ae> %at · %cn %ct",
      snapshot.worktree,
    ]);
    expect(parseHandoffMessage(`${body}\n`)).toEqual(
      Result.succeed({
        machine: "dana-mbp",
        localBranch: "fix/login",
        cutAt: CUT.toISOString(),
        defaultTip: snapshot.defaultTip,
        mergeBase: snapshot.mergeBase,
      }),
    );
    const seconds = CUT.getTime() / 1000;
    expect(author).toBe(`mend <mend@mend.invalid> ${seconds} · mend ${seconds}`);
    expect(snapshot.cutAt).toBe(CUT.toISOString());
    expect(snapshot.bundleBytes).toBe(fs.statSync(snapshot.bundlePath).size);
  });

  it("counts the fact line: commits ahead, uncommitted files once each, untracked not ignored", () => {
    const w = world();
    const snapshot = snapshotOf(w, countedCheckout(w));
    expect(snapshot.facts).toEqual({ commitsAhead: 2, uncommitted: 3, untracked: 1 });
    expect(formatFactLine({ ...snapshot.facts, defaultBranch: "main" })).toBe(
      "2 commits ahead of main · 3 uncommitted files · 1 untracked",
    );
  });

  it("names every .env file a commit ahead added or changed, intermediate commits included", () => {
    const w = world();
    const { checkout: dana, added, staging } = committedEnvCheckout(w);
    const snapshot = snapshotOf(w, dana);
    expect(snapshot.committedEnv).toEqual([
      { path: "deploy/.env.staging", commit: staging },
      { path: ".env.prod", commit: added },
    ]);
    expect(snapshot.leftOut).toEqual([]);
  });

  it("hands off a detached HEAD, even with main", () => {
    const w = world();
    const dana = detachedCheckout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.localBranch).toBeNull();
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 1, untracked: 0 });
    const store = storeWithBundle(w, snapshot);
    const body = w.git(store, ["log", "-1", "--format=%B", snapshot.worktree]);
    expect(body).not.toContain("Mend-Branch");
    expect(w.git(store, ["show", `${snapshot.worktree}:a.txt`])).toBe("edited");
  });

  it("hands off a linked worktree and leaves it and its main checkout byte-identical", () => {
    const w = world();
    const { main, linked } = linkedWorktree(w);
    const before = [fingerprint(main), fingerprint(linked)];
    const snapshot = snapshotOf(w, linked);
    expect([fingerprint(main), fingerprint(linked)]).toEqual(before);
    expect(snapshot.localBranch).toBe("feature");
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 1, untracked: 1 });
    const store = storeWithBundle(w, snapshot);
    expect(w.git(store, ["show", `${snapshot.index}:a.txt`])).toBe("in the linked worktree");
    expect(w.git(store, ["show", `${snapshot.worktree}:fresh.txt`])).toBe("fresh");
  });

  it("refuses without origin's default branch, and names the fetch to run", () => {
    const w = world();
    const dana = noOriginMainCheckout(w);
    const before = fingerprint(dana);
    expect(outcomeOf(w, dana)).toEqual({
      _tag: "refused",
      message:
        "this checkout has no origin/main · run git fetch origin, then hand off again · nothing was created",
    });
    expect(fingerprint(dana)).toEqual(before);
  });

  it("refuses unmerged paths", () => {
    const w = world();
    expect(outcomeOf(w, unmergedCheckout(w))).toEqual({
      _tag: "refused",
      message: "1 unmerged path · finish or abort the merge, then hand off · nothing was created",
    });
  });

  it("carries tracked and untracked paths that are not UTF-8 byte for byte, and counts them", () => {
    const w = world();
    const { checkout: dana, tracked, untracked } = nonUtf8Checkout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.facts).toEqual({ commitsAhead: 1, uncommitted: 1, untracked: 1 });
    const store = storeWithBundle(w, snapshot);
    expect(blobAt(w, store, snapshot.head, tracked)).toBe("v1");
    expect(blobAt(w, store, snapshot.index, tracked)).toBe("v1");
    expect(blobAt(w, store, snapshot.worktree, tracked)).toBe("v2");
    expect(blobAt(w, store, snapshot.worktree, untracked)).toBe("new");
    expect(entriesOf(w, store, snapshot.worktree)).toHaveLength(
      Object.keys(w.seedFiles).length + 2,
    );
  });

  it.each(SAME_TICKS)(
    "carries a same-size edit made in the tick its commit wrote the index (%s)",
    (_, tick) => {
      const w = world();
      const dana = sameTickCheckout(w, tick);
      const snapshot = snapshotOf(w, dana);
      expect(w.git(dana, ["--no-optional-locks", "status", "--porcelain"])).toBe("M a.txt");
      expect(snapshot.facts.uncommitted).toBe(1);
      const store = storeWithBundle(w, snapshot);
      expect(blobAt(w, store, snapshot.worktree, Buffer.from("a.txt"))).toBe("v2");
    },
  );

  it("carries a directory replaced by a file, its old files gone", () => {
    const w = world();
    const snapshot = snapshotOf(w, dirToFileCheckout(w));
    const store = storeWithBundle(w, snapshot);
    expect(w.git(store, ["show", `${snapshot.worktree}:docs`])).toBe("a file now");
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 1, untracked: 1 });
  });

  it("carries edits under assume-unchanged and skip-worktree, and names them", () => {
    const w = world();
    const dana = hiddenEditsCheckout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.hidden).toEqual([
      { path: "a.txt", bit: "assume-unchanged" },
      { path: "b.txt", bit: "skip-worktree" },
      { path: "d.txt", bit: "assume-unchanged and skip-worktree" },
    ]);
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 3, untracked: 0 });
    const store = storeWithBundle(w, snapshot);
    expect(w.git(store, ["show", `${snapshot.worktree}:a.txt`])).toBe("assumed unchanged, edited");
    expect(w.git(store, ["show", `${snapshot.worktree}:b.txt`])).toBe("skipped, edited");
    expect(w.git(store, ["show", `${snapshot.index}:a.txt`])).toBe("one");
  });

  it("never fetches into a treeless partial clone; a missing object refuses in words", () => {
    const w = world();
    const dana = partialClone(w);
    const before = fingerprint(dana);
    const outcome = outcomeOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(outcome).toEqual({
      _tag: "refused",
      message: expect.stringMatching(
        /^this partial clone lacks objects a handoff reads, and mend handoff never fetches · git log -p [0-9a-f]{7}\.\.HEAD fetches them, then hand off again · git said: .+ · nothing was created$/u,
      ),
    });
    const mergeBase = w.git(dana, ["merge-base", "HEAD", "origin/main"]);
    w.git(dana, ["log", "-p", `${mergeBase}..HEAD`]);
    expect(snapshotOf(w, dana).facts).toEqual({ commitsAhead: 2, uncommitted: 1, untracked: 0 });
  });

  it("reads the commits ahead as they are, not as a replace ref says", () => {
    const w = world();
    const { checkout: dana, real } = replacedCheckout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.committedEnv).toEqual([{ path: ".env.prod", commit: real }]);
  });

  it("never runs the checkout's signature verifier on a signed commit ahead", () => {
    const w = world();
    const { checkout: dana, signed, marker } = signedCheckout(w);
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.committedEnv).toEqual([{ path: ".env.prod", commit: signed.slice(0, 7) }]);
  });

  it("leaves a cone sparse checkout with a sparse index byte-identical, and carries what it does not check out", () => {
    const w = world();
    const dana = sparseIndexCheckout(w);
    expect(w.git(dana, ["ls-files", "--sparse"])).toContain("assets/");
    const before = fingerprint(dana);
    const snapshot = snapshotOf(w, dana);
    expect(fingerprint(dana)).toEqual(before);
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 1, untracked: 1 });
    const store = storeWithBundle(w, snapshot);
    expect(treeFiles(w, store, `${snapshot.worktree}^{tree}`)).toEqual({
      ...w.seedFiles,
      "docs/guide.md": "guide, edited\n",
      "docs/new.md": "new\n",
    });
  });

  it("names a .env file a merge commit brought in", () => {
    const w = world();
    const { checkout: dana, merge } = evilMergeCheckout(w);
    expect(snapshotOf(w, dana).committedEnv).toEqual([{ path: ".env.prod", commit: merge }]);
  });

  it("names the gitignored .env files that stay behind", () => {
    const w = world();
    const snapshot = snapshotOf(w, ignoredEnvCheckout(w));
    expect(snapshot.leftOut).toEqual([{ path: ".env.production", reason: "env" }]);
    expect(snapshot.facts).toEqual({ commitsAhead: 0, uncommitted: 0, untracked: 0 });
  });

  it("cuts a branch that merged main: two prerequisites, M in the trailers", () => {
    const w = world();
    const { checkout: dana, forkPoint, mainTip } = mergedMainCheckout(w);
    const snapshot = snapshotOf(w, dana);
    expect(snapshot.mergeBase).toBe(mainTip);
    expect(prerequisitesOf(snapshot.bundlePath)).toEqual([forkPoint, mainTip].toSorted());
    const store = storeWithBundle(w, snapshot);
    const body = w.git(store, ["log", "-1", "--format=%B", snapshot.worktree]);
    expect(parseHandoffMessage(`${body}\n`)).toEqual(
      Result.succeed({
        machine: "dana-mbp",
        localBranch: "fix/catch-up",
        cutAt: CUT.toISOString(),
        defaultTip: mainTip,
        mergeBase: mainTip,
      }),
    );
    expect(w.git(store, ["show", `${snapshot.worktree}:fix.txt`])).toBe("fix, after the merge");
    expect(snapshot.facts).toEqual({ commitsAhead: 3, uncommitted: 0, untracked: 0 });
  });
});

describe("machineName", () => {
  it("is the hostname without .local, control characters or surrounding space", () => {
    expect(machineName("dana-mbp.local")).toBe("dana-mbp");
    expect(machineName("Dana-MBP.LOCAL")).toBe("Dana-MBP");
    expect(machineName(" build\u0007box\n")).toBe("buildbox");
    expect(machineName("box.example.com")).toBe("box.example.com");
  });

  it("keeps the first 64 characters, never splitting one", () => {
    expect(machineName("é".repeat(70))).toBe("é".repeat(64));
    expect(machineName(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });

  it("says this machine when nothing is left", () => {
    expect(machineName("")).toBe("this machine");
    expect(machineName(".local")).toBe("this machine");
    expect(machineName("\u0000")).toBe("this machine");
  });
});
