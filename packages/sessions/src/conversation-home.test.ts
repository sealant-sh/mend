import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { LinuxIdentity } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import {
  CLAUDE_NEUTRAL_ENV,
  CONVERSATION_LINKS,
  type ConversationHarness,
  claudeSettingsArgOf,
  codexNeutralConfig,
  conversationArgv,
  conversationDirOf,
  conversationHomeOf,
  conversationProcessEnv,
  exchangeConversationHomeScript,
  foreignReasoningLine,
  isForeignReasoningRefusal,
  parseConversationReport,
  stageConversationHomeScript,
  stagedHomeOf,
} from "./conversation-home.ts";
import { savedDirOf } from "./harness-layout.ts";

const alice = new LinuxIdentity({ accountId: "alice-1", name: "m3kq7xj2a", uid: 40_001 });
const bob = new LinuxIdentity({ accountId: "bob-2", name: "mb7ezq4fd", uid: 40_002 });
const SESSION = "s-shared-1";

const temps: Array<string> = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
const children: Array<number> = [];
afterEach(() => {
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const modeOf = (file: string) => fs.statSync(file).mode & 0o7777;

/**
 * An executor's root as the conversation scripts see it, without being root: `id -u` says 0,
 * `chown` and `setfacl` change nothing and log, and `setpriv` logs the uid it was asked for, then
 * runs the rest as the test's own user with `FAKE_UID` set to it, so a fake harness can say whose
 * process it was.
 */
const world = () => {
  const dir = tempDir("mend-conv-");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "log");
  fs.mkdirSync(bin);
  const stub = (name: string, body: string) =>
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("id", `if [ "$1" = -u ] && [ -z "$2" ]; then echo 0; exit 0; fi\nexit 1`);
  stub("chown", `echo "chown $*" >> "${log}"`);
  stub("setfacl", `echo "setfacl $*" >> "${log}"`);
  stub(
    "setpriv",
    `uid=; while [ "$#" -gt 0 ]; do case "$1" in --reuid=*) uid=\${1#--reuid=}; shift ;; --) shift; break ;; -*) shift ;; *) break ;; esac; done\n` +
      `echo "setpriv $uid" >> "${log}"\nFAKE_UID=$uid exec "$@"`,
  );
  const harnessHome = path.join(dir, "harness-home");
  const homesRoot = path.join(dir, "conv");
  const repo = path.join(dir, "repo");
  const homes = {
    [alice.accountId]: path.join(dir, "home-alice"),
    [bob.accountId]: path.join(dir, "home-bob"),
  };
  for (const home of Object.values(homes)) fs.mkdirSync(home, { recursive: true });
  for (const person of [alice, bob]) {
    const saved = savedDirOf(harnessHome, person.accountId);
    fs.mkdirSync(path.join(saved, "conversations"), { recursive: true });
    fs.mkdirSync(path.join(saved, "codex-db"), { recursive: true });
  }
  fs.mkdirSync(repo, { recursive: true });
  const places = { harnessHome, homesRoot, waitTenths: 5 } as const;
  const env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
  const run = (script: string) => spawnSync("sh", ["-c", script], { encoding: "utf8", env });
  return {
    dir,
    harnessHome,
    homesRoot,
    repo,
    homes,
    places,
    env,
    run,
    log: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
    conversation: conversationDirOf(harnessHome, alice.accountId, SESSION),
    home: conversationHomeOf(SESSION, homesRoot),
  };
};
type World = ReturnType<typeof world>;

/**
 * A fake Claude for one turn, as far as this design depends on it: it creates its transcript 0600
 * under `CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl` (or continues the file `--resume` names),
 * writes a large tool output and a sub-agent's transcript under `<id>/` and its task list under
 * `tasks/<id>/`, recording the output's absolute path as Claude does (`persistedOutputPath`).
 * Writing to a file another uid left needs the group's read and write, as it would for real.
 * Its request is what Claude would load: user memory from `CLAUDE_CONFIG_DIR/CLAUDE.md`, the
 * repository's `CLAUDE.md` with `@~/` imports only when `.claude.json` approves external
 * includes, settings `env` merged user < project < local < `--settings`, memory on unless turned
 * off, cron tools unless `CLAUDE_CODE_DISABLE_CRON` says so.
 */
const FAKE_CLAUDE = String.raw`
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const dir = process.env.CLAUDE_CONFIG_DIR;
const uid = process.env.FAKE_UID;
const fail = (why) => { process.stderr.write(why + "\n"); process.exit(1); };
let id = flag("--session-id"), transcript, turn = 1;
const resume = flag("--resume");
if (resume !== null) {
  if (!resume.startsWith("/")) fail("resume by path only");
  if (!fs.existsSync(resume)) fail("No conversation found at " + resume);
  transcript = resume;
  id = path.basename(resume, ".jsonl");
  const lines = fs.readFileSync(transcript, "utf8").trim().split("\n");
  const last = JSON.parse(lines.at(-1));
  turn = lines.length + 1;
  if (last.uid !== uid) {
    for (const p of [transcript, path.join(path.dirname(transcript), id)]) {
      if (fs.existsSync(p) && (fs.statSync(p).mode & 0o060) !== 0o060) fail("permission denied: " + p);
    }
  }
} else {
  transcript = path.join(dir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), id + ".jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.closeSync(fs.openSync(transcript, "wx", 0o600));
  fs.chmodSync(transcript, 0o600);
}
const results = path.join(path.dirname(transcript), id, "tool-results");
fs.mkdirSync(results, { recursive: true });
const output = path.join(results, "turn-" + turn + ".txt");
fs.writeFileSync(output, "x".repeat(200000));
const agents = path.join(path.dirname(transcript), id, "subagents");
fs.mkdirSync(agents, { recursive: true });
fs.writeFileSync(path.join(agents, "agent-" + turn + ".jsonl"), JSON.stringify({ turn }) + "\n");
const tasks = path.join(dir, "tasks", id);
fs.mkdirSync(tasks, { recursive: true });
fs.writeFileSync(path.join(tasks, turn + ".json"), JSON.stringify({ subject: "task " + turn, by: uid }));
fs.appendFileSync(transcript, JSON.stringify({ turn, uid, persistedOutputPath: output, tasks: fs.readdirSync(tasks).length }) + "\n");
// What Claude would send.
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const json = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
const global = json(path.join(dir, ".claude.json"));
let instructions = [read(path.join(dir, "CLAUDE.md")), read(path.join(dir, "rules", "personal.md"))].filter(Boolean).join("\n");
const repoMd = read(path.join(process.cwd(), "CLAUDE.md")) ?? "";
instructions += "\n" + repoMd.replace(/@~\/(\S+)/g, (_, rel) => global.hasClaudeMdExternalIncludesApproved === true ? (read(path.join(process.env.HOME, rel)) ?? "") : "");
const settingsFile = flag("--settings");
// Claude takes \`--settings\` as a file or as JSON inline.
const flagLayer = settingsFile === null ? [] : [settingsFile.trim().startsWith("{") ? JSON.parse(settingsFile) : json(settingsFile)];
const layers = [...[path.join(dir, "settings.json"), path.join(process.cwd(), ".claude", "settings.json"), path.join(process.cwd(), ".claude", "settings.local.json")].map(json), ...flagLayer];
const env = Object.assign({}, process.env, ...layers.map((layer) => layer.env ?? {}));
const autoMemory = layers.every((layer) => layer.autoMemoryEnabled !== false) && env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1";
const memoryDir = path.join(dir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), "memory");
if (autoMemory) { fs.mkdirSync(memoryDir, { recursive: true }); fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "remembered"); }
const tools = ["Bash", "Read", ...(env.CLAUDE_CODE_DISABLE_CRON === "1" ? [] : ["CronCreate", "CronDelete", "CronList"])];
const mcp = Object.keys(global.mcpServers ?? {});
fs.appendFileSync(process.env.FAKE_REQUEST_OUT, JSON.stringify({ uid, instructions, autoMemory, tools, mcp, memorySection: autoMemory ? read(path.join(memoryDir, "MEMORY.md")) : null }) + "\n");
`;

/**
 * A fake Codex app-server for one turn: a new thread or the rollout `FAKE_RESUME_PATH` names
 * (refused when it is missing, as `thread/resume { path }` is), a sub-agent thread whose rollout's
 * first line names its parent, the thread index in `CODEX_SQLITE_HOME/state_5.sqlite`, and, with
 * `FAKE_GIT_CHILD`, a child (Codex's plugin sync or git) that outlives the app-server. Its request
 * is what Codex would load: `CODEX_HOME/AGENTS.md`, `$HOME/.agents/skills`, the repository's
 * `AGENTS.md`, and its memory and plugin switches.
 */
const FAKE_CODEX = String.raw`
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const fail = (why) => { process.stderr.write(why + "\n"); process.exit(1); };
const home = process.env.CODEX_HOME, uid = process.env.FAKE_UID;
let rollout = process.env.FAKE_RESUME_PATH || null, id;
if (rollout !== null) {
  if (!fs.existsSync(rollout)) fail("no rollout found for thread id " + path.basename(rollout));
  id = /-([0-9a-f-]{36})\.jsonl$/.exec(rollout)[1];
  const last = JSON.parse(fs.readFileSync(rollout, "utf8").trim().split("\n").at(-1));
  if (last.uid !== undefined && last.uid !== uid && (fs.statSync(rollout).mode & 0o060) !== 0o060) fail("permission denied: " + rollout);
} else {
  id = process.env.FAKE_THREAD;
  rollout = path.join(home, "sessions", "2026", "10", "07", "rollout-2026-10-07T10-00-00-" + id + ".jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n", { mode: 0o600 });
}
const child = process.env.FAKE_CHILD_THREAD;
if (child) {
  const sub = path.join(path.dirname(rollout), "rollout-2026-10-07T10-00-01-" + child + ".jsonl");
  fs.writeFileSync(sub, JSON.stringify({ type: "session_meta", payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: id } } } } }) + "\n");
}
fs.appendFileSync(rollout, JSON.stringify({ type: "turn", uid }) + "\n");
fs.mkdirSync(process.env.CODEX_SQLITE_HOME, { recursive: true });
const db = new DatabaseSync(path.join(process.env.CODEX_SQLITE_HOME, "state_5.sqlite"));
db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY)");
db.prepare("INSERT OR IGNORE INTO threads (id) VALUES (?)").run(id);
db.close();
if (process.env.FAKE_GIT_CHILD) {
  const git = cp.spawn("sleep", ["30"], { cwd: home, detached: true, stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_GIT_CHILD, String(git.pid));
  git.unref();
}
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const config = read(path.join(home, "config.toml")) ?? "";
let skills = [];
try { skills = fs.readdirSync(path.join(process.env.HOME, ".agents", "skills")); } catch {}
const shellHome = (/HOME = "([^"]+)"/.exec(config) ?? [])[1] ?? process.env.HOME;
fs.appendFileSync(process.env.FAKE_REQUEST_OUT, JSON.stringify({ uid, thread: id, instructions: [read(path.join(home, "AGENTS.md")), read(path.join(process.cwd(), "AGENTS.md"))].filter(Boolean).join("\n"), skills, memories: !/memories = false/.test(config), plugins: !/plugins = false/.test(config), shellHome }) + "\n");
`;

/** One turn of the conversation, by `sender`: the restart path, then the fake harness. */
const turnBy = (
  w: World,
  input: {
    readonly harness: ConversationHarness;
    readonly sender: LinuxIdentity;
    readonly providerSessionId: string | null;
    readonly move: boolean;
    readonly newId?: string;
    readonly childThread?: string;
    readonly gitChild?: string;
  },
) => {
  const stage = w.run(
    stageConversationHomeScript({
      sessionId: SESSION,
      harness: input.harness,
      owner: alice,
      sender: input.sender,
      providerSessionId: input.providerSessionId,
      model: input.harness === "codex" ? "gpt-6" : null,
      move: input.move,
      places: w.places,
      senderHome: w.homes[input.sender.accountId] ?? "",
    }),
  );
  expect(stage.stderr).toBe("");
  expect(stage.status).toBe(0);
  const staged = parseConversationReport(stage.stdout);
  if (staged.missing) return { staged, exchanged: null, harness: null };
  const exchange = w.run(
    exchangeConversationHomeScript({ sessionId: SESSION, owner: alice, places: w.places }),
  );
  expect(exchange.stderr).toBe("");
  expect(exchange.status).toBe(0);
  const exchanged = parseConversationReport(exchange.stdout);
  const fake = path.join(w.dir, input.harness === "claude" ? "claude.js" : "codex.js");
  if (!fs.existsSync(fake))
    fs.writeFileSync(fake, input.harness === "claude" ? FAKE_CLAUDE : FAKE_CODEX);
  const base =
    input.harness === "claude"
      ? input.providerSessionId === null
        ? ["claude", "--print", "--session-id", input.newId ?? ""]
        : ["claude", "--print", "--resume", input.providerSessionId]
      : ["codex", "app-server"];
  const argv = conversationArgv({
    harness: input.harness,
    argv: base,
    resumePath: staged.resume,
  });
  const env = conversationProcessEnv({
    harness: input.harness,
    sessionId: SESSION,
    root: w.homesRoot,
    personEnv: {
      CODEX_SQLITE_HOME: path.join(savedDirOf(w.harnessHome, input.sender.accountId), "codex-db"),
      MEND_SESSION_ID: SESSION,
    },
  });
  const harness = spawnSync(process.execPath, [fake, ...argv.slice(1)], {
    cwd: w.repo,
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      // sealantd's passwd identity; the conversation's own environment wins over it.
      HOME: w.homes[input.sender.accountId] ?? "",
      ...env,
      FAKE_UID: String(input.sender.uid),
      FAKE_REQUEST_OUT: path.join(w.dir, "requests.jsonl"),
      ...(input.newId === undefined ? {} : { FAKE_THREAD: input.newId }),
      ...(input.harness === "codex" && staged.resume !== null
        ? { FAKE_RESUME_PATH: staged.resume }
        : {}),
      ...(input.childThread === undefined ? {} : { FAKE_CHILD_THREAD: input.childThread }),
      ...(input.gitChild === undefined ? {} : { FAKE_GIT_CHILD: input.gitChild }),
    },
  });
  return { staged, exchanged, harness };
};

const requests = (w: World) =>
  fs
    .readFileSync(path.join(w.dir, "requests.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

describe("Claude's settings (decision 6)", () => {
  it("are passed inline, so no file has to be there: neutral, no-cron and personal", () => {
    expect(JSON.parse(claudeSettingsArgOf("neutral"))).toEqual({
      autoMemoryEnabled: false,
      env: {
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
        CLAUDE_CODE_DISABLE_CRON: "1",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      },
    });
    expect(JSON.parse(claudeSettingsArgOf("no-cron"))).toEqual({
      env: { CLAUDE_CODE_DISABLE_CRON: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    });
    expect(JSON.parse(claudeSettingsArgOf("personal"))).toEqual({
      env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
    });
  });
});

describe("one shared Claude conversation, each turn on its sender's user (Delivery 17)", () => {
  it("Alice's transcript is created 0600, Bob's resume works, then Alice's again: five turns, two uids", () => {
    const w = world();
    const id = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
    const senders = [alice, bob, alice, bob, alice];
    let mode: number | null = null;
    senders.forEach((sender, index) => {
      const turn = turnBy(w, {
        harness: "claude",
        sender,
        providerSessionId: index === 0 ? null : id,
        newId: id,
        move: index === 0,
      });
      expect(turn.harness?.stderr).toBe("");
      expect(turn.harness?.status).toBe(0);
      const transcript = path.join(
        w.conversation,
        ".claude/projects",
        "-" + w.repo.slice(1).replaceAll(/[^A-Za-z0-9]/g, "-"),
        `${id}.jsonl`,
      );
      if (index === 0) {
        // Claude made it 0600, as it always does; the next process's restart gives the group back.
        mode = modeOf(transcript);
      } else {
        expect(turn.staged.resume).toBe(
          `${w.home}/.claude/projects/${path.basename(path.dirname(transcript))}/${id}.jsonl`,
        );
        expect(turn.exchanged?.exchanged).toMatch(/^renameat2|renames$/);
      }
    });
    expect(mode).toBe(0o600);
    const transcriptDir = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    const lines = fs
      .readFileSync(
        path.join(w.conversation, ".claude/projects", transcriptDir, `${id}.jsonl`),
        "utf8",
      )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.uid)).toEqual(["40001", "40002", "40001", "40002", "40001"]);
    // Each person's staging and seed ran as them, the move as the owner.
    const asWhom = w
      .log()
      .split("\n")
      .filter((line) => line.startsWith("setpriv "));
    expect(asWhom).toEqual([
      "setpriv 40001", // move, as Alice (the owner)
      "setpriv 40001", // Alice's seed
      "setpriv 40002",
      "setpriv 40001",
      "setpriv 40002",
      "setpriv 40001",
    ]);
    expect(w.log()).toContain(`chown 40002:40000 ${stagedHomeOf(SESSION, w.homesRoot)}`);
    // `H` is one fixed path whoever runs, and nothing of a previous sender's home is left beside it.
    expect(fs.existsSync(stagedHomeOf(SESSION, w.homesRoot))).toBe(false);
  });

  it("puts a steered turn's large tool output and its sub-agent's transcript in C, where they stay", () => {
    const w = world();
    const id = "1c5b2f0e-4a7d-4e2b-8a11-3d9e6f0b7c22";
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    const steered = turnBy(w, {
      harness: "claude",
      sender: bob,
      providerSessionId: id,
      move: false,
    });
    expect(steered.harness?.status).toBe(0);
    const project = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    const under = path.join(w.conversation, ".claude/projects", project, id);
    expect(fs.statSync(path.join(under, "tool-results/turn-2.txt")).size).toBe(200_000);
    expect(fs.existsSync(path.join(under, "subagents/agent-2.jsonl"))).toBe(true);
    // Another change of sender keeps them: nothing is deleted when a steer ends.
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: id, move: false });
    expect(fs.statSync(path.join(under, "tool-results/turn-2.txt")).size).toBe(200_000);
    // Their recorded paths are under H, the same for every person, and resolve to C.
    const lines = fs.readFileSync(
      path.join(w.conversation, ".claude/projects", project, `${id}.jsonl`),
      "utf8",
    );
    for (const line of lines.trim().split("\n")) {
      const recorded: string = JSON.parse(line).persistedOutputPath;
      expect(recorded.startsWith(`${w.home}/.claude/projects/`)).toBe(true);
      expect(fs.realpathSync(recorded).startsWith(fs.realpathSync(w.conversation))).toBe(true);
    }
  });

  it("keeps the task list across a change of sender", () => {
    const w = world();
    const id = "6a1d0c3b-9e8f-4f5a-b2c7-0d4e1f2a3b44";
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    turnBy(w, { harness: "claude", sender: bob, providerSessionId: id, move: false });
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: id, move: false });
    const tasks = fs.readdirSync(path.join(w.conversation, ".claude/tasks", id)).toSorted();
    expect(tasks).toEqual(["1.json", "2.json", "3.json"]);
    const project = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    const seen = fs
      .readFileSync(path.join(w.conversation, ".claude/projects", project, `${id}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).tasks);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("has no path under the steerer's home in the owner's transcript", () => {
    const w = world();
    const id = "9b2e4d6f-1a3c-4e5b-8d7f-2c4e6a8b0d55";
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    turnBy(w, { harness: "claude", sender: bob, providerSessionId: id, move: false });
    const project = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    const transcript = fs.readFileSync(
      path.join(w.conversation, ".claude/projects", project, `${id}.jsonl`),
      "utf8",
    );
    expect(transcript).not.toContain(w.homes[bob.accountId]);
    expect(transcript).not.toContain(w.homes[alice.accountId]);
  });

  it("keeps every personal canary and the env canary out of the request: no memory, no cron tools", () => {
    const w = world();
    const id = "3e5f7a9b-2c4d-4e6f-9a1b-5c7d9e1f3a66";
    // Bob's own Claude home: instructions, rules, MCP servers, settings that turn memory on.
    const bobs = path.join(w.homes[bob.accountId] ?? "", ".claude");
    fs.mkdirSync(path.join(bobs, "rules"), { recursive: true });
    fs.writeFileSync(path.join(bobs, "CLAUDE.md"), "CANARY-BOB-HOME");
    fs.writeFileSync(path.join(bobs, "rules", "personal.md"), "CANARY-BOB-RULES");
    fs.writeFileSync(
      path.join(w.homes[bob.accountId] ?? "", ".claude.json"),
      JSON.stringify({ mcpServers: { private: {} }, hasClaudeMdExternalIncludesApproved: true }),
    );
    fs.writeFileSync(path.join(w.homes[bob.accountId] ?? "", "private.md"), "CANARY-IMPORT");
    // The repository's CLAUDE.md imports a personal file; the repository's and the worktree's
    // local settings try to turn memory and crons back on.
    fs.writeFileSync(path.join(w.repo, "CLAUDE.md"), "Repository rules.\n@~/private.md\n");
    fs.mkdirSync(path.join(w.repo, ".claude"), { recursive: true });
    const envCanary = {
      env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0", CLAUDE_CODE_DISABLE_CRON: "" },
    };
    fs.writeFileSync(path.join(w.repo, ".claude", "settings.json"), JSON.stringify(envCanary));
    fs.writeFileSync(
      path.join(w.repo, ".claude", "settings.local.json"),
      JSON.stringify(envCanary),
    );
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    turnBy(w, { harness: "claude", sender: bob, providerSessionId: id, move: false });
    for (const request of requests(w)) {
      expect(request.instructions).toContain("Repository rules.");
      expect(request.instructions).not.toMatch(/CANARY/);
      expect(request.mcp).toEqual([]);
      expect(request.autoMemory).toBe(false);
      expect(request.memorySection).toBeNull();
      expect(request.tools).not.toContain("CronCreate");
    }
    const project = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    expect(fs.existsSync(path.join(w.conversation, ".claude/projects", project, "memory"))).toBe(
      false,
    );
  });

  it("moves Alice's conversation into C once, never over anything, and leaves the rest of her saved directory alone", () => {
    const w = world();
    const id = "7c9e1a3b-5d7f-4b9c-8e2a-4f6b8d0c2e77";
    const saved = savedDirOf(w.harnessHome, alice.accountId);
    const project = path.join(saved, ".claude/projects/-workspace-repo");
    fs.mkdirSync(path.join(project, id, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(project, `${id}.jsonl`), `{"uid":"40001","turn":1}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(path.join(project, id, "subagents", "agent-1.jsonl"), "{}\n");
    fs.writeFileSync(path.join(project, "other-conversation.jsonl"), "{}\n");
    fs.mkdirSync(path.join(saved, ".claude/tasks", id), { recursive: true });
    fs.writeFileSync(path.join(saved, ".claude/tasks", id, "1.json"), "{}");
    fs.mkdirSync(path.join(saved, ".claude/projects/-workspace-repo/memory"), { recursive: true });
    fs.writeFileSync(path.join(saved, ".claude/projects/-workspace-repo/memory/MEMORY.md"), "hers");
    const first = turnBy(w, {
      harness: "claude",
      sender: alice,
      providerSessionId: id,
      move: true,
    });
    expect(first.staged.moved).toBe(3);
    const moved = path.join(w.conversation, ".claude/projects/-workspace-repo");
    expect(fs.existsSync(path.join(moved, `${id}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(moved, id, "subagents", "agent-1.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(w.conversation, ".claude/tasks", id, "1.json"))).toBe(true);
    // Her other conversations and her memory stay hers.
    expect(fs.existsSync(path.join(project, "other-conversation.jsonl"))).toBe(true);
    expect(
      fs.readFileSync(
        path.join(saved, ".claude/projects/-workspace-repo/memory/MEMORY.md"),
        "utf8",
      ),
    ).toBe("hers");
    expect(fs.existsSync(path.join(moved, "memory"))).toBe(false);
    // C is the group's: setgid 2770.
    expect(modeOf(w.conversation) & 0o2770).toBe(0o2770);
    // Running it again moves nothing and overwrites nothing.
    fs.writeFileSync(path.join(project, `${id}.jsonl`), "a stray personal copy\n");
    const again = w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "claude",
        owner: alice,
        sender: alice,
        providerSessionId: id,
        model: null,
        move: true,
        places: w.places,
      }),
    );
    const report = parseConversationReport(again.stdout);
    expect(report.moved).toBe(0);
    expect(report.kept).toEqual([path.join(project, `${id}.jsonl`)]);
    expect(fs.readFileSync(path.join(moved, `${id}.jsonl`), "utf8")).toContain('"turn":1');
  });

  it("never follows a link the owner put in C's place: Bob's login stays his (review of mend#572, P2-A)", () => {
    const w = world();
    const id = "4a6c8e0a-2b4d-4f6a-8c0e-2a4c6e8a0b99";
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    // A stand-in for Bob's home, his login in it.
    const bobs = path.join(w.dir, "bob-elsewhere");
    fs.mkdirSync(path.join(bobs, ".claude"), { recursive: true, mode: 0o700 });
    fs.chmodSync(bobs, 0o700);
    fs.writeFileSync(path.join(bobs, ".claude", ".credentials.json"), "{}", { mode: 0o600 });
    // Bob's staging ran; then Alice swaps C for a link to Bob's home before the exchange.
    w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "claude",
        owner: alice,
        sender: bob,
        providerSessionId: id,
        model: null,
        move: false,
        places: w.places,
      }),
    );
    fs.renameSync(w.conversation, `${w.conversation}.moved`);
    fs.symlinkSync(bobs, w.conversation);
    const exchange = w.run(
      exchangeConversationHomeScript({ sessionId: SESSION, owner: alice, places: w.places }),
    );
    expect(exchange.status).not.toBe(0);
    expect(exchange.stderr).toContain("unexpected link");
    expect(modeOf(bobs)).toBe(0o700);
    expect(modeOf(path.join(bobs, ".claude", ".credentials.json"))).toBe(0o600);
    // And a link above C (the owner's conversations/ directory) reaches nothing either.
    fs.unlinkSync(w.conversation);
    fs.renameSync(`${w.conversation}.moved`, w.conversation);
    const conversations = path.dirname(w.conversation);
    const elsewhere = path.join(w.dir, "conversations-elsewhere");
    fs.renameSync(conversations, elsewhere);
    fs.symlinkSync(elsewhere, conversations);
    const above = w.run(
      exchangeConversationHomeScript({ sessionId: SESSION, owner: alice, places: w.places }),
    );
    expect(above.status).not.toBe(0);
    expect(above.stderr).toContain("is not where it should be");
  });

  it("restores the group's access a harness's 0600 files masked, before each process", () => {
    const w = world();
    const id = "2d4f6b8d-0e2a-4c4e-9b6d-8f0a2c4e6a88";
    turnBy(w, { harness: "claude", sender: alice, providerSessionId: null, newId: id, move: true });
    const project = fs.readdirSync(path.join(w.conversation, ".claude/projects"))[0] ?? "";
    const transcript = path.join(w.conversation, ".claude/projects", project, `${id}.jsonl`);
    expect(modeOf(transcript)).toBe(0o600);
    w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "claude",
        owner: alice,
        sender: bob,
        providerSessionId: id,
        model: null,
        move: false,
        places: w.places,
      }),
    );
    w.run(exchangeConversationHomeScript({ sessionId: SESSION, owner: alice, places: w.places }));
    expect(modeOf(transcript)).toBe(0o660);
    expect(modeOf(path.join(w.conversation, ".claude/projects", project, id)) & 0o2070).toBe(
      0o2070,
    );
  });
});

describe("one shared Codex conversation (Delivery 17)", () => {
  const thread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
  const child = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c";

  it("puts a steered turn's sub-agent rollout in C, and stays there", () => {
    const w = world();
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
    });
    const steered = turnBy(w, {
      harness: "codex",
      sender: bob,
      providerSessionId: thread,
      move: false,
      childThread: child,
    });
    expect(steered.harness?.stderr).toBe("");
    expect(steered.staged.resume).toMatch(
      new RegExp(`^${w.home}/\\.codex/sessions/.*-${thread}\\.jsonl$`),
    );
    const day = path.join(w.conversation, ".codex/sessions/2026/10/07");
    expect(fs.readdirSync(day).toSorted()).toEqual([
      `rollout-2026-10-07T10-00-00-${thread}.jsonl`,
      `rollout-2026-10-07T10-00-01-${child}.jsonl`,
    ]);
    turnBy(w, { harness: "codex", sender: alice, providerSessionId: thread, move: false });
    expect(fs.existsSync(path.join(day, `rollout-2026-10-07T10-00-01-${child}.jsonl`))).toBe(true);
  });

  it("leaves no row for Alice's thread in Bob's saved index after his steered turn", () => {
    const w = world();
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
    });
    turnBy(w, { harness: "codex", sender: bob, providerSessionId: thread, move: false });
    const bobsIndex = path.join(
      savedDirOf(w.harnessHome, bob.accountId),
      "codex-db",
      "state_5.sqlite",
    );
    if (fs.existsSync(bobsIndex)) {
      const db = new DatabaseSync(bobsIndex);
      expect(db.prepare("SELECT id FROM threads WHERE id = ?").all(thread)).toEqual([]);
      db.close();
    }
    // Nor in Alice's: the shared conversation enters no person's saved index.
    expect(
      fs.existsSync(
        path.join(savedDirOf(w.harnessHome, alice.accountId), "codex-db", "state_5.sqlite"),
      ),
    ).toBe(false);
  });

  it("keeps the personal canaries out: no personal AGENTS.md or skills, memories and plugins off, tools on the sender's home", () => {
    const w = world();
    const bobs = w.homes[bob.accountId] ?? "";
    fs.mkdirSync(path.join(bobs, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(bobs, ".codex", "AGENTS.md"), "CANARY-BOB-AGENTS");
    fs.mkdirSync(path.join(bobs, ".agents", "skills", "private-skill"), { recursive: true });
    fs.writeFileSync(path.join(w.repo, "AGENTS.md"), "Repository agents.");
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
    });
    turnBy(w, { harness: "codex", sender: bob, providerSessionId: thread, move: false });
    const [, steered] = requests(w);
    expect(steered.uid).toBe("40002");
    expect(steered.instructions).toBe("Repository agents.");
    expect(steered.skills).toEqual([]);
    expect(steered.memories).toBe(false);
    expect(steered.plugins).toBe(false);
    expect(steered.shellHome).toBe(bobs);
  });

  it("ends a git child an exited app-server left behind before the exchange, which never meets a busy directory", async () => {
    const w = world();
    const pidFile = path.join(w.dir, "git-child.pid");
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
      gitChild: pidFile,
    });
    const gitChild = Number(fs.readFileSync(pidFile, "utf8"));
    children.push(gitChild);
    expect(() => process.kill(gitChild, 0)).not.toThrow();
    const next = turnBy(w, {
      harness: "codex",
      sender: bob,
      providerSessionId: thread,
      move: false,
    });
    expect(next.staged.ended).toBe(1);
    expect(next.staged.empty).toBe(true);
    expect(next.exchanged?.exchanged).toMatch(/^renameat2|renames$/);
    // Gone: a zombie at most, until its parent (the test runner) reaps it.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(gitChild)], {
      encoding: "utf8",
    }).stdout.trim();
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("waits for the old process to exit before it says the group is empty", async () => {
    const w = world();
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
    });
    // The old app-server, still stopping: it carries the conversation's marker.
    const old = spawn("sleep", ["0.3"], {
      env: { ...process.env, MEND_CONVERSATION: SESSION },
      stdio: "ignore",
    });
    if (old.pid !== undefined) children.push(old.pid);
    const started = Date.now();
    const stage = w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "codex",
        owner: alice,
        sender: bob,
        providerSessionId: thread,
        model: null,
        move: false,
        places: { ...w.places, waitTenths: 50 },
      }),
    );
    const report = parseConversationReport(stage.stdout);
    expect(report.empty).toBe(true);
    expect(report.ended).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("moves Alice's thread and the threads it spawned into C, and nothing else of hers", () => {
    const w = world();
    const saved = savedDirOf(w.harnessHome, alice.accountId);
    const day = path.join(saved, ".codex/sessions/2026/10/06");
    fs.mkdirSync(day, { recursive: true });
    const own = `rollout-2026-10-06T09-00-00-${thread}.jsonl`;
    const spawned = `rollout-2026-10-06T09-05-00-${child}.jsonl`;
    const unrelated = "rollout-2026-10-06T08-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7d.jsonl";
    fs.writeFileSync(
      path.join(day, own),
      `${JSON.stringify({ type: "session_meta", payload: { id: thread } })}\n`,
    );
    fs.writeFileSync(
      path.join(day, spawned),
      `${JSON.stringify({ type: "session_meta", payload: { id: child, source: { subagent: { thread_spawn: { parent_thread_id: thread } } } } })}\n`,
    );
    fs.writeFileSync(
      path.join(day, unrelated),
      `${JSON.stringify({ type: "session_meta", payload: { id: "other" } })}\n`,
    );
    fs.writeFileSync(
      path.join(saved, ".codex/session_index.jsonl"),
      `${JSON.stringify({ id: thread, thread_name: "shared" })}\n${JSON.stringify({ id: "other" })}\n`,
    );
    const first = turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: thread,
      move: true,
    });
    expect(first.staged.moved).toBe(2);
    const moved = path.join(w.conversation, ".codex/sessions/2026/10/06");
    expect(fs.readdirSync(moved).toSorted()).toEqual([own, spawned]);
    expect(fs.readdirSync(day)).toEqual([unrelated]);
    const index = () =>
      fs.readFileSync(path.join(w.conversation, ".codex/session_index.jsonl"), "utf8");
    expect(index()).toBe(`${JSON.stringify({ id: thread, thread_name: "shared" })}\n`);
    // Moved again (a move that ran twice): nothing moves, and the index line is not doubled.
    w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "codex",
        owner: alice,
        sender: alice,
        providerSessionId: thread,
        model: null,
        move: true,
        places: w.places,
      }),
    );
    expect(index()).toBe(`${JSON.stringify({ id: thread, thread_name: "shared" })}\n`);
  });

  it("says the group is busy when a leftover outlives the kill, so nothing is exchanged over it", () => {
    const w = world();
    turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: null,
      newId: thread,
      move: true,
    });
    // A process list where one entry carries the marker and no kill can end it.
    const proc = path.join(w.dir, "proc");
    fs.mkdirSync(path.join(proc, "4242424"), { recursive: true });
    fs.writeFileSync(
      path.join(proc, "4242424", "environ"),
      `PATH=/bin\0MEND_CONVERSATION=${SESSION}\0`,
    );
    const stage = w.run(
      stageConversationHomeScript({
        sessionId: SESSION,
        harness: "codex",
        owner: alice,
        sender: bob,
        providerSessionId: thread,
        model: null,
        move: false,
        places: { ...w.places, procRoot: proc, waitTenths: 2 },
      }),
    );
    const report = parseConversationReport(stage.stdout);
    expect(report.ended).toBe(1);
    expect(report.empty).toBe(false);
  });

  it("moves only the threads Alice's thread spawned or forked, never one that merely mentions it", () => {
    const w = world();
    const saved = savedDirOf(w.harnessHome, alice.accountId);
    const day = path.join(saved, ".codex/sessions/2026/10/06");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, `rollout-2026-10-06T09-00-00-${thread}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: thread } })}\n`,
    );
    const mentions = "rollout-2026-10-06T08-00-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7e.jsonl";
    fs.writeFileSync(
      path.join(day, mentions),
      `${JSON.stringify({ type: "session_meta", payload: { id: "other", instructions: `see ${thread}` } })}\n`,
    );
    const forked = "rollout-2026-10-06T09-10-00-0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a7f.jsonl";
    fs.writeFileSync(
      path.join(day, forked),
      `${JSON.stringify({ type: "session_meta", payload: { id: "fork", forked_from_id: thread } })}\n`,
    );
    const first = turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: thread,
      move: true,
    });
    expect(first.staged.moved).toBe(2);
    expect(fs.readdirSync(day)).toEqual([mentions]);
  });

  it("fails the turn when the rollout is missing: nothing is staged into H and nothing starts", () => {
    const w = world();
    const missing = turnBy(w, {
      harness: "codex",
      sender: alice,
      providerSessionId: thread,
      move: true,
    });
    expect(missing.staged.missing).toBe(true);
    expect(missing.harness).toBeNull();
    expect(fs.existsSync(w.home)).toBe(false);
  });
});

describe("what a conversation home's process gets", () => {
  it("Claude: its directory at H, the neutral switches in the environment too, no Codex index, no seed wrapper", () => {
    const env = conversationProcessEnv({
      harness: "claude",
      sessionId: SESSION,
      personEnv: {
        CODEX_SQLITE_HOME: "/workspace/harness-home/people/bob-2/codex-db",
        MEND_SESSION_ID: SESSION,
      },
    });
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(`/run/mend/conv/${SESSION}/.claude`);
    expect(env["CODEX_SQLITE_HOME"]).toBeUndefined();
    for (const [key, value] of Object.entries(CLAUDE_NEUTRAL_ENV)) expect(env[key]).toBe(value);
    expect(env["MEND_CONVERSATION"]).toBe(SESSION);
    expect(
      conversationArgv({
        harness: "claude",
        argv: ["claude", "--print", "--resume", "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11"],
        resumePath: `/run/mend/conv/${SESSION}/.claude/projects/-workspace-repo/8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11.jsonl`,
      }),
    ).toEqual([
      "claude",
      "--print",
      "--resume",
      `/run/mend/conv/${SESSION}/.claude/projects/-workspace-repo/8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11.jsonl`,
      "--settings",
      claudeSettingsArgOf("neutral"),
    ]);
  });

  it("Codex: HOME, CODEX_HOME and its index at H, memories and plugins off on the command line too", () => {
    const env = conversationProcessEnv({
      harness: "codex",
      sessionId: SESSION,
      personEnv: { CODEX_SQLITE_HOME: "/workspace/harness-home/people/bob-2/codex-db" },
    });
    expect(env["HOME"]).toBe(`/run/mend/conv/${SESSION}`);
    expect(env["CODEX_HOME"]).toBe(`/run/mend/conv/${SESSION}/.codex`);
    expect(env["CODEX_SQLITE_HOME"]).toBe(`/run/mend/conv/${SESSION}/.codex`);
    expect(
      conversationArgv({ harness: "codex", argv: ["codex", "app-server"], resumePath: null }),
    ).toEqual([
      "codex",
      "-c",
      "features.memories=false",
      "-c",
      "features.plugins=false",
      "-c",
      "features.daemon_auto_start=false",
      "-c",
      "features.shell_snapshot=false",
      "app-server",
    ]);
    const config = codexNeutralConfig({ senderHome: "/home/mb7ezq4fd", model: "gpt-6" });
    expect(config).toContain(`set = { HOME = "/home/mb7ezq4fd" }`);
    expect(config).toContain("plugins = false");
    expect(config).not.toContain("mcp_servers");
  });

  it("links only conversation state into C: never Codex's prompt history nor Claude's file history", () => {
    const paths = [...CONVERSATION_LINKS.claude, ...CONVERSATION_LINKS.codex].map(
      (link) => link.path,
    );
    expect(paths).not.toContain(".codex/history.jsonl");
    expect(paths.some((entry) => entry.includes("file-history"))).toBe(false);
  });

  it("refuses a session id that cannot name a directory", () => {
    expect(() => conversationHomeOf("../etc")).toThrow();
  });
});

describe("a rejection of reasoning made on another account (decision 6)", () => {
  it("is recognised in Codex's and Anthropic's words, and nothing else", () => {
    expect(
      isForeignReasoningRefusal(
        "invalid_encrypted_content: The encrypted content could not be verified",
      ),
    ).toBe(true);
    expect(
      isForeignReasoningRefusal(
        "API Error: 400 messages.3.content.0: Invalid `signature` in `thinking` block",
      ),
    ).toBe(true);
    expect(isForeignReasoningRefusal("401 Unauthorized")).toBe(false);
    expect(isForeignReasoningRefusal(null)).toBe(false);
  });

  it("fails the turn with the provider's reason and who can continue", () => {
    expect(foreignReasoningLine({ harness: "codex", sender: "Bob", previous: "Alice" })).toBe(
      "Bob's turn failed: OpenAI refused reasoning made on Alice's account. Alice can continue the conversation.",
    );
    expect(foreignReasoningLine({ harness: "claude", sender: "Bob", previous: "Alice" })).toContain(
      "Anthropic",
    );
  });
});
