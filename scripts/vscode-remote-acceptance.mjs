#!/usr/bin/env node
/**
 * VS Code against a Mend server on another address: the MacBook-and-Mac-mini shape, on one Linux
 * machine. The server runs in its own Docker daemon (Docker-in-Docker), as on a Mac, where Docker
 * Desktop is a Linux VM whose published ports the host forwards. `mend server setup` installs the
 * packaged server there with `--bind 0.0.0.0` and `--url http://<address>:<port>`, and the daemon's
 * ports are forwarded from a NON-loopback address of this machine only (a LAN or tailnet IP). It
 * creates the first account, adopts a repository,
 * then runs apps/vscode/test/e2e/suite.ts inside a real VS Code under Xvfb. The suite signs in
 * through the browser walk, watches live events, starts a Workbench session, writes the
 * Remote-SSH config and connects with `ssh` through it, types in the session's terminal over
 * /api/tty, opens review, and (MEND_E2E_REMOTE_SSH=1, the default) opens the workspace with the
 * real Remote-SSH extension.
 *
 *   MEND_TEST_VERSION=0.36.0-next.656 [MEND_E2E_HOST=100.101.141.6] \
 *     node scripts/vscode-remote-acceptance.mjs
 *
 * Inputs:
 *   MEND_TEST_VERSION   a preloaded ghcr.io/sealant-sh/mend:<version> (required)
 *   MEND_E2E_HOST       the address to bind and advertise; default the first non-loopback,
 *                       non-bridge IPv4 of this machine
 *   MEND_E2E_REPO       the Git URL to adopt; default https://github.com/octocat/Hello-World.git
 *   VSCODE_CLI          the `code` command, for installing Remote-SSH; default `code` on PATH
 *   VSCODE_BIN          the VS Code application (Electron) the suite runs in; default VSCODE_CLI
 *   MEND_E2E_REMOTE_SSH 0 skips the real Remote-SSH window (step 8)
 *   MEND_E2E_KEEP       1 leaves the server and scratch directory up for inspection
 *
 * Nothing touches this machine's own Docker daemon but the one Docker-in-Docker container, run from
 * a preloaded docker:27.5.1-dind with the images copied in; on exit it is removed with its storage,
 * and the scratch HOME and Xvfb go with it.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.env.MEND_TEST_VERSION;
if (!version) throw new Error("set MEND_TEST_VERSION to a preloaded ghcr.io/sealant-sh/mend tag");
const image = `ghcr.io/sealant-sh/mend:${version}`;
const sourceUrl = process.env.MEND_E2E_REPO || "https://github.com/octocat/Hello-World.git";
const projectName = "st-vscode-remote";
const remoteSsh = process.env.MEND_E2E_REMOTE_SSH !== "0";
const keep = process.env.MEND_E2E_KEEP === "1";
const runId = `st-vscode-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

const log = (line) => console.log(`[acceptance] ${line}`);

const sh = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result;
};
const docker = (args, options) => sh("docker", args, options).stdout.trim();
const lines = (text) => text.split("\n").filter((line) => line.trim() !== "");

const hostAddress = () => {
  if (process.env.MEND_E2E_HOST) return process.env.MEND_E2E_HOST;
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|kind|cni|flannel)/.test(name)) continue;
    const found = addresses?.find((address) => address.family === "IPv4" && !address.internal);
    if (found) return found.address;
  }
  throw new Error("no non-loopback IPv4 address; set MEND_E2E_HOST");
};

const freePort = (host) =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dindImage = "docker:27.5.1-dind";
for (const needed of [image, "postgres:17-alpine", "dxflrs/garage:v2.4.1", dindImage]) {
  docker(["image", "inspect", needed, "--format", "{{.Id}}"]);
}

// Not under /tmp: docker:dind mounts its own tmpfs there, which would hide the shared HOME.
const scratchRoot = path.join(os.homedir(), ".cache");
fs.mkdirSync(scratchRoot, { recursive: true });
const scratch = fs.mkdtempSync(path.join(scratchRoot, "mend-vscode-remote-"));
const home = path.join(scratch, "home");
fs.mkdirSync(home, { mode: 0o700 });
const configHome = path.join(home, ".config");
// The run's own HOME, sign-in and SSH key: never this machine's cli.json, ~/.ssh or agent identities.
const { MEND_URL: _url, MEND_TOKEN: _token, SSH_AUTH_SOCK: _agent, ...inherited } = process.env;
const clientEnv = { ...inherited, HOME: home, XDG_CONFIG_HOME: configHome };
// OpenSSH takes `~` from the passwd entry, not HOME: without this hand-written block every ssh of
// the run (the suite's and Remote-SSH's) would record gateway keys in this machine's known_hosts.
// The extension's managed block goes before it, and must leave it as written.
const sshDir = path.join(home, ".ssh");
fs.mkdirSync(sshDir, { mode: 0o700 });
const handWritten = `# The run's own: keep host keys out of this machine's known_hosts.\nHost *\n  UserKnownHostsFile ${path.join(sshDir, "known_hosts")}\n`;
fs.writeFileSync(path.join(sshDir, "config"), handWritten, { mode: 0o600 });

let xvfb = null;
let dind = null;

const cleanup = () => {
  if (xvfb !== null) xvfb.kill("SIGTERM");
  if (keep) {
    log(`MEND_E2E_KEEP=1: ${dind ?? "no daemon"} and ${scratch} left up`);
    return;
  }
  if (dind !== null) sh("docker", ["rm", "-fv", dind], { allowFailure: true });
  // The daemon wrote some of it as root (its socket directory, Postgres's files).
  sh(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${scratch}:/scratch`,
      "--entrypoint",
      "sh",
      dindImage,
      "-c",
      "rm -rf /scratch/* /scratch/.[!.]*",
    ],
    { allowFailure: true },
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  log("removed the Docker-in-Docker daemon and the scratch HOME");
};

const main = async () => {
  const host = hostAddress();
  const port = await freePort(host);
  const sshPort = await freePort(host);
  const origin = `http://${host}:${port}`;

  // The server's own daemon. Its published ports are forwarded from `host` alone.
  const socketDir = path.join(scratch, "dind-run");
  fs.mkdirSync(socketDir);
  dind = docker([
    "run",
    "-d",
    "--privileged",
    "--name",
    `${runId}-dind`,
    "-e",
    "DOCKER_TLS_CERTDIR=",
    "-p",
    `${host}:${port}:${port}`,
    "-p",
    `${host}:${sshPort}:${sshPort}`,
    "-v",
    `${socketDir}:/var/run`,
    // The generation's files are bind-mounted by host path (postgres-init.sh), so the daemon must
    // see this HOME at the same path: Docker Desktop's file sharing, which covers /Users on a Mac.
    "-v",
    `${home}:${home}`,
    dindImage,
    "dockerd",
    "--host=unix:///var/run/docker.sock",
  ]);
  const socket = path.join(socketDir, "docker.sock");
  for (let attempt = 0; attempt < 60 && !fs.existsSync(socket); attempt += 1) await sleep(500);
  docker(["exec", dind, "chmod", "666", "/var/run/docker.sock"]);
  const context = "st-vscode-dind";
  sh("docker", ["context", "create", context, "--docker", `host=unix://${socket}`], {
    env: clientEnv,
  });
  const inner = (args, options = {}) =>
    sh("docker", ["--context", context, ...args], { env: clientEnv, ...options }).stdout.trim();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      sh("docker", ["--context", context, "info"], { env: clientEnv, allowFailure: true })
        .status === 0
    )
      break;
    await sleep(500);
  }
  log("copying the server's images into its daemon");
  const saved = path.join(scratch, "images.tar");
  docker(
    ["save", "-o", saved, image, "postgres:17-alpine", "dxflrs/garage:v2.4.1", "node:26-bookworm"],
    {
      timeout: 900_000,
    },
  );
  inner(["load", "-i", saved], { timeout: 900_000 });
  fs.rmSync(saved);
  const cli = (args, options = {}) =>
    sh(process.execPath, [path.join(repo, "apps/cli/src/main.ts"), ...args], {
      env: clientEnv,
      timeout: 900_000,
      ...options,
    });

  log(`server setup on ${origin}, workspace SSH on ${host}:${sshPort}`);
  const setup = cli([
    "server",
    "setup",
    "--offline",
    "--version",
    version,
    "--assets-dir",
    path.join(repo, "deploy/docker"),
    "--context",
    context,
    // The daemon-side socket, as on Docker Desktop: the client reaches the daemon through a socket
    // of its own, and the containers mount the daemon's.
    "--docker-socket",
    "/var/run/docker.sock",
    "--bind",
    "0.0.0.0",
    "--url",
    origin,
    "--port",
    String(port),
    "--ssh-port",
    String(sshPort),
  ]);
  for (const line of lines(setup.stdout)) log(`setup: ${line}`);

  // Inside the daemon, 3105 and 2222 are published on every interface (what --bind 0.0.0.0 asks);
  // outside, only `host` forwards to them.
  const mendId = inner([
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=mend",
    "--filter",
    "label=com.docker.compose.service=mend",
  ]);
  const bindings = JSON.parse(
    inner(["inspect", mendId, "--format", "{{json .HostConfig.PortBindings}}"]),
  );
  for (const [inside, outside] of [
    ["3105/tcp", port],
    ["2222/tcp", sshPort],
  ]) {
    const bound = bindings[inside];
    if (
      bound?.length !== 1 ||
      bound[0].HostIp !== "0.0.0.0" ||
      bound[0].HostPort !== String(outside)
    ) {
      throw new Error(`${inside} is published as ${JSON.stringify(bound)}, not 0.0.0.0:${outside}`);
    }
  }
  log(
    `PASS 3105 and 2222 reach ${host}:${port} and ${host}:${sshPort} through the daemon's forward`,
  );

  const signup = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: `${runId}@acceptance.invalid`,
      password: randomBytes(24).toString("hex"),
      name: "VS Code acceptance",
    }),
  });
  const token = signup.headers.get("set-auth-token");
  if (!signup.ok || !token) throw new Error(`signup at ${origin} failed: ${signup.status}`);
  const api = async (route, init = {}) => {
    const response = await fetch(`${origin}/api${route}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${init.method ?? "GET"} ${route} → ${response.status} ${text}`);
    return text === "" ? null : JSON.parse(text);
  };
  log("PASS first account at the non-loopback origin");

  const project = await api("/projects", {
    method: "POST",
    body: JSON.stringify({ name: projectName, source: sourceUrl }),
  });
  // With sudo and ACL tools the image can take a person per Linux user (ADR 0016, the 0.36
  // default): the terminal then runs as the person, and the run records what Remote-SSH runs as.
  const workspaceBase = `${runId}-base:latest`;
  const baseContext = path.join(scratch, "base");
  fs.mkdirSync(baseContext);
  fs.writeFileSync(
    path.join(baseContext, "Dockerfile"),
    "FROM node:26-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends sudo acl && rm -rf /var/lib/apt/lists/*\n",
  );
  inner(["build", "-q", "-t", workspaceBase, baseContext], { timeout: 900_000 });
  await api(`/projects/${project.id}/workspace-image`, {
    method: "PUT",
    body: JSON.stringify({
      workspaceImage: {
        mode: "custom",
        baseImage: workspaceBase,
        packages: [],
        setupCommands: [],
        services: { docker: false },
      },
    }),
  });
  log(
    `PASS adopted ${sourceUrl} as ${projectName} with a node:26-bookworm workspace base carrying sudo and acl`,
  );

  // The extension and the suite, bundled inside the extension's folder so the suite shares its
  // `vscode` API object (the dialogs it answers are the extension's).
  sh("pnpm", ["--filter", "mend", "build"], { cwd: repo, stdio: "inherit" });
  const suiteDir = path.join(repo, "apps/vscode/.e2e");
  fs.mkdirSync(suiteDir, { recursive: true });
  sh(
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
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(
    path.join(userData, "User", "settings.json"),
    JSON.stringify(
      {
        "security.workspace.trust.enabled": false,
        "telemetry.telemetryLevel": "off",
        "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
        "update.mode": "none",
        "workbench.startupEditor": "none",
        "remote.SSH.showLoginTerminal": true,
        // Remote-SSH reads ~/.ssh/config by the passwd home too; the run's HOME is elsewhere.
        "remote.SSH.configFile": path.join(sshDir, "config"),
        "remote.SSH.connectTimeout": 60,
      },
      null,
      2,
    ),
  );
  const code = process.env.VSCODE_CLI || "code";
  const app = process.env.VSCODE_BIN || code;
  const vscodeEnv = { ...clientEnv };
  delete vscodeEnv.WAYLAND_DISPLAY;
  delete vscodeEnv.NIXOS_OZONE_WL;
  delete vscodeEnv.ELECTRON_RUN_AS_NODE;
  const display = `:${90 + Math.floor(Math.random() * 9)}`;
  xvfb = spawn("Xvfb", [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], {
    stdio: "ignore",
  });
  vscodeEnv.DISPLAY = display;
  await sleep(1500);
  const installed = sh(
    code,
    [
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensions,
      "--install-extension",
      "ms-vscode-remote.remote-ssh",
    ],
    { env: vscodeEnv, allowFailure: true, timeout: 300_000 },
  );
  if (installed.status !== 0) throw new Error(`Remote-SSH install failed: ${installed.stderr}`);
  log(`Remote-SSH installed: ${lines(installed.stdout).at(-1)}`);

  const resultFile = path.join(scratch, "result.json");
  const testEnv = {
    ...vscodeEnv,
    MEND_E2E_URL: origin,
    MEND_E2E_OWNER_TOKEN: token,
    MEND_E2E_PROJECT: projectName,
    MEND_E2E_RESULT: resultFile,
    MEND_E2E_REMOTE_SSH: remoteSsh ? "1" : "0",
  };
  log(`VS Code ${lines(sh(code, ["--version"], { env: vscodeEnv }).stdout)[0]} on ${display}`);
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
        "--disable-gpu",
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
  // Whatever the suite left running.
  const detail = await api(`/projects/${project.id}`).catch(() => null);
  for (const session of detail?.sessions ?? []) {
    if (!["stopped", "completed", "failed"].includes(session.status)) {
      await api(`/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
    }
  }
  if (exit !== 0) throw new Error(`the editor suite exited ${exit}`);
  log("PASS the editor suite against the non-loopback server");
};

try {
  await main();
} catch (cause) {
  console.error(`[acceptance] FAIL ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
