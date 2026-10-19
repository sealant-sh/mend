// drive-vscode.lib.mjs: option parsing, run names, the state ledger and the step log. No process,
// no Docker, no editor.
//
//   node --test .claude/skills/verify/scripts/drive-vscode.test.mjs

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  UsageError,
  newRunName,
  parseArgs,
  pickRun,
  quickInputStep,
  readState,
  remoteSshLogFiles,
  resolves,
  runNames,
  stepLog,
  updateState,
  writeState,
} from "./drive-vscode.lib.mjs";
import { loadSecrets, register } from "./secrets.mjs";

const TOKEN = "tok-8b1d2e3f4a5c6b7d8e9f";

test("up takes exactly one server image source and its switches", () => {
  assert.deepEqual(parseArgs(["up", "--version", "0.36.0-next.1033", "--signed-out"]), {
    command: "up",
    options: { version: "0.36.0-next.1033", "signed-out": true },
    positional: [],
  });
  assert.deepEqual(parseArgs(["up", "--image=mend:dev", "--no-video"]).options, {
    image: "mend:dev",
    "no-video": true,
  });
  assert.deepEqual(parseArgs(["up", "--build", "--extension", "/x"]).options, {
    build: true,
    extension: "/x",
  });
  assert.deepEqual(parseArgs(["up", "--version", "0.36.0-next.1033", "--no-remote-ssh"]).options, {
    version: "0.36.0-next.1033",
    "no-remote-ssh": true,
  });
  for (const [argv, why] of [
    [["up"], /exactly one of/],
    [["up", "--version", "1", "--build"], /exactly one of/],
    [["up", "--version"], /needs a value/],
    [["up", "--version", "--build"], /needs a value/],
    [["up", "--build=yes"], /takes no value/],
    [["up", "--build", "--no-remote-ssh=1"], /takes no value/],
    [["up", "--image", "x", "--out", "e"], /does not take --out/],
    [["up", "--image", "x", "stray"], /no positional/],
    [["fly"], /a command is needed/],
    [[], /a command is needed/],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, argv.join(" "));
    assert.throws(() => parseArgs(argv), why, argv.join(" "));
  }
});

test("run needs one recipe and --out; logs and down take only --run", () => {
  assert.deepEqual(parseArgs(["run", "r.mjs", "--out", "e", "--timeout", "5000"]), {
    command: "run",
    options: { out: "e", timeout: "5000" },
    positional: ["r.mjs"],
  });
  assert.throws(() => parseArgs(["run", "--out", "e"]), /one recipe module/);
  assert.throws(() => parseArgs(["run", "a.mjs", "b.mjs", "--out", "e"]), /one recipe module/);
  assert.throws(() => parseArgs(["run", "r.mjs"]), /needs --out/);
  assert.throws(
    () => parseArgs(["run", "r.mjs", "--out", "e", "--timeout", "soon"]),
    /milliseconds/,
  );
  assert.deepEqual(parseArgs(["logs", "--run", "x"]).options, { run: "x" });
  assert.deepEqual(parseArgs(["down"]).options, {});
  assert.throws(() => parseArgs(["down", "now"]), /no positional/);
});

test("a run is named like the skill's runs, and everything of it hangs off that name", () => {
  const name = newRunName(new Date(Date.UTC(2026, 9, 18, 7, 5)), () => 0.5);
  assert.equal(name, "1018-0705-8000");
  const names = runNames(name, { XDG_STATE_HOME: "/state" }, "/home/v");
  assert.equal(names.world, "st-verify-vscode-1018-0705-8000");
  assert.equal(names.root, "/home/v/.cache/mend-verify/vscode/st-verify-vscode-1018-0705-8000");
  assert.equal(names.stateFile, join(names.root, "state.json"));
  assert.equal(names.privateDir, join(names.root, "private"));
  assert.equal(names.evidenceDir, "/state/mend-verify/st-verify-vscode-1018-0705-8000");
  assert.equal(
    runNames("x", {}, "/home/v").evidenceDir,
    "/home/v/.local/state/mend-verify/st-verify-vscode-x",
  );
  assert.equal(
    runNames("x", { MEND_VERIFY_VSCODE_ROOT: "/r" }, "/h").root,
    "/r/st-verify-vscode-x",
  );
  for (const bad of ["", "../x", "a b", "-x", "x/y"])
    assert.throws(() => runNames(bad), UsageError);
});

test("the run a command means: --run, the variable, else the only one that is up", () => {
  const root = mkdtempSync(join(tmpdir(), "verify-vscode-runs-"));
  const env = { MEND_VERIFY_VSCODE_ROOT: root };
  try {
    assert.equal(pickRun("given", env), "given");
    assert.equal(pickRun(undefined, { ...env, MEND_VERIFY_VSCODE_RUN: "fromEnv" }), "fromEnv");
    assert.throws(() => pickRun(undefined, env), /no run is up/);
    mkdirSync(join(root, "st-verify-vscode-one"));
    writeFileSync(join(root, "st-verify-vscode-one", "state.json"), "{}");
    mkdirSync(join(root, "st-verify-vscode-stale"));
    assert.equal(pickRun(undefined, env), "one");
    mkdirSync(join(root, "st-verify-vscode-two"));
    writeFileSync(join(root, "st-verify-vscode-two", "state.json"), "{}");
    assert.throws(() => pickRun(undefined, env), /2 runs are up \(one, two\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the state file is a ledger: each update keeps what was there, written atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-vscode-state-"));
  const file = join(dir, "deep", "state.json");
  try {
    assert.deepEqual(readState(file), {});
    updateState(file, { run: "r", pids: { xvfb: 1 } });
    updateState(file, { pids: { xvfb: 1, vscode: 2 }, display: ":93" });
    assert.deepEqual(readState(file), { run: "r", pids: { xvfb: 1, vscode: 2 }, display: ":93" });
    assert.ok(!existsSync(`${file}.${process.pid}.tmp`), "the temporary file is gone");
    writeState(file, { run: "r" });
    assert.deepEqual(readState(file), { run: "r" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a step line is numbered and redacted by value and by shape, strings at any depth", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-vscode-steps-"));
  const privateDir = join(dir, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  register(privateDir, "token", TOKEN);
  try {
    const log = stepLog(join(dir, "steps.jsonl"), loadSecrets(privateDir));
    const first = log.write({
      name: "open",
      via: "dom",
      observed: `authorization: Bearer ${TOKEN} · 2 windows`,
      detail: { urls: [`http://x/?token=${TOKEN}`], toast: "Set up workspace SSH?" },
    });
    assert.equal(first.n, 1);
    assert.equal(first.observed, "authorization: Bearer <secret> · 2 windows");
    // By value first (`<secret>`), then by shape: the signed-URL shape covers what the value left.
    assert.match(first.detail.urls[0], /^http:\/\/x\/\?token=<(?:secret|redacted)>$/);
    assert.equal(first.detail.toast, "Set up workspace SSH?");
    const second = log.write({ note: "device mdt_AbCdEfGh12345678 shown" });
    assert.equal(second.n, 2);
    assert.equal(second.note, "device mdt_<token> shown");
    const lines = readFileSync(join(dir, "steps.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.ok(!lines.join("\n").includes(TOKEN), "the token reached the step log");
    assert.deepEqual(JSON.parse(lines[0]), first);
    assert.equal(log.scrub(`x ${TOKEN} y`), "x <secret> y");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opens count each Remote-SSH window's first resolve, across every window's log", () => {
  const userData = mkdtempSync(join(tmpdir(), "verify-vscode-resolves-"));
  const log = (window, stamp, lines) => {
    const dir = join(
      userData,
      "logs",
      "20261019T001716",
      window,
      "exthost",
      `output_logging_${stamp}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1-Remote - SSH.log"), `${lines.join("\n")}\n`);
  };
  const authority = "ssh-remote+ws-90a77cd2@mend-ws-172-17-0-4-670a93b5";
  try {
    assert.equal(resolves(userData), 0, "no logs directory yet");
    // The local window loads Remote-SSH too and logs, but resolves nothing.
    log("window1", "20261019T001716", ["[00:17:16.500] Remote-SSH version: remote-ssh@0.122.0"]);
    log("window2", "20261019T001721", [
      `[00:17:21.934] SSH Resolver called for "${authority}", attempt 1`,
      `[00:17:21.941] SSH Resolver called for host: ws-90a77cd2@mend-ws-172-17-0-4-670a93b5`,
      `[00:19:02.100] SSH Resolver called for "${authority}", attempt 2`,
    ]);
    log("window3", "20261019T001751", [
      `[00:17:51.344] SSH Resolver called for "${authority}", attempt 1`,
    ]);
    // A reload of window3: a new extension host, a new log, a second open of that window.
    log("window3", "20261019T001830", [
      `[00:18:30.002] SSH Resolver called for "${authority}", attempt 1`,
    ]);
    const other = join(userData, "logs", "20261019T001716", "window1", "exthost");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "exthost.log"),
      `SSH Resolver called for "${authority}", attempt 1\n`,
    );
    assert.equal(remoteSshLogFiles(userData).length, 4);
    assert.equal(
      resolves(userData),
      3,
      "two windows, one reloaded; the reconnect and other logs not counted",
    );
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test("a quick input's step counter is read off its title as VS Code appends it", () => {
  assert.deepEqual(quickInputStep("New session · newsroom-api (2/5)"), {
    title: "New session · newsroom-api",
    step: 2,
    total: 5,
  });
  assert.deepEqual(quickInputStep("New session · newsroom-api"), {
    title: "New session · newsroom-api",
    step: null,
    total: null,
  });
  assert.deepEqual(quickInputStep("Pick one (3)"), { title: "Pick one", step: 3, total: null });
  assert.deepEqual(quickInputStep("1/4"), { title: "", step: 1, total: 4 });
  assert.deepEqual(quickInputStep("Run (fast) mode"), {
    title: "Run (fast) mode",
    step: null,
    total: null,
  });
  assert.deepEqual(quickInputStep(null), { title: "", step: null, total: null });
});
