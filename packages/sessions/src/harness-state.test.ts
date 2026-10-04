import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { writeOpencodeDatabase } from "../test/opencode-db.ts";
import {
  CAPTURED_LOGIN_FILES,
  HARNESS_HOME_MOUNT_PATH,
  HARNESS_STATE,
  distillOpeningPrompt,
  extractTranscript,
  hasLiveConversation,
  hasLiveHarnessState,
  harvestHarnessStateScript,
  locateLiveTranscript,
  HARNESS_HOME_CREDENTIALS,
  nativeResumeArgv,
  relocateHarnessHomeScript,
} from "./harness-state.ts";

const claudeJsonl = [
  JSON.stringify({ type: "summary", summary: "ignored" }),
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: { role: "user", content: "meta line — ignored" },
  }),
  JSON.stringify({ type: "user", message: { role: "user", content: "add a health endpoint" } }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Added /health returning ok." },
        { type: "tool_use", id: "t1", name: "Edit", input: {} },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
  }),
  "not json",
].join("\n");

const codexJsonl = [
  JSON.stringify({ type: "session_meta", payload: { id: "abc" } }),
  JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "" },
        { type: "text", text: "rename the flag" },
      ],
    },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "reasoning", summary: [] },
  }),
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "text", text: "Renamed." }] },
  }),
].join("\n");

describe("transcript adapters", () => {
  it("normalizes a claude session jsonl to turns, skipping meta/tool noise", () => {
    const turns = extractTranscript("claude", claudeJsonl);
    expect(turns).toEqual([
      { role: "user", text: "add a health endpoint" },
      { role: "assistant", text: "Added /health returning ok." },
    ]);
  });

  it("normalizes a codex rollout jsonl to turns", () => {
    const turns = extractTranscript("codex", codexJsonl);
    expect(turns).toEqual([
      { role: "user", text: "rename the flag" },
      { role: "assistant", text: "Renamed." },
    ]);
  });

  it("unknown harness yields no turns", () => {
    expect(extractTranscript("run", claudeJsonl)).toEqual([]);
  });

  it("distills a cross-harness opening prompt with the source named", () => {
    const prompt = distillOpeningPrompt("claude", extractTranscript("claude", claudeJsonl));
    expect(prompt).toContain("previously driven by claude");
    expect(prompt).toContain("add a health endpoint");
    expect(prompt).toContain("Continue from where the conversation left off.");
  });

  it("derives provider session ids from native transcript paths", () => {
    expect(
      HARNESS_STATE["claude"]?.providerSessionId(
        "/root/.claude/projects/-workspace-repo/0f9a2c3d-1111-2222-3333-444455556666.jsonl",
      ),
    ).toBe("0f9a2c3d-1111-2222-3333-444455556666");
    expect(
      HARNESS_STATE["codex"]?.providerSessionId(
        "/root/.codex/sessions/2026/07/25/rollout-2026-07-25T22-11-00-0f9a2c3d-1111-2222-3333-444455556666.jsonl",
      ),
    ).toBe("0f9a2c3d-1111-2222-3333-444455556666");
  });

  it("reads pi's session id from its file, resumes it, and keeps pi's and opencode's logins private", () => {
    expect(
      HARNESS_STATE["pi"]?.providerSessionId(
        "/root/.pi/agent/sessions/--workspace-repo--/2026-10-01T13-33-08-888Z_01a02ed3-3598-7bda-85a7-382585b3712c.jsonl",
      ),
    ).toBe("01a02ed3-3598-7bda-85a7-382585b3712c");
    expect(
      HARNESS_STATE["pi"]?.liveTranscript?.test(
        ".pi/agent/sessions/--workspace-repo--/2026-10-01T13-33-08-888Z_01a02ed3-3598-7bda-85a7-382585b3712c.jsonl",
      ),
    ).toBe(true);
    expect(HARNESS_STATE["pi"]?.homeDirs).toEqual([".pi"]);
    expect(nativeResumeArgv("pi", "pi-session-id", ["pi", "--approve"])).toEqual([
      "pi",
      "--session",
      "pi-session-id",
      "--approve",
    ]);
    expect(nativeResumeArgv("pi", "saved", ["pi", "--session", "requested"])).toEqual([
      "pi",
      "--session",
      "requested",
    ]);
    expect(HARNESS_HOME_CREDENTIALS).toEqual(
      expect.arrayContaining([".pi/agent/auth.json", ".local/share/opencode/auth.json"]),
    );
  });

  it("resumes a saved Codex session by provider id", () => {
    expect(nativeResumeArgv("codex", "codex-session-id", ["codex"])).toEqual([
      "codex",
      "resume",
      "codex-session-id",
    ]);
    expect(nativeResumeArgv("codex", "codex-session-id", ["codex", "continue the review"])).toEqual(
      ["codex", "resume", "codex-session-id", "continue the review"],
    );
  });

  it("does not wrap an argv that already resumes natively", () => {
    expect(
      nativeResumeArgv("codex", "saved-session-id", ["codex", "resume", "requested-session-id"]),
    ).toEqual(["codex", "resume", "requested-session-id"]);
    expect(
      nativeResumeArgv("claude", "saved-session-id", [
        "claude",
        "--resume",
        "requested-session-id",
      ]),
    ).toEqual(["claude", "--resume", "requested-session-id"]);
  });

  it("leaves launches without resumable native state unchanged", () => {
    expect(nativeResumeArgv("codex", null, ["codex"])).toEqual(["codex"]);
  });

  it("opens opencode's own conversation by id, and never guesses one", () => {
    expect(nativeResumeArgv("opencode", "ses_a", ["opencode"])).toEqual([
      "opencode",
      "--session",
      "ses_a",
    ]);
    expect(nativeResumeArgv("opencode", "ses_a", ["opencode", "--model", "openai/x"])).toEqual([
      "opencode",
      "--session",
      "ses_a",
      "--model",
      "openai/x",
    ]);
    // No id is no resume: never `--continue`, which opens whichever conversation is newest.
    expect(nativeResumeArgv("opencode", null, ["opencode"])).toEqual(["opencode"]);
    // A launch that names a conversation, or brings a prompt (submitted only from opencode's home
    // screen, which opening a conversation skips), stays as it is; so does one in a shell.
    for (const argv of [
      ["opencode", "--continue"],
      ["opencode", "-c"],
      ["opencode", "--session", "ses_1"],
      ["opencode", "-s", "ses_1"],
      ["opencode", "--prompt", "fix the test"],
      ["sh", "-c", "exec opencode", "sh"],
    ]) {
      expect(nativeResumeArgv("opencode", "ses_a", argv)).toEqual(argv);
    }
  });

  it("relocates opencode's state directory beside its data, and knows its database", () => {
    expect(HARNESS_STATE["opencode"]?.homeDirs).toEqual([
      ".local/share/opencode",
      ".local/state/opencode",
    ]);
    expect(HARNESS_STATE["opencode"]?.stateFile).toBe(".local/share/opencode/opencode.db");
  });
});

/** Mode, exact time and (for a file) bytes of each path under `root`. */
const factsOf = (root: string, paths: ReadonlyArray<string>) =>
  Object.fromEntries(
    paths.map((rel) => {
      const target = path.join(root, rel);
      const stat = fs.lstatSync(target, { bigint: true });
      return [
        rel,
        {
          mode: Number(stat.mode & 0o7777n),
          mtime: stat.mtimeNs.toString(),
          bytes: stat.isFile() ? fs.readFileSync(target, "utf8") : null,
        },
      ];
    }),
  );

describe("harness home", () => {
  it("relocation script covers every harness's state dirs and keeps mount-side files", () => {
    const script = relocateHarnessHomeScript();
    for (const shape of Object.values(HARNESS_STATE)) {
      for (const dir of shape.homeDirs) {
        expect(script).toContain(`${HARNESS_HOME_MOUNT_PATH}/${dir}`);
        expect(script).toContain(`ln -s "${HARNESS_HOME_MOUNT_PATH}/${dir}" "$HOME/${dir}"`);
      }
    }
    // Only missing entries are copied: on a collision the mounted (live, newer) copy wins over a
    // restored one, and no existing directory takes the copied one's mode or time.
    expect(script).not.toContain("cp -an");
    expect(script).toContain("merge_missing");
    // The mode keeper: harnesses that tighten their state to 0700 (codex) would blind the
    // store-side observer; a detached root loop re-opens read bits.
    expect(script).toContain("chmod -R go+rX");
    expect(script).toContain(".mode-keeper.pid");
    // Credentials are exempt from the widening, in the loop and on the first pass: the harness
    // home holds the injected provider credential, and `go+rX` made a refresh token
    // world-readable on the store (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
    expect(script).toContain('for c in ".claude/.credentials.json" ".codex/auth.json"');
    expect(script).toContain("chmod go-rwx");
    const widens = script.split("chmod -R go+rX").length - 1;
    const tightens = script.split("chmod go-rwx").length - 1;
    expect(tightens).toBe(widens);
  });

  it("executes relocation against a capture root without starting the co-located mode keeper", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-executor-home-"));
    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-capture-harness-"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(captureRoot, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "ephemeral");
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "injected credential");
    fs.writeFileSync(path.join(captureRoot, ".codex", "config.toml"), "restored");

    const script = relocateHarnessHomeScript(captureRoot, { keepStoreReadable: false });
    expect(script).not.toContain(".mode-keeper.pid");
    execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: home } });

    expect(fs.realpathSync(path.join(home, ".codex"))).toBe(path.join(captureRoot, ".codex"));
    expect(fs.lstatSync(path.join(captureRoot, ".codex")).isDirectory()).toBe(true);
    expect(fs.lstatSync(path.join(captureRoot, ".codex")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(captureRoot, ".codex", "config.toml"), "utf8")).toBe(
      "restored",
    );
    expect(fs.readFileSync(path.join(captureRoot, ".codex", "auth.json"), "utf8")).toBe(
      "injected credential",
    );

    const transcript = path.join(home, ".claude", "projects", "repo", "session.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "conversation\n");
    execFileSync("sh", ["-c", script], { env: { ...process.env, HOME: home } });
    expect(
      fs.readFileSync(
        path.join(captureRoot, ".claude", "projects", "repo", "session.jsonl"),
        "utf8",
      ),
    ).toBe("conversation\n");
  });

  it("keeps HOME state when a checked copy fails", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-copy-failure-home-"));
    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-copy-failure-root-"));
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mend-copy-failure-bin-"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "session.jsonl"), "must survive\n");
    fs.writeFileSync(path.join(bin, "cp"), "#!/bin/sh\nexit 23\n", { mode: 0o755 });

    const result = spawnSync(
      "sh",
      ["-c", relocateHarnessHomeScript(captureRoot, { keepStoreReadable: false })],
      { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env["PATH"] ?? ""}` } },
    );

    expect(result.status).not.toBe(0);
    expect(fs.lstatSync(path.join(home, ".codex")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex", "session.jsonl"), "utf8")).toBe(
      "must survive\n",
    );
  });

  it("rejects missing, linked, and indirectly linked capture roots", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-root-home-"));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "session.jsonl"), "must survive\n");
    const missing = path.join(os.tmpdir(), `missing-capture-root-${crypto.randomUUID()}`);
    const missingResult = spawnSync(
      "sh",
      ["-c", relocateHarnessHomeScript(missing, { keepStoreReadable: false })],
      { env: { ...process.env, HOME: home } },
    );
    expect(missingResult.status).not.toBe(0);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-root-target-"));
    const linkedRoot = `${target}-link`;
    fs.symlinkSync(target, linkedRoot);
    const linkedResult = spawnSync(
      "sh",
      ["-c", relocateHarnessHomeScript(linkedRoot, { keepStoreReadable: false })],
      { env: { ...process.env, HOME: home } },
    );
    expect(linkedResult.status).not.toBe(0);

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-root-parent-"));
    const actualParent = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-root-actual-"));
    const indirectParent = path.join(parent, "linked-parent");
    fs.symlinkSync(actualParent, indirectParent);
    const indirectRoot = path.join(indirectParent, "harness-home");
    fs.mkdirSync(indirectRoot);
    const indirectResult = spawnSync(
      "sh",
      ["-c", relocateHarnessHomeScript(indirectRoot, { keepStoreReadable: false })],
      { env: { ...process.env, HOME: home } },
    );
    expect(indirectResult.status).not.toBe(0);

    expect(fs.lstatSync(path.join(home, ".codex")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(home, ".codex", "session.jsonl"), "utf8")).toBe(
      "must survive\n",
    );
  });

  it("rejects a HOME link that does not resolve to the configured capture directory", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-source-home-"));
    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-source-root-"));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "mend-unsafe-source-target-"));
    fs.symlinkSync(elsewhere, path.join(home, ".codex"));

    const result = spawnSync(
      "sh",
      ["-c", relocateHarnessHomeScript(captureRoot, { keepStoreReadable: false })],
      { env: { ...process.env, HOME: home } },
    );

    expect(result.status).not.toBe(0);
    expect(fs.realpathSync(path.join(home, ".codex"))).toBe(elsewhere);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  /**
   * Review 2026-09-28 (19) #1: the relocation merged each fresh `$HOME` harness directory into the
   * restored root with `cp -an source/. destination/`. No-clobber kept the files, but archive mode
   * copied the source directory's mode and mtime over the destination: a restored `.claude` saved
   * at 0750 read 0700 (Core writes the injected credential's parent under `umask 077`) with the
   * executor's own time. Now only missing entries are copied, and every existing destination
   * directory keeps its mode and exact time, descendants and the root included.
   */
  describe("relocation over a restored root keeps what was saved", () => {
    it("AUDIT R19 relocation keeps saved directory metadata on cold resume", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r19-relocation-"));
      const home = path.join(root, "home");
      const captured = path.join(root, "harness");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(captured, ".claude/projects"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "injected credential\n");
      fs.writeFileSync(path.join(captured, ".claude", ".credentials.json"), "saved credential\n");
      fs.writeFileSync(path.join(captured, ".claude/projects", "session.jsonl"), "own work\n");
      const dir = path.join(captured, ".claude");
      fs.chmodSync(dir, 0o700);
      fs.utimesSync(dir, 1700000000.125, 1700000000.125);
      const tracked = [".claude", ".claude/projects/session.jsonl", ".claude/.credentials.json"];
      const before = factsOf(captured, tracked);
      const run = spawnSync(
        "sh",
        ["-c", relocateHarnessHomeScript(captured, { keepStoreReadable: false })],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(factsOf(captured, tracked)).toEqual(before);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it("merges only what is missing: existing directories and files keep mode and time, new entries keep theirs", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-r19-merge-"));
      const home = path.join(root, "home");
      const captured = path.join(root, "harness");
      fs.mkdirSync(home);
      // The executor's fresh home: Core's credential write (`umask 077`, file 0600), what the
      // image baked, and a file that collides with a restored one.
      const injected = spawnSync(
        "sh",
        [
          "-c",
          'umask 077 && mkdir -p "$(dirname "$HOME/.claude/.credentials.json")" && ' +
            'printf "fresh\\n" > "$HOME/.claude/.credentials.json" && ' +
            'chmod 600 "$HOME/.claude/.credentials.json"',
        ],
        { env: { ...process.env, HOME: home } },
      );
      expect(injected.status).toBe(0);
      fs.mkdirSync(path.join(home, ".claude/projects/existing"), { recursive: true });
      fs.mkdirSync(path.join(home, ".claude/projects/new/deeper"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude/projects/existing/extra.txt"), "baked\n");
      fs.writeFileSync(path.join(home, ".claude/projects/new/deeper/x.jsonl"), "new\n");
      fs.writeFileSync(path.join(home, ".claude/settings.json"), "image default\n");
      fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
      fs.writeFileSync(path.join(home, ".codex/auth.json"), "codex\n", { mode: 0o600 });
      // The restored root: modes and times as the capture saved them.
      fs.mkdirSync(path.join(captured, ".claude/projects/existing"), { recursive: true });
      fs.writeFileSync(path.join(captured, ".claude/settings.json"), "saved\n");
      fs.writeFileSync(path.join(captured, ".claude/projects/existing/session.jsonl"), "work\n");
      fs.chmodSync(path.join(captured, ".claude/settings.json"), 0o640);
      fs.chmodSync(path.join(captured, ".claude/projects/existing"), 0o711);
      fs.chmodSync(path.join(captured, ".claude/projects"), 0o755);
      fs.chmodSync(path.join(captured, ".claude"), 0o750);
      const times: ReadonlyArray<readonly [string, number]> = [
        [".claude/settings.json", 1700000000.5],
        [".claude/projects/existing/session.jsonl", 1700000001.25],
        [".claude/projects/existing", 1700000002.125],
        [".claude/projects", 1700000003.375],
        [".claude", 1700000004.625],
        ["", 1700000005.75],
      ];
      for (const [rel, at] of times) fs.utimesSync(path.join(captured, rel), at, at);
      const tracked = times.map(([rel]) => rel);
      const before = factsOf(captured, tracked);

      const run = spawnSync(
        "sh",
        ["-c", relocateHarnessHomeScript(captured, { keepStoreReadable: false })],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      expect(factsOf(captured, tracked)).toEqual(before);
      // What was missing arrived, with its own modes; a collision kept the restored file.
      const credential = path.join(captured, ".claude/.credentials.json");
      expect(fs.readFileSync(credential, "utf8")).toBe("fresh\n");
      expect(fs.statSync(credential).mode & 0o777).toBe(0o600);
      expect(
        fs.readFileSync(path.join(captured, ".claude/projects/existing/extra.txt"), "utf8"),
      ).toBe("baked\n");
      expect(
        fs.readFileSync(path.join(captured, ".claude/projects/new/deeper/x.jsonl"), "utf8"),
      ).toBe("new\n");
      expect(fs.statSync(path.join(captured, ".codex")).mode & 0o777).toBe(0o700);
      expect(fs.readFileSync(path.join(captured, ".codex/auth.json"), "utf8")).toBe("codex\n");
      for (const dir of [".claude", ".codex", ".local/share/opencode", ".local/state/opencode"]) {
        expect(fs.realpathSync(path.join(home, dir))).toBe(path.join(captured, dir));
      }
      // A rerun over the links changes nothing.
      const again = spawnSync(
        "sh",
        ["-c", relocateHarnessHomeScript(captured, { keepStoreReadable: false })],
        { env: { ...process.env, HOME: home }, encoding: "utf8" },
      );
      expect(again.status).toBe(0);
      expect(factsOf(captured, tracked)).toEqual(before);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  it("reads live state presence from the harness home, absence as false", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-harness-home-"));
    expect(await Effect.runPromise(hasLiveHarnessState(home, "claude"))).toBe(false);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    expect(await Effect.runPromise(hasLiveHarnessState(home, "claude"))).toBe(false);
    // Mend-materialized skills are configuration, not harness-written state.
    fs.mkdirSync(path.join(home, ".claude", "skills", "review"), { recursive: true });
    expect(await Effect.runPromise(hasLiveHarnessState(home, "claude"))).toBe(false);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    expect(await Effect.runPromise(hasLiveHarnessState(home, "claude"))).toBe(true);
    expect(await Effect.runPromise(hasLiveHarnessState(home, "codex"))).toBe(false);
    expect(await Effect.runPromise(hasLiveHarnessState(home, "unknown"))).toBe(false);
  });

  it("locates the newest live transcript and derives its provider session id", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-harness-home-"));
    const projectDir = path.join(home, ".claude", "projects", "-workspace-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    const older = path.join(projectDir, "0f9a2c3d-1111-2222-3333-444455556666.jsonl");
    const newer = path.join(projectDir, "aabbccdd-1111-2222-3333-444455556666.jsonl");
    fs.writeFileSync(older, "{}\n");
    fs.writeFileSync(newer, "{}\n");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);

    const located = await Effect.runPromise(locateLiveTranscript(home, "claude"));
    expect(located?.path).toBe(newer);
    expect(located?.providerSessionId).toBe("aabbccdd-1111-2222-3333-444455556666");
  });

  it("live transcript lookup answers null for empty homes and transcript-less harnesses", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-harness-home-"));
    expect(await Effect.runPromise(locateLiveTranscript(home, "claude"))).toBeNull();
    expect(await Effect.runPromise(locateLiveTranscript(home, "opencode"))).toBeNull();
    expect(
      await Effect.runPromise(locateLiveTranscript(path.join(home, "missing"), "codex")),
    ).toBeNull();
  });

  it("counts opencode's database as a conversation only when it opens and lists one", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-harness-home-"));
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(false);
    const db = path.join(home, ".local", "share", "opencode", "opencode.db");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    // A link where the database belongs leads anywhere; it is not the harness's state.
    fs.symlinkSync("/etc/hostname", db);
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(false);
    fs.rmSync(db);
    // Zero bytes, a header and nothing else, and a real database with no conversation: none.
    fs.writeFileSync(db, "");
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(false);
    fs.writeFileSync(db, "SQLite format 3\0");
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(false);
    fs.rmSync(db);
    writeOpencodeDatabase(db, []);
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(false);
    writeOpencodeDatabase(db, [{ id: "ses_1", createdAt: 1 }]);
    expect(await Effect.runPromise(hasLiveConversation(home, "opencode"))).toBe(true);
    // A harness with a transcript answers by its transcript; one with neither, false.
    expect(await Effect.runPromise(hasLiveConversation(home, "claude"))).toBe(false);
    const projectDir = path.join(home, ".claude", "projects", "-workspace-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "0f9a2c3d-1111-2222-3333-444455556666.jsonl"), "{}\n");
    expect(await Effect.runPromise(hasLiveConversation(home, "claude"))).toBe(true);
    expect(await Effect.runPromise(hasLiveConversation(home, "unknown"))).toBe(false);
  });
});

describe("the co-located harvest keeps no login", () => {
  it("archives opencode's data and state without its login files, and no harness's login", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-harvest-logins-"));
    const home = path.join(root, "home");
    const put = (relative: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
      fs.writeFileSync(path.join(home, relative), text);
    };
    for (const credential of HARNESS_HOME_CREDENTIALS) {
      put(credential, `{"access":"SYNTHETIC-LOGIN-${credential}"}`);
    }
    put(".local/share/opencode/opencode.db", "the conversations");
    put(".local/share/opencode/snapshot/x", "a snapshot");
    put(".local/state/opencode/model.json", '{"recent":[]}');
    put(".claude/projects/-workspace-repo/s.jsonl", "{}\n");
    put(".pi/agent/settings.json", "{}");
    for (const [harness, shape] of Object.entries(HARNESS_STATE)) {
      const packed = spawnSync(
        "sh",
        ["-c", harvestHarnessStateScript(shape.paths, path.join(root, "no-mount"))],
        { env: { ...process.env, HOME: home, TMPDIR: root }, encoding: "utf8" },
      );
      if (packed.status === 3) continue;
      expect(packed.status, `${harness}: ${packed.stderr}`).toBe(0);
      const archive = path.join(root, `${harness}.tgz`);
      fs.writeFileSync(archive, Buffer.from(packed.stdout.trim(), "base64"));
      const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
      for (const credential of HARNESS_HOME_CREDENTIALS) {
        expect(listed, `${harness}: ${credential}`).not.toContain(credential);
      }
      const unpacked = path.join(root, `unpacked-${harness}`);
      fs.mkdirSync(unpacked);
      spawnSync("tar", ["-xzf", archive, "-C", unpacked]);
      const bytes = execFileSync("sh", ["-c", 'find "$1" -type f -exec cat {} +', "sh", unpacked], {
        encoding: "utf8",
      });
      expect(bytes, harness).not.toContain("SYNTHETIC-LOGIN");
      if (harness === "opencode") {
        expect(listed).toContain(".local/share/opencode/opencode.db");
        expect(listed).toContain(".local/share/opencode/snapshot/x");
        expect(listed).toContain(".local/state/opencode/model.json");
      }
    }
    expect(HARNESS_HOME_CREDENTIALS).toContain(".local/share/opencode/mcp-auth.json");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

const relocateWithLogins = (home: string, root: string, dropCapturedLogins: boolean) => {
  const run = spawnSync(
    "sh",
    ["-c", relocateHarnessHomeScript(root, { keepStoreReadable: false, dropCapturedLogins })],
    { env: { ...process.env, HOME: home }, encoding: "utf8" },
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
};
describe("a login an older capture brought (review 2026-10-04, round 4)", () => {
  it("capture mode removes a plain mcp-auth.json unread before any harness starts; co-located keeps its own", () => {
    for (const dropCapturedLogins of [true, false]) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-captured-login-"));
      const home = path.join(scratch, "home");
      const root = path.join(scratch, "harness");
      // What a materialised head brought: the earlier person's MCP logins beside the database.
      const data = path.join(root, ".local", "share", "opencode");
      fs.mkdirSync(data, { recursive: true });
      fs.mkdirSync(home);
      fs.writeFileSync(
        path.join(data, "mcp-auth.json"),
        '{"s":{"tokens":{"accessToken":"ALICE"}}}',
      );
      fs.writeFileSync(path.join(data, "opencode.db"), "the conversations");
      relocateWithLogins(home, root, dropCapturedLogins);
      const login = path.join(home, ".local", "share", "opencode", "mcp-auth.json");
      expect(fs.existsSync(login), String(dropCapturedLogins)).toBe(!dropCapturedLogins);
      expect(fs.existsSync(path.join(home, ".local", "share", "opencode", "opencode.db"))).toBe(
        true,
      );
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the link the opencode seed made, and the logins behind it", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-captured-login-"));
    const home = path.join(scratch, "home");
    const root = path.join(scratch, "harness");
    const data = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(home, ".mend", "opencode"), { recursive: true });
    const kept = path.join(home, ".mend", "opencode", "mcp-auth.json");
    fs.writeFileSync(kept, "mine");
    fs.symlinkSync(kept, path.join(data, "mcp-auth.json"));
    relocateWithLogins(home, root, true);
    expect(fs.lstatSync(path.join(data, "mcp-auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(kept, "utf8")).toBe("mine");
    expect(CAPTURED_LOGIN_FILES.map((file) => file.path)).toEqual([
      ".local/share/opencode/mcp-auth.json",
    ]);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("removes a link planted at mcp-auth.json that leads anywhere but the executor's own home", () => {
    // Alice links the file into the worktree from her shell; the next person's opencode would
    // write their MCP logins through it into the change.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-captured-login-"));
    const home = path.join(scratch, "home");
    const root = path.join(scratch, "harness");
    const worktree = path.join(scratch, "repo");
    const data = path.join(root, ".local", "share", "opencode");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(home);
    fs.mkdirSync(worktree);
    fs.symlinkSync(path.join(worktree, ".planted"), path.join(data, "mcp-auth.json"));
    relocateWithLogins(home, root, true);
    expect(fs.existsSync(path.join(data, "mcp-auth.json"))).toBe(false);
    expect(() => fs.lstatSync(path.join(data, "mcp-auth.json"))).toThrow();
    // Co-located, the session's home is its own: nothing is removed.
    fs.symlinkSync(path.join(worktree, ".planted"), path.join(data, "mcp-auth.json"));
    relocateWithLogins(home, root, false);
    expect(fs.lstatSync(path.join(data, "mcp-auth.json")).isSymbolicLink()).toBe(true);
    fs.rmSync(scratch, { recursive: true, force: true });
  });
});
