import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { agentMemoryDigest, type StoredMemoryFile } from "@mend/db";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_MEMORY_DELIVERED,
  AGENT_MEMORY_KEPT_DIR,
  materializeAgentMemory,
  mergeTextUnion,
  planAgentMemory,
  readAgentMemoryFromHome,
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
const deliver = (home: string, files: ReadonlyArray<StoredMemoryFile>) =>
  Effect.runPromise(materializeAgentMemory(home, planAgentMemory(files)));
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
