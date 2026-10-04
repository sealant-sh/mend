import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { agentMemoryDigest, type StoredMemoryFile } from "@mend/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_MEMORY_DELIVERED,
  AGENT_MEMORY_KEPT_DIR,
  AGENT_MEMORY_OWNER,
  agentMemoryHandoverKeptDir,
  handOverAgentMemoryExec,
  materializeAgentMemory,
  mergeTextUnion,
  planAgentMemory,
  readAgentMemoryFromHome,
  withoutSkipped,
} from "./agent-memory.ts";

const ROOT = ".claude/projects/-workspace-repo/memory";
const homes: Array<string> = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
const makeHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-memory-"));
  homes.push(home);
  return home;
};
const stored = (name: string, contents: string): StoredMemoryFile => {
  const file = { path: `${ROOT}/${name}`, encoding: "utf8" as const, contents };
  return { ...file, digest: agentMemoryDigest(file), updatedBySession: null };
};
const deliver = (home: string, files: ReadonlyArray<StoredMemoryFile>, owner = "user-anna") =>
  Effect.runPromise(materializeAgentMemory(home, planAgentMemory(files), owner));
const inHome = (home: string, name: string) => path.join(home, ROOT, name);

describe("delivering agent memory into a harness home", () => {
  it("writes the stored memory and records what it delivered, leaving nothing staged", async () => {
    const home = makeHome();
    const index = stored("MEMORY.md", "- [notes](notes.md)\n");
    const outcomes = await deliver(home, [index, stored("notes.md", "build with pnpm\n")]);
    expect(outcomes.map((item) => item.outcome)).toEqual(["written", "written"]);
    expect(fs.readFileSync(inHome(home, "MEMORY.md"), "utf8")).toBe(index.contents);
    expect(JSON.parse(fs.readFileSync(path.join(home, AGENT_MEMORY_DELIVERED), "utf8"))).toEqual({
      [index.path]: index.digest,
      [`${ROOT}/notes.md`]: stored("notes.md", "build with pnpm\n").digest,
    });
    expect(fs.existsSync(path.join(home, ".mend", "agent-memory-incoming"))).toBe(false);
  });

  it("replaces a file the session left as delivered, and leaves one the session changed", async () => {
    const home = makeHome();
    await deliver(home, [stored("MEMORY.md", "v1\n"), stored("notes.md", "n1\n")]);
    // The session (not read back yet) changed notes.md; another session saved new versions of both.
    fs.writeFileSync(inHome(home, "notes.md"), "n1\nmine\n");
    const outcomes = await deliver(home, [stored("MEMORY.md", "v2\n"), stored("notes.md", "n2\n")]);
    expect(outcomes).toEqual([
      { outcome: "written", path: `${ROOT}/MEMORY.md` },
      { outcome: "left", path: `${ROOT}/notes.md` },
    ]);
    expect(fs.readFileSync(inHome(home, "MEMORY.md"), "utf8")).toBe("v2\n");
    expect(fs.readFileSync(inHome(home, "notes.md"), "utf8")).toBe("n1\nmine\n");
    // The record keeps notes.md's delivered base, so the read-back sees the session's change.
    expect(
      JSON.parse(fs.readFileSync(path.join(home, AGENT_MEMORY_DELIVERED), "utf8"))[
        `${ROOT}/notes.md`
      ],
    ).toBe(stored("notes.md", "n1\n").digest);
  });

  it("moves aside, never deletes, a delivered file Mend no longer stores", async () => {
    const home = makeHome();
    await deliver(home, [stored("old.md", "gone elsewhere\n")]);
    const outcomes = await deliver(home, []);
    expect(outcomes).toEqual([{ outcome: "kept", path: `${ROOT}/old.md` }]);
    expect(fs.existsSync(inHome(home, "old.md"))).toBe(false);
    const kept = fs.readdirSync(path.join(home, AGENT_MEMORY_KEPT_DIR));
    expect(kept).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(home, AGENT_MEMORY_KEPT_DIR, kept[0] ?? "", ROOT, "old.md"),
        "utf8",
      ),
    ).toBe("gone elsewhere\n");
  });

  it("reads back the memory in a home and what was delivered there, and nothing else", async () => {
    const home = makeHome();
    await deliver(home, [stored("MEMORY.md", "v1\n")]);
    fs.writeFileSync(inHome(home, "learned.md"), "the API runs on 3101\n");
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
    const read = await Effect.runPromise(readAgentMemoryFromHome(home));
    expect(read.files.map((file) => file.path).toSorted()).toEqual([
      `${ROOT}/MEMORY.md`,
      `${ROOT}/learned.md`,
    ]);
    expect(read.delivered).toEqual({ [`${ROOT}/MEMORY.md`]: stored("MEMORY.md", "v1\n").digest });
  });

  it("records whose memory the home holds, with nothing stored too, and the next person's over it", async () => {
    const home = makeHome();
    await deliver(home, [], "user-anna");
    expect(fs.readFileSync(path.join(home, AGENT_MEMORY_OWNER), "utf8")).toBe("user-anna");
    await deliver(home, [stored("MEMORY.md", "v1\n")], "user-maria");
    expect(fs.readFileSync(path.join(home, AGENT_MEMORY_OWNER), "utf8")).toBe("user-maria");
  });
});

describe("merging two sessions' memory", () => {
  it("keeps both sides' lines, with no conflict markers", async () => {
    const merged = await Effect.runPromise(
      mergeTextUnion({
        base: "- one\n",
        ours: "- one\n- two\n",
        theirs: "- one\n- three\n",
      }),
    );
    expect(merged).toBe("- one\n- two\n- three\n");
  });
});

describe("Codex memory in a harness home (docs/adr/0009, Codex)", () => {
  it("reads back Codex's memory folder and its summary database, and nothing else of .codex", async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, ".codex/memories/rollout_summaries"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/memories/MEMORY.md"), "- tests run with pnpm\n");
    fs.writeFileSync(path.join(home, ".codex/memories/rollout_summaries/a.md"), "summary\n");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path.join(home, ".codex/memories_1.sqlite"));
    database.exec("create table stage1_outputs (thread_id text primary key)");
    database.close();
    // A torn database is not stored: the last stored one stays.
    fs.mkdirSync(path.join(home, "torn/.codex"), { recursive: true });
    fs.writeFileSync(path.join(home, "torn/.codex/memories_1.sqlite"), Buffer.from([0, 1, 2, 3]));
    fs.mkdirSync(path.join(home, ".codex/sessions/2026/10/02"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex/sessions/2026/10/02/rollout-x.jsonl"), "{}\n");
    fs.writeFileSync(path.join(home, ".codex/auth.json"), "{}");
    const read = await Effect.runPromise(readAgentMemoryFromHome(home));
    expect(read.files.map((file) => file.path).toSorted()).toEqual([
      ".codex/memories/MEMORY.md",
      ".codex/memories/rollout_summaries/a.md",
      ".codex/memories_1.sqlite",
    ]);
    expect(read.files.find((file) => file.path.endsWith(".sqlite"))?.encoding).toBe("base64");
    const torn = await Effect.runPromise(readAgentMemoryFromHome(path.join(home, "torn")));
    expect(torn.files).toEqual([]);
    expect(torn.skipped).toEqual([".codex/memories_1.sqlite"]);
  });
});

describe("a memory file the read-back could not read", () => {
  it("is not taken as deleted: it leaves the delivered record before the read-back", () => {
    expect(
      withoutSkipped({
        delivered: { a: "1", ".codex/memories_1.sqlite": "2" },
        files: [],
        skipped: [".codex/memories_1.sqlite"],
      }),
    ).toEqual({ a: "1" });
  });
});

describe("handing a harness home over to another person (docs/adr/0009)", () => {
  it("moves every memory path aside, deletes nothing, and records the new owner, with sh alone", async () => {
    const home = makeHome();
    await deliver(home, [stored("MEMORY.md", "anna's index\n")], "user-anna");
    fs.writeFileSync(inHome(home, "feedback.md"), "anna learned this\n");
    fs.mkdirSync(path.join(home, ".codex", "memories"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "memories", "MEMORY.md"), "codex notes\n");
    fs.writeFileSync(path.join(home, ".codex", "memories_1.sqlite"), "db");
    fs.writeFileSync(path.join(home, ".codex", "memories_1.sqlite-wal"), "wal");
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
    const kept = agentMemoryHandoverKeptDir();
    const [, , script, ...args] = handOverAgentMemoryExec(home, kept, "user-maria", false);
    const result = spawnSync("sh", ["-c", script ?? "", ...args], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "" },
    });
    expect(result.status).toBe(0);
    // Nothing of Anna's memory is left where Maria's agent and read-back would find it.
    expect(fs.existsSync(path.join(home, ROOT))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "memories"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex", "memories_1.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(home, AGENT_MEMORY_DELIVERED))).toBe(false);
    expect((await Effect.runPromise(readAgentMemoryFromHome(home))).files).toEqual([]);
    // All of it is kept, byte for byte; what is not memory stays where it was.
    expect(fs.readFileSync(path.join(home, kept, ROOT, "feedback.md"), "utf8")).toBe(
      "anna learned this\n",
    );
    expect(fs.readFileSync(path.join(home, kept, ".codex", "memories_1.sqlite-wal"), "utf8")).toBe(
      "wal",
    );
    expect(fs.readFileSync(path.join(home, kept, AGENT_MEMORY_OWNER), "utf8")).toBe("user-anna");
    expect(fs.existsSync(path.join(home, ".codex", "auth.json"))).toBe(true);
    expect(fs.readFileSync(path.join(home, AGENT_MEMORY_OWNER), "utf8")).toBe("user-maria");
  });
});
