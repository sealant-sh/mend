/**
 * The world a real VS Code is driven against: a packaged Mend server in its own Docker daemon
 * (Docker-in-Docker, reached at the daemon container's address, nothing published on this
 * machine), a scratch HOME with its own CLI config and `~/.ssh`, Remote-SSH installed into a
 * scratch extensions directory, and an Xvfb display. Two scripts build from it:
 * scripts/vscode-remote-acceptance.mjs (the extension's acceptance suite) and the verify skill's
 * .claude/skills/verify/scripts/drive-vscode.mjs (the live, person-like driver).
 *
 * Everything here is asynchronous on purpose. The server's HTTP keep-alive is 5 s: a blocking
 * spawnSync between two API requests leaves Node reusing a socket the server has already closed
 * ("other side closed"), so no call in this module blocks the event loop.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DIND_IMAGE = "docker:27.5.1-dind";
/** Setup's own images beside the server: its database and object store, and the package mirrors. */
export const SERVER_SUPPORT_IMAGES = [
  "postgres:17-alpine",
  "dxflrs/garage:v2.4.1",
  "nginx:1.29-alpine",
  "registry:3.1",
];
/** The workspace base the fresh-worktree session builds its image from. */
export const WORKSPACE_BASE_IMAGE = "node:26-bookworm";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const runId = (prefix) =>
  `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

/**
 * One command, awaited: stdout and stderr collected, a non-zero exit thrown unless
 * `allowFailure`. `stdio: "inherit"` streams instead of collecting.
 */
export const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const { allowFailure = false, timeout, input, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
      ...spawnOptions,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    if (child.stdin !== null) {
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
    const timer =
      timeout === undefined
        ? null
        : setTimeout(() => {
            child.kill("SIGKILL");
            stderr += `\n${command} ${args.join(" ")} timed out after ${timeout} ms`;
          }, timeout);
    child.on("error", (error) => {
      if (timer !== null) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (timer !== null) clearTimeout(timer);
      const result = { status, signal, stdout, stderr };
      if (status !== 0 && !allowFailure) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${status ?? signal}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });

export const docker = async (args, options) => (await run("docker", args, options)).stdout.trim();

export const lines = (text) => text.split("\n").filter((line) => line.trim() !== "");

/** Every image the world needs is on this machine's Docker; the first missing one is named. */
export const requireImages = async (serverImage) => {
  for (const needed of [serverImage, ...SERVER_SUPPORT_IMAGES, WORKSPACE_BASE_IMAGE, DIND_IMAGE]) {
    const found = await run("docker", ["image", "inspect", needed, "--format", "{{.Id}}"], {
      allowFailure: true,
    });
    if (found.status !== 0)
      throw new Error(`${needed} is not on this machine's Docker (docker pull it first)`);
  }
};

/**
 * The run's own HOME under ~/.cache (never /tmp: docker:dind mounts a tmpfs there, which would
 * hide the shared HOME), with its CLI config directory and a `~/.ssh/config` whose hand-written
 * block pins UserKnownHostsFile. OpenSSH takes `~` from the passwd entry, not HOME, so without
 * that block every ssh of the run would record gateway keys in this machine's known_hosts. The
 * extension's managed block goes before it and must leave it as written.
 */
export const makeScratch = (prefix, root = path.join(os.homedir(), ".cache")) => {
  fs.mkdirSync(root, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, `${prefix}-`));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const configHome = path.join(home, ".config");
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir, { mode: 0o700 });
  const handWritten = `# The run's own: keep host keys out of this machine's known_hosts.\nHost *\n  UserKnownHostsFile ${path.join(sshDir, "known_hosts")}\n`;
  fs.writeFileSync(path.join(sshDir, "config"), handWritten, { mode: 0o600 });
  // The run's own sign-in and SSH key: never this machine's cli.json, ~/.ssh or agent identities.
  const { MEND_URL: _url, MEND_TOKEN: _token, SSH_AUTH_SOCK: _agent, ...inherited } = process.env;
  const clientEnv = { ...inherited, HOME: home, XDG_CONFIG_HOME: configHome };
  return { scratch, home, configHome, sshDir, handWritten, clientEnv };
};

/**
 * The Docker-in-Docker daemon: privileged, the run's HOME bind-mounted at the same path (the
 * generation's files are bind-mounted by host path, as Docker Desktop shares /Users on a Mac),
 * and a Docker context on this machine that reaches it through its socket.
 */
export const startDind = async ({ name, scratch, home, context, clientEnv }) => {
  const socketDir = path.join(scratch, "dind-run");
  fs.mkdirSync(socketDir);
  const dind = await docker([
    "run",
    "-d",
    "--privileged",
    "--name",
    name,
    "-e",
    "DOCKER_TLS_CERTDIR=",
    "-v",
    `${socketDir}:/var/run`,
    "-v",
    `${home}:${home}`,
    DIND_IMAGE,
    "dockerd",
    "--host=unix:///var/run/docker.sock",
  ]);
  const host = await docker([
    "inspect",
    dind,
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
  ]);
  const socket = path.join(socketDir, "docker.sock");
  for (let attempt = 0; attempt < 60 && !fs.existsSync(socket); attempt += 1) await sleep(500);
  await docker(["exec", dind, "chmod", "666", "/var/run/docker.sock"]);
  await run("docker", ["context", "rm", "-f", context], { env: clientEnv, allowFailure: true });
  await run("docker", ["context", "create", context, "--docker", `host=unix://${socket}`], {
    env: clientEnv,
  });
  const inner = async (args, options = {}) =>
    (
      await run("docker", ["--context", context, ...args], { env: clientEnv, ...options })
    ).stdout.trim();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const info = await run("docker", ["--context", context, "info"], {
      env: clientEnv,
      allowFailure: true,
    });
    if (info.status === 0) break;
    await sleep(500);
  }
  return { dind, host, socket, inner };
};

/**
 * The server's images copied into the daemon, the network guard image its label names pulled
 * there (pinned by digest; `docker load` into a classic image store drops repo digests), and the
 * workspace base built: node with sudo and acl, so the image can take a person per Linux user
 * (ADR 0016, the 0.36 default) and Remote-SSH lands as the person. All before the first request.
 */
export const prepareDaemon = async ({ inner, scratch, serverImage, baseTag, log }) => {
  log("copying the server's images into its daemon");
  const saved = path.join(scratch, "images.tar");
  await docker(["save", "-o", saved, serverImage, ...SERVER_SUPPORT_IMAGES, WORKSPACE_BASE_IMAGE], {
    timeout: 900_000,
  });
  await inner(["load", "-i", saved], { timeout: 900_000 });
  fs.rmSync(saved);
  const guardImage = await inner([
    "image",
    "inspect",
    serverImage,
    "--format",
    '{{index .Config.Labels "dev.sealant.mend.network-guard-image"}}',
  ]);
  if (guardImage !== "") await inner(["pull", "-q", guardImage], { timeout: 300_000 });
  const baseContext = path.join(scratch, "base");
  fs.mkdirSync(baseContext);
  fs.writeFileSync(
    path.join(baseContext, "Dockerfile"),
    `FROM ${WORKSPACE_BASE_IMAGE}\nRUN apt-get update && apt-get install -y --no-install-recommends sudo acl && rm -rf /var/lib/apt/lists/*\n`,
  );
  await inner(["build", "-q", "-t", baseTag, baseContext], { timeout: 900_000 });
};

/** This checkout's CLI from source, in the run's environment. */
export const cli = (args, clientEnv, options = {}) =>
  run(process.execPath, [path.join(repoRoot, "apps/cli/src/main.ts"), ...args], {
    env: clientEnv,
    timeout: 900_000,
    ...options,
  });

/**
 * `mend server setup --offline` into the daemon, bound on every interface and told its own
 * non-loopback URL, then a check that 3105 and 2222 are published that way inside the daemon.
 */
export const installServer = async ({
  version,
  context,
  origin,
  port,
  sshPort,
  clientEnv,
  inner,
  log,
}) => {
  const setup = await cli(
    [
      "server",
      "setup",
      "--offline",
      "--version",
      version,
      "--assets-dir",
      path.join(repoRoot, "deploy/docker"),
      "--context",
      context,
      // The daemon-side socket, as on Docker Desktop: the client reaches the daemon through a
      // socket of its own, and the containers mount the daemon's.
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
    ],
    clientEnv,
  );
  for (const line of lines(setup.stdout)) log(`setup: ${line}`);
  const mendId = await inner([
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=mend",
    "--filter",
    "label=com.docker.compose.service=mend",
  ]);
  const bindings = JSON.parse(
    await inner(["inspect", mendId, "--format", "{{json .HostConfig.PortBindings}}"]),
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
    )
      throw new Error(`${inside} is published as ${JSON.stringify(bound)}, not 0.0.0.0:${outside}`);
  }
  return { mendContainer: mendId };
};

/**
 * The first account, signed up at the server's own origin; its bearer token is returned. A caller
 * that signs in on the web later passes the password; otherwise it is random and forgotten.
 */
export const signUp = async (
  origin,
  { email, name, password = randomBytes(24).toString("hex") },
) => {
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  const token = response.headers.get("set-auth-token");
  if (!response.ok || !token) throw new Error(`signup at ${origin} failed: ${response.status}`);
  return token;
};

/** A Mend HTTP client on one bearer: JSON in, JSON out, a non-2xx thrown with its body. */
export const makeApi =
  (origin, token) =>
  async (route, init = {}) => {
    let response;
    try {
      response = await fetch(`${origin}/api${route}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
    } catch (cause) {
      // Node says only "fetch failed"; the reason is its cause.
      throw new Error(
        `${init.method ?? "GET"} ${route} did not answer: ${cause?.cause?.message ?? cause?.message ?? cause}`,
        { cause },
      );
    }
    const text = await response.text();
    if (!response.ok)
      throw new Error(`${init.method ?? "GET"} ${route} → ${response.status} ${text}`);
    return text === "" ? null : JSON.parse(text);
  };

/** A project adopted from a clone URL, on the workspace base built by prepareDaemon. */
export const adoptProject = async (api, { name, sourceUrl, baseTag }) => {
  const project = await api("/projects", {
    method: "POST",
    body: JSON.stringify({ name, source: sourceUrl }),
  });
  await api(`/projects/${project.id}/workspace-image`, {
    method: "PUT",
    body: JSON.stringify({
      workspaceImage: {
        mode: "custom",
        baseImage: baseTag,
        packages: [],
        setupCommands: [],
        services: { docker: false },
      },
    }),
  });
  return project;
};

/**
 * A session in a fresh worktree, run once and stopped: it builds the project's workspace image,
 * so the editor's own session boots with an owner map and Remote-SSH lands as the person.
 */
export const runFreshWorktreeSession = async (api, projectId, log) => {
  const created = await api(`/projects/${projectId}/sessions`, {
    method: "POST",
    body: JSON.stringify({
      harness: "claude",
      label: "fresh worktree",
      base: null,
      name: `st-fresh-${Date.now().toString(36)}`,
    }),
  });
  const startedAt = Date.now();
  await api(`/sessions/${created.id}/resume`, {
    method: "POST",
    body: JSON.stringify({ harness: "shell" }),
  });
  for (;;) {
    const { session } = await api(`/sessions/${created.id}`);
    if (session.sealantWorkspaceId && ["running", "idle", "waiting"].includes(session.status))
      break;
    if (["failed", "stopped", "completed"].includes(session.status))
      throw new Error(`the fresh worktree's session ended ${session.status} before it ran`);
    if (Date.now() - startedAt > 5 * 60_000)
      throw new Error("the fresh worktree's session did not run within 5 minutes");
    await sleep(2_000);
  }
  await api(`/sessions/${created.id}/stop`, { method: "POST", body: "{}" }).catch(() => null);
  log(
    `PASS a session in a fresh worktree runs (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`,
  );
  return created.id;
};

/** The editor's user settings: no trust prompt, no telemetry, no updates, Remote-SSH on the run's config. */
export const writeUserSettings = (userData, sshDir, extra = {}) => {
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
        ...extra,
      },
      null,
      2,
    ),
  );
};

/**
 * The editor's environment: the run's HOME, no Wayland. Electron takes Wayland from the session
 * type even with WAYLAND_DISPLAY unset, opens the default socket and puts the windows on this
 * machine's own desktop instead of Xvfb. Unseen there, they get no idle time, and VS Code's
 * idle-time startup work (the remote terminal backend among it) crawls.
 */
export const editorEnv = (clientEnv, display) => {
  const env = { ...clientEnv, DISPLAY: display };
  if (display === "") delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.NIXOS_OZONE_WL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.XDG_SESSION_TYPE;
  return env;
};

/**
 * An Xvfb on a display no other one holds: sharing one puts this run's windows beside another's,
 * and ends them with the other's Xvfb. Choosing and starting are one step, in random order over
 * :90 to :98: a display that looked free a moment ago may be another run's by now, and Xvfb then
 * exits at once ("Server is already active"), so a start that is not alive after a moment moves on.
 */
export const startXvfb = async (
  size = "1440x900x24",
  candidates = [90, 91, 92, 93, 94, 95, 96, 97, 98],
) => {
  const order = candidates.toSorted(() => Math.random() - 0.5);
  for (const n of order) {
    if (fs.existsSync(`/tmp/.X11-unix/X${n}`) || fs.existsSync(`/tmp/.X${n}-lock`)) continue;
    const display = `:${n}`;
    const xvfb = spawn("Xvfb", [display, "-screen", "0", size, "-nolisten", "tcp"], {
      stdio: "ignore",
      detached: true,
    });
    xvfb.unref();
    await sleep(1500);
    if (xvfb.exitCode === null && xvfb.signalCode === null) return { display, xvfb };
  }
  throw new Error(`displays :${candidates[0]} to :${candidates.at(-1)} are all taken`);
};

/** `code --install-extension` into the run's own extensions directory. */
export const installExtension = async (code, { userData, extensions, id, env }) => {
  const installed = await run(
    code,
    ["--user-data-dir", userData, "--extensions-dir", extensions, "--install-extension", id],
    { env, allowFailure: true, timeout: 300_000 },
  );
  if (installed.status !== 0) throw new Error(`installing ${id} failed: ${installed.stderr}`);
  return lines(installed.stdout).at(-1) ?? "";
};

/**
 * The extension, built from a checkout (`apps/vscode/dist/extension.js`). By path, not by name:
 * the root package is named `mend` too, and `--filter mend` would run the whole workspace's build.
 * Its workspace dependencies export their TypeScript sources, so nothing else needs building.
 */
export const buildExtension = async (checkout = repoRoot) => {
  await run("pnpm", ["--filter", "./apps/vscode", "run", "build"], {
    cwd: checkout,
    stdio: "inherit",
  });
  const built = path.join(checkout, "apps/vscode/dist/extension.js");
  if (!fs.existsSync(built)) throw new Error(`${built} is missing after the build`);
  return path.join(checkout, "apps/vscode");
};

/**
 * The daemon removed with its storage, and the scratch directory with it. The daemon wrote some
 * of the scratch as root (its socket directory, Postgres's files), so a dind container removes it.
 */
export const removeWorld = async ({ dind, context, scratch, clientEnv }) => {
  if (dind) await run("docker", ["rm", "-fv", dind], { allowFailure: true });
  if (context)
    await run("docker", ["context", "rm", "-f", context], { env: clientEnv, allowFailure: true });
  if (scratch && fs.existsSync(scratch)) {
    await run(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${scratch}:/scratch`,
        "--entrypoint",
        "sh",
        DIND_IMAGE,
        "-c",
        "rm -rf /scratch/* /scratch/.[!.]*",
      ],
      { allowFailure: true },
    );
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};
