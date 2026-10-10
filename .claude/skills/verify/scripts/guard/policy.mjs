#!/usr/bin/env node
// The guard's policy: which Mend server a verifier may reach from this machine, with which CLI
// config, which CLI and which environment. One module, used by the `mend` guard beside it and by
// every driver that hands a Mend client a server (drive-tui.sh, drive-desktop.sh, drive-web.mjs,
// drive-mobile.mjs).
//
//   node guard/policy.mjs exec -- <mend argv...>   the guard: check, then replace this process with
//                                                  the real CLI, or refuse
//   node guard/policy.mjs target <url>             a driver's check: the URL is a server this run
//                                                  may reach, or refuses
//
// A run may reach two servers, and nothing else:
//   - the outer server it declared (MEND_VERIFY_OUTER_URL, as the CLI config names it);
//   - its own stack, through its own tunnel: http://localhost:<port> or http://127.0.0.1:<port>,
//     where $MEND_VERIFY_PRIVATE/tunnel.json records <port>, that tunnel.mjs saw its own child bind
//     it (`bound`), and the recorded pid is still that child (its start time). Nothing may listen on
//     [::1]:<port>, where a browser would try `localhost` first. A loopback URL is not enough on its
//     own: the owner's own server, or the owner's own stack tunnel, may listen on this machine.
//
// The CLI check refuses (exit 97, nothing run) when:
//   - MEND_VERIFY_OUTER_URL is not set, or is not a URL;
//   - MEND_TOKEN is set, or MEND_URL is (they override the config file), except MEND_URL set to
//     http://127.0.0.1:9, loopback's discard port, where no server answers: the map drives the
//     CLI's unreachable-server lines with it;
//   - XDG_CONFIG_HOME is not set, is relative, or does not exist (a relative one is resolved again
//     from whatever directory the CLI starts in, and the CLI falls back to ~/.mend when it misses);
//   - <XDG_CONFIG_HOME>/mend/cli.json is missing, which is when the CLI reads the legacy ~/.mend
//     (except `mend login --url <a run's server>` into an existing <XDG_CONFIG_HOME>/mend, the one
//     command that makes a config);
//   - the config is this machine's own: under ~/.config/mend or ~/.mend (for $HOME and for the
//     account's home in the password database, which a changed HOME cannot move, and under
//     $MEND_VERIFY_MACHINE_XDG when Launch recorded one), or the same file (device and inode, so a
//     hard link), or one holding the same token or device id (a copy). Those files are read here
//     to compare and never printed;
//   - the config names a server outside the two above, or none (the CLI's default server);
//   - an argument names one: `--url <x>`, `--url=<x>`, `--server <x>`, `--server=<x>`, wherever
//     the CLI would read it (every argument, except the command after a runner's `--`: `mend run`,
//     `mend service`, `mend claude|codex|opencode|pi` pass that to the workspace, not to the CLI);
//   - the command acts on this machine's own Mend installation (`mend server …`,
//     `mend uninstall`), except their help pages: those recipes run on a disposable host;
//   - MEND_VERIFY_REAL_MEND names a Mend session's in-workspace helper (/run/mend/bin/mend, linked
//     to /usr/local/bin/mend in every workspace), or a script that starts it: the helper ignores the
//     config and acts on the session it runs in.
// The real CLI is $MEND_VERIFY_REAL_MEND, else this checkout's apps/cli from source; PATH is never
// searched, since inside a session the next `mend` on it is that helper.
// `mend login` is covered by the same rules: it signs in to its `--url`, else to the config's URL.
//
// The real CLI then runs with this machine left out of its environment: XDG_CONFIG_HOME pinned to
// the resolved directory checked above; HOME, CLAUDE_CONFIG_DIR, CODEX_HOME and GH_CONFIG_DIR in a
// home of the run's own (~/.cache/mend-verify/home/<digest of the config home>, outside the private
// directory); and no MEND_SESSION_*, SSH_AUTH_SOCK, GH_*/GITHUB_* or provider variable
// (ANTHROPIC_*, OPENAI_*, CLAUDE_*, CODEX_*, …). So `mend connect github`, `--use-my-login`,
// `memory import`, `dotfiles sync`, `skills push` and `ssh setup` see an empty home, never the
// owner's logins and files.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export class Refused extends Error {}
const refuse = (reason) => {
  throw new Refused(reason);
};

/** A server URL as the CLI dials it: a bare host:port gets http://, no trailing slash. */
export const normalizeUrl = (input) => {
  const trimmed = String(input ?? "").trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

/** The one MEND_URL a run may set: loopback's discard port, where no server answers. */
export const UNREACHABLE = "http://127.0.0.1:9";

/** A process's start time as `ps` reports it, or null once it is gone (tunnel.mjs records it). */
export const identityOf = (pid) => {
  const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  const line = run.status === 0 ? run.stdout.trim() : "";
  return line === "" ? null : line;
};

/** The local addresses listening on a TCP port (`ss`), or null when they cannot be read. */
export const listenersOn = (port) => {
  const run = spawnSync("ss", ["-ltnH", `sport = :${port}`], { encoding: "utf8" });
  if (run.status !== 0) return null;
  return run.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[3])
    .filter(Boolean);
};

/** The run's tunnel URLs, when its tunnel is the one tunnel.mjs saw bind and is still alive. */
const tunnelTargets = (env) => {
  const privateDir = env.MEND_VERIFY_PRIVATE ?? "";
  if (privateDir === "" || !isAbsolute(privateDir)) return [];
  const file = join(privateDir, "tunnel.json");
  if (!existsSync(file)) return [];
  let tunnel;
  try {
    tunnel = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    refuse(`${file} is not valid JSON`);
  }
  const port = String(tunnel.port ?? "");
  if (!/^\d+$/.test(port) || tunnel.bound !== true) return [];
  if (!Number.isInteger(tunnel.pid) || typeof tunnel.identity !== "string") return [];
  if (identityOf(tunnel.pid) !== tunnel.identity) return [];
  const listening = listenersOn(port);
  if (listening === null || listening.some((at) => at.startsWith("[")))
    refuse(`something listens on [::1]:${port}, where localhost goes first; not this run's tunnel`);
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
};

/** The servers this run may reach: its declared outer, and its own stack through its tunnel. */
export const allowedTargets = (env) => {
  const declared = env.MEND_VERIFY_OUTER_URL ?? "";
  if (declared === "") refuse("MEND_VERIFY_OUTER_URL is not set");
  const outer =
    normalizeUrl(declared) ?? refuse(`MEND_VERIFY_OUTER_URL (${declared}) is not a URL`);
  return [outer, ...tunnelTargets(env)];
};

/** Refuses unless `url` is one of the run's servers. */
export const checkTarget = (url, env) => {
  const targets = allowedTargets(env);
  const wanted = normalizeUrl(url);
  if (wanted === null || !targets.includes(wanted))
    refuse(
      `${url || "no server"} is neither the declared outer (${targets[0]}) nor this run's tunnel`,
    );
  return wanted;
};

const RUNNERS = new Set(["run", "service", "claude", "codex", "opencode", "pi"]);
const MACHINE = new Set(["server", "uninstall"]);
const TARGET_FLAGS = ["--url", "--server"];

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * This machine's own homes: $HOME's, and the account's home from the password database, which no
 * environment changes. A run that sets HOME elsewhere must not make the real home's config look
 * like a run's own.
 */
export const machineHomes = () => [...new Set([homedir(), userInfo().homedir])];

/** This machine's own CLI config files that exist: each home's, and the recorded XDG one's. */
const machineConfigs = (homes, env) => {
  const dirs = homes.flatMap((at) => [join(at, ".config", "mend"), join(at, ".mend")]);
  const recorded = env.MEND_VERIFY_MACHINE_XDG ?? "";
  if (recorded !== "" && isAbsolute(recorded)) dirs.push(join(recorded, "mend"));
  return dirs;
};

/** The values a config is the owner's by: its token and device id. Read, never printed. */
const credentialsOf = (file) => {
  try {
    const { token, deviceId } = JSON.parse(readFileSync(file, "utf8"));
    return [token, deviceId].filter((value) => typeof value === "string" && value.length >= 6);
  } catch {
    return [];
  }
};

/** Refuses a config dir that is this machine's own: by path, by file identity, by credential. */
const refuseMachineConfig = (configDir, configFile, homes, env) => {
  const resolved = [real(configDir) ?? configDir, real(configFile)].filter((at) => at !== null);
  const mine = existsSync(configFile) ? statSync(configFile) : null;
  const held = existsSync(configFile) ? credentialsOf(configFile) : [];
  for (const dir of machineConfigs(homes, env)) {
    const own = real(dir);
    if (own === null) continue;
    if (resolved.some((at) => at === own || at.startsWith(own + sep)))
      refuse(`${configDir} is this machine's own CLI config`);
    const ownFile = join(own, "cli.json");
    if (mine === null || !existsSync(ownFile)) continue;
    const theirs = statSync(ownFile);
    if (theirs.dev === mine.dev && theirs.ino === mine.ino)
      refuse(`${configFile} is this machine's own CLI config (the same file)`);
    // Read only with something to compare: a run config holding no credential needs no look.
    if (held.length === 0) continue;
    const ownValues = credentialsOf(ownFile);
    if (held.some((value) => ownValues.includes(value)))
      refuse(`${configFile} holds this machine's own sign-in (a copy of its CLI config)`);
  }
};

/**
 * The guard's check of one `mend` invocation; returns the absolute CLI config home to pin. `homes`
 * is for tests: the guard always passes this machine's own.
 */
export const checkCli = (argv, env, homes = machineHomes()) => {
  const home = homes[0];
  // One address only: the map drives the CLI's unreachable-server lines against loopback's
  // discard port, a privileged port no Mend listens on.
  if ((env.MEND_URL ?? "") !== "" && normalizeUrl(env.MEND_URL) !== UNREACHABLE)
    refuse(`MEND_URL is set (only ${UNREACHABLE}, where nothing answers, may be)`);
  if ((env.MEND_TOKEN ?? "") !== "") refuse("MEND_TOKEN is set");
  const targets = allowedTargets(env);

  const xdg = env.XDG_CONFIG_HOME ?? "";
  if (xdg === "")
    refuse("XDG_CONFIG_HOME is not set (the CLI would read this machine's own config)");
  if (!isAbsolute(xdg)) refuse(`XDG_CONFIG_HOME (${xdg}) is relative`);
  const configHome = real(xdg) ?? refuse(`XDG_CONFIG_HOME (${xdg}) does not exist`);
  const configDir = join(configHome, "mend");
  const configFile = join(configDir, "cli.json");
  refuseMachineConfig(configDir, configFile, homes, env);

  const [command, ...rest] = argv;
  const dashdash = rest.indexOf("--");
  const own = RUNNERS.has(command ?? "") && dashdash !== -1 ? rest.slice(0, dashdash) : rest;

  if (!existsSync(configFile)) {
    // The one command that makes a config: `mend login --url <a run's server>` into an existing
    // <config home>/mend, so the CLI writes there and never reaches for ~/.mend. The URL is checked
    // with every other argument below.
    const fresh =
      command === "login" &&
      own.includes("--url") &&
      real(configDir) !== null &&
      statSync(configDir).isDirectory();
    if (!fresh)
      refuse(
        `no CLI config at ${configFile} (the CLI would fall back to ${join(home, ".mend")}; only mend login --url <a run's server> may make one, into an existing ${configDir})`,
      );
  } else {
    let url;
    try {
      url = JSON.parse(readFileSync(configFile, "utf8")).url;
    } catch {
      refuse(`${configFile} is not valid JSON`);
    }
    const named = normalizeUrl(url);
    if (named === null || !targets.includes(named))
      refuse(
        `the CLI config in effect (${configDir}) names ${url || "no server"}, not ${targets[0]}`,
      );
  }
  if (MACHINE.has(command ?? "") && !own.some((arg) => arg === "--help" || arg === "-h"))
    refuse(`mend ${command} acts on this machine's own Mend installation`);
  own.forEach((arg, at) => {
    for (const flag of TARGET_FLAGS) {
      let value;
      if (arg === flag) value = own[at + 1];
      else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
      else continue;
      const wanted = normalizeUrl(value);
      if (wanted === null || !targets.includes(wanted))
        refuse(
          `${flag} ${value ?? ""} is neither the declared outer (${targets[0]}) nor this run's tunnel`,
        );
    }
  });
  return configHome;
};

// ─── the real CLI ────────────────────────────────────────────────────────────

const HELPER_ROOT = "/run/mend";
const HELPER_MARKS = ["mend — the in-workspace helper", `"${HELPER_ROOT}/mend.sock"`];

const textOf = (path) => {
  try {
    return statSync(path).size <= 4 * 1024 * 1024 ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
};

/** Whether a program is the session helper, or a script that names it. */
const isHelper = (path, root = HELPER_ROOT) => {
  const resolved = real(path) ?? path;
  if (resolved === root || resolved.startsWith(root + sep)) return true;
  const text = textOf(resolved);
  if (HELPER_MARKS.some((mark) => text.includes(mark))) return true;
  // A wrapper (`#!/bin/sh … exec <program>`): every absolute path it names, one level down.
  if (!text.startsWith("#!") || text.length > 64 * 1024) return false;
  return [...text.matchAll(/\/[^\s"'`$;|&<>()]+/g)].some(([named]) => {
    const target = real(named);
    if (target === null || target === resolved) return false;
    if (target === root || target.startsWith(root + sep)) return true;
    const inner = textOf(target);
    return HELPER_MARKS.some((mark) => inner.includes(mark));
  });
};

/**
 * The real CLI, as a program and the arguments before mend's own: $MEND_VERIFY_REAL_MEND, else this
 * checkout's own apps/cli from source (`node apps/cli/src/main.ts`). PATH is never searched: inside a
 * Mend session the next `mend` on it is the session's in-workspace helper, which ignores the config
 * and acts on that session, not on the run's stack.
 */
export const realCli = (env, guardDir, root = HELPER_ROOT) => {
  const named = env.MEND_VERIFY_REAL_MEND ?? "";
  if (named === "") {
    const main = join(guardDir, "..", "..", "..", "..", "..", "apps", "cli", "src", "main.ts");
    if (!existsSync(main)) refuse(`no CLI at ${main}; name one with MEND_VERIFY_REAL_MEND`);
    return { file: process.execPath, args: [real(main) ?? main] };
  }
  if (!isAbsolute(named)) refuse(`MEND_VERIFY_REAL_MEND (${named}) is relative`);
  if (isHelper(named, root))
    refuse(`${named} is a Mend session's in-workspace helper, which acts on that session`);
  return { file: named, args: [] };
};

// ─── the real CLI's environment ─────────────────────────────────────────────

const SCRUBBED =
  /^(?:MEND_SESSION_|MEND_URL$|MEND_TOKEN$|SSH_AUTH_SOCK$|GH_|GITHUB_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_|OPENCODE_|GEMINI_|GOOGLE_API_KEY$|GOOGLE_GENERATIVE_AI_|AZURE_OPENAI_|OPENROUTER_|XAI_|MISTRAL_|GROQ_|DEEPSEEK_|AWS_)/;

/** The home the real CLI gets: the run's own, outside the private directory. */
export const runHome = (configHome) =>
  join(
    userInfo().homedir,
    ".cache",
    "mend-verify",
    "home",
    createHash("sha256").update(configHome).digest("hex").slice(0, 16),
  );

/** The real CLI's environment: this machine's homes, logins and session left out. */
export const childEnv = (env, configHome) => {
  const child = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !SCRUBBED.test(name) || (name === "MEND_URL" && normalizeUrl(env.MEND_URL) === UNREACHABLE),
    ),
  );
  const home = runHome(configHome);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return {
    ...child,
    XDG_CONFIG_HOME: configHome,
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    GH_CONFIG_DIR: join(home, ".config", "gh"),
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "exec" && rest[0] === "--") {
      const argv = rest.slice(1);
      const configHome = checkCli(argv, process.env);
      const cli = realCli(process.env, dirname(fileURLToPath(import.meta.url)));
      process.execve(cli.file, [cli.file, ...cli.args, ...argv], childEnv(process.env, configHome));
    } else if (mode === "target" && rest.length === 1) checkTarget(rest[0], process.env);
    else {
      process.stderr.write("usage: policy.mjs exec -- <mend argv...> | target <url>\n");
      process.exit(2);
    }
  } catch (error) {
    // Anything else that goes wrong refuses too: the guard fails closed.
    const reason =
      error instanceof Refused ? error.message : `the guard failed (${error?.message ?? error})`;
    process.stderr.write(
      `mend-guard: ${reason}; refused · a verifier never talks to the owner's server\n`,
    );
    process.exit(97);
  }
}
