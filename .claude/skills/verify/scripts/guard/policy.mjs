#!/usr/bin/env node
// The guard's policy: which Mend server a verifier may reach from this machine, and with which CLI
// config. One module, used by the `mend` guard beside it and by every driver that hands a Mend
// client a server (drive-tui.sh, drive-desktop.sh, drive-web.mjs, drive-mobile.mjs).
//
//   node guard/policy.mjs cli -- <mend argv...>   the guard's check: prints the CLI config
//                                                 directory to pin, or refuses
//   node guard/policy.mjs target <url>            a driver's check: the URL is a server this run
//                                                 may reach, or refuses
//
// A run may reach two servers, and nothing else:
//   - the outer server it declared (MEND_VERIFY_OUTER_URL, as the CLI config names it);
//   - its own stack, through its own tunnel: http://localhost:<port> (or 127.0.0.1, [::1]) where
//     <port> is the one $MEND_VERIFY_PRIVATE/tunnel.json records (tunnel.mjs writes it).
// A loopback URL is not enough on its own: the owner's own server may listen on this machine.
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
//   - the config is this machine's own (under ~/.config/mend or ~/.mend, for $HOME and for the
//     account's home in the password database, which a changed HOME cannot move): a verifier's
//     config is its own;
//   - the config names a server outside the two above, or none (the CLI's default server);
//   - an argument names one: `--url <x>`, `--url=<x>`, `--server <x>`, `--server=<x>`, wherever
//     the CLI would read it (every argument, except the command after a runner's `--`: `mend run`,
//     `mend service`, `mend claude|codex|opencode|pi` pass that to the workspace, not to the CLI);
//   - the command acts on this machine's own Mend installation (`mend server …`,
//     `mend uninstall`), except their help pages: those recipes run on a disposable host.
// `mend login` is covered by the same rules: it signs in to its `--url`, else to the config's URL.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, sep } from "node:path";
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The servers this run may reach: its declared outer, and its own stack through its tunnel. */
export const allowedTargets = (env) => {
  const declared = env.MEND_VERIFY_OUTER_URL ?? "";
  if (declared === "") refuse("MEND_VERIFY_OUTER_URL is not set");
  const outer =
    normalizeUrl(declared) ?? refuse(`MEND_VERIFY_OUTER_URL (${declared}) is not a URL`);
  const targets = [outer];
  const privateDir = env.MEND_VERIFY_PRIVATE ?? "";
  if (privateDir !== "" && isAbsolute(privateDir)) {
    const file = join(privateDir, "tunnel.json");
    if (existsSync(file)) {
      let port;
      try {
        port = String(JSON.parse(readFileSync(file, "utf8")).port ?? "");
      } catch {
        refuse(`${file} is not valid JSON`);
      }
      if (/^\d+$/.test(port)) for (const host of LOOPBACK) targets.push(`http://${host}:${port}`);
    }
  }
  return targets;
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
const machineHomes = () => [...new Set([homedir(), userInfo().homedir])];

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
  // Under either home's ~/.config/mend or ~/.mend, symlinks resolved: this machine's own config.
  // The directory and the file each resolved: either may be a link into the owner's config.
  const resolved = [real(configDir) ?? configDir, real(configFile)].filter((at) => at !== null);
  for (const own of homes.flatMap((at) => [join(at, ".config", "mend"), join(at, ".mend")])) {
    const mine = real(own);
    if (mine !== null && resolved.some((at) => at === mine || at.startsWith(mine + sep)))
      refuse(`${configDir} is this machine's own CLI config`);
  }

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "cli" && rest[0] === "--")
      process.stdout.write(checkCli(rest.slice(1), process.env));
    else if (mode === "target" && rest.length === 1) checkTarget(rest[0], process.env);
    else {
      process.stderr.write("usage: policy.mjs cli -- <mend argv...> | target <url>\n");
      process.exit(2);
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    process.stderr.write(
      `mend-guard: ${error.message}; refused · a verifier never talks to the owner's server\n`,
    );
    process.exit(97);
  }
}
