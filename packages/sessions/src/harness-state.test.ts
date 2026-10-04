import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  HARNESS_CREDENTIALS,
  HARNESS_HOME_MOUNT_PATH,
  HARNESS_MACHINE_STATE,
  HARNESS_STATE,
  distillOpeningPrompt,
  extractTranscript,
  hasLiveHarnessState,
  locateLiveTranscript,
  tightenCredentials,
  HARNESS_HOME_CREDENTIALS,
  nativeResumeArgv,
  relocateHarnessHomeScript,
} from "./harness-state.ts";

/**
 * sealantd's `HARNESS_CREDENTIALS` (`crates/sealant-capture/src/index.rs`, sealantd#136), which
 * keeps these paths out of captures and restores; a directory ends in `/`. Mend's table must name
 * the same paths: change both together, and pin a sealantd that has the change.
 */
const SEALANTD_HARNESS_CREDENTIALS = [
  ".claude/.credentials.json",
  ".claude/.device-keys.json",
  ".claude/backups/",
  ".claude/shell-snapshots/",
  ".claude/session-env/",
  ".claude/ide/",
  ".claude/sessions/",
  ".claude/file-history/",
  ".claude/remote-settings.json",
  ".codex/auth.json",
  ".codex/.credentials.json",
  ".codex/secrets/",
  ".codex/shell_snapshots/",
  ".local/share/opencode/auth.json",
  ".local/share/opencode/mcp-auth.json",
  ".local/share/opencode/repos/",
  ".local/share/opencode/log/",
  ".pi/agent/auth.json",
  ".pi/agent/mcp-auth.json",
  ".pi/agent/oauth.json",
  ".pi/agent/mcp-oauth/",
  ".pi/agent/mcp-oauth-encrypted/",
  ".pi/agent/mcp.json",
  ".pi/agent/tmp/",
  ".pi/agent/crashes.json",
  ".pi/agent/mend/profile/root/mcp.json",
  ".mend/pi-profile-kept/",
];

/** sealantd's `HARNESS_MACHINE_STATE`, the same way: never saved, and not credentials. */
const SEALANTD_HARNESS_MACHINE_STATE = [
  ".codex/packages/",
  ".codex/app-server-daemon/",
  ".codex/app-server-control/",
];

const machineStateEntries = Object.entries(HARNESS_MACHINE_STATE).flatMap(([harness, entries]) =>
  entries.map((entry) => ({ harness, ...entry })),
);
const credentialEntries = Object.entries(HARNESS_CREDENTIALS).flatMap(([harness, credentials]) =>
  credentials.map((credential) => ({ harness, ...credential })),
);
const shownPath = (credential: { readonly path: string; readonly kind: string }) =>
  credential.kind === "directory" ? `${credential.path}/` : credential.path;

/** The first cell of each table row in a piece of markdown, without its backticks. */
const tableRows = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => line.split("`")[1]);

describe("harness credentials", () => {
  it("lists every harness Mend runs, and only those", () => {
    expect(Object.keys(HARNESS_CREDENTIALS).toSorted()).toEqual(
      Object.keys(HARNESS_STATE).toSorted(),
    );
  });

  it("names paths in the harness home: under the harness's own directories, or Mend's", () => {
    for (const credential of credentialEntries) {
      const roots = [...(HARNESS_STATE[credential.harness]?.homeDirs ?? []), ".mend"];
      expect(
        roots.some((root) => credential.path.startsWith(`${root}/`)),
        credential.path,
      ).toBe(true);
    }
    expect(new Set(HARNESS_HOME_CREDENTIALS).size).toBe(HARNESS_HOME_CREDENTIALS.length);
  });

  it("names exactly what sealantd keeps out of captures", () => {
    expect(credentialEntries.map(shownPath)).toEqual(SEALANTD_HARNESS_CREDENTIALS);
    expect(machineStateEntries.map(shownPath)).toEqual(SEALANTD_HARNESS_MACHINE_STATE);
  });

  it("keeps machine state apart from the credentials, inside the harness's own directories", () => {
    for (const entry of machineStateEntries) {
      const roots = HARNESS_STATE[entry.harness]?.homeDirs ?? [];
      expect(
        roots.some((root) => entry.path.startsWith(`${root}/`)),
        entry.path,
      ).toBe(true);
      expect(HARNESS_HOME_CREDENTIALS).not.toContain(entry.path);
    }
  });

  it("are closed to group and other by the mode keeper, with their suffixed siblings", () => {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "mend-tighten-"));
    try {
      const files = [
        ".pi/agent/oauth.json.migrated",
        ".pi/agent/auth.json.mend-seed-42",
        ".local/share/opencode/auth.json",
        ".codex/shell_snapshots/thread.1.sh",
        ".pi/agent/settings.json",
      ];
      for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(mount, file)), { recursive: true });
        fs.writeFileSync(path.join(mount, file), "x", { mode: 0o644 });
        fs.chmodSync(path.join(mount, file), 0o644);
      }
      fs.chmodSync(path.join(mount, ".codex/shell_snapshots"), 0o755);
      const run = spawnSync("sh", ["-c", tightenCredentials(mount)], { encoding: "utf8" });
      expect(run.status).toBe(0);
      const mode = (file: string) => fs.statSync(path.join(mount, file)).mode & 0o777;
      expect(mode(".pi/agent/oauth.json.migrated")).toBe(0o600);
      expect(mode(".pi/agent/auth.json.mend-seed-42")).toBe(0o600);
      expect(mode(".local/share/opencode/auth.json")).toBe(0o600);
      expect(mode(".codex/shell_snapshots")).toBe(0o700);
      // Not a credential: left as it was.
      expect(mode(".pi/agent/settings.json")).toBe(0o644);
    } finally {
      fs.rmSync(mount, { recursive: true, force: true });
    }
  });

  it("are all listed on the provider-logins docs page", () => {
    const page = fs.readFileSync(
      path.join(
        import.meta.dirname,
        "../../../apps/docs/src/content/docs/concepts/provider-logins.md",
      ),
      "utf8",
    );
    const section = page.split("## What a session never saves")[1]?.split("\n## ")[0] ?? "";
    const [credentials = "", machine = ""] = section.split("### Never saved, and not logins");
    expect(tableRows(credentials)).toEqual(credentialEntries.map(shownPath));
    expect(tableRows(machine)).toEqual(machineStateEntries.map(shownPath));
  });
});

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
    expect(nativeResumeArgv("opencode", "session-id", ["opencode"])).toEqual(["opencode"]);
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
    expect(script).toContain('for c in ".claude/.credentials.json" ');
    for (const credential of HARNESS_HOME_CREDENTIALS) expect(script).toContain(`"${credential}"`);
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
      for (const dir of [".claude", ".codex", ".local/share/opencode"]) {
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
});
