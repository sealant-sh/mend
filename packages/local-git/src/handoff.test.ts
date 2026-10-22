import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { formatFactLine, HANDOFF_SNAPSHOT_REF, parseHandoffMessage } from "@mend/domain/workbench";
import { Result } from "effect";
import { describe, expect, it } from "vitest";

import {
  committedEnvCheckout,
  countedCheckout,
  danglingOriginHeadCheckout,
  detachedCheckout,
  dirToFileCheckout,
  envFilesCheckout,
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
  otherDefaultCheckout,
  partialClone,
  replacedCheckout,
  SAME_TICKS,
  sameTickCheckout,
  signedCheckout,
  sparseIndexCheckout,
  unmergedCheckout,
  unsetDefaultCheckout,
} from "../test/testing.ts";
import {
  captureCheckout,
  type CaptureRequest,
  type CaptureSummary,
  type CapturedCheckout,
  checkoutOf,
  type EnvFiles,
  type GitRuntime,
  type LeftOut,
  machineName,
  preflightIssue,
} from "./handoff.ts";

const world = handoffWorlds();
const CUT = new Date("2026-10-18T07:42:05.000Z");

const requestFor = (
  w: HandoffWorld,
  checkout: string,
  options: { readonly envFiles?: EnvFiles; readonly runtime?: GitRuntime } = {},
): CaptureRequest => ({
  checkout,
  defaultBranch: "main",
  machine: "dana-mbp",
  maxFileBytes: w.fileBytes,
  envFiles: options.envFiles ?? "exclude",
  cutAt: CUT,
  scratchParent: fs.mkdtempSync(path.join(w.root, "scratch-")),
  runtime: { env: w.hostileEnv, ...options.runtime },
});

type Cut = CaptureSummary & { readonly bundlePath: string; readonly bundleBytes: number };

const capturedOf = (request: CaptureRequest): CapturedCheckout => {
  const outcome = captureCheckout(request);
  if (outcome._tag !== "captured") throw new Error(JSON.stringify(outcome));
  return outcome.capture;
};

const packedOf = (capture: CapturedCheckout): Cut => {
  const packed = capture.pack();
  if (packed._tag !== "packed") throw new Error(JSON.stringify(packed));
  return { ...capture.summary, bundlePath: packed.bundlePath, bundleBytes: packed.bundleBytes };
};

const outcomeOf = (w: HandoffWorld, checkout: string) => {
  const outcome = captureCheckout(requestFor(w, checkout));
  return outcome._tag === "captured" ? outcome.capture.pack() : outcome;
};

const snapshotOf = (
  w: HandoffWorld,
  checkout: string,
  options: { readonly envFiles?: EnvFiles; readonly runtime?: GitRuntime } = {},
): Cut => packedOf(capturedOf(requestFor(w, checkout, options)));

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

const mixedTrees = (w: HandoffWorld) => {
  const head = { ...w.seedFiles, "a.txt": "one\ntwo\n", "c.txt": "three\n" };
  return {
    head,
    index: { ...without(head, "b.txt"), "a.txt": "one\ntwo\nstaged-a\n", "s.txt": "staged\n" },
    worktree: {
      ...without(head, "b.txt", "d.txt"),
      "a.txt": "one\ntwo\nstaged-a\nunstaged-a\n",
      "s.txt": "staged\n",
      "c.txt": "unstaged\n",
      "u.txt": "new\n",
      "reuses-main-blob.txt": "one\n",
      "ita.txt": "ita\n",
    },
  };
};

const storeWithBundle = (w: HandoffWorld, snapshot: Cut): string => {
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

describe("captureCheckout, then pack", () => {
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
    const trees = mixedTrees(w);
    expect(treeFiles(w, store, `${snapshot.head}^{tree}`)).toEqual(trees.head);
    expect(treeFiles(w, store, `${snapshot.index}^{tree}`)).toEqual(trees.index);
    expect(treeFiles(w, store, `${W}^{tree}`)).toEqual(trees.worktree);
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
    expect(snapshot.leftOut).toEqual([{ path: ".env.production", reason: "ignored-env" }]);
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

const byPath = (leftOut: ReadonlyArray<LeftOut>) =>
  leftOut.toSorted((a, b) => a.path.localeCompare(b.path));

describe("a capture", () => {
  it("packs what it captured, whatever the checkout and its index do after", () => {
    const w = world();
    const { checkout: dana } = mixedCheckout(w);
    const capture = capturedOf(requestFor(w, dana));
    w.write(path.join(dana, "a.txt"), "changed after the capture\n");
    w.write(path.join(dana, "later.txt"), "added after the capture\n");
    fs.rmSync(path.join(dana, "c.txt"));
    fs.rmSync(path.join(dana, "u.txt"));
    w.git(dana, ["add", "a.txt", "later.txt"]);
    w.git(dana, ["rm", "-q", "--cached", "s.txt"]);
    const snapshot = packedOf(capture);
    const store = storeWithBundle(w, snapshot);
    expect(w.git(store, ["rev-parse", HANDOFF_SNAPSHOT_REF])).toBe(capture.summary.worktree);
    const trees = mixedTrees(w);
    expect(treeFiles(w, store, `${snapshot.index}^{tree}`)).toEqual(trees.index);
    expect(treeFiles(w, store, `${snapshot.worktree}^{tree}`)).toEqual(trees.worktree);
  });

  it("packs after its checkout is gone, a linked worktree removed", () => {
    const w = world();
    const { main, linked } = linkedWorktree(w);
    const capture = capturedOf(requestFor(w, linked));
    w.git(main, ["worktree", "remove", "--force", linked]);
    const store = storeWithBundle(w, packedOf(capture));
    expect(w.git(store, ["rev-parse", HANDOFF_SNAPSHOT_REF])).toBe(capture.summary.worktree);
    expect(w.git(store, ["show", `${capture.summary.worktree}:fresh.txt`])).toBe("fresh");
    capture.dispose();
  });

  it("takes origin's default branch from origin/HEAD when none is named, or main when that is unset or dangling", () => {
    const cases = [
      { scenario: unsetDefaultCheckout, branch: "main" },
      { scenario: danglingOriginHeadCheckout, branch: "main" },
      {
        scenario: (w: HandoffWorld, origin: string) => {
          const dana = otherDefaultCheckout(w, origin);
          w.git(dana, ["remote", "set-head", "origin", "trunk"]);
          return dana;
        },
        branch: "trunk",
      },
    ];
    for (const { scenario, branch } of cases) {
      const w = world();
      const checkout = scenario(w, w.origin);
      const capture = capturedOf({ ...requestFor(w, checkout), defaultBranch: null });
      expect(capture.summary.defaultBranch).toBe(branch);
      expect(capture.summary.defaultTip).toBe(w.git(checkout, ["rev-parse", `origin/${branch}`]));
      capture.dispose();
    }
  });

  it("carries tracked and untracked .env edits only on include; gitignored ones stay either way", () => {
    const w = world();
    const { checkout, committed } = envFilesCheckout(w);
    const excluded = snapshotOf(w, checkout);
    const included = snapshotOf(w, checkout, { envFiles: "include" });
    expect(byPath(excluded.leftOut)).toEqual([
      { path: ".env", reason: "env" },
      { path: ".env.big", reason: "env" },
      { path: ".env.dat", reason: "env" },
      { path: ".env.local", reason: "env" },
      { path: ".env.secret", reason: "ignored-env" },
    ]);
    expect(byPath(included.leftOut)).toEqual([
      { path: ".env.big", reason: "over-limit", bytes: w.fileBytes + 1 },
      { path: ".env.dat", reason: "filter", filter: "marker" },
      { path: ".env.secret", reason: "ignored-env" },
    ]);
    expect([excluded.envFiles, included.envFiles]).toEqual(["exclude", "include"]);
    expect(excluded.facts).toEqual({ commitsAhead: 1, uncommitted: 0, untracked: 0 });
    expect(included.facts).toEqual({ commitsAhead: 1, uncommitted: 1, untracked: 1 });
    for (const cut of [excluded, included]) {
      expect(cut.committedEnv).toEqual([{ path: ".env", commit: committed }]);
    }
    expect(treeFiles(w, storeWithBundle(w, excluded), `${excluded.worktree}^{tree}`)).toEqual({
      ...w.seedFiles,
      ".env": "committed=1\n",
    });
    expect(treeFiles(w, storeWithBundle(w, included), `${included.worktree}^{tree}`)).toEqual({
      ...w.seedFiles,
      ".env": "committed=2\n",
      ".env.local": "local=1\n",
    });
  });
});

describe("a capture's directory", () => {
  it("is private to this user while held, and gone once disposed", () => {
    const w = world();
    const request = requestFor(w, countedCheckout(w));
    const capture = capturedOf(request);
    const held = fs.readdirSync(request.scratchParent).map((name) => {
      const dir = path.join(request.scratchParent, name);
      return { dir, mode: fs.statSync(dir).mode & 0o777 };
    });
    expect(held).toEqual([{ dir: expect.any(String), mode: 0o700 }]);
    const { bundlePath } = packedOf(capture);
    expect(bundlePath.startsWith(`${held[0]?.dir}${path.sep}`)).toBe(true);
    capture.dispose();
    capture.dispose();
    expect(fs.readdirSync(request.scratchParent)).toEqual([]);
    expect(() => capture.pack()).toThrow();
  });

  it("is gone after a refusal, made before or after it", () => {
    const w = world();
    for (const checkout of [unmergedCheckout(w), noOriginMainCheckout(w)]) {
      const request = requestFor(w, checkout);
      expect(captureCheckout(request)._tag).toBe("refused");
      expect(fs.readdirSync(request.scratchParent)).toEqual([]);
    }
  });
});

const cancelling = (at = Infinity) => {
  const counter = {
    at,
    checks: 0,
    cancelled: () => {
      counter.checks += 1;
      return counter.checks >= counter.at;
    },
  };
  return counter;
};

describe("a cancelled capture", () => {
  it("stops before its first git command, mid-capture or at its last command", () => {
    const w = world();
    const { checkout } = mixedCheckout(w);
    const full = cancelling();
    capturedOf(requestFor(w, checkout, { runtime: { cancelled: full.cancelled } })).dispose();
    for (const at of [1, Math.floor(full.checks / 2), full.checks]) {
      const { cancelled } = cancelling(at);
      const request = requestFor(w, checkout, { runtime: { cancelled } });
      expect(captureCheckout(request), `cancelled at check ${at}`).toEqual({ _tag: "cancelled" });
      expect(fs.readdirSync(request.scratchParent)).toEqual([]);
    }
  });

  it("stops during its pack, and leaves nothing", () => {
    const w = world();
    const counter = cancelling();
    const request = requestFor(w, countedCheckout(w), {
      runtime: { cancelled: counter.cancelled },
    });
    const capture = capturedOf(request);
    counter.at = counter.checks + 2;
    expect(capture.pack()).toEqual({ _tag: "cancelled" });
    expect(fs.readdirSync(request.scratchParent)).toEqual([]);
    capture.dispose();
  });

  it("stops a preflight at its last command, which leaves nothing", () => {
    const w = world();
    const checkout = countedCheckout(w);
    const scratchParent = fs.mkdtempSync(path.join(w.root, "scratch-"));
    const full = cancelling();
    const runtime = (cancelled: () => boolean) => ({ env: w.hostileEnv, cancelled });
    expect(preflightIssue({ checkout, scratchParent, runtime: runtime(full.cancelled) })).toEqual({
      _tag: "clear",
    });
    const last = cancelling(full.checks);
    expect(preflightIssue({ checkout, scratchParent, runtime: runtime(last.cancelled) })).toEqual({
      _tag: "cancelled",
    });
    expect(fs.readdirSync(scratchParent)).toEqual([]);
  });
});

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const gitWrapper = (w: HandoffWorld, name: string, before: string): string => {
  const file = path.join(w.root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${before}\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  return file;
};

describe("the git a capture runs", () => {
  it("is the one it is given, for discovery, preflight, capture and pack", () => {
    const w = world();
    const log = path.join(w.root, "git.log");
    const git = gitWrapper(w, "logging-git", `printf '%s\\n' "$*" >> '${log}'`);
    const noGitOnPath = { ...w.hostileEnv, PATH: path.join(w.root, "no-bin") };
    const checkout = countedCheckout(w);
    expect(checkoutOf(checkout, { git, env: noGitOnPath })).toMatchObject({ _tag: "checkout" });
    const scratchParent = fs.mkdtempSync(path.join(w.root, "scratch-"));
    expect(preflightIssue({ checkout, scratchParent, runtime: { git, env: noGitOnPath } })).toEqual(
      {
        _tag: "clear",
      },
    );
    const snapshot = snapshotOf(w, checkout, { runtime: { git, env: noGitOnPath } });
    expect(snapshot.facts).toEqual({ commitsAhead: 2, uncommitted: 3, untracked: 1 });
    const ran = fs.readFileSync(log, "utf8");
    expect(ran).toContain("rev-parse --show-toplevel");
    expect(ran).toContain("ls-files --unmerged");
    expect(ran).toContain(`bundle create -q ${snapshot.bundlePath}`);
  });

  it("refuses when a git command outlasts its timeout, and leaves nothing", () => {
    const w = world();
    const git = gitWrapper(w, "slow-git", `case " $* " in *" status "*) exec sleep 30;; esac`);
    const request = requestFor(w, countedCheckout(w), { runtime: { git, timeoutMs: 2000 } });
    expect(captureCheckout(request)).toEqual({
      _tag: "refused",
      message: "git status timed out after 2 s · nothing was created",
    });
    expect(fs.readdirSync(request.scratchParent)).toEqual([]);
  });

  it("refuses when it cannot run, and never reads that as no checkout", () => {
    const w = world();
    const git = path.join(w.root, "no-such-git");
    const checkout = countedCheckout(w);
    const refusal = {
      _tag: "refused",
      message: `git rev-parse could not run · spawnSync ${git} ENOENT · nothing was created`,
    };
    const scratchParent = fs.mkdtempSync(path.join(w.root, "scratch-"));
    expect(checkoutOf(checkout, { git })).toEqual(refusal);
    expect(preflightIssue({ checkout, scratchParent, runtime: { git } })).toEqual(refusal);
    expect(captureCheckout(requestFor(w, checkout, { runtime: { git } }))).toEqual(refusal);
    expect(checkoutOf(w.root, { env: w.hostileEnv })).toEqual({
      _tag: "refused",
      message: `${w.root} is not inside a git checkout · run mend handoff in one · nothing was created`,
    });
  });

  it("refuses in git's words when a question it asks fails, never reading that as no", () => {
    const w = world();
    const checkout = countedCheckout(w);
    const failingAt = (name: string, argument: string, words: string) =>
      gitWrapper(w, name, `case " $* " in *" ${argument} "*) echo "${words}" >&2; exit 128;; esac`);
    const doubted = `fatal: detected dubious ownership in repository at '${checkout}'`;
    const doubting = failingAt("doubting-git", "--show-toplevel", doubted);
    const notOwned = {
      _tag: "refused",
      message: `git rev-parse failed · ${doubted} · nothing was created`,
    };
    expect(checkoutOf(checkout, { git: doubting, env: w.hostileEnv })).toEqual(notOwned);
    expect(captureCheckout(requestFor(w, checkout, { runtime: { git: doubting } }))).toEqual(
      notOwned,
    );
    const broken = failingAt("broken-git", "merge-base", "fatal: unable to read tree 1234567");
    const unread = {
      _tag: "refused",
      message: "git merge-base failed · fatal: unable to read tree 1234567 · nothing was created",
    };
    const scratchParent = fs.mkdtempSync(path.join(w.root, "scratch-"));
    const runtime = { git: broken, env: w.hostileEnv };
    expect(preflightIssue({ checkout, scratchParent, runtime })).toEqual(unread);
    expect(captureCheckout(requestFor(w, checkout, { runtime: { git: broken } }))).toEqual(unread);
  });

  it("takes a timeout only as a positive number of milliseconds", () => {
    const w = world();
    const checkout = countedCheckout(w);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => checkoutOf(checkout, { env: w.hostileEnv, timeoutMs })).toThrow(
        `timeoutMs is ${timeoutMs}`,
      );
      expect(() => captureCheckout(requestFor(w, checkout, { runtime: { timeoutMs } }))).toThrow(
        `timeoutMs is ${timeoutMs}`,
      );
    }
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
