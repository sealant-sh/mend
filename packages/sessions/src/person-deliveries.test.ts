import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";

import { agentMemoryDigest, type StoredMemoryFile } from "@mend/db";
import { CODEX_MEMORY_DATABASE } from "@mend/domain/workbench";
import { LinuxIdentity } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import {
  AGENT_MEMORY_DELIVERED,
  deliverAgentMemoryExec,
  mapAgentMemoryPlan,
  planAgentMemory,
} from "./agent-memory.ts";
import { CARRIED_INCOMING, carryConversationsExec } from "./codex-memory.ts";
import { PERSON_SAVED_STATE } from "./harness-layout.ts";
import { CARRIED_TRANSCRIPTS } from "./harness-state.ts";
import {
  dotfilesRefusalWords,
  homePathOfPersonSaved,
  opencodeScrubArgv,
  FIRST_PROCESS_DONE,
  parseDisplacedLinks,
  parseOpencodeScrub,
  parsePersonRecords,
  PERSON_SKILLS_KEPT,
  PERSON_SKILLS_MANIFEST,
  personLinksScript,
  personMemoryInPlace,
  personRecordsExec,
  personSavedPathOf,
} from "./person-deliveries.ts";
import { PI_PROFILE_PROGRAM } from "./pi-profile.ts";
import { vacateSkillsExec } from "./skills.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tmp = (prefix = "mend-person-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const run = (argv: ReadonlyArray<string>) => {
  const [command, ...rest] = argv;
  if (command === undefined) throw new Error("no command");
  return spawnSync(command, rest, { encoding: "utf8" });
};

const alice = new LinuxIdentity({ accountId: "alice-1", name: "m3kq7xj2a", uid: 40_012 });

/** `R` and `P` for one person, under a temporary root. */
const placesIn = (root: string) => {
  const home = path.join(root, "home", alice.name);
  const harnessHome = path.join(root, "harness-home");
  const saved = path.join(harnessHome, "people", alice.accountId);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(saved, { recursive: true });
  return { home, saved, harnessHome };
};

describe("where a person's deliveries land (docs/adr/0016, decision 2)", () => {
  it("puts Codex's summary database in codex-db and Mend's records in .mend-saved, and back", () => {
    for (const [home, saved] of [
      [CODEX_MEMORY_DATABASE, "codex-db/memories_1.sqlite"],
      [`${CODEX_MEMORY_DATABASE}-wal`, "codex-db/memories_1.sqlite-wal"],
      [AGENT_MEMORY_DELIVERED, ".mend-saved/agent-memory-delivered.json"],
      [CARRIED_TRANSCRIPTS, ".mend-saved/carried-transcripts"],
      [".mend/codex-threads/x.jsonl", ".mend-saved/codex-threads/x.jsonl"],
      [
        ".claude/projects/-workspace-repo/memory/MEMORY.md",
        ".claude/projects/-workspace-repo/memory/MEMORY.md",
      ],
      [".codex/memories/MEMORY.md", ".codex/memories/MEMORY.md"],
    ] as const) {
      expect(personSavedPathOf(home)).toBe(saved);
      expect(homePathOfPersonSaved(saved)).toBe(home);
    }
  });
});

describe("what was delivered before, in one read (personRecordsExec)", () => {
  it("reads the records in P and the secret files' record in ~/.mend, and nothing through a link", () => {
    const root = tmp();
    const places = placesIn(root);
    fs.mkdirSync(path.join(places.saved, ".mend-saved"), { recursive: true });
    fs.writeFileSync(
      path.join(places.saved, PERSON_SKILLS_MANIFEST),
      '{\n  ".claude/skills": []\n}',
    );
    fs.writeFileSync(path.join(places.saved, ".mend-saved/agent-memory-delivered.json"), "{}");
    fs.mkdirSync(path.join(places.home, ".mend"), { recursive: true });
    fs.writeFileSync(path.join(places.home, ".mend/secret-files"), "sealed-record\n");
    const records = parsePersonRecords(
      run(
        personRecordsExec(places, {
          memoryDelivered: personSavedPathOf(AGENT_MEMORY_DELIVERED),
        }),
      ).stdout,
    );
    expect(records.get("skills-manifest")).toBe('{\n  ".claude/skills": []\n}');
    expect(records.get("skills-digests")).toBeNull();
    expect(records.get("memory-delivered")).toBe("{}");
    expect(records.get("secret-files")).toBe("sealed-record\n");
    expect(records.get("first-done")).toBeNull();
    // A `~/.mend` that became a link says nothing.
    fs.rmSync(path.join(places.home, ".mend"), { recursive: true });
    const elsewhere = tmp();
    fs.writeFileSync(path.join(elsewhere, "secret-files"), "planted");
    fs.symlinkSync(elsewhere, path.join(places.home, ".mend"));
    const linked = parsePersonRecords(
      run(personRecordsExec(places, { memoryDelivered: ".mend-saved/x" })).stdout,
    );
    expect(linked.get("secret-files")).toBeNull();
  });
});

/** Everything under `root`, each path with what it is (a link's target, a file's text). */
const listTree = (root: string): ReadonlyArray<string> =>
  fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .toSorted()
    .map((relative) => {
      const at = path.join(root, relative);
      const stat = fs.lstatSync(at);
      return stat.isSymbolicLink()
        ? `${relative} -> ${fs.readlinkSync(at)}`
        : stat.isDirectory()
          ? `${relative}/`
          : `${relative}: ${fs.readFileSync(at, "utf8")}`;
    });

/** What was moved aside for a home-relative path, under its flat names. */
const displacedAt = (home: string, relative: string): ReadonlyArray<string> => {
  const dir = path.join(home, ".mend/displaced");
  const suffix = `-${relative.replaceAll("/", "%")}`;
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((name) => name.endsWith(suffix))
        .map((name) => path.join(dir, name))
    : [];
};

describe("Mend's links after a person's dotfiles (decision 11)", () => {
  it("puts its links back, merging what the dotfiles left and moving their own links aside", () => {
    const root = tmp();
    const places = placesIn(root);
    // As prepare left the home: every link in place.
    for (const entry of PERSON_SAVED_STATE) {
      const from = path.join(places.home, entry.path);
      const to = path.join(places.saved, entry.path);
      fs.mkdirSync(path.dirname(from), { recursive: true });
      if (entry.kind === "directory") fs.mkdirSync(to, { recursive: true });
      else fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(to, from);
    }
    // The dotfiles stowed `.claude/agents` into their checkout, and wrote a real `.claude/commands`.
    const checkout = path.join(root, "dotfiles/.claude/agents");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "mine.md"), "my agent\n");
    fs.rmSync(path.join(places.home, ".claude/agents"));
    fs.symlinkSync(checkout, path.join(places.home, ".claude/agents"));
    fs.rmSync(path.join(places.home, ".claude/commands"));
    fs.mkdirSync(path.join(places.home, ".claude/commands"));
    fs.writeFileSync(path.join(places.home, ".claude/commands/go.md"), "go\n");
    const script = personLinksScript(alice, { harnessHome: places.harnessHome, home: places.home });
    const out = run(["sh", "-c", script]);
    expect(out.status).toBe(0);
    expect(parseDisplacedLinks(out.stdout)).toEqual([".claude/agents"]);
    for (const entry of PERSON_SAVED_STATE) {
      expect(fs.readlinkSync(path.join(places.home, entry.path))).toBe(
        path.join(places.saved, entry.path),
      );
    }
    // Nothing lost: the command moved into P, the stowed link is kept aside where it points.
    expect(fs.readFileSync(path.join(places.saved, ".claude/commands/go.md"), "utf8")).toBe("go\n");
    expect(displacedAt(places.home, ".claude/agents").map((at) => fs.readlinkSync(at))).toEqual([
      checkout,
    ]);
    // Run again: nothing to do. Their first-process deliveries are marked done.
    expect(parseDisplacedLinks(run(["sh", "-c", script]).stdout)).toEqual([]);
    expect(fs.readFileSync(path.join(places.home, FIRST_PROCESS_DONE), "utf8")).toBe("done");
  });

  it.each(["absolute", "relative"] as const)(
    "unfolds a stow-folded ~/.claude and ~/.pi (%s links) into real directories, reads the checkout only, and changes nothing run twice",
    (kind) => {
      const root = tmp();
      const places = placesIn(root);
      // What `P` already holds: their own reviewer agent.
      fs.mkdirSync(path.join(places.saved, ".claude/agents"), { recursive: true });
      fs.writeFileSync(path.join(places.saved, ".claude/agents/reviewer.md"), "P's reviewer\n");
      // Their dotfiles folded all of `~/.claude` and `~/.pi` into the checkout.
      const dotfiles = path.join(places.home, "dotfiles");
      fs.mkdirSync(path.join(dotfiles, ".claude/agents"), { recursive: true });
      fs.writeFileSync(
        path.join(dotfiles, ".claude/agents/reviewer.md"),
        "the dotfiles' reviewer\n",
      );
      fs.writeFileSync(path.join(dotfiles, ".claude/agents/other.md"), "another agent\n");
      fs.writeFileSync(path.join(dotfiles, ".claude/CLAUDE.md"), "my instructions\n");
      fs.mkdirSync(path.join(dotfiles, ".pi/agent"), { recursive: true });
      fs.writeFileSync(path.join(dotfiles, ".pi/agent/settings.json"), '{"theme":"dots"}');
      for (const name of [".claude", ".pi"]) {
        fs.symlinkSync(
          kind === "absolute" ? path.join(dotfiles, name) : path.join("dotfiles", name),
          path.join(places.home, name),
        );
      }
      const before = listTree(dotfiles);
      const script = personLinksScript(alice, {
        harnessHome: places.harnessHome,
        home: places.home,
      });
      const out = run(["sh", "-c", script]);
      expect(out.stderr).toBe("");
      expect(out.status).toBe(0);
      // The checkout is exactly as it was: nothing written, moved or removed in it.
      expect(listTree(dotfiles)).toEqual(before);
      // Every saved-state entry is a link to `P`, under real directories.
      for (const name of [".claude", ".pi", ".pi/agent"]) {
        expect(fs.lstatSync(path.join(places.home, name)).isDirectory()).toBe(true);
      }
      for (const entry of PERSON_SAVED_STATE) {
        expect(fs.readlinkSync(path.join(places.home, entry.path))).toBe(
          path.join(places.saved, entry.path),
        );
      }
      // Their instructions still apply, as a copy; `P`'s reviewer stays, the dotfiles' new agent
      // joins it, and the dotfiles' reviewer and settings are kept aside.
      expect(fs.readFileSync(path.join(places.home, ".claude/CLAUDE.md"), "utf8")).toBe(
        "my instructions\n",
      );
      expect(fs.readFileSync(path.join(places.saved, ".claude/agents/reviewer.md"), "utf8")).toBe(
        "P's reviewer\n",
      );
      expect(fs.readFileSync(path.join(places.saved, ".claude/agents/other.md"), "utf8")).toBe(
        "another agent\n",
      );
      expect(fs.readFileSync(path.join(places.saved, ".pi/agent/settings.json"), "utf8")).toBe(
        '{"theme":"dots"}',
      );
      expect(
        displacedAt(places.home, ".claude/agents/reviewer.md").map((at) =>
          fs.readFileSync(at, "utf8"),
        ),
      ).toEqual(["the dotfiles' reviewer\n"]);
      // The folded links are recorded aside, pointing where they pointed, absolutely.
      expect(displacedAt(places.home, ".claude").map((at) => fs.readlinkSync(at))).toEqual([
        path.join(dotfiles, ".claude"),
      ]);
      // Running again changes nothing.
      const displacedBefore = fs.readdirSync(path.join(places.home, ".mend/displaced")).toSorted();
      const again = run(["sh", "-c", script]);
      expect(again.status).toBe(0);
      expect(parseDisplacedLinks(again.stdout)).toEqual([]);
      expect(fs.readdirSync(path.join(places.home, ".mend/displaced")).toSorted()).toEqual(
        displacedBefore,
      );
      expect(listTree(dotfiles)).toEqual(before);
    },
  );

  it("merges a real directory into P entry by entry, moving aside what P already holds", () => {
    const root = tmp();
    const places = placesIn(root);
    fs.mkdirSync(path.join(places.saved, ".claude/commands"), { recursive: true });
    fs.writeFileSync(path.join(places.saved, ".claude/commands/go.md"), "P's go\n");
    fs.mkdirSync(path.join(places.home, ".claude/commands"), { recursive: true });
    fs.writeFileSync(path.join(places.home, ".claude/commands/go.md"), "the dotfiles' go\n");
    fs.writeFileSync(path.join(places.home, ".claude/commands/new.md"), "new\n");
    const out = run([
      "sh",
      "-c",
      personLinksScript(alice, { harnessHome: places.harnessHome, home: places.home }),
    ]);
    expect(out.status).toBe(0);
    expect(fs.readFileSync(path.join(places.saved, ".claude/commands/go.md"), "utf8")).toBe(
      "P's go\n",
    );
    expect(fs.readFileSync(path.join(places.saved, ".claude/commands/new.md"), "utf8")).toBe(
      "new\n",
    );
    expect(
      displacedAt(places.home, ".claude/commands/go.md").map((at) => fs.readFileSync(at, "utf8")),
    ).toEqual(["the dotfiles' go\n"]);
    // A second copy at the same path, moved aside later, keeps the first (review of mend#566,
    // P3-3).
    fs.rmSync(path.join(places.home, ".claude/commands"));
    fs.mkdirSync(path.join(places.home, ".claude/commands"));
    fs.writeFileSync(path.join(places.home, ".claude/commands/go.md"), "a later go\n");
    expect(
      run([
        "sh",
        "-c",
        personLinksScript(alice, { harnessHome: places.harnessHome, home: places.home }),
      ]).status,
    ).toBe(0);
    expect(
      displacedAt(places.home, ".claude/commands/go.md")
        .map((at) => fs.readFileSync(at, "utf8"))
        .toSorted(),
    ).toEqual(["a later go\n", "the dotfiles' go\n"]);
  });
});

/** opencode's tables that hold logins, with a conversation beside them, in WAL mode. */
const opencodeDatabase = (file: string) => {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA wal_autocheckpoint=0");
  db.exec(`CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT, access_token TEXT)`);
  db.exec(`CREATE TABLE control_account (id TEXT PRIMARY KEY, token TEXT)`);
  db.exec(`CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT)`);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)`);
  db.exec(`CREATE TABLE session_share (session_id TEXT PRIMARY KEY, url TEXT, secret TEXT)`);
  db.prepare("INSERT INTO account VALUES (?, ?, ?)").run("a1", "a@x", "ACCOUNT_TOKEN_CANARY_1");
  db.prepare("INSERT INTO control_account VALUES (?, ?)").run("c1", "CONTROL_TOKEN_CANARY_2");
  db.prepare("INSERT INTO credential VALUES (?, ?)").run("k1", "CREDENTIAL_CANARY_3");
  db.prepare("INSERT INTO session VALUES (?, ?)").run("ses_1", "the conversation stays");
  db.prepare("INSERT INTO session_share VALUES (?, ?, ?)").run(
    "ses_1",
    "https://opncd.ai/s/1",
    "SHARE_SECRET_CANARY_4",
  );
  return db;
};
const CANARIES = [
  "ACCOUNT_TOKEN_CANARY_1",
  "CONTROL_TOKEN_CANARY_2",
  "CREDENTIAL_CANARY_3",
  "SHARE_SECRET_CANARY_4",
];

describe("the opencode scrub (decision 8a)", () => {
  it("leaves no row and no WAL page, and keeps the conversations", () => {
    const file = path.join(tmp("mend-scrub-"), "opencode.db");
    // A reader stays open, as another process of the person's might: the log is not removed on
    // close then, only emptied.
    const held = opencodeDatabase(file);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    const result = run(opencodeScrubArgv([file]));
    expect(result.status).toBe(0);
    expect(parseOpencodeScrub(result.stdout)).toEqual([
      { outcome: "scrubbed", file, rows: 4, reason: null },
    ]);
    held.close();
    const db = new DatabaseSync(file);
    for (const table of ["account", "control_account", "credential"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT secret FROM session_share").get()).toEqual({ secret: null });
    expect(db.prepare("SELECT title FROM session").get()).toEqual({
      title: "the conversation stays",
    });
    db.close();
    // No page of what was deleted, in the database or its log.
    const wal = fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`) : Buffer.alloc(0);
    expect(wal.byteLength).toBe(0);
    const bytes = Buffer.concat([fs.readFileSync(file), wal]).toString("latin1");
    for (const canary of CANARIES) expect(bytes).not.toContain(canary);
  });

  it("says failed, never scrubbed, when a reader keeps its log from being emptied", () => {
    const file = path.join(tmp("mend-scrub-"), "opencode.db");
    const writer = opencodeDatabase(file);
    // A second opencode of the person's, mid-read.
    const reader = new DatabaseSync(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM session").get();
    const result = run(opencodeScrubArgv([file]));
    expect(result.status).toBe(1);
    expect(parseOpencodeScrub(result.stdout)).toEqual([
      {
        outcome: "failed",
        file,
        rows: 0,
        reason: "the database is in use, so its write-ahead log still holds what was deleted",
      },
    ]);
    reader.exec("COMMIT");
    reader.close();
    writer.close();
  });

  it("says absent for no database and failed for one that is not a database, leaving it as it is", () => {
    const dir = tmp("mend-scrub-");
    const broken = path.join(dir, "broken.db");
    fs.writeFileSync(broken, "not a database at all, but long enough to be read as one".repeat(20));
    const before = fs.readFileSync(broken);
    const result = run(opencodeScrubArgv([path.join(dir, "absent.db"), broken]));
    expect(result.status).toBe(1);
    const outcomes = parseOpencodeScrub(result.stdout);
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(["absent", "failed"]);
    expect(fs.readFileSync(broken)).toEqual(before);
  });
});

describe("skills kept aside in a person's saved directory", () => {
  it("moves a directory that is not Mend's to an absolute kept directory, across filesystems too", () => {
    const root = tmp();
    const places = placesIn(root);
    fs.mkdirSync(path.join(places.home, ".codex/skills/review"), { recursive: true });
    fs.writeFileSync(path.join(places.home, ".codex/skills/review/SKILL.md"), "edited\n");
    const kept = path.join(places.saved, PERSON_SKILLS_KEPT, "stamp");
    const result = run(
      vacateSkillsExec(places.home, kept, {
        directories: [".codex/skills"],
        vacate: [{ dir: ".codex/skills/review", accept: [], delivering: "x" }],
        files: [],
        manifest: "{}",
        digests: "{}",
      }),
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(places.home, ".codex/skills/review"))).toBe(false);
    expect(fs.readFileSync(path.join(kept, ".codex/skills/review/SKILL.md"), "utf8")).toBe(
      "edited\n",
    );
  });
});

/** A memory file as the store holds it. */
const stored = (filePath: string, contents: string): StoredMemoryFile => {
  const file = { path: filePath, encoding: "utf8" as const, contents };
  return { ...file, digest: agentMemoryDigest(file), updatedBySession: null };
};

describe("a person's memory, in their saved directory (decision 9)", () => {
  it("lays Claude's memory where R links to, Codex's database in codex-db and the record in .mend-saved", () => {
    const root = tmp();
    const places = placesIn(root);
    const files = [
      stored(".claude/projects/-workspace-repo/memory/MEMORY.md", "- notes\n"),
      stored(CODEX_MEMORY_DATABASE, "a database"),
    ];
    const plan = mapAgentMemoryPlan(planAgentMemory(files), personSavedPathOf);
    for (const file of plan.staged) {
      const at = path.join(places.saved, file.path);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, file.bytes);
    }
    const result = run(
      deliverAgentMemoryExec(places.saved, plan, "", {
        incoming: plan.incoming,
        record: personSavedPathOf(AGENT_MEMORY_DELIVERED),
      }),
    );
    expect(result.status).toBe(0);
    expect(
      fs.readFileSync(
        path.join(places.saved, ".claude/projects/-workspace-repo/memory/MEMORY.md"),
        "utf8",
      ),
    ).toBe("- notes\n");
    expect(fs.readFileSync(path.join(places.saved, "codex-db/memories_1.sqlite"), "utf8")).toBe(
      "a database",
    );
    const record = JSON.parse(
      fs.readFileSync(path.join(places.saved, ".mend-saved/agent-memory-delivered.json"), "utf8"),
    );
    expect(Object.keys(record).toSorted()).toEqual([
      ".claude/projects/-workspace-repo/memory/MEMORY.md",
      "codex-db/memories_1.sqlite",
    ]);
    // Nothing staged is left, no owner record is written, and nothing lands under `.mend`.
    expect(fs.existsSync(path.join(places.saved, plan.incoming))).toBe(false);
    expect(fs.existsSync(path.join(places.saved, ".mend"))).toBe(false);
  });
});

describe("a person's memory already in place (a same-person join)", () => {
  const MEMORY = ".claude/projects/-workspace-repo/memory/MEMORY.md";
  const NOTES = ".claude/projects/-workspace-repo/memory/notes.md";
  /** Stages and runs the delivery program for `files`, into `saved`, as a person's start does. */
  const deliver = (saved: string, files: ReadonlyArray<StoredMemoryFile>) => {
    const plan = mapAgentMemoryPlan(planAgentMemory(files), personSavedPathOf);
    for (const file of plan.staged) {
      const at = path.join(saved, file.path);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, file.bytes);
    }
    const result = run(
      deliverAgentMemoryExec(saved, plan, "", {
        incoming: plan.incoming,
        record: personSavedPathOf(AGENT_MEMORY_DELIVERED),
      }),
    );
    expect(result.status).toBe(0);
    return result.stdout;
  };
  /** Whether a start would skip delivering `files`, from the one records exec it runs anyway. */
  const inPlace = (places: ReturnType<typeof placesIn>, files: ReadonlyArray<StoredMemoryFile>) =>
    personMemoryInPlace(
      mapAgentMemoryPlan(planAgentMemory(files), personSavedPathOf).list,
      parsePersonRecords(
        run(
          personRecordsExec(places, { memoryDelivered: personSavedPathOf(AGENT_MEMORY_DELIVERED) }),
        ).stdout,
      ),
    );
  const memory = [
    stored(MEMORY, "- notes\n"),
    stored(NOTES, "- more\n"),
    stored(CODEX_MEMORY_DATABASE, "a database"),
  ];

  it("is in place after a delivery, and delivering it again would change nothing in P", () => {
    const places = placesIn(tmp());
    expect(inPlace(places, memory)).toBe(false);
    deliver(places.saved, memory);
    expect(inPlace(places, memory)).toBe(true);
    const before = listTree(places.saved);
    deliver(places.saved, memory);
    expect(listTree(places.saved)).toEqual(before);
  });

  it("stays in place when the person's own agent changed a file since: the program leaves it too", () => {
    const places = placesIn(tmp());
    deliver(places.saved, memory);
    fs.writeFileSync(path.join(places.saved, MEMORY), "- notes\n- learned today\n");
    expect(inPlace(places, memory)).toBe(true);
    const before = listTree(places.saved);
    expect(deliver(places.saved, memory)).toContain(`memory left ${MEMORY}`);
    expect(listTree(places.saved)).toEqual(before);
  });

  it("is not in place when the stored memory changed, a file is gone, or a file was left as it was", () => {
    const places = placesIn(tmp());
    deliver(places.saved, memory);
    // The store changed a file: delivered, and in place again after.
    const changed = [stored(MEMORY, "- notes\n- from another session\n"), ...memory.slice(1)];
    expect(inPlace(places, changed)).toBe(false);
    expect(deliver(places.saved, changed)).toContain(`memory written ${MEMORY}`);
    expect(inPlace(places, changed)).toBe(true);
    // A file the store added, or no longer keeps.
    expect(inPlace(places, [...changed, stored(".codex/memories/new.md", "new\n")])).toBe(false);
    expect(inPlace(places, changed.slice(1))).toBe(false);
    // A delivered file gone from P: delivered again.
    fs.rmSync(path.join(places.saved, NOTES));
    expect(inPlace(places, changed)).toBe(false);
    expect(deliver(places.saved, changed)).toContain(`memory written ${NOTES}`);
    expect(inPlace(places, changed)).toBe(true);
  });

  it("is not in place when the last delivery left a file as the session had it", () => {
    const places = placesIn(tmp());
    // A file in P before any delivery, other than the stored one: left, and not recorded.
    fs.mkdirSync(path.dirname(path.join(places.saved, MEMORY)), { recursive: true });
    fs.writeFileSync(path.join(places.saved, MEMORY), "- mine\n");
    expect(deliver(places.saved, memory)).toContain(`memory left ${MEMORY}`);
    expect(inPlace(places, memory)).toBe(false);
  });

  it("is never another person's: Maria's memory is not in place in a P that holds Alice's", () => {
    const places = placesIn(tmp());
    deliver(places.saved, memory);
    expect(inPlace(places, [stored(MEMORY, "- what Maria learned\n")])).toBe(false);
  });

  it("an empty memory delivered is in place; a record not written by the program is not", () => {
    const places = placesIn(tmp());
    deliver(places.saved, []);
    expect(inPlace(places, [])).toBe(true);
    // The same keys, written another way (on one line): not taken as the program's.
    deliver(places.saved, memory);
    const record = path.join(places.saved, personSavedPathOf(AGENT_MEMORY_DELIVERED));
    fs.writeFileSync(record, JSON.stringify(JSON.parse(fs.readFileSync(record, "utf8"))));
    expect(inPlace(places, memory)).toBe(false);
  });
});

describe("a person's carried Codex conversations (decision 9)", () => {
  it("lists them in .mend-saved and lays them in P's Codex sessions", () => {
    const root = tmp();
    const places = placesIn(root);
    const id = "0199a000-0000-7000-8000-000000000001";
    const carry = carryConversationsExec(
      places.saved,
      [
        {
          providerSessionId: id,
          path: `.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${id}.jsonl`,
          gzipped: new Uint8Array(gzipSync(Buffer.from('{"type":"session_meta"}\n'))),
          mtime: 1_700_000_000,
        },
      ],
      {
        listed: personSavedPathOf(CARRIED_TRANSCRIPTS),
        incoming: personSavedPathOf(CARRIED_INCOMING),
      },
    );
    for (const file of carry.staged) {
      fs.mkdirSync(path.dirname(file.path), { recursive: true });
      fs.writeFileSync(file.path, file.bytes);
    }
    const result = run(carry.argv);
    expect(result.stdout).toContain(`carried written ${id}`);
    expect(
      fs.readFileSync(path.join(places.saved, ".mend-saved/carried-transcripts"), "utf8"),
    ).toBe(`${id}\n`);
    expect(
      fs.existsSync(
        path.join(
          places.saved,
          `.codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-${id}.jsonl`,
        ),
      ),
    ).toBe(true);
  });
});

describe("pi's settings through a person's link (decision 2)", () => {
  it("writes the profile's settings into P through R's link, and the link stays a link", () => {
    const root = tmp();
    const places = placesIn(root);
    const agent = path.join(places.home, ".pi/agent");
    fs.mkdirSync(path.join(agent, "mend/profile"), { recursive: true });
    fs.writeFileSync(
      path.join(agent, "mend/profile/settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    // `settings.json` links into P, where nothing is yet.
    fs.mkdirSync(path.join(places.saved, ".pi/agent"), { recursive: true });
    fs.symlinkSync(
      path.join(places.saved, ".pi/agent/settings.json"),
      path.join(agent, "settings.json"),
    );
    const result = spawnSync("node", ["-e", PI_PROFILE_PROGRAM, agent], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(fs.lstatSync(path.join(agent, "settings.json")).isSymbolicLink()).toBe(true);
    const saved = JSON.parse(
      fs.readFileSync(path.join(places.saved, ".pi/agent/settings.json"), "utf8"),
    );
    expect(saved.theme).toBe("dark");
  });
});

const words = (code: string, message = "the daemon's words") =>
  dotfilesRefusalWords({ code, message });

describe("a person's dotfiles Core refused, as the session says it (decisions 11 and 13)", () => {
  it("says what was observed for each of Core's codes, and Core's own words for any other", () => {
    for (const code of [
      "dotfiles-user-unsupported",
      "user-unknown",
      "home-mismatch",
      "home-unusable",
      "home-held",
    ]) {
      expect(words(code)).toMatch(/, so they were not applied$/);
      expect(words(code)).not.toContain("the daemon's words");
    }
    expect(words("workspace-not-running")).toBe(
      "the workspace stopped before the dotfiles were applied",
    );
    expect(words("dotfiles_failed", "chezmoi: exit 1")).toBe(
      "the dotfiles apply failed, so they were not applied: chezmoi: exit 1",
    );
    expect(words("dotfiles_apply_timeout", "dotfiles were not applied within 120 s")).toBe(
      "dotfiles were not applied within 120 s",
    );
    // Core refuses root before staging, with no code (a 400): its own words, never Mend's.
    expect(words("WorkspaceBadRequestError", "root is not a person")).toBe("root is not a person");
  });
});
