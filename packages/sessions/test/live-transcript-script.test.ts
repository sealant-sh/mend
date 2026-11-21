import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HARNESS_STATE, readLiveTranscriptScript } from "../src/harness-state.ts";

// SLNT-1235: a live agent's transcript is read where the agent writes it, as its person sees it:
// by its id, under its home, through the relocation's own link and no other.
let root: string;
let home: string;
let saved: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "mend-live-transcript-"));
  home = path.join(root, "home");
  saved = path.join(root, "saved");
  await fs.mkdir(path.join(saved, ".codex/sessions/2026/11/21"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex"), { recursive: true });
  // As the person layout lays it: the sessions directory is a link onto the saved directory.
  await fs.symlink(path.join(saved, ".codex/sessions"), path.join(home, ".codex/sessions"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const run = (script: string | null) => {
  if (script === null) throw new Error("no script");
  const result = spawnSync("sh", ["-c", script], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home },
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout };
};

const codex = (providerSessionId: string | null) =>
  readLiveTranscriptScript({
    harness: "codex",
    providerSessionId,
    latest: HARNESS_STATE["codex"]?.latestTranscript ?? "true",
    home: null,
    mountPath: saved,
  });

describe("readLiveTranscriptScript", () => {
  it("reads the agent's own rollout by its id, through the relocation's link", async () => {
    const day = path.join(saved, ".codex/sessions/2026/11/21");
    await fs.writeFile(path.join(day, "rollout-2026-11-21T01-53-15-0aaa-11.jsonl"), "mine\n");
    await fs.writeFile(path.join(day, "rollout-2026-11-21T02-00-00-0bbb-22.jsonl"), "newer\n");
    expect(run(codex("0aaa-11"))).toEqual({ code: 0, out: "mine\n" });
  });

  it("exits 3 when the agent has no rollout yet", () => {
    expect(run(codex("0ccc-33")).code).toBe(3);
  });

  it("never reads through any other link", async () => {
    const day = path.join(saved, ".codex/sessions/2026/11/21");
    await fs.writeFile(path.join(root, "secret"), "secret\n");
    await fs.symlink(
      path.join(root, "secret"),
      path.join(day, "rollout-2026-11-21T03-00-00-0ddd-44.jsonl"),
    );
    const read = run(codex("0ddd-44"));
    expect(read.code).not.toBe(0);
    expect(read.out).toBe("");
  });

  it("refuses an id, a home or a path that is not plain", () => {
    expect(codex("x; rm -rf /")).toBeNull();
    expect(
      readLiveTranscriptScript({
        harness: "codex",
        providerSessionId: "0aaa-11",
        latest: "true",
        home: "/root",
        mountPath: saved,
      }),
    ).toBeNull();
  });
});
