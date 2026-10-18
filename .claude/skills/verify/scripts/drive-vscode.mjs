#!/usr/bin/env node
// The verify skill's VS Code driver: a real VS Code (the Mend extension built from a checkout,
// Microsoft's Remote-SSH installed) on an Xvfb display of its own, against a packaged Mend server
// in Docker-in-Docker, driven through its workbench DOM over CDP, the way a person clicks through
// it. The world outlives one call, like drive-desktop.sh's app:
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs up (--version <v> | --image <ref> | --build)
//       [--extension <checkout>] [--repo <url>] [--run <name>] [--signed-out] [--no-ssh-setup] [--no-video]
//   node .claude/skills/verify/scripts/drive-vscode.mjs run <recipe.mjs> --out <dir> [--run <name>] [--timeout <ms>]
//   node .claude/skills/verify/scripts/drive-vscode.mjs logs [--out <dir>] [--run <name>]
//   node .claude/skills/verify/scripts/drive-vscode.mjs down [--run <name>]
//
// `up` builds the world from scripts/vscode-remote-world.mjs (shared with the Remote-SSH
// acceptance): the daemon `st-verify-vscode-<run>-dind`, the server image (`--version` names a
// preloaded ghcr.io/sealant-sh/mend tag, `--image` any image on this machine's Docker, `--build`
// one built now from the extension checkout's Dockerfile), the first account, one adopted project
// on a workspace base with sudo and acl, one fresh-worktree session run and stopped so the image is
// built, a scratch HOME with its own CLI config and ~/.ssh, Remote-SSH installed into a scratch
// extensions directory, then VS Code (VSCODE_BIN, the Electron binary; VSCODE_CLI, the `code`
// launcher, for installs) with `--extensionDevelopmentPath <checkout>/apps/vscode`, a remote
// debugging port, a scratch user data directory, on an Xvfb display, with a local clone of the
// adopted repository open in its first window. Signed in by default (the CLI connection the
// extension reads, written as `mend login` writes it), with workspace SSH set up (`mend ssh setup`
// in the scratch HOME, and Remote-SSH's platform seeded for the alias); `--signed-out` and
// `--no-ssh-setup` start the first-run stories instead. The display is recorded with ffmpeg
// (x11grab) when ffmpeg is on PATH and `--no-video` is not given. Every name is run-scoped, so two
// runs on one machine do not collide, and nothing of local-outer.sh's is touched.
//
// Files: the ledger `~/.cache/mend-verify/vscode/st-verify-vscode-<run>/state.json` (pids, the
// display, the CDP port, the server's URL, every path; written as each resource appears, so `down`
// converges from a crash), the private directory beside it (the account's token as
// `token.secret`, the registry every helper redacts by), `side/` (the editor's stdout, beside the
// private directory, never in it), and the evidence under
// `${XDG_STATE_HOME:-~/.local/state}/mend-verify/st-verify-vscode-<run>/` (`display.mp4`, each
// recipe's `--out`, `logs/`). `up` prints `export MEND_VERIFY_VSCODE_RUN=<run>`; the other commands
// take `--run`, that variable, or the only run that is up.
//
// `run` attaches Playwright ($MEND_VERIFY_PLAYWRIGHT, default ~/.cache/mend-verify/playwright,
// never this repository's) over CDP and runs the recipe module's default export with the helpers of
// drive-vscode.workbench.mjs: `palette`, `quickInput`, `view`, `treeItem`, `notification`,
// `dialog`, `statusBar`, `terminal`, `windows`/`waitForWindow`/`useWindow`, `waitForText`,
// `shot`, `step` and `api`. Each step is one redacted line of <out>/steps.jsonl; a failing recipe
// keeps `failure-<n>.png`, collects the logs, and exits 1. `logs` copies the editor's logs (main,
// renderer, extension host, the output channels, Remote-SSH's) and the server container's into the
// evidence, redacted. `down` ends the editor, ffmpeg and Xvfb by pid, removes the daemon, the scratch
// and the context, scans the evidence against the registry, then removes the private directory.
// Running it twice, or after a crash, converges.

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  UsageError,
  newRunName,
  parseArgs,
  pickRun,
  readState,
  runNames,
  stepLog,
  updateState,
  usage,
} from "./drive-vscode.lib.mjs";
import { workbenchHelpers } from "./drive-vscode.workbench.mjs";
import { redact } from "./redact.mjs";
import { loadSecrets, redactValues, register } from "./secrets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const world = await import(
  pathToFileURL(join(here, "../../../../scripts/vscode-remote-world.mjs")).href
);

const say = (line) => process.stdout.write(`drive-vscode · ${line}\n`);
const fail = (message, code = 1) => {
  process.stderr.write(`drive-vscode: ${message}\n`);
  process.exit(code);
};

let parsed;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  fail(`${error.message}\n${usage()}`, 2);
}
const { command, options, positional } = parsed;

const alive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const end = async (pid, signal, grace) => {
  if (!alive(pid)) return "gone";
  process.kill(pid, signal);
  for (const deadline = Date.now() + grace; Date.now() < deadline; ) {
    if (!alive(pid)) return "ended";
    await world.sleep(200);
  }
  process.kill(pid, "SIGKILL");
  return "killed";
};

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });

const waitForCdp = async (port, limit = 90_000) => {
  for (const deadline = Date.now() + limit; Date.now() < deadline; ) {
    const answer = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (answer?.ok) return answer.json();
    await world.sleep(1000);
  }
  throw new Error(`no CDP on :${port} after ${limit / 1000} s`);
};

const require = createRequire(import.meta.url);

/** A detached child whose output goes to a file beside the private directory. */
const background = (program, args, { env, logFile, cwd }) => {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  const child = spawn(program, args, { env, cwd, stdio: ["ignore", fd, fd], detached: true });
  child.unref();
  closeSync(fd);
  return child.pid;
};

/** The version the server image is installed as: its label when it fits, else a dev stamp. */
const VERSION_SHAPE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const downCommand = (run) => `node ${join(here, "drive-vscode.mjs")} down --run ${run}`;

/** The run `up` is making, once it has a name: a failed `up` names it for `down`. */
let upRun = null;

const up = async () => {
  const run = options.run ?? newRunName();
  const names = runNames(run);
  if (existsSync(names.stateFile))
    fail(`run ${run} is already up (${names.stateFile}); down it first: ${downCommand(run)}`);
  upRun = run;
  const extensionCheckout = resolve(options.extension ?? world.repoRoot);
  const extensionDir = join(extensionCheckout, "apps/vscode");
  if (!existsSync(join(extensionDir, "package.json")))
    fail(`${extensionDir} is not a Mend extension checkout`);
  const sourceUrl = options.repo ?? "https://github.com/octocat/Hello-World.git";
  const code = process.env.VSCODE_CLI || "code";
  const app = process.env.VSCODE_BIN || code;
  const projectName = `st-vscode-${run}`.slice(0, 40);

  mkdirSync(names.root, { recursive: true });
  mkdirSync(names.privateDir, { mode: 0o700 });
  mkdirSync(names.sideDir, { recursive: true });
  mkdirSync(names.evidenceDir, { recursive: true });
  const state = (patch) => updateState(names.stateFile, patch);
  state({
    run,
    world: names.world,
    createdAt: new Date().toISOString(),
    evidenceDir: names.evidenceDir,
    privateDir: names.privateDir,
    sideDir: names.sideDir,
    extension: extensionDir,
    sourceUrl,
  });
  say(`run ${run} · evidence ${names.evidenceDir}`);

  // The server image: a tag on this machine's Docker, and the version setup installs it as.
  let serverImage;
  let version;
  if (options.version !== undefined) {
    version = options.version;
    serverImage = `ghcr.io/sealant-sh/mend:${version}`;
  } else if (options.build) {
    const head = (
      await world.run("git", ["rev-parse", "--short=12", "HEAD"], { cwd: extensionCheckout })
    ).stdout.trim();
    const dirty =
      (
        await world.run("git", ["status", "--porcelain"], { cwd: extensionCheckout })
      ).stdout.trim() !== "";
    version = `0.0.0-dev.sha${head}${dirty ? "-dirty" : ""}`;
    serverImage = `ghcr.io/sealant-sh/mend:${version}`;
    say(`building ${serverImage} from ${extensionCheckout} (the release's Sealant pins)`);
    await world.run(
      "docker",
      ["build", "-t", serverImage, "--build-arg", `MEND_VERSION=${version}`, extensionCheckout],
      { stdio: "inherit", timeout: 3_600_000 },
    );
  } else {
    serverImage = options.image;
    const label = await world
      .docker([
        "image",
        "inspect",
        serverImage,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.version"}}',
      ])
      .catch(() => "");
    const id = (
      await world.docker(["image", "inspect", serverImage, "--format", "{{.Id}}"])
    ).replace(/^sha256:/, "");
    version =
      VERSION_SHAPE.test(label) && label !== "dev" ? label : `0.0.0-dev.id${id.slice(0, 12)}`;
  }
  await world.requireImages(serverImage);
  state({ server: { image: serverImage, version } });

  // Everything that blocks or takes long and needs no server goes first: the extension build, the
  // editor's installs and the local clone. After the first request only awaited work runs.
  say(`building the extension in ${extensionCheckout}`);
  await world.buildExtension(extensionCheckout);
  const { scratch, home, configHome, sshDir, clientEnv } = world.makeScratch("scratch", names.root);
  const userData = join(scratch, "user-data");
  const extensions = join(scratch, "extensions");
  const checkout = join(scratch, "checkout");
  state({ scratch, home, configHome, sshDir, userData, extensions, checkout });
  world.writeUserSettings(userData, sshDir, {
    // Modals and menus in the DOM, where the helpers reach them; the terminal drawn as text.
    "window.dialogStyle": "custom",
    "window.titleBarStyle": "custom",
    "terminal.integrated.gpuAcceleration": "off",
    "window.restoreWindows": "none",
    "window.newWindowDimensions": "inherit",
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "chat.commandCenter.enabled": false,
  });
  const context = `${names.world}-dind`;
  // No display yet: the installs below need none, and a display chosen now could be another
  // run's by the time the editor starts. It is taken right before the editor.
  const installEnv = world.editorEnv(clientEnv, "");
  say(
    `Remote-SSH: ${await world.installExtension(code, { userData, extensions, id: "ms-vscode-remote.remote-ssh", env: installEnv })}`,
  );
  await world.run("git", ["clone", "-q", sourceUrl, checkout], {
    env: clientEnv,
    timeout: 600_000,
  });
  say(`cloned ${sourceUrl} into the first window's folder`);

  say(`starting the daemon ${context}`);
  const daemon = await world.startDind({ name: context, scratch, home, context, clientEnv });
  state({ dind: daemon.dind, context });
  const port = 3105;
  const sshPort = 2222;
  const origin = `http://${daemon.host}:${port}`;
  const baseTag = `${names.world}-base:latest`;
  await world.prepareDaemon({ inner: daemon.inner, scratch, serverImage, baseTag, log: say });
  if (serverImage !== `ghcr.io/sealant-sh/mend:${version}`)
    await daemon.inner(["tag", serverImage, `ghcr.io/sealant-sh/mend:${version}`]);
  say(`server setup on ${origin} · workspace SSH on ${daemon.host}:${sshPort}`);
  const { mendContainer } = await world.installServer({
    version,
    context,
    origin,
    port,
    sshPort,
    clientEnv,
    inner: daemon.inner,
    log: say,
  });
  state({
    server: {
      image: serverImage,
      version,
      origin,
      host: daemon.host,
      port,
      sshPort,
      container: mendContainer,
    },
  });

  const email = `${names.world}@verify.invalid`;
  const token = await world.signUp(origin, { email, name: "verify vscode" });
  register(names.privateDir, "token", token);
  writeFileSync(join(names.privateDir, "token.secret"), token, { mode: 0o600 });
  const api = world.makeApi(origin, token);
  const project = await world.adoptProject(api, { name: projectName, sourceUrl, baseTag });
  state({ account: { email }, project: { id: project.id, name: projectName } });
  say(`first account · project ${projectName} (${project.id})`);
  const warm = await world.runFreshWorktreeSession(api, project.id, say);
  state({ warmSession: warm });

  // The CLI connection the extension reads, written as `mend login` writes it.
  const cliDir = join(configHome, "mend");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(cliDir, "cli.json"), JSON.stringify({ url: origin, token }), { mode: 0o600 });
  let sshSetup = null;
  if (!options["no-ssh-setup"]) {
    const setup = await world.cli(["ssh", "setup"], clientEnv);
    const alias = /^Host (mend-ws-[a-z0-9-]+)$/m.exec(
      readFileSync(join(sshDir, "config"), "utf8"),
    )?.[1];
    if (alias === undefined)
      throw new Error(`mend ssh setup wrote no managed Host block: ${setup.stdout}`);
    sshSetup = { alias };
    // Remote-SSH asks the platform of an unknown host once; a person answers Linux. Seeded here so
    // the first open goes straight through, as it does after story h's first run.
    const settingsFile = join(userData, "User", "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings["remote.SSH.remotePlatform"] = { [alias]: "linux" };
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    say(`workspace SSH set up · Host ${alias}`);
  }
  if (options["signed-out"]) rmSync(join(cliDir, "cli.json"));
  state({ signedIn: !options["signed-out"], sshSetup });

  const { display, xvfb } = await world.startXvfb();
  const editorEnv = world.editorEnv(clientEnv, display);
  say(`display ${display}`);
  state({ display, pids: { xvfb: xvfb.pid } });
  let video = null;
  const ffmpeg = (
    await world.run("sh", ["-c", "command -v ffmpeg"], { allowFailure: true })
  ).stdout.trim();
  if (ffmpeg !== "" && !options["no-video"]) {
    video = join(names.evidenceDir, "display.mp4");
    const pid = background(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        "1440x900",
        "-framerate",
        "5",
        "-i",
        display,
        "-codec:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        video,
      ],
      { env: editorEnv, logFile: join(names.sideDir, "ffmpeg.log") },
    );
    state({ pids: { xvfb: xvfb.pid, ffmpeg: pid }, video });
  }

  const cdpPort = await freePort();
  const vscodePid = background(
    app,
    [
      "--extensionDevelopmentPath",
      extensionDir,
      "--user-data-dir",
      userData,
      "--extensions-dir",
      extensions,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-gpu",
      "--ozone-platform=x11",
      `--remote-debugging-port=${cdpPort}`,
      checkout,
    ],
    { env: editorEnv, logFile: join(names.sideDir, "vscode.log"), cwd: checkout },
  );
  state({
    pids: { ...readState(names.stateFile).pids, vscode: vscodePid },
    cdp: { port: cdpPort, url: `http://127.0.0.1:${cdpPort}` },
  });
  const browser = await waitForCdp(cdpPort);
  state({ editor: { app, cli: code, browser: browser.Browser } });
  say(
    `VS Code ${browser.Browser} on ${display} · CDP http://127.0.0.1:${cdpPort}${video ? ` · recording ${video}` : ""}`,
  );
  say(
    `signed ${options["signed-out"] ? "out" : "in"} · workspace SSH ${sshSetup ? `set up (${sshSetup.alias})` : "not set up"}`,
  );
  process.stdout.write(`export MEND_VERIFY_VSCODE_RUN=${run}\n`);
};

const loadState = () => {
  const run = pickRun(options.run);
  const names = runNames(run);
  const state = readState(names.stateFile);
  if (state.run === undefined) fail(`run ${run} is not up: no ${names.stateFile}`);
  return { names, state };
};

const playwrightHome =
  process.env.MEND_VERIFY_PLAYWRIGHT ?? join(homedir(), ".cache", "mend-verify", "playwright");

/** The server container's logs, raw: callers redact before anything of them is kept. */
const serverLogs = async (state) => {
  if (!state.server?.container || !state.context) return "";
  const env = { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome };
  const logs = await world.run(
    "docker",
    ["--context", state.context, "logs", "--timestamps", state.server.container],
    { env, allowFailure: true, timeout: 120_000 },
  );
  return `${logs.stdout}${logs.stderr}`;
};

const copyLogs = async ({ names, state }, out) => {
  mkdirSync(out, { recursive: true });
  const secrets = loadSecrets(names.privateDir);
  const scrub = (text) => redact(redactValues(text, secrets));
  const keep = (target, text) => {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, scrub(text));
  };
  const copied = [];
  const logsRoot = join(state.userData ?? "", "logs");
  if (existsSync(logsRoot)) {
    // Every session of this user data directory; a window's logs live under window<n>/.
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, join(rel, name));
        else if (/\.(log|json|txt)$/.test(name)) {
          keep(join(out, "editor", rel, name), readFileSync(path, "utf8"));
          copied.push(join("editor", rel, name));
        }
      }
    };
    walk(logsRoot, "");
  }
  for (const name of ["vscode.log", "ffmpeg.log"]) {
    const path = join(names.sideDir, name);
    if (existsSync(path)) {
      keep(join(out, name), readFileSync(path, "utf8"));
      copied.push(name);
    }
  }
  if (state.server?.container && state.context) {
    keep(join(out, "server.log"), await serverLogs(state));
    copied.push("server.log");
  }
  return copied;
};

const runRecipe = async () => {
  const loaded = loadState();
  const { names, state } = loaded;
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const timeout = Number(options.timeout ?? 30_000);
  const secrets = loadSecrets(names.privateDir);
  const steps = stepLog(join(out, "steps.jsonl"), secrets);
  const token = readFileSync(join(names.privateDir, "token.secret"), "utf8").trim();
  const api = world.makeApi(state.server.origin, token);
  const { chromium } = require(join(playwrightHome, "node_modules", "playwright-core"));
  const browser = await chromium.connectOverCDP(state.cdp.url);
  const context = browser.contexts()[0];
  const helpers = await workbenchHelpers(context, {
    out,
    secrets,
    steps,
    api,
    state,
    timeout,
    log: say,
    serverLogs: () => serverLogs(state),
  });
  const recipe = (await import(pathToFileURL(resolve(positional[0])).href)).default;
  let failed = false;
  try {
    await recipe(helpers);
    steps.write({ note: "recipe ended" });
  } catch (error) {
    failed = true;
    const message = steps.scrub(String(error?.message ?? error)).split("\n")[0];
    steps.write({ note: `FAILED · ${message}` });
    // Numbered among the recipe's shots, so a second failed drive into the same folder keeps the first.
    const earlier = readdirSync(out).filter((name) => /-failure-\d+\.png/.test(name)).length;
    await helpers.shot(`failure-${earlier + 1}`).catch(() => undefined);
    const copied = await copyLogs(loaded, join(out, "logs")).catch(() => []);
    process.stderr.write(
      `drive-vscode: ${message}${copied.length > 0 ? ` · logs in ${join(out, "logs")}` : ""}\n`,
    );
  } finally {
    // Over CDP this only disconnects: the editor stays as it was for the next recipe.
    await browser.close().catch(() => undefined);
  }
  process.exit(failed ? 1 : 0);
};

const logs = async () => {
  const loaded = loadState();
  const out = resolve(options.out ?? join(loaded.names.evidenceDir, "logs"));
  const copied = await copyLogs(loaded, out);
  say(`${copied.length} log file(s) in ${out}`);
};

const down = async () => {
  const run = pickRun(options.run);
  const names = runNames(run);
  const state = readState(names.stateFile);
  const pids = state.pids ?? {};
  // The editor first, then the recording (SIGINT lets ffmpeg write the file's index), then the display.
  if (pids.vscode) say(`VS Code · ${await end(pids.vscode, "SIGTERM", 15_000)}`);
  if (pids.ffmpeg) say(`ffmpeg · ${await end(pids.ffmpeg, "SIGINT", 15_000)}`);
  if (pids.xvfb) say(`Xvfb · ${await end(pids.xvfb, "SIGTERM", 5_000)}`);
  // By the name `up` gives it (the ledger keeps its id): `docker ps` exits 0 with no id when the
  // daemon is already gone.
  const dind = `${names.world}-dind`;
  const found = await world.run("docker", ["ps", "-aq", "--filter", `name=^${dind}$`], {
    allowFailure: true,
  });
  const present = found.status === 0 && found.stdout.trim() !== "";
  const clientEnv = {
    ...process.env,
    HOME: state.home ?? names.root,
    XDG_CONFIG_HOME: state.configHome ?? join(names.root, "none"),
  };
  await world.removeWorld({
    dind: present ? dind : null,
    context: state.context ?? `${names.world}-dind`,
    scratch: state.scratch,
    clientEnv,
  });
  say(`daemon ${dind} · ${present ? "removed" : "was gone"} · scratch removed`);
  let scan = 0;
  if (existsSync(names.privateDir) && existsSync(names.evidenceDir)) {
    const result = await world.run(
      process.execPath,
      [
        join(here, "scan-evidence.mjs"),
        "--dir",
        names.evidenceDir,
        "--secrets",
        names.privateDir,
        "--delete-hits",
      ],
      { allowFailure: true },
    );
    scan = result.status ?? 1;
    // Exit 2: the registry holds nothing to compare (an `up` that died before the account).
    const said =
      scan === 0
        ? "no hit"
        : scan === 2
          ? "nothing compared (no secret registered)"
          : `HIT (files deleted, see ${join(names.evidenceDir, "scan.json")})`;
    say(`evidence scan · ${said}`);
  }
  rmSync(names.root, { recursive: true, force: true });
  say(`run ${run} is down · evidence kept in ${names.evidenceDir}`);
  if (scan === 1) fail("the evidence scan found a secret; this run FAILED");
};

try {
  if (command === "up") await up();
  else if (command === "run") await runRecipe();
  else if (command === "logs") await logs();
  else await down();
} catch (error) {
  if (error instanceof UsageError) fail(error.message, 2);
  const names = (() => {
    try {
      return runNames(upRun ?? pickRun(options.run));
    } catch {
      return null;
    }
  })();
  const secrets = names && existsSync(names.privateDir) ? loadSecrets(names.privateDir) : new Map();
  const message = redact(redactValues(String(error?.stack ?? error), secrets));
  fail(
    upRun === null
      ? message
      : `${message}\nup failed part way; whatever it made is in its ledger: ${downCommand(upRun)}`,
  );
}
