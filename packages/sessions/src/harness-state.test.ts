import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  HARNESS_HOME_MOUNT_PATH,
  HARNESS_STATE,
  distillOpeningPrompt,
  extractTranscript,
  hasLiveHarnessState,
  locateLiveTranscript,
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

describe("harness home", () => {
  it("relocation script covers every harness's state dirs and keeps mount-side files", () => {
    const script = relocateHarnessHomeScript();
    for (const shape of Object.values(HARNESS_STATE)) {
      for (const dir of shape.homeDirs) {
        expect(script).toContain(`${HARNESS_HOME_MOUNT_PATH}/${dir}`);
        expect(script).toContain(`ln -s "${HARNESS_HOME_MOUNT_PATH}/${dir}" "$HOME/${dir}"`);
      }
    }
    // -n: on a collision the mounted (live, newer) copy wins over a restored one.
    expect(script).toContain("cp -an");
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
