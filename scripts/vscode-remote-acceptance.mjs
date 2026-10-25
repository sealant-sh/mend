#!/usr/bin/env node
/**
 * VS Code against a Mend server on another address: the MacBook-and-Mac-mini shape, on one Linux
 * machine. The server runs in its own Docker daemon (Docker-in-Docker), as on a Mac, where Docker
 * Desktop is a Linux VM. `mend server setup` installs the packaged server there with `--bind
 * 0.0.0.0` and `--url http://<daemon address>:3105`: clients reach it at the daemon container's own
 * address, as a laptop reaches another machine, and nothing is published on this machine, so its
 * loopback reaches nothing. It creates the first account, adopts a repository,
 * then runs apps/vscode/test/e2e/suite.ts inside a real VS Code under Xvfb. The suite signs in
 * through the browser walk, watches live events, starts a Workbench session, writes the
 * Remote-SSH config and connects with `ssh` through it, types in the session's terminal over
 * /api/tty, opens review, and (MEND_E2E_REMOTE_SSH=1, the default) opens the workspace with the
 * real Remote-SSH extension: the owner's own story, in that window. It edits a file, runs a command
 * in the workspace's integrated terminal, forwards a port the workspace serves on its loopback and
 * opens it from this machine; Mend installs the seeded local extension that runs in a workspace
 * there and leaves the seeded theme local, with Settings Sync on and no question asked;
 * then Mend's terminal into the session reads the edited file and the change review lists it.
 * Before the editor starts, a session in a fresh worktree must run: it builds the image, so the
 * editor's workbench session boots with an owner map and Remote-SSH lands as the person.
 *
 *   MEND_TEST_VERSION=0.36.0-next.656 node scripts/vscode-remote-acceptance.mjs
 *
 * Inputs:
 *   MEND_TEST_VERSION   a preloaded ghcr.io/sealant-sh/mend:<version> (required)
 *   MEND_E2E_REPO       the Git URL to adopt; default https://github.com/octocat/Hello-World.git
 *   VSCODE_CLI          the `code` command, for installing Remote-SSH; default `code` on PATH
 *   VSCODE_BIN          the VS Code application (Electron) the suite runs in; default VSCODE_CLI.
 *                       Where `code` is a launcher that detaches (Linux packages), point this at
 *                       the Electron binary itself, e.g. <install>/lib/vscode/code
 *   MEND_E2E_REMOTE_SSH 0 skips the real Remote-SSH window (step 8)
 *   MEND_E2E_KEEP       1 leaves the server and scratch directory up for inspection
 *   MEND_E2E_EDITOR     off runs with mend.workspaces.bringMyEditor off (the before/after timing)
 *   MEND_E2E_EVIDENCE   a directory to copy result.json and the remote window's report into
 *
 * The world (the daemon, the scratch HOME, the editor's install and display) is
 * scripts/vscode-remote-world.mjs, shared with the verify skill's drive-vscode.mjs. Nothing touches
 * this machine's own Docker daemon but the one Docker-in-Docker container; on exit it is removed
 * with its storage, and the scratch HOME and Xvfb go with it.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { assertEditorEvidence } from "./vscode-acceptance-evidence.mjs";
import {
  adoptProject,
  buildExtension,
  editorEnv,
  installExtension,
  installServer,
  lines,
  makeApi,
  makeScratch,
  prepareDaemon,
  removeWorld,
  repoRoot,
  requireImages,
  run,
  runFreshWorktreeSession,
  runId,
  signUp,
  sleep,
  startDind,
  startXvfb,
  writeUserSettings,
} from "./vscode-remote-world.mjs";

const repo = repoRoot;
const version = process.env.MEND_TEST_VERSION;
if (!version) throw new Error("set MEND_TEST_VERSION to a preloaded ghcr.io/sealant-sh/mend tag");
const image = `ghcr.io/sealant-sh/mend:${version}`;
const sourceUrl = process.env.MEND_E2E_REPO || "https://github.com/octocat/Hello-World.git";
const projectName = "st-vscode-remote";
const remoteSsh = process.env.MEND_E2E_REMOTE_SSH !== "0";
const keep = process.env.MEND_E2E_KEEP === "1";
const editorOff = process.env.MEND_E2E_EDITOR === "off";
const evidenceDir = process.env.MEND_E2E_EVIDENCE;
const seedWorkspace = "editorconfig.editorconfig";
const seedUi = "dracula-theme.theme-dracula";
const id = runId("st-vscode");

const log = (line) => console.log(`[acceptance] ${line}`);

await requireImages(image);

const { scratch, home, sshDir, clientEnv } = makeScratch("mend-vscode-remote");

let xvfb = null;
let dind = null;
const context = "st-vscode-dind";

let cleaning = null;
const cleanup = () =>
  (cleaning ??= (async () => {
    if (xvfb !== null) xvfb.kill("SIGTERM");
    if (keep) {
      log(`MEND_E2E_KEEP=1: ${dind ?? "no daemon"} and ${scratch} left up`);
      return;
    }
    await removeWorld({ dind, context, scratch, clientEnv });
    log("removed the Docker-in-Docker daemon and the scratch HOME");
  })());

// Xvfb is detached, so an interrupted run would leave it (and the daemon) behind.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, () => {
    log(`${signal}: cleaning up`);
    void cleanup().finally(() => process.exit(code));
  });

const main = async () => {
  const port = 3105;
  const sshPort = 2222;

  const daemon = await startDind({ name: `${id}-dind`, scratch, home, context, clientEnv });
  dind = daemon.dind;
  const { host, inner } = daemon;
  const origin = `http://${host}:${port}`;
  const workspaceBase = `${id}-base:latest`;
  await prepareDaemon({ inner, scratch, serverImage: image, baseTag: workspaceBase, log });

  log(`server setup on ${origin}, workspace SSH on ${host}:${sshPort}`);
  await installServer({ version, context, origin, port, sshPort, clientEnv, inner, log });
  log(`PASS 3105 and 2222 are published on every interface of the daemon at ${host}`);

  const token = await signUp(origin, {
    email: `${id}@acceptance.invalid`,
    name: "VS Code acceptance",
  });
  const api = makeApi(origin, token);
  log("PASS first account at the non-loopback origin");

  const project = await adoptProject(api, { name: projectName, sourceUrl, baseTag: workspaceBase });
  log(
    `PASS adopted ${sourceUrl} as ${projectName} with a node:26-bookworm workspace base carrying sudo and acl`,
  );

  const freshWorktreeSession = await runFreshWorktreeSession(api, project.id, log);

  // The extension and the suite, bundled inside the extension's folder so the suite shares its
  // `vscode` API object (the dialogs it answers are the extension's).
  await buildExtension(repo);
  const suiteDir = path.join(repo, "apps/vscode/.e2e");
  fs.mkdirSync(suiteDir, { recursive: true });
  await run(
    path.join(repo, "apps/vscode/node_modules/.bin/esbuild"),
    [
      path.join(repo, "apps/vscode/test/e2e/suite.ts"),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--external:vscode",
      `--outfile=${path.join(suiteDir, "suite.js")}`,
    ],
    { cwd: repo },
  );

  const userData = path.join(scratch, "user-data");
  const extensions = path.join(scratch, "extensions");
  writeUserSettings(userData, sshDir, editorOff ? { "mend.workspaces.bringMyEditor": "off" } : {});
  const code = process.env.VSCODE_CLI || "code";
  const app = process.env.VSCODE_BIN || code;
  const started = await startXvfb();
  xvfb = started.xvfb;
  const display = started.display;
  const vscodeEnv = editorEnv(clientEnv, display);
  log(
    `Remote-SSH installed: ${await installExtension(code, { userData, extensions, id: "ms-vscode-remote.remote-ssh", env: vscodeEnv })}`,
  );

  for (const [seed, wantsMain] of [
    [seedWorkspace, true],
    [seedUi, false],
  ]) {
    await installExtension(code, { userData, extensions, id: seed, env: vscodeEnv });
    const folder = fs
      .readdirSync(extensions)
      .find((name) => name.toLowerCase().startsWith(`${seed}-`));
    const manifest = folder
      ? JSON.parse(fs.readFileSync(path.join(extensions, folder, "package.json"), "utf8"))
      : null;
    if (manifest === null || (typeof manifest.main === "string") !== wantsMain) {
      throw new Error(
        `${seed} is no longer the ${wantsMain ? "workspace" : "declarative"} fixture`,
      );
    }
    log(`seeded ${folder}`);
  }
  const listed = JSON.parse(fs.readFileSync(path.join(extensions, "extensions.json"), "utf8"));
  const seededEntry = listed.find(
    (entry) => String(entry?.identifier?.id).toLowerCase() === seedWorkspace,
  );
  if (
    seededEntry?.metadata?.source !== "gallery" ||
    typeof seededEntry.identifier.uuid !== "string"
  ) {
    throw new Error(`${seedWorkspace} is not recorded as installed from the gallery`);
  }
  log(`${seedWorkspace} is from the gallery (${seededEntry.identifier.uuid})`);

  const resultFile = path.join(scratch, "result.json");
  const testEnv = {
    ...vscodeEnv,
    MEND_E2E_URL: origin,
    MEND_E2E_OWNER_TOKEN: token,
    MEND_E2E_PROJECT: projectName,
    MEND_E2E_RESULT: resultFile,
    MEND_E2E_RUN_ID: id,
    MEND_E2E_REMOTE_SSH: remoteSsh ? "1" : "0",
    MEND_E2E_EDITOR: editorOff ? "off" : "on",
    MEND_E2E_SEED_WORKSPACE: seedWorkspace,
    MEND_E2E_SEED_UI: seedUi,
    MEND_E2E_SEED_UUID: seededEntry.identifier.uuid,
    MEND_E2E_PRIOR_SESSION: freshWorktreeSession,
  };
  log(
    `VS Code ${lines((await run(code, ["--version"], { env: vscodeEnv })).stdout)[0]} on ${display}`,
  );
  const exit = await new Promise((resolve) => {
    const child = spawn(
      app,
      [
        "--extensionDevelopmentPath",
        path.join(repo, "apps/vscode"),
        "--extensionTestsPath",
        path.join(suiteDir, "suite.js"),
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        // VS Code refuses dialogs in a test host, so an install that asks fails.
        "--sync",
        "on",
        "--disable-gpu",
        "--ozone-platform=x11",
      ],
      { env: testEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    const relay = (chunk) => {
      for (const line of chunk.toString().split("\n")) {
        if (line.includes("[mend-e2e]") || /error|fail/i.test(line)) console.log(`  ${line}`);
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const timer = setTimeout(() => child.kill("SIGTERM"), 30 * 60_000);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : {};
  console.log(JSON.stringify(result, null, 2));
  // The suite's last step stops the workbench session; VS Code can exit before that stop lands.
  let workbenchStatus = null;
  const workbench = result.startSession?.sessionId;
  for (const deadline = Date.now() + 120_000; workbench && Date.now() < deadline; ) {
    workbenchStatus = (await api(`/sessions/${workbench}`).catch(() => null))?.session?.status;
    if (workbenchStatus === "stopped" || workbenchStatus === "completed") break;
    await sleep(2_000);
  }
  // Whatever the suite left running.
  const detail = await api(`/projects/${project.id}`).catch(() => null);
  for (const session of detail?.sessions ?? []) {
    if (!["stopped", "completed", "failed"].includes(session.status)) {
      await api(`/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
    }
  }
  if (exit !== 0) throw new Error(`the editor suite exited ${exit}`);
  assertEditorEvidence(result, { runId: id, remoteSsh });
  if (workbenchStatus !== "stopped" && workbenchStatus !== "completed") {
    throw new Error(`the workbench session the suite stopped is ${workbenchStatus}, not stopped`);
  }
  log("PASS the editor suite against the non-loopback server");
};

try {
  await main();
} catch (cause) {
  console.error(`[acceptance] FAIL ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir, { recursive: true });
    for (const name of ["result.json", "result.json.remote.json"]) {
      const from = path.join(scratch, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(evidenceDir, name));
    }
  }
  await cleanup();
}
