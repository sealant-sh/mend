import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgClient } from "@effect/sql-pg";
import type { ProjectId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  AgentMemoryRepo,
  AgentMemoryRepoLive,
  agentMemoryDigest,
  type MergeText,
  isSoleCopy,
  mergeAgentMemoryText,
  planAgentMemoryImport,
  planAgentMemoryReadBack,
  type StoredMemoryFile,
} from "../src/repos/agent-memory.ts";

const ROOT = ".claude/projects/-workspace-repo/memory";
const text = (name: string, contents: string) => ({
  path: `${ROOT}/${name}`,
  encoding: "utf8" as const,
  contents,
});
const withDigest = (file: ReturnType<typeof text>) => ({
  ...file,
  digest: agentMemoryDigest(file),
});
const stored = (
  file: ReturnType<typeof text>,
  updatedBySession: string | null = null,
): StoredMemoryFile => ({ ...withDigest(file), updatedBySession });

describe("reading a session's memory back", () => {
  const v1 = text("MEMORY.md", "- one\n");
  const v2 = text("MEMORY.md", "- one\n- two\n");
  const other = text("MEMORY.md", "- one\n- three\n");
  const delivered = { [v1.path]: agentMemoryDigest(v1) };

  it("saves nothing the session left as delivered", () => {
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [withDigest(v1)],
        stored: new Map([[v1.path, stored(other, "s-other")]]),
        sessionId: "s1",
      }),
    ).toEqual([]);
  });

  it("saves a change when the store still holds what was delivered, or its own earlier save", () => {
    for (const current of [stored(v1), stored(other, "s1")]) {
      expect(
        planAgentMemoryReadBack({
          delivered,
          session: [withDigest(v2)],
          stored: new Map([[v1.path, current]]),
          sessionId: "s1",
        }),
      ).toEqual([{ kind: "save", file: v2, replacing: current }]);
    }
  });

  it("merges text both changed since delivery, against the delivered version", () => {
    const current = stored(other, "s-other");
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [withDigest(v2)],
        stored: new Map([[v1.path, current]]),
        sessionId: "s1",
      }),
    ).toEqual([{ kind: "merge", file: v2, stored: current, base: agentMemoryDigest(v1) }]);
  });

  it("deletes a delivered file the session deleted, unless the store changed it meanwhile", () => {
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [],
        stored: new Map([[v1.path, stored(v1)]]),
        sessionId: "s1",
      }),
    ).toEqual([{ kind: "delete", stored: stored(v1) }]);
    expect(
      planAgentMemoryReadBack({
        delivered,
        session: [],
        stored: new Map([[v1.path, stored(other, "s-other")]]),
        sessionId: "s1",
      }),
    ).toEqual([]);
  });
});

/** What the last import from this machine sent: `file`. */
const baseOf = (file: ReturnType<typeof text>) =>
  new Map([
    [file.path, { path: file.path, digest: agentMemoryDigest(file), contents: file.contents }],
  ]);

const binary = (path: string, bytes: string) => {
  const file = {
    path,
    encoding: "base64" as const,
    contents: Buffer.from(bytes).toString("base64"),
  };
  return { ...file, digest: agentMemoryDigest(file) };
};

/** A Claude topic note with frontmatter. */
const note = (description: string, body: string) =>
  `---\nname: Build\ndescription: ${description}\ntype: project\n---\n${body}`;

/** A MEMORY.md with frontmatter and two fenced blocks around one entry. */
const fencedIndex = (entry: string) =>
  [
    "---",
    "name: index",
    "---",
    "# Memory",
    "```sh",
    "pnpm test",
    "```",
    entry,
    "```sh",
    "pnpm lint",
    "```",
    "",
  ].join("\n");

/** A note whose description is a block scalar. */
const blockNote = (extra: string) =>
  `---\nname: Build\ndescription: |\n  pnpm${extra}\n---\nbody\n`;

/** A note with CRLF line endings. */
const crlfNote = (description: string) =>
  `---\r\nname: Build\r\ndescription: ${description}\r\n---\r\nbody\r\n`;

/** 2,001 distinct lines: two of these are past the alignment limit. */
const distinctLines = (side: string, pad: number) =>
  `${Array.from({ length: 2001 }, (_, i) => `${side} ${"x".repeat(pad)} ${i}`).join("\n")}\n`;

/** How often each line of `contents` occurs. */
const lineCounts = (contents: string) => {
  const out = new Map<string, number>();
  for (const line of contents.replace(/\n$/, "").split("\n")) {
    out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
};

/** A merge that keeps only Mend's side: stands in for any merge that loses a line. */
const keepsOurs: MergeText = ({ ours }) => Effect.succeed(ours);

describe("importing memory from a machine", () => {
  const mend = text("MEMORY.md", "- [a](a.md)\n- [mend](mend.md)\n");
  const laptop = text("MEMORY.md", "- [a](a.md)\n- [laptop](laptop.md)\n");
  const before = text("MEMORY.md", "- [a](a.md)\n");
  const plan = (
    files: ReadonlyArray<ReturnType<typeof text>>,
    storedFiles: ReadonlyArray<StoredMemoryFile>,
    bases: ReturnType<typeof baseOf> = new Map(),
  ) =>
    planAgentMemoryImport({
      files: files.map(withDigest),
      stored: new Map(storedFiles.map((file) => [file.path, file])),
      bases,
    }).map((step) => step.kind);

  it("leaves a file the same on both sides", () => {
    expect(plan([mend], [stored(mend)])).toEqual(["unchanged"]);
  });

  it("adds a file only this machine has, and leaves one only Mend has", () => {
    const only = text("notes.md", "pnpm\n");
    expect(plan([only], [stored(mend)])).toEqual(["add"]);
    expect(plan([], [stored(mend)])).toEqual([]);
  });

  it("merges a file both changed with no earlier import, with no shared version", () => {
    const steps = planAgentMemoryImport({
      files: [withDigest(laptop)],
      stored: new Map([[mend.path, stored(mend, "s1")]]),
      bases: new Map(),
    });
    expect(steps).toEqual([
      { kind: "merge", file: withDigest(laptop), stored: stored(mend, "s1"), base: null },
    ]);
  });

  it("merges a file both changed since the last import against it", () => {
    const steps = planAgentMemoryImport({
      files: [withDigest(laptop)],
      stored: new Map([[mend.path, stored(mend)]]),
      bases: baseOf(before),
    });
    expect(steps).toEqual([
      { kind: "merge", file: withDigest(laptop), stored: stored(mend), base: before.contents },
    ]);
  });

  it("takes whichever side alone changed since the last import", () => {
    expect(plan([laptop], [stored(before)], baseOf(before))).toEqual(["update"]);
    expect(plan([laptop], [stored(mend)], baseOf(laptop))).toEqual(["keepStored"]);
  });

  it("does not add again what Mend removed since, unless this machine changed it", () => {
    expect(plan([laptop], [], baseOf(laptop))).toEqual(["removedInMend"]);
    expect(plan([laptop], [], baseOf(before))).toEqual(["add"]);
  });

  it("merges Codex's summary database by conversation, and nothing else that is not text", () => {
    const kinds = planAgentMemoryImport({
      files: [binary(".codex/memories_1.sqlite", "laptop"), binary(`${ROOT}/a.png`, "laptop")],
      stored: new Map(
        [binary(".codex/memories_1.sqlite", "mend"), binary(`${ROOT}/a.png`, "mend")].map((f) => [
          f.path,
          { ...f, updatedBySession: null },
        ]),
      ),
      bases: new Map(),
    }).map((step) => step.kind);
    expect(kinds).toEqual(["mergeDatabase", "conflict"]);
  });

  const outcome = (input: {
    ours: string;
    theirs: string;
    base: string | null;
    path?: string;
    with?: MergeText;
  }) =>
    Effect.runPromise(
      mergeAgentMemoryText({
        path: input.path ?? `${ROOT}/build.md`,
        ours: input.ours,
        theirs: input.theirs,
        base: input.base,
        note: "from laptop, 2026-10-04",
        merge: input.with ?? gitUnion,
      }),
    );
  /** The merged contents, for a merge that kept every line of `theirs`. */
  const merge = async (input: {
    ours: string;
    theirs: string;
    base: string | null;
    path?: string;
  }) => {
    const result = await outcome(input);
    if (result.kind !== "merged") throw new Error("merges");
    expect(result.lostTheirs).toEqual([]);
    expect(result.lostOurs).toEqual([]);
    return result.contents;
  };

  it("merges a note's frontmatter key by key and its body by line, with no shared version", async () => {
    expect(
      await merge({
        ours: note("pnpm, not npm", "- pnpm install\n- mend: pnpm test\n"),
        theirs: note("pnpm 11, not npm", "- pnpm install\n- laptop: pnpm lint\n"),
        base: null,
      }),
    ).toBe(
      [
        "---",
        "name: Build",
        "description: pnpm, not npm",
        "# from laptop, 2026-10-04: description: pnpm 11, not npm",
        "type: project",
        "---",
        "- pnpm install",
        "- mend: pnpm test",
        "- laptop: pnpm lint",
        "",
      ].join("\n"),
    );
  });

  it("merges a note against the last import: one side's frontmatter change wins, bodies three-way", async () => {
    const base = note("old", "- one\n- two\n- three\n");
    expect(
      await merge({
        ours: note("old", "- one\n- two\n- three\n- mend\n"),
        theirs: note("new", "- zero\n- one\n- two\n- three\n"),
        base,
      }),
    ).toBe(note("new", "- zero\n- one\n- two\n- three\n- mend\n"));
  });

  // Review round 3: no line is removed after the merge. A line both sides wrote at different
  // places stays twice; the agent folds it when it next rewrites its memory.
  it("keeps a line both sides wrote at different places twice in a merged index", async () => {
    expect(
      await merge({
        path: `${ROOT}/MEMORY.md`,
        ours: "- [a](a.md)\n- [b](b.md)\n",
        theirs: "- [b](b.md)\n- [a](a.md)\n- [c](c.md)\n",
        base: null,
      }),
    ).toBe("- [a](a.md)\n- [b](b.md)\n- [a](a.md)\n- [c](c.md)\n");
  });

  // Review round 3, finding 2 (reproduced): the union closed the store's unclosed fence, then the
  // dedupe took the store's second entry, and the check only looked at the incoming side.
  it("keeps every line of the store's side too", async () => {
    const ours = "- [E](e.md)\n~~~\n\nb\n- [E](e.md)\n";
    const theirs = "\n~~~\nb\n";
    const merged = await merge({ path: `${ROOT}/MEMORY.md`, ours, theirs, base: null });
    expect(merged.split("\n").filter((line) => line === "- [E](e.md)")).toHaveLength(2);
  });

  // Review round 3, finding 3 (reproduced): an indented code block was not code to the fence
  // parser, so a repeated entry in it was deduped and exempted.
  it("keeps a repeated entry inside an indented code block", async () => {
    const block = "Example:\n\n    - [E](e.md)\n    - [E](e.md)\n";
    const merged = await merge({
      path: `${ROOT}/MEMORY.md`,
      ours: "# Memory\n",
      theirs: `# Memory\n${block}`,
      base: null,
    });
    expect(merged.split("\n").filter((line) => line === "    - [E](e.md)")).toHaveLength(2);
  });

  // Review round 1, finding 1 (reproduced): the index dedupe ran over the whole document and took
  // the closing `---` and the second fenced block's fences.
  it("keeps a merged index's frontmatter delimiters and every fence", async () => {
    const merged = await merge({
      path: `${ROOT}/MEMORY.md`,
      ours: fencedIndex("- [mend](mend.md)"),
      theirs: fencedIndex("- [laptop](laptop.md)"),
      base: null,
    });
    expect(merged.split("\n").filter((line) => line === "---")).toHaveLength(2);
    expect(merged.split("\n").filter((line) => line === "```sh")).toHaveLength(2);
    expect(merged.split("\n").filter((line) => line === "```")).toHaveLength(2);
    expect(merged).toContain("- [mend](mend.md)\n- [laptop](laptop.md)\n");
  });

  // Review round 1, finding 2 (reproduced): `name: Build` against `name: Build` plus a comment
  // gave only `name: Build`.
  it("keeps a comment the machine added to the frontmatter", async () => {
    expect(
      await merge({
        ours: "---\nname: Build\n---\nbody\n",
        theirs: "---\nname: Build\n# Production requires --offline\n---\nbody\n",
        base: null,
      }),
    ).toBe("---\nname: Build\n# Production requires --offline\n---\nbody\n");
  });

  // Review round 1, findings 2 and 5 (reproduced): a block scalar's `  # New heading` and a quoted
  // key are outside the subset merged by key; the two are not merged at all.
  it("does not merge a note whose differing frontmatter is outside the simple subset", async () => {
    expect(
      await outcome({ ours: blockNote(""), theirs: blockNote("\n  # New heading"), base: null }),
    ).toEqual({
      kind: "unmergeable",
    });
    expect(
      await outcome({
        ours: "---\nname: Build\n---\nbody\n",
        theirs: '---\n"name": Compile\n---\nbody\n',
        base: null,
      }),
    ).toEqual({ kind: "unmergeable" });
  });

  // Review round 1, finding 4 (reproduced): CRLF frontmatter skipped the key merge and wrote
  // `description:` twice.
  it("merges CRLF frontmatter by key and keeps CRLF", async () => {
    const merged = await merge({ ours: crlfNote("a"), theirs: crlfNote("b"), base: null });
    expect(merged).toBe(
      "---\r\nname: Build\r\ndescription: a\r\n# from laptop, 2026-10-04: description: b\r\n---\r\nbody\r\n",
    );
  });

  // Review round 1, finding 3 (reproduced): two files of 2,001 distinct lines (about 19 and 23 KB)
  // were "merged" by set membership, dropping repeated lines.
  it("does not merge files too different to align with no shared version", async () => {
    const ours = distinctLines("mend", 1);
    const theirs = distinctLines("laptop", 3);
    expect(ours.length).toBeGreaterThan(18_000);
    expect(theirs.length).toBeGreaterThan(22_000);
    expect(await outcome({ ours, theirs, base: null })).toEqual({ kind: "unmergeable" });
  });

  it("says which of the machine's lines a merge did not keep", async () => {
    const result = await outcome({
      ours: "a\n",
      theirs: "a\nb\n",
      base: "a\n",
      with: keepsOurs,
    });
    expect(result).toEqual({ kind: "merged", contents: "a\n", lostOurs: [], lostTheirs: ["b"] });
  });

  // Review round 2, finding 1 (reproduced): a ``` line inside a four-backtick block ended the
  // block for the dedupe, which then took a repeated entry inside it and reported nothing missing.
  it("keeps every entry inside a code block of a merged index, however it is fenced", async () => {
    const entry = "- [Build](build.md) — pnpm";
    for (const block of [
      ["````md", "```sh", entry, "```", entry, "````"],
      ["~~~", entry, "```", entry, "~~~"],
      ["```", entry, entry],
    ]) {
      const theirs = `# Memory\n${block.join("\n")}\n`;
      const merged = await merge({
        path: `${ROOT}/MEMORY.md`,
        ours: `# Memory\n${entry}\n`,
        theirs,
        base: null,
      });
      // Every copy inside the block stays; Mend's own copy may line up with one of them.
      const copies = merged.split("\n").filter((line) => line === entry).length;
      expect(copies).toBeGreaterThanOrEqual(block.filter((line) => line === entry).length);
      for (const line of block) expect(merged).toContain(line);
    }
  });

  // Review round 2, finding 2 (reproduced): frontmatter on one side only took the whole-file
  // path, where a repeated line was lost the same way.
  it("keeps a repeated line when only one side has frontmatter", async () => {
    const entry = "- [Build](build.md) — pnpm";
    const session = `\`\`\`\`md\n\`\`\`\n${entry}\n\`\`\`\n${entry}\n\`\`\`\`\n`;
    for (const [ours, theirs] of [
      [`---\nname: index\n---\n${entry}\n`, session],
      [session, `---\nname: index\n---\n${entry}\n`],
    ] as const) {
      const result = await outcome({ path: `${ROOT}/MEMORY.md`, ours, theirs, base: null });
      if (result.kind !== "merged") throw new Error("merges");
      expect(result.lostTheirs).toEqual([]);
      expect(result.lostOurs).toEqual([]);
      for (const line of theirs.split("\n")) expect(result.contents).toContain(line);
      const want = (contents: string) =>
        contents.split("\n").filter((line) => line === entry).length;
      expect(want(result.contents)).toBeGreaterThanOrEqual(want(theirs));
    }
  });

  // Review round 2: the check runs on the final text after every step. Over random files from a
  // vocabulary of fences, delimiters, frontmatter keys and entries, merged with the real three-way
  // merge, a line of either side is in the result as often as it was, less the copies the other
  // side removed since the base, or the merge reports it. No other exemption.
  it("never loses an incoming line without reporting it", async () => {
    const vocabulary = ["---", "name: a", "x", "x", "- [a](a.md)", "```", "````", "~~~", "", "# h"];
    // A fixed seed and exact 32-bit arithmetic (mulberry32): the same files on every machine.
    let seed = 7;
    const next = (n: number) => {
      seed = (seed + 0x6d_2b_79_f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const file = () =>
      `${next(2) === 0 ? "---\nname: a\n---\n" : ""}${Array.from(
        { length: next(9) },
        () => vocabulary[next(vocabulary.length)],
      ).join("\n")}\n`;
    let unreported = 0;
    for (let round = 0; round < 300; round += 1) {
      const base = next(3) === 0 ? null : file();
      const ours = file();
      const theirs = file();
      for (const path of [`${ROOT}/notes.md`, `${ROOT}/MEMORY.md`]) {
        const result = await outcome({ path, ours, theirs, base });
        if (result.kind !== "merged") continue;
        const have = lineCounts(result.contents);
        const shared = base === null ? new Map<string, number>() : lineCounts(base);
        for (const [side, other, reported] of [
          [theirs, ours, result.lostTheirs],
          [ours, theirs, result.lostOurs],
        ] as const) {
          if (reported.length > 0) continue;
          const kept = lineCounts(other);
          for (const [line, count] of lineCounts(side)) {
            const removed = Math.max(0, (shared.get(line) ?? 0) - (kept.get(line) ?? 0));
            if ((have.get(line) ?? 0) < count - removed) unreported += 1;
          }
        }
      }
    }
    expect(unreported).toBe(0);
    // 300 merges spawn `git merge-file` a few hundred times: under a second here, over vitest's
    // default 5 s on a CI runner.
  }, 60_000);
});

// Review round 3, invariant C: one function writes versions, and decides pinning itself, so no
// path can keep a version without the rule.
describe("where versions are written", () => {
  const source = readFileSync(
    join(import.meta.dirname, "..", "src", "repos", "agent-memory.ts"),
    "utf8",
  );
  it("has one insert into the versions table, inside keepVersion, pinned by isSoleCopy", () => {
    expect(source.match(/\.insert\(agentMemoryVersions\)/g)).toHaveLength(1);
    const keep = source.slice(source.indexOf("const keepVersion = ("));
    expect(keep.indexOf(".insert(agentMemoryVersions)")).toBeLessThan(
      keep.indexOf("const write = ("),
    );
    expect(keep).toMatch(/const pinned = yield\* isSoleCopy\(version, current, holdsDatabase\);/);
    // Every call must name the file it is kept beside (null for a deletion) and a database check:
    // both parameters are required, with no default, so the compiler holds every call to it.
    expect(keep).toMatch(
      /version: StoredMemoryFile,\s+current: MemoryFile \| null,\s+holdsDatabase: HoldsDatabase,\s+\) =>/,
    );
  });

  it("pins a version that holds a line, or any bytes, the current file lacks", async () => {
    const t = (contents: string) => text("x.md", contents);
    const b = (contents: string) => ({
      path: `${ROOT}/x.png`,
      encoding: "base64" as const,
      contents,
    });
    expect(await soleCopy(t("a\n"), t("a\nb\n"))).toBe(false);
    expect(await soleCopy(t("a\nA\n"), t("a\n"))).toBe(true);
    expect(await soleCopy(t("a\n"), null)).toBe(true);
    expect(await soleCopy(b("AAAA"), b("AAAA"))).toBe(false);
    expect(await soleCopy(b("AAAA"), b("BBBB"))).toBe(true);
  });
});

type MemoryLike = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

/** `isSoleCopy` with no database check. */
const soleCopy = (version: MemoryLike, current: MemoryLike | null) =>
  Effect.runPromise(isSoleCopy(version, current, () => Effect.succeed(false)));

/**
 * Against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database. Without one
 * reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_agent_memory_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = AgentMemoryRepoLive.pipe(
  Layer.provide(MendDBLive),
  Layer.provideMerge(scratchLayer),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, AgentMemoryRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));
const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

/** Keeps every line of both sides, as `git merge-file --union` does for appended lines. */
const unionMerge: MergeText = ({ ours, theirs }) =>
  Effect.succeed([...new Set([...ours.split("\n"), ...theirs.split("\n")])].join("\n"));

/** The server's three-way merge (`git merge-file --union`), recording the base it was given. */
let lastMergeBase: string | null = null;
const gitUnion: MergeText = ({ base, ours, theirs }) =>
  Effect.sync(() => {
    lastMergeBase = base;
    const dir = mkdtempSync(join(tmpdir(), "mend-memory-test-"));
    try {
      writeFileSync(join(dir, "ours"), ours);
      writeFileSync(join(dir, "base"), base);
      writeFileSync(join(dir, "theirs"), theirs);
      return spawnSync("git", ["merge-file", "-p", "--union", "ours", "base", "theirs"], {
        cwd: dir,
        encoding: "utf8",
      }).stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

const project = "project-1" as ProjectId;

const nothing = {
  added: [],
  unchanged: [],
  updated: [],
  merged: [],
  keptStored: [],
  removedInMend: [],
  conflicting: [],
  skipped: [],
};

/** An import as `mend memory import` on the laptop sends it. */
const importing = (
  files: ReadonlyArray<{
    readonly path: string;
    readonly encoding: "utf8" | "base64";
    readonly contents: string;
  }>,
  options: {
    readonly dryRun?: boolean;
    readonly source?: { readonly id: string; readonly label: string } | null;
    readonly merge?: MergeText;
  } = {},
) => ({
  userId: "anna",
  projectId: project,
  files,
  source:
    options.source === undefined ? { id: "machine-1:/code/repo", label: "laptop" } : options.source,
  dryRun: options.dryRun ?? false,
  merge: options.merge ?? gitUnion,
  mergeDatabase: () => Effect.succeed(null),
  holdsDatabase: () => Effect.succeed(false),
});

// Review round 4, finding 2 (reproduced by reading 0106): the column came in as `false` on every
// existing version, so a version that was the only copy of some lines before the upgrade could be
// pruned by later saves. 0106 pins them all.
const UPGRADE_DB = `mend_agent_memory_upgrade_${process.pid}_${Date.now()}`;
const upgradeLayer = PgClient.layer({
  url: Redacted.make(
    (() => {
      const url = new URL(ADMIN_URL);
      url.pathname = `/${UPGRADE_DB}`;
      return url.toString();
    })(),
  ),
});

describe.skipIf(!reachable)("upgrading to 0106", () => {
  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${UPGRADE_DB} WITH (FORCE)`);
      }),
    );
  });

  it("pins every version kept before it", async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${UPGRADE_DB}`);
      }),
    );
    const pinned = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        const before = ordered.filter(([name]) => name < "0106");
        const upgrade = ordered.filter(([name]) => name >= "0106");
        yield* Effect.forEach(before, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-up', 'p', '/store/p-up/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO agent_memory_versions (user_id, project_id, path, digest, encoding, contents)
          VALUES ('anna', 'p-up', ${`${ROOT}/old.md`}, 'd-old', 'utf8', 'the only copy')`;
        yield* Effect.forEach(upgrade, ([, migration]) => migration, { discard: true });
        return yield* sql<{ pinned: boolean }>`SELECT pinned FROM agent_memory_versions`;
      }).pipe(Effect.provide(upgradeLayer), Effect.scoped),
    );
    expect(pinned).toEqual([{ pinned: true }]);
  });
});

describe.skipIf(!reachable)("agent memory, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('anna', 'Anna Example', 'anna@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${project}, 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("keeps what two sessions learned from the same delivery, and every version it replaced", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const v1 = text("MEMORY.md", "- one");
        expect(yield* repo.importFiles(importing([v1], { source: null }))).toEqual({
          ...nothing,
          added: [v1.path],
        });
        // Two sessions receive v1; each adds a line.
        const delivered = { [v1.path]: agentMemoryDigest(v1) };
        const first = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s1",
          delivered,
          session: [text("MEMORY.md", "- one\n- two"), text("notes.md", "build with pnpm")],
          merge: unionMerge,
        });
        expect(first).toEqual({
          saved: [v1.path, `${ROOT}/notes.md`],
          merged: [],
          deleted: [],
          skipped: [],
        });
        const second = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s2",
          delivered,
          session: [text("MEMORY.md", "- one\n- three")],
          merge: unionMerge,
        });
        expect(second.merged).toEqual([v1.path]);
        expect((yield* repo.read("anna", project, v1.path))?.file.contents).toBe(
          "- one\n- two\n- three",
        );
        // s1 deleted nothing; s2 never had notes.md delivered, so it is not "deleted" by s2.
        expect((yield* repo.list("anna", project)).map((entry) => entry.name).toSorted()).toEqual([
          "MEMORY.md",
          "notes.md",
        ]);
        const versions = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${v1.path} ORDER BY contents`;
        expect(versions.map((row) => row.contents)).toEqual(["- one", "- one\n- two"]);
      }),
    );
  });

  it("lets a session's later read-back replace its own earlier save", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const path = `${ROOT}/notes.md`;
        const before = (yield* repo.read("anna", project, path))?.file.contents;
        expect(before).toBe("build with pnpm");
        const again = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s1",
          delivered: {},
          session: [text("notes.md", "build with pnpm\ntest with vitest")],
          merge: () => Effect.die("no merge for a session's own save"),
        });
        expect(again.saved).toEqual([path]);
      }),
    );
  });

  it("deletes what a session deleted, keeps it as a version, and refuses paths outside memory", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const notes = (yield* repo.read("anna", project, `${ROOT}/notes.md`))?.file;
        if (notes === undefined) throw new Error("notes.md is stored");
        const done = yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s3",
          delivered: { [notes.path]: agentMemoryDigest(notes) },
          session: [{ path: ".claude/.credentials.json", encoding: "utf8", contents: "{}" }],
          merge: unionMerge,
        });
        expect(done).toEqual({
          saved: [],
          merged: [],
          deleted: [notes.path],
          skipped: [".claude/.credentials.json"],
        });
        const kept = yield* sql`SELECT 1 FROM agent_memory_versions WHERE path = ${notes.path}`;
        expect(kept.length).toBeGreaterThan(0);
        expect(yield* repo.remove("anna", project, `${ROOT}/MEMORY.md`)).toBe(true);
        expect(yield* repo.remove("anna", project, `${ROOT}/MEMORY.md`)).toBe(false);
        expect(yield* repo.list("anna", project)).toEqual([]);
      }),
    );
  });

  it("merges a drifted MEMORY.md, then merges the next import against this one", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const index = (contents: string) => text("MEMORY.md", contents);
        // Mend's copy, as its sessions left it.
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-mend",
          delivered: {},
          session: [index("# Memory\n- [a](a.md) — a\n- [mend](mend.md) — from Mend\n")],
          merge: unionMerge,
        });
        const laptop = index(
          "# Memory\n- [a](a.md) — a\n- [laptop](laptop.md) — from the laptop\n",
        );
        // A dry run plans the same and writes nothing.
        const planned = yield* repo.importFiles(importing([laptop], { dryRun: true }));
        expect(planned).toEqual({
          ...nothing,
          merged: [
            {
              path: laptop.path,
              against: "no-shared-version",
              missingLines: 0,
              storeMissingLines: 0,
            },
          ],
        });
        expect(yield* sql`SELECT 1 FROM agent_memory_import_bases`).toEqual([]);
        expect(yield* repo.importFiles(importing([laptop]))).toEqual(planned);
        const first =
          "# Memory\n- [a](a.md) — a\n- [mend](mend.md) — from Mend\n- [laptop](laptop.md) — from the laptop\n";
        expect((yield* repo.read("anna", project, laptop.path))?.file.contents).toBe(first);
        // Both sides' copies are kept as versions.
        const kept = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${laptop.path}`;
        expect(kept.map((row) => row.contents)).toContain(laptop.contents);

        // The same laptop again, unchanged: Mend's stays.
        expect(yield* repo.importFiles(importing([laptop]))).toEqual({
          ...nothing,
          unchanged: [],
          keptStored: [laptop.path],
        });

        // The laptop removes a line and adds one; a Mend session adds another meanwhile.
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-mend-2",
          delivered: {},
          session: [index(`${first}- [later](later.md) — Mend, later\n`)],
          merge: unionMerge,
        });
        const laptop2 = index(
          "# Memory\n- [laptop](laptop.md) — from the laptop\n- [new](new.md) — new\n",
        );
        const second = yield* repo.importFiles(importing([laptop2]));
        expect(second.merged).toEqual([
          { path: laptop.path, against: "last-import", missingLines: 0, storeMissingLines: 0 },
        ]);
        // Three-way against the last import: what each side added since stays.
        expect(lastMergeBase).toBe(laptop.contents);
        const merged = (yield* repo.read("anna", project, laptop.path))?.file.contents ?? "";
        for (const line of ["- [mend](mend.md)", "- [later](later.md)", "- [new](new.md)"]) {
          expect(merged).toContain(line);
        }

        // Another machine, never imported from: no shared version.
        const other = yield* repo.importFiles(
          importing([index("# Memory\n- [desk](desk.md) — desk\n")], {
            source: { id: "machine-2:/code/repo", label: "desk" },
          }),
        );
        expect(other.merged).toEqual([
          {
            path: laptop.path,
            against: "no-shared-version",
            missingLines: 0,
            storeMissingLines: 0,
          },
        ]);
      }),
    );
  });

  it("takes the side that changed, and does not bring back what Mend removed", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const build = text("build.md", "pnpm\n");
        const gone = text("gone.md", "old\n");
        yield* repo.importFiles(importing([build, gone]));
        // Unchanged in Mend since: the laptop's change replaces it.
        const changed = text("build.md", "pnpm 11\n");
        expect(yield* repo.importFiles(importing([changed, gone]))).toEqual({
          ...nothing,
          updated: [changed.path],
          unchanged: [gone.path],
        });
        expect((yield* repo.read("anna", project, changed.path))?.file.contents).toBe("pnpm 11\n");
        // Removed in Mend, unchanged on the laptop: not added again; changed there: added.
        yield* repo.remove("anna", project, gone.path);
        expect((yield* repo.importFiles(importing([gone]))).removedInMend).toEqual([gone.path]);
        const revived = text("gone.md", "old\nand new\n");
        expect((yield* repo.importFiles(importing([revived]))).added).toEqual([gone.path]);
        // A file Mend has that this import does not send stays.
        expect((yield* repo.importFiles(importing([]))).added).toEqual([]);
        expect((yield* repo.read("anna", project, changed.path))?.file.contents).toBe("pnpm 11\n");
      }),
    );
  });

  it("keeps Mend's binary file in a conflict, keeps this machine's as a version, and says so again", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const image = (bytes: string) => ({
          path: `${ROOT}/diagram.png`,
          encoding: "base64" as const,
          contents: Buffer.from(bytes).toString("base64"),
        });
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-png",
          delivered: {},
          session: [image("mend\0")],
          merge: unionMerge,
        });
        const laptop = image("laptop\0");
        for (let round = 0; round < 2; round += 1) {
          expect(yield* repo.importFiles(importing([laptop]))).toEqual({
            ...nothing,
            conflicting: [laptop.path],
          });
        }
        expect((yield* repo.read("anna", project, laptop.path))?.file.contents).toBe(
          image("mend\0").contents,
        );
        const versions = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${laptop.path}`;
        expect(versions.map((row) => row.contents)).toEqual([laptop.contents]);
      }),
    );
  });

  // Review round 1, finding 2: when a merge equalled the store, the machine's file was not kept
  // and the base still moved, so later imports kept ignoring what was lost.
  it("keeps the machine's file and holds the base when a merge does not keep all its lines", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const v1 = text("lossy.md", "a\n");
        yield* repo.importFiles(importing([v1]));
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-lossy",
          delivered: {},
          session: [text("lossy.md", "a\nmend\n")],
          merge: unionMerge,
        });
        const laptop = text("lossy.md", "a\nlaptop\n");
        for (let round = 0; round < 2; round += 1) {
          const report = yield* repo.importFiles(importing([laptop], { merge: keepsOurs }));
          expect(report.merged).toEqual([
            { path: laptop.path, against: "last-import", missingLines: 1, storeMissingLines: 0 },
          ]);
        }
        const versions = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${laptop.path}`;
        expect(versions.map((row) => row.contents)).toContain(laptop.contents);
        const [base] = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_import_bases WHERE path = ${laptop.path}`;
        expect(base?.contents).toBe(v1.contents);
      }),
    );
  });

  it("keeps a session's file whole when its read-back merge does not keep all its lines", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const v1 = text("readback.md", "a\n");
        yield* repo.importFiles(importing([v1]));
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-other",
          delivered: {},
          session: [text("readback.md", "a\nother\n")],
          merge: unionMerge,
        });
        const session = text("readback.md", "a\nmine\n");
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-mine",
          delivered: { [v1.path]: agentMemoryDigest(v1) },
          session: [session],
          merge: keepsOurs,
        });
        const versions = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${session.path} AND pinned`;
        expect(versions.map((row) => row.contents)).toContain(session.contents);
      }),
    );
  });

  // Review round 1, finding 3, through the store: the oversized merge is a conflict.
  it("keeps Mend's file when an import is too different to align, and says so", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-big",
          delivered: {},
          session: [text("big.md", distinctLines("mend", 0))],
          merge: unionMerge,
        });
        const laptop = text("big.md", distinctLines("laptop", 0));
        const report = yield* repo.importFiles(importing([laptop], { source: null }));
        expect(report.conflicting).toEqual([laptop.path]);
        expect((yield* repo.read("anna", project, laptop.path))?.file.contents).toBe(
          distinctLines("mend", 0),
        );
      }),
    );
  });

  // Review round 1, finding 6: the API refuses a path named twice; the store never plans one.
  it("refuses an import that names a path twice", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        return yield* repo.importFiles(importing([text("twice.md", "a"), text("twice.md", "b")]));
      }).pipe(Effect.provide(repoLayer), Effect.scoped),
    );
    expect(exit._tag).toBe("Failure");
    await run(
      Effect.gen(function* () {
        expect(
          yield* (yield* AgentMemoryRepo).read("anna", project, `${ROOT}/twice.md`),
        ).toBeNull();
      }),
    );
  });

  // Review round 2, finding 2, through the store: a read-back whose merge loses a line keeps the
  // session's file, pinned, with frontmatter on one side only.
  it("keeps a session's file when a one-sided-frontmatter read-back loses a line", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const index = text("one-sided/MEMORY.md", "---\nname: index\n---\n- [a](a.md)\n");
        yield* repo.importFiles(importing([index], { source: null }));
        const session = text("one-sided/MEMORY.md", "- [a](a.md)\n```\n- [b](b.md)\n- [b](b.md)\n");
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-one-sided",
          delivered: {},
          session: [session],
          merge: keepsOurs,
        });
        const merged = (yield* repo.read("anna", project, session.path))?.file.contents ?? "";
        // Merged with no shared version: every line of the session's is there.
        for (const line of session.contents.split("\n")) expect(merged).toContain(line);
        expect(merged.split("\n").filter((line) => line === "- [b](b.md)")).toHaveLength(2);
        expect(merged.startsWith("---\nname: index\n---\n")).toBe(true);
        const kept = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${session.path}`;
        expect(kept.map((row) => row.contents)).toContain(index.contents);
      }),
    );
  });

  // Review round 2, finding 3 (reproduced by reading the prune): the cap of twenty versions per
  // file took the oldest first, so twenty later saves evicted the machine's file a lossy merge
  // had kept, the only copy of its lines.
  it("never lets the version cap take a version that is the only copy of some lines", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const v1 = text("capped.md", "a\n");
        yield* repo.importFiles(importing([v1]));
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-capped",
          delivered: {},
          session: [text("capped.md", "a\nmend\n")],
          merge: unionMerge,
        });
        const laptop = text("capped.md", "a\nlaptop\n");
        const report = yield* repo.importFiles(importing([laptop], { merge: keepsOurs }));
        expect(report.merged[0]?.missingLines).toBe(1);
        // Twenty-five later saves by one session, each adding a line: every version they displace
        // is held by the next, so those are the ones the cap may take.
        for (let n = 0; n < 25; n += 1) {
          yield* repo.readBack({
            userId: "anna",
            projectId: project,
            sessionId: "s-capped",
            delivered: {},
            session: [
              text(
                "capped.md",
                `a\nmend\n${Array.from({ length: n + 1 }, (_, i) => `save ${i}\n`).join("")}`,
              ),
            ],
            merge: unionMerge,
          });
        }
        const versions = yield* sql<{ contents: string; pinned: boolean }>`
          SELECT contents, pinned FROM agent_memory_versions WHERE path = ${laptop.path}`;
        expect(versions.filter((row) => row.pinned).map((row) => row.contents)).toEqual([
          laptop.contents,
        ]);
        expect(versions.filter((row) => !row.pinned)).toHaveLength(20);
      }),
    );
  });

  // Review round 3, finding 1 (reproduced): A and B receive the same file; A saves base+A, B saves
  // base+B (merged to base+A+B); B's identical second read-back takes the same-session path and
  // writes base+B. The versions holding A were unpinned, and 25 later saves evicted them.
  it("pins every version that holds a line the current file lacks, on the same-session path too", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const base = text("ab.md", "base\n");
        yield* repo.importFiles(importing([base], { source: null }));
        const delivered = { [base.path]: agentMemoryDigest(base) };
        const readBack = (sessionId: string, contents: string, from = delivered) =>
          repo.readBack({
            userId: "anna",
            projectId: project,
            sessionId,
            delivered: from,
            session: [text("ab.md", contents)],
            merge: gitUnion,
          });
        yield* readBack("s-a", "base\nA\n");
        yield* readBack("s-b", "base\nB\n");
        expect((yield* repo.read("anna", project, base.path))?.file.contents).toContain("A\n");
        yield* readBack("s-b", "base\nB\n");
        // Twenty-five later saves that each add a line.
        let saved = (yield* repo.read("anna", project, base.path))?.file.contents ?? "";
        for (let n = 0; n < 25; n += 1) {
          const next = `${saved}later ${n}\n`;
          yield* readBack("s-c", next, { [base.path]: agentMemoryDigest(text("ab.md", saved)) });
          saved = next;
        }
        const current = (yield* repo.read("anna", project, base.path))?.file.contents ?? "";
        const pinned = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${base.path} AND pinned`;
        // A is in the current file or in a pinned version: never only in an evictable one.
        expect(
          current.includes("\nA\n") || pinned.some((row) => row.contents.includes("\nA\n")),
        ).toBe(true);
      }),
    );
  });

  // Review round 3, finding 1, binary: two sessions replace the same binary file; the one they
  // both replaced and the first one's are pinned, and survive 25 later saves.
  it("pins a binary version another session's save replaced", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        const png = (bytes: string) => ({
          path: `${ROOT}/race.png`,
          encoding: "base64" as const,
          contents: Buffer.from(`${bytes}\0`).toString("base64"),
        });
        yield* repo.importFiles(importing([png("zero")], { source: null }));
        const delivered = { [png("zero").path]: agentMemoryDigest(png("zero")) };
        for (const [sessionId, bytes] of [
          ["s-png-a", "a"],
          ["s-png-b", "b"],
        ] as const) {
          yield* repo.readBack({
            userId: "anna",
            projectId: project,
            sessionId,
            delivered,
            session: [png(bytes)],
            merge: gitUnion,
          });
        }
        for (let n = 0; n < 25; n += 1) {
          yield* repo.readBack({
            userId: "anna",
            projectId: project,
            sessionId: "s-png-c",
            delivered: {},
            session: [png(`later ${n}`)],
            merge: gitUnion,
          });
        }
        const pinned = yield* sql<{ contents: string }>`
          SELECT contents FROM agent_memory_versions WHERE path = ${png("a").path} AND pinned`;
        expect(pinned.map((row) => row.contents)).toEqual(
          expect.arrayContaining([png("zero").contents, png("a").contents]),
        );
      }),
    );
  });

  // Review round 3, finding 3 through the store: nothing lost, nothing reported, base advanced.
  it("imports an index with a repeated entry in an indented code block whole", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const path = "indented/MEMORY.md";
        yield* repo.importFiles(importing([text(path, "# Memory\n")], { source: null }));
        yield* repo.readBack({
          userId: "anna",
          projectId: project,
          sessionId: "s-indented",
          delivered: {},
          session: [text(path, "# Memory\n- [mend](mend.md)\n")],
          merge: gitUnion,
        });
        const laptop = text(path, "# Memory\nExample:\n\n    - [E](e.md)\n    - [E](e.md)\n");
        const report = yield* repo.importFiles(
          importing([laptop], { source: { id: "machine-3:/code/repo", label: "desk" } }),
        );
        expect(report.merged).toEqual([
          {
            path: laptop.path,
            against: "no-shared-version",
            missingLines: 0,
            storeMissingLines: 0,
          },
        ]);
        const merged = (yield* repo.read("anna", project, laptop.path))?.file.contents ?? "";
        expect(merged.split("\n").filter((line) => line === "    - [E](e.md)")).toHaveLength(2);
      }),
    );
  });

  it("goes with the account", async () => {
    await run(
      Effect.gen(function* () {
        const repo = yield* AgentMemoryRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* repo.importFiles(importing([text("a.md", "a")]));
        yield* sql`DELETE FROM "user" WHERE id = 'anna'`;
        expect(yield* sql`SELECT 1 FROM agent_memory_files`).toEqual([]);
        expect(yield* sql`SELECT 1 FROM agent_memory_versions`).toEqual([]);
        expect(yield* sql`SELECT 1 FROM agent_memory_import_bases`).toEqual([]);
      }),
    );
  });
});
