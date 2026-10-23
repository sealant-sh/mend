import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  countedCheckout,
  envFilesCheckout,
  fingerprint,
  handoffWorlds,
  linkedWorktree,
  unbornCheckout,
} from "@mend/local-git/testing";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

import { HandoffDraft } from "./handoff-draft.js";
import { HandoffWorker, sweepHandoffScratch } from "./handoff-worker.js";
import { fakeHandoff } from "./test-handoff.js";

const world = handoffWorlds();
const entry = path.resolve("dist/handoff-worker.js");
beforeAll(async () => {
  const built = await build({
    entryPoints: ["src/handoff-worker-entry.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    metafile: true,
  });
  expect(
    Object.keys(built.metafile.inputs).some(
      (file) => file.includes("vscode/src/extension") || file === "vscode",
    ),
  ).toBe(false);
});
const scratchEntries = async (root: string) =>
  (await fs.readdir(root)).filter((name) => name.startsWith("mend-vscode-handoff-"));
describe("the actual packaged worker", () => {
  it("captures a real checkout without changing its index or files, then packs that same cut", async () => {
    const w = world();
    const checkout = countedCheckout(w);
    const worker = new HandoffWorker({
      entry,
      checkout,
      git: "git",
      scratchParent: w.root,
      env: w.hostileEnv,
    });
    const received = w.clone("receiver");
    const before = fingerprint(checkout);
    try {
      expect(await worker.discover()).toMatchObject({
        kind: "ok",
        value: { top: checkout, originUrl: w.origin },
      });
      const captured = await worker.capture(
        "main",
        w.fileBytes,
        "exclude",
        new AbortController().signal,
      );
      expect(captured).toMatchObject({
        kind: "ok",
        value: { facts: { commitsAhead: 2, uncommitted: 3, untracked: 1 } },
      });
      expect(fingerprint(checkout)).toEqual(before);
      if (!("kind" in captured)) throw new Error("No snapshot");
      await fs.writeFile(path.join(checkout, "notes.txt"), "newer local edit\n");
      const afterEdit = fingerprint(checkout);
      const packed = await worker.pack();
      if (!("kind" in packed)) throw new Error("No bundle");
      const bytes: Buffer[] = [];
      for await (const chunk of packed.value.open()) bytes.push(Buffer.from(chunk));
      const file = path.join(w.root, "received.bundle");
      await fs.writeFile(file, Buffer.concat(bytes));
      w.git(received, ["fetch", file, "refs/mend/handoff/snapshot"]);
      expect(w.git(received, ["rev-parse", "FETCH_HEAD"])).toBe(captured.value.worktree);
      expect(w.git(received, ["show", "FETCH_HEAD:notes.txt"])).toBe("untracked");
      expect(w.git(received, ["show", "FETCH_HEAD^:a.txt"])).toBe("staged only");
      expect(fingerprint(checkout)).toEqual(afterEdit);
    } finally {
      await worker.dispose();
    }
    expect(await scratchEntries(w.root)).toEqual([]);
  });
  it("recaptures env choices while ignored files stay excluded, with no abandoned scratch", async () => {
    const w = world();
    const { checkout } = envFilesCheckout(w);
    const worker = new HandoffWorker({
      entry,
      checkout,
      git: "git",
      scratchParent: w.root,
      env: w.hostileEnv,
    });
    const f = fakeHandoff();
    const draft = new HandoffDraft({ ...f.accepted, worker });
    const before = fingerprint(checkout);
    try {
      expect(await draft.withEnv("exclude")).toMatchObject({
        kind: "ok",
        value: { envFiles: "exclude" },
      });
      const include = await draft.withEnv("include");
      expect(include).toMatchObject({ kind: "ok", value: { envFiles: "include" } });
      if (!("kind" in include)) throw new Error("No snapshot");
      expect(include.value.leftOut.some((file) => file.path === ".env.local")).toBe(false);
      expect(include.value.leftOut).toContainEqual({ path: ".env.secret", reason: "ignored-env" });
    } finally {
      await draft.discard();
    }
    expect(fingerprint(checkout)).toEqual(before);
    expect(await scratchEntries(w.root)).toEqual([]);
  });
  it("refuses a temporary parent inside the checkout before creating anything there", async () => {
    const w = world();
    const checkout = countedCheckout(w);
    const before = fingerprint(checkout);
    const worker = new HandoffWorker({
      entry,
      checkout,
      git: "git",
      scratchParent: checkout,
      env: w.hostileEnv,
    });
    try {
      expect(
        await worker.capture("main", w.fileBytes, "exclude", new AbortController().signal),
      ).toMatchObject({
        _tag: "refused",
        why: { reason: "scratch-inside-checkout", parent: checkout },
      });
    } finally {
      await worker.dispose();
    }
    expect(fingerprint(checkout)).toEqual(before);
  });
  it("cancel during capture leaves no scratch and never changes linked Git directories", async () => {
    const w = world();
    const { main, linked } = linkedWorktree(w);
    const before = [fingerprint(main), fingerprint(linked)];
    const worker = new HandoffWorker({
      entry,
      checkout: linked,
      git: "git",
      scratchParent: w.root,
      env: w.hostileEnv,
    });
    const controller = new AbortController();
    const capturing = worker.capture("main", w.fileBytes, "exclude", controller.signal);
    controller.abort();
    await capturing;
    await worker.dispose();
    expect([fingerprint(main), fingerprint(linked)]).toEqual(before);
    expect(await scratchEntries(w.root)).toEqual([]);
  });
  it("disposal waits for a bounded Git child, then removes the capture directory", async () => {
    const w = world();
    const checkout = countedCheckout(w);
    const wrapper = path.join(w.root, "slow-git");
    const marker = path.join(w.root, "git-child");
    await fs.writeFile(
      wrapper,
      '#!/bin/sh\ncase " $* " in *" status "*) echo "$$" > "$MEND_TEST_STARTED"; exec sleep 30;; esac\nexec git "$@"\n',
      { mode: 0o700 },
    );
    const before = fingerprint(checkout);
    const worker = new HandoffWorker({
      entry,
      checkout,
      git: wrapper,
      scratchParent: w.root,
      timeoutMs: 1000,
      env: { ...w.hostileEnv, MEND_TEST_STARTED: marker },
    });
    const controller = new AbortController();
    try {
      const capturing = worker.capture("main", w.fileBytes, "exclude", controller.signal);
      const deadline = Date.now() + 5000;
      while (
        !(await fs.access(marker).then(
          () => true,
          () => false,
        )) &&
        Date.now() < deadline
      )
        await wait(10);
      const pid = Number(await fs.readFile(marker, "utf8"));
      expect(await scratchEntries(w.root)).toHaveLength(1);
      controller.abort();
      await worker.dispose();
      await capturing;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await scratchEntries(w.root)).toEqual([]);
      expect(fingerprint(checkout)).toEqual(before);
    } finally {
      await worker.dispose();
    }
  });
  it("refuses unborn repositories with a typed reason", async () => {
    const w = world();
    const checkout = unbornCheckout(w, w.origin);
    const worker = new HandoffWorker({
      entry,
      checkout,
      git: "git",
      scratchParent: w.root,
      env: w.hostileEnv,
    });
    try {
      expect(
        await worker.capture(null, w.fileBytes, "exclude", new AbortController().signal),
      ).toMatchObject({ _tag: "refused", why: { reason: "no-commit" } });
    } finally {
      await worker.dispose();
    }
    expect(await scratchEntries(w.root)).toEqual([]);
  });
  it("a missing packaged worker is an actionable result and disposal settles", async () => {
    const worker = new HandoffWorker({
      entry: path.resolve("dist/missing-worker.js"),
      checkout: "/tmp",
      git: "git",
    });
    expect(await worker.discover()).toMatchObject({
      _tag: "refused",
      why: { reason: "git", words: "The handoff worker stopped. Try again." },
    });
    await worker.dispose();
  });
  it("the orphan sweep preserves another live window's scratch", async () => {
    const directory = await fs.mkdtemp("/tmp/mend-sweep-test-");
    const live = `mend-vscode-handoff-${process.pid}-00000000-0000-0000-0000-000000000000`;
    const unrelated = "mend-handoff-unrelated";
    await fs.mkdir(path.join(directory, live));
    await fs.mkdir(path.join(directory, unrelated));
    await sweepHandoffScratch(directory);
    expect((await fs.readdir(directory)).toSorted()).toEqual([unrelated, live].toSorted());
    await fs.rm(directory, { recursive: true });
  });
});
