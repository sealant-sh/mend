// The pure parts of drive-vscode.mjs: its option parsing, the names of a run, its state file (the
// ledger of what `up` made, written as each resource appears, so `down` converges from any partial
// run) and the step log (one redacted JSON line per step). No process, no network, no Playwright:
// drive-vscode.test.mjs covers these.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { redact } from "./redact.mjs";
import { redactValues } from "./secrets.mjs";

export const COMMANDS = ["up", "run", "logs", "down"];

/** The flags each command takes; a flag without `value` is a switch. */
export const FLAGS = {
  up: {
    image: { value: true, help: "a Mend server image on this machine's Docker (any ref)" },
    version: { value: true, help: "a preloaded ghcr.io/sealant-sh/mend:<version>" },
    build: {
      value: false,
      help: "build the server image from the extension checkout's Dockerfile",
    },
    extension: {
      value: true,
      help: "the Mend checkout whose apps/vscode runs (default: this one)",
    },
    repo: { value: true, help: "the Git URL to adopt and clone (default: octocat/Hello-World)" },
    run: { value: true, help: "the run's name (default: <MMDD-HHMM>-<4 hex>)" },
    "signed-out": { value: false, help: "no CLI connection seeded: the editor starts signed out" },
    "no-ssh-setup": { value: false, help: "leave workspace SSH and Remote-SSH's platform unset" },
    "no-video": { value: false, help: "do not record the display with ffmpeg" },
  },
  run: {
    run: { value: true, help: "the run (default: $MEND_VERIFY_VSCODE_RUN, else the only one)" },
    out: { value: true, help: "the evidence directory for this recipe (required)" },
    timeout: { value: true, help: "the default wait per gesture, in ms (default 30000)" },
  },
  logs: {
    run: { value: true, help: "the run (default: $MEND_VERIFY_VSCODE_RUN, else the only one)" },
    out: { value: true, help: "where the logs go (default: <evidence>/logs)" },
  },
  down: {
    run: { value: true, help: "the run (default: $MEND_VERIFY_VSCODE_RUN, else the only one)" },
  },
};

export class UsageError extends Error {}

/**
 * `<command> [--flag [value]]... [positional]...` for one of COMMANDS; an unknown flag, a missing
 * value or a value given to a switch is a UsageError. `--flag=value` is accepted too.
 */
export const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command))
    throw new UsageError(`a command is needed: ${COMMANDS.join("|")}`);
  const known = FLAGS[command];
  const options = {};
  const positional = [];
  for (let at = 0; at < rest.length; at += 1) {
    const word = rest[at];
    if (!word.startsWith("--")) {
      positional.push(word);
      continue;
    }
    const equals = word.indexOf("=");
    const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
    const spec = known[name];
    if (spec === undefined) throw new UsageError(`${command} does not take --${name}`);
    if (!spec.value) {
      if (equals !== -1) throw new UsageError(`--${name} takes no value`);
      options[name] = true;
      continue;
    }
    const value = equals === -1 ? rest[(at += 1)] : word.slice(equals + 1);
    if (value === undefined || (equals === -1 && value.startsWith("--")))
      throw new UsageError(`--${name} needs a value`);
    options[name] = value;
  }
  if (command === "up") {
    const sources = ["image", "version", "build"].filter((name) => options[name] !== undefined);
    if (sources.length !== 1)
      throw new UsageError("up takes exactly one of --image <ref>, --version <v>, --build");
  }
  if (command === "run") {
    if (positional.length !== 1) throw new UsageError("run takes one recipe module");
    if (options.out === undefined) throw new UsageError("run needs --out <dir>");
    if (options.timeout !== undefined && !/^\d+$/.test(options.timeout))
      throw new UsageError("--timeout is in milliseconds");
  } else if (positional.length !== 0) {
    throw new UsageError(`${command} takes no positional argument: ${positional.join(" ")}`);
  }
  return { command, options, positional };
};

export const usage = () =>
  [
    "usage: drive-vscode.mjs <command> [flags]",
    ...COMMANDS.flatMap((command) => [
      `  ${command}${command === "run" ? " <recipe.mjs>" : ""}`,
      ...Object.entries(FLAGS[command]).map(
        ([name, spec]) => `      --${name}${spec.value ? " <value>" : ""}  ${spec.help}`,
      ),
    ]),
  ].join("\n");

const two = (n) => String(n).padStart(2, "0");

/** `<MMDD-HHMM>-<4 hex>`, as the skill's Launch names a run. */
export const newRunName = (now = new Date(), random = Math.random) => {
  const hex = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-${two(now.getUTCHours())}${two(now.getUTCMinutes())}-${hex}`;
};

/** Everything a run is named by: its world, and where its files go. */
export const runNames = (run, env = process.env, home = homedir()) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(run))
    throw new UsageError(`a run name is letters, digits, dots, dashes and underscores: ${run}`);
  const world = `st-verify-vscode-${run}`;
  const runsRoot = join(
    env.MEND_VERIFY_VSCODE_ROOT ?? join(home, ".cache", "mend-verify", "vscode"),
  );
  const root = join(runsRoot, world);
  return {
    run,
    world,
    root,
    stateFile: join(root, "state.json"),
    privateDir: join(root, "private"),
    sideDir: join(root, "side"),
    evidenceDir: join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "mend-verify", world),
  };
};

/**
 * Which run a command means: `--run`, else $MEND_VERIFY_VSCODE_RUN, else the one run whose state
 * file exists under the runs root. Two or none without a name is a UsageError.
 */
export const pickRun = (option, env = process.env, home = homedir()) => {
  if (option !== undefined) return option;
  if (env.MEND_VERIFY_VSCODE_RUN) return env.MEND_VERIFY_VSCODE_RUN;
  const runsRoot = env.MEND_VERIFY_VSCODE_ROOT ?? join(home, ".cache", "mend-verify", "vscode");
  const found = existsSync(runsRoot)
    ? readdirSync(runsRoot)
        .filter((name) => name.startsWith("st-verify-vscode-"))
        .filter((name) => existsSync(join(runsRoot, name, "state.json")))
        .map((name) => name.slice("st-verify-vscode-".length))
    : [];
  if (found.length === 1) return found[0];
  throw new UsageError(
    found.length === 0
      ? "no run is up: pass --run <name> or set MEND_VERIFY_VSCODE_RUN"
      : `${found.length} runs are up (${found.join(", ")}): pass --run <name> or set MEND_VERIFY_VSCODE_RUN`,
  );
};

/** Every Remote-SSH output log under `<userData>/logs`: one per window extension host that loaded it. */
export const remoteSshLogFiles = (userData) => {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^\d+-Remote - SSH\.log$/.test(name)) found.push(path);
    }
  };
  const root = join(userData, "logs");
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return found;
};

/**
 * Opens of a Remote-SSH window: the resolver's first attempt for an `ssh-remote+` authority, one
 * line per window open or reload, whichever extension asked. A reconnect logs `attempt 2` and up.
 */
export const resolves = (userData) =>
  remoteSshLogFiles(userData)
    .flatMap((file) => readFileSync(file, "utf8").split("\n"))
    .filter((line) => /SSH Resolver called for "ssh-remote\+[^"]*", attempt 1$/.test(line)).length;

/** The state file read, or an empty ledger when none is there. */
export const readState = (stateFile) =>
  existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};

/** The ledger rewritten whole, atomically (a crash never leaves half a file). */
export const writeState = (stateFile, state) => {
  mkdirSync(join(stateFile, ".."), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
  return state;
};

/** One more fact in the ledger, kept at once: `down` sees whatever `up` had made when it died. */
export const updateState = (stateFile, patch) =>
  writeState(stateFile, { ...readState(stateFile), ...patch });

/**
 * The step log: `steps.jsonl` under the recipe's evidence directory, one line per step, every
 * string in it redacted by value (the registry) and by shape (redact.mjs). `n` counts from 1.
 */
export const stepLog = (file, secrets) => {
  const scrub = (text) => redact(redactValues(text, secrets));
  const scrubDeep = (value) => {
    if (typeof value === "string") return scrub(value);
    if (Array.isArray(value)) return value.map(scrubDeep);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, scrubDeep(inner)]),
      );
    return value;
  };
  let n = 0;
  return {
    scrub,
    /** Appends the line and returns it, as written. */
    write: (line) => {
      n += 1;
      const written = scrubDeep({ n, ...line });
      writeFileSync(file, `${JSON.stringify(written)}\n`, { flag: "a" });
      return written;
    },
  };
};
