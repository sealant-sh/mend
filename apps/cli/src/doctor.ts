import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  claudeGrantFacts,
  HOST_USER_NAMESPACES_REFUSED,
  hostUserNamespacesFixLine,
} from "@mend/domain/workbench";

import {
  dockerStopCheck,
  type DockerStopReading,
  observeHostDockerStop,
} from "./docker-shutdown.ts";
import { redactCredentials } from "./shared.ts";

/**
 * `mend doctor`: one read-only pass over everything a first run depends on, printed
 * as mono status lines (DESIGN.md §4 — a mark plus a word, never a badge). Every
 * line states what was observed; a line that needs an action ends with the single
 * command that takes it. Nothing here writes, launches, or repairs anything.
 *
 * No request waits longer than 3s: a doctor that hangs is worse than a doctor that
 * reports "not checked".
 */

const TIMEOUT_MS = 3_000;

export type Provider = "claude" | "codex" | "github";

export interface DoctorConfig {
  readonly url: string;
  readonly token: string | null;
}

/** One `pmset -g` setting as a number: `sleep`, `womp`; null when the output does not list it. */
const pmsetValue = (output: string, name: string): number | null => {
  const match = new RegExp(`^\\s*${name}\\s+(\\d+)`, "m").exec(output);
  return match?.[1] === undefined ? null : Number(match[1]);
};

/**
 * A Mac that serves Mend and sleeps on its own, as one doctor line; null when it does not (or the
 * settings say nothing). OrbStack and Docker Desktop pause their VM while the Mac sleeps, the
 * lid-closed Maintenance Sleep included: builds stall, sessions drop, and the VM's clock wakes
 * behind. "Wake for network access" (`womp`) lets the tailnet wake it.
 */
export const macSleepCheck = (pmset: string): Check | null => {
  const sleepMinutes = pmsetValue(pmset, "sleep");
  if (sleepMinutes === null || sleepMinutes === 0) return null;
  const wakeForNetwork = pmsetValue(pmset, "womp");
  return {
    label: "sleep",
    state: "todo",
    detail: `this Mac sleeps after ${sleepMinutes} min idle, and the Docker VM pauses while it sleeps: builds stall, sessions drop, its clock drifts`,
    fix: `sudo pmset -a sleep 0 disksleep 0${wakeForNetwork === 0 ? " womp 1" : ""} (System Settings → Energy → Prevent automatic sleeping when the display is off${wakeForNetwork === 0 ? ", and Wake for network access" : ""})`,
  };
};

/**
 * A Mac with a lid that sleeps when it is closed, as one doctor line; null when it does not (no
 * lid, as on a Mac mini, or closed-lid mode: power and an external display attached) or the
 * reading says nothing. `pmset -g` can read `sleep 0` on such a Mac and closing the lid still
 * sleeps it, pausing the Docker VM (RC 0.36.0-next.768, a MacBook: the VM's clock woke 72 min
 * behind). `ioreg`'s `AppleClamshellCausesSleep` is what decides it: `Yes` while closing the lid
 * sleeps the Mac.
 */
export const macLidSleepCheck = (ioreg: string): Check | null => {
  const match = /"AppleClamshellCausesSleep"\s*=\s*(Yes|No)/.exec(ioreg);
  if (match?.[1] !== "Yes") return null;
  return {
    label: "lid",
    state: "todo",
    detail:
      "closing this Mac's lid sleeps it unless an external display and power are attached, and the Docker VM pauses while it sleeps: builds stall, sessions drop, its clock drifts",
    fix: "keep the lid open, or attach power and an external display before you close it",
  };
};

/** `ioreg`'s power-management root, where a Mac with a lid says what closing it does. */
export const readMacLid = (): string | null => {
  const read = spawnSync("ioreg", ["-r", "-k", "AppleClamshellCausesSleep", "-d", "1"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  return read.status === 0 ? read.stdout : null;
};

/** `pmset -g`, bounded like every other read here; null when it fails. */
export const readMacPowerSettings = (): string | null => {
  const read = spawnSync("pmset", ["-g"], { encoding: "utf8", timeout: TIMEOUT_MS });
  return read.status === 0 ? read.stdout : null;
};

/** ok: observed working · todo: not set up yet · failed: the workbench cannot run like this. */
export type CheckState = "ok" | "todo" | "failed";

export interface Check {
  readonly label: string;
  readonly state: CheckState;
  readonly detail: string;
  /** The one command that changes this line, printed after an arrow. */
  readonly fix: string | null;
}

export interface DoctorProbes {
  /** The credential as THIS machine holds it (main.ts owns the file locations). */
  readonly localCredential: (provider: Provider) => string | null;
  /**
   * The Claude grant Mend keeps for itself, or null when it keeps none — someone who connected
   * with `--use-my-login` or `--from-stdin` has no grant of Mend's own, and there is nothing to
   * report (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
   */
  readonly claudeGrant: () => string | null;
  readonly onPath: (command: string) => boolean;
  /**
   * What a Docker daemon stop waits for against what its host allows (`docker-shutdown.ts`), read
   * only when docker is on PATH: the daemon of the context named, the server's own when one is
   * installed here, else the current one. Absent: the line is left out.
   */
  readonly dockerStop?: (context: string | null) => DockerStopReading;
  /**
   * The Mend server installed on this machine (`mend server setup`), or null when there is none
   * here. A setup that moved the server leaves this machine's CLI on the old URL, and a second
   * server on this machine (another Docker engine) may answer where the CLI points. Absent: not
   * read.
   */
  readonly localServer?: () => Promise<LocalServerFacts | null>;
  /**
   * `pmset -g` on a Mac, read only when a server is installed on this machine: whether it sleeps
   * on its own. Null when it could not be read. Absent (not a Mac): the line is left out.
   */
  readonly macPowerSettings?: () => string | null;
  /**
   * `ioreg`'s `AppleClamshellCausesSleep` on a Mac, read only when a server is installed on this
   * machine: whether closing its lid sleeps it. Null when it could not be read. Absent (not a
   * Mac): the line is left out.
   */
  readonly macLid?: () => string | null;
}

/** What doctor reads of the server `mend server setup` installed here. */
export interface LocalServerFacts {
  readonly url: string;
  /** The Docker context it runs on: the daemon whose settings its workspaces live by. */
  readonly dockerContext: string;
  readonly version: string;
  /** What its health reports as `instance`. */
  readonly instance: string;
}

const MARKS: Record<CheckState, string> = { ok: "✓", todo: "○", failed: "✗" };

const LABEL_WIDTH = 11;

/** A date as a person reads it in a status line. */
const day = (at: Date): string => at.toISOString().slice(0, 10);

/** One status line. The mark is painted by the caller so the formatter stays testable. */
export const formatCheck = (
  check: Check,
  paint: (state: CheckState, mark: string) => string = (_state, mark) => mark,
): string =>
  `${paint(check.state, MARKS[check.state])} ${check.label.padEnd(LABEL_WIDTH)} ${check.detail}${
    check.fix === null ? "" : ` → ${check.fix}`
  }`;

/**
 * What one read produced. Deliberately one shape rather than a tagged union: the
 * published build compiles this file with plain `tsc` flags (no tsconfig, hence no
 * strictNullChecks), where a boolean discriminant does not narrow.
 */
interface Fetched<T> {
  /** The decoded body, or null when the read produced none. */
  readonly value: T | null;
  /** The HTTP status; null when the request got no answer at all. */
  readonly status: number | null;
  /**
   * How far the server's clock reads from this machine's, in ms (positive: the server's is
   * ahead), from its Date header against the middle of the request. Null without one.
   */
  readonly clockSkewMs: number | null;
}

/** A read that never throws and never blocks: the outcome is a value the checklist can print. */
const getJson = async <T>(config: DoctorConfig, route: string): Promise<Fetched<T>> => {
  try {
    const sent = Date.now();
    const response = await fetch(`${config.url}/api${route}`, {
      headers: config.token === null ? {} : { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const date = Date.parse(response.headers.get("date") ?? "");
    const clockSkewMs = Number.isNaN(date) ? null : date - (sent + Date.now()) / 2;
    if (!response.ok) return { value: null, status: response.status, clockSkewMs };
    return { value: (await response.json()) as T, status: response.status, clockSkewMs };
  } catch {
    return { value: null, status: null, clockSkewMs: null };
  }
};

/**
 * Past this, the server's clock and this machine's disagree enough to say so. A Date header is
 * whole seconds and a slow answer adds its own, so a smaller gap is not a finding.
 */
const CLOCK_SKEW_FINDING_MS = 2 * 60_000;

/**
 * The server's clock against this machine's, as one doctor line, or null when they agree. Sign-in
 * counts down from what the server says is left, so skew no longer breaks it, but anything that
 * compares the server's times with this machine's still reads wrong. OrbStack and Docker Desktop
 * pause their VM while a Mac sleeps, and its clock can wake hours behind until the VM restarts.
 */
export const clockCheck = (clockSkewMs: number): Check | null => {
  if (Math.abs(clockSkewMs) < CLOCK_SKEW_FINDING_MS) return null;
  const minutes = Math.round(Math.abs(clockSkewMs) / 60_000);
  return {
    label: "clock",
    state: "todo",
    detail: `this server's clock is ${minutes} min ${clockSkewMs < 0 ? "behind" : "ahead of"} this machine's`,
    fix: "if the server runs in OrbStack or Docker Desktop, restart it; otherwise check NTP on both machines (timedatectl, or sntp on a Mac)",
  };
};

interface HealthDto {
  readonly status: string;
  readonly version: string;
  /** Which install answered; absent on an older server. */
  readonly instance?: string;
}

interface ProjectSummaryDto {
  readonly id: string;
  readonly name: string;
}

interface ConnectionDto {
  readonly status: "connected" | "unauthorized" | "mismatched" | "unreachable";
  readonly baseUrl: string;
  readonly detail: string | null;
}

interface AccountDto {
  readonly provider: Provider;
  readonly name: string;
  readonly status: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface IdentityDto {
  readonly sealantUserId: string;
  readonly accounts: ReadonlyArray<AccountDto>;
}

interface MachineDto {
  /** Absent from a server older than `exposure` (docs/adr/0004). */
  readonly exposure?: {
    readonly declared: "loopback" | "private" | "public";
    readonly originScheme: "http" | "https";
    /** Absent from a server that predates the `private` default; read as false. */
    readonly originOnMachine?: boolean;
    readonly arrivedVia: "direct" | "trusted-proxy";
    readonly addressKinds: ReadonlyArray<string>;
    readonly gateOpen: number;
  };
  /** Absent from an older server, and from one whose workspaces run elsewhere than its host. */
  readonly userNamespaces?: { readonly allowed: boolean; readonly setting: string | null };
}

/**
 * How this instance is reached, as one doctor line: what the operator declared, then what the
 * server observed. A missing tailnet is not a finding, and neither is a present one. The line is
 * `todo` only for something the reader can act on: a browser origin still on plain http while
 * the instance is reachable beyond the machine. "Beyond the machine" is read from two facts, not
 * the declaration alone: the default declaration is `private`, so a laptop install whose APP_URL
 * is http://localhost would otherwise be asked for https on every run. The open gate items are
 * counted only then too: the gate is about exposure, some of its items can only ever be closed by
 * an operator's own statement, and a line that always says "items open" on a laptop install is
 * the tailnet line again under another name.
 */
export const exposureCheck = (exposure: NonNullable<MachineDto["exposure"]>): Check => {
  const beyondMachine = exposure.declared !== "loopback" && exposure.originOnMachine !== true;
  const gateOpen = beyondMachine ? exposure.gateOpen : 0;
  const facts = [
    `declared ${exposure.declared}`,
    `${exposure.originScheme} origin`,
    ...(exposure.arrivedVia === "trusted-proxy" ? ["arrived via a trusted proxy"] : []),
    ...(gateOpen === 0 ? [] : [`${gateOpen} gate items open`]),
  ].join(" · ");
  const plainBeyondMachine = beyondMachine && exposure.originScheme === "http";
  return {
    label: "exposure",
    state: plainBeyondMachine ? "todo" : "ok",
    detail: facts,
    fix: plainBeyondMachine
      ? "serve it over https: on the server's machine, mend server setup --edge <domain>, or mend server setup --url https://<origin> behind HTTPS you run"
      : gateOpen === 0
        ? null
        : "mend operator exposure",
  };
};

/**
 * Whether the server's host lets a workspace's Docker service start, as one doctor line. That
 * service is a rootless Docker daemon; a kernel that refuses unprivileged user namespaces (Ubuntu
 * 23.10 and later, by default) stops it, and every session's launch fails.
 */
export const userNamespacesCheck = (observed: NonNullable<MachineDto["userNamespaces"]>): Check =>
  observed.allowed
    ? {
        label: "workspaces",
        state: "ok",
        detail: "the server's host allows rootless Docker",
        fix: null,
      }
    : {
        label: "workspaces",
        state: "failed",
        detail: HOST_USER_NAMESPACES_REFUSED,
        fix: observed.setting === null ? null : hostUserNamespacesFixLine(observed.setting),
      };

/** Where each provider's own CLI writes the credential Mend forwards (mirrors `mend connect`). */
const LOGIN_COMMANDS: Record<Provider, string> = {
  claude: "claude setup-token",
  codex: "codex login",
  github: "gh auth login",
};

const HARNESS_CLIS: ReadonlyArray<{ readonly command: string; readonly provider: Provider }> = [
  { command: "claude", provider: "claude" },
  { command: "codex", provider: "codex" },
  { command: "gh", provider: "github" },
];

const notChecked = (label: string): Check => ({
  label,
  state: "todo",
  detail: "not checked",
  fix: null,
});

const identityOf = (account: AccountDto): string | null => {
  const meta = account.metadata;
  for (const key of ["login", "email", "accountEmail", "accountId"]) {
    const value = meta[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
};

/**
 * The server line when the configured URL does not answer. When the server installed on this
 * machine answers at another URL, setup moved it and this CLI still points at the old one: that is
 * said, rather than asking for a server that is running to be started.
 */
const unreachedServer = async (
  config: DoctorConfig,
  local: LocalServerFacts | null,
): Promise<Check> => {
  if (local !== null && local.url !== config.url) {
    const there = await getJson<HealthDto>({ url: local.url, token: null }, "/health");
    if (there.value !== null) {
      return {
        label: "server",
        state: "failed",
        detail: `cannot reach ${config.url} · the Mend server on this machine answers at ${local.url}, and this CLI points at the old URL`,
        fix: `mend login --url ${local.url}`,
      };
    }
  }
  return {
    label: "server",
    state: "failed",
    detail: `cannot reach ${config.url}`,
    fix: "start the Mend server (mend server start on its machine), or, if its URL changed, mend login --url <its URL>",
  };
};

const isLoopbackUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
};

/**
 * The server line when the CLI's URL answered. On this machine's loopback, beside a server
 * `mend server setup` installed at another URL, what answers may be another server (another
 * Docker engine's, an older install's): said when it is not the one installed here, as far as
 * its health tells.
 */
const answeredServer = async (
  config: DoctorConfig,
  health: HealthDto,
  local: LocalServerFacts | null,
): Promise<Check> => {
  const ok: Check = {
    label: "server",
    state: "ok",
    detail: `${config.url} · mend ${health.version}`,
    fix: null,
  };
  if (local === null || local.url === config.url || !isLoopbackUrl(config.url)) return ok;
  const same =
    health.instance === undefined
      ? health.version === local.version
      : health.instance === local.instance;
  if (same) return ok;
  const there = await getJson<HealthDto>({ url: local.url, token: null }, "/health");
  if (there.value === null) return ok;
  return {
    label: "server",
    state: "todo",
    detail: `${config.url} · mend ${health.version} · not the server installed on this machine, which answers at ${local.url} (mend ${there.value.version})`,
    fix: `mend login --url ${local.url}`,
  };
};

/** Every fact the checklist prints, in the order a first run needs them. */
export const runChecks = async (
  config: DoctorConfig,
  probes: DoctorProbes,
): Promise<ReadonlyArray<Check>> => {
  const checks: Array<Check> = [];

  const health = await getJson<HealthDto>(config, "/health");
  const local = probes.localServer === undefined ? null : await probes.localServer();
  checks.push(
    health.value === null
      ? await unreachedServer(config, local)
      : await answeredServer(config, health.value, local),
  );
  const clock =
    health.value === null || health.clockSkewMs === null ? null : clockCheck(health.clockSkewMs);
  if (clock !== null) checks.push(clock);

  // Projects double as the cheapest authenticated read there is: it proves the token
  // without asking the platform anything.
  const projects =
    health.value !== null && config.token !== null
      ? await getJson<ReadonlyArray<ProjectSummaryDto>>(config, "/projects")
      : null;
  if (health.value === null) checks.push(notChecked("signed in"));
  else if (config.token === null) {
    checks.push({
      label: "signed in",
      state: "failed",
      detail: "no token saved",
      fix: "mend login",
    });
  } else if (projects !== null && projects.value !== null) {
    checks.push({ label: "signed in", state: "ok", detail: "token accepted", fix: null });
  } else {
    const status = projects === null ? null : projects.status;
    checks.push(
      status === 401 || status === 403
        ? { label: "signed in", state: "failed", detail: "token rejected", fix: "mend login" }
        : {
            label: "signed in",
            state: "failed",
            detail: `GET /projects → ${status ?? "no answer"}`,
            fix: null,
          },
    );
  }
  const signedIn = projects !== null && projects.value !== null;

  const connection = signedIn ? await getJson<ConnectionDto>(config, "/sealant/connection") : null;
  if (connection === null) checks.push(notChecked("sealant"));
  else if (connection.value === null) {
    // 404 is a server older than the endpoint: nothing was observed, so nothing is claimed.
    checks.push(
      connection.status === 404
        ? notChecked("sealant")
        : {
            label: "sealant",
            state: "failed",
            detail: `GET /sealant/connection → ${connection.status ?? "no answer"}`,
            fix: null,
          },
    );
  } else if (connection.value.status === "connected") {
    checks.push({
      label: "sealant",
      state: "ok",
      detail: `connected · ${connection.value.baseUrl}`,
      fix: null,
    });
  } else {
    checks.push({
      label: "sealant",
      state: "failed",
      detail: `${connection.value.status} · ${connection.value.detail ?? connection.value.baseUrl}`,
      fix: null,
    });
  }

  const identity = signedIn ? await getJson<IdentityDto>(config, "/me/sealant") : null;
  const platform = identity === null ? null : identity.value;
  for (const { provider } of HARNESS_CLIS) {
    if (platform === null) {
      checks.push(notChecked(provider));
      continue;
    }
    const account =
      platform.accounts.find((row) => row.provider === provider && row.name === "default") ??
      platform.accounts.find((row) => row.provider === provider);
    if (account === undefined) {
      checks.push({
        label: provider,
        state: "todo",
        detail: "not connected",
        fix: `mend connect ${provider}`,
      });
      continue;
    }
    const who = identityOf(account);
    checks.push(
      account.status === "active"
        ? {
            label: provider,
            state: "ok",
            detail: who === null ? "connected" : `connected · ${who}`,
            fix: null,
          }
        : {
            label: provider,
            state: "todo",
            // A refused refresh ends the login (docs/adr/0008): say what happened, not the enum.
            detail:
              account.status === "invalid"
                ? "reconnect needed · the provider refused the login"
                : account.status,
            fix: `mend connect ${provider}`,
          },
    );
  }

  // Mend's own Claude grant, from the copy on this machine. The platform holds the same grant and
  // refreshes it, but it does not report freshness yet (PLATFORM-FEEDBACK.md 2026-09-18), so this
  // reads the local copy and says what it observed rather than guessing.
  const grant = probes.claudeGrant();
  if (grant !== null) {
    const facts = claudeGrantFacts(grant);
    if (facts === null) {
      checks.push({
        label: "grant",
        state: "failed",
        detail: "unreadable",
        fix: "mend connect claude",
      });
    } else if (!facts.hasRefreshToken) {
      checks.push({
        label: "grant",
        state: "failed",
        detail: "signed out",
        fix: "mend connect claude",
      });
    } else if (facts.refreshExpiresAt !== null && facts.refreshExpiresAt.getTime() <= Date.now()) {
      checks.push({
        label: "grant",
        state: "todo",
        detail: `expired ${day(facts.refreshExpiresAt)}`,
        fix: "mend connect claude",
      });
    } else {
      checks.push({
        label: "grant",
        state: "ok",
        detail:
          facts.refreshExpiresAt === null
            ? "Mend's own"
            : `Mend's own · expires ${day(facts.refreshExpiresAt)}`,
        fix: null,
      });
    }
  }

  const adopted = projects === null ? null : projects.value;
  if (adopted === null) checks.push(notChecked("projects"));
  else if (adopted.length === 0) {
    checks.push({ label: "projects", state: "todo", detail: "none adopted", fix: "mend adopt" });
  } else {
    checks.push({ label: "projects", state: "ok", detail: `${adopted.length} adopted`, fix: null });
  }

  for (const { command, provider } of HARNESS_CLIS) {
    const label = `${command} cli`;
    if (!probes.onPath(command)) {
      checks.push({ label, state: "todo", detail: "not on PATH", fix: null });
      continue;
    }
    const credential = probes.localCredential(provider);
    checks.push(
      credential === null
        ? {
            label,
            state: "todo",
            detail: "on PATH · no credential here",
            fix: LOGIN_COMMANDS[provider],
          }
        : { label, state: "ok", detail: "on PATH · credential present", fix: null },
    );
  }

  const machine = signedIn ? await getJson<MachineDto>(config, "/machine") : null;
  const exposure = machine === null || machine.value === null ? undefined : machine.value.exposure;
  checks.push(exposure === undefined ? notChecked("exposure") : exposureCheck(exposure));
  const userNamespaces =
    machine === null || machine.value === null ? undefined : machine.value.userNamespaces;
  if (userNamespaces !== undefined) checks.push(userNamespacesCheck(userNamespaces));

  // A daemon stop (`systemctl stop docker`, a docker-ce upgrade) waits for each container's own
  // stop timeout; one that outlasts systemd's stop of the unit leaves Docker down on its next
  // start. Read the daemon of the server installed here (OrbStack's beside Docker Desktop's on one
  // Mac), else the current context's.
  if (probes.dockerStop !== undefined && probes.onPath("docker")) {
    checks.push(dockerStopCheck(probes.dockerStop(local?.dockerContext ?? null)));
  }

  // A Mac serving Mend that sleeps on its own pauses the Docker VM with it.
  const pmset =
    local === null || probes.macPowerSettings === undefined ? null : probes.macPowerSettings();
  const sleep = pmset === null ? null : macSleepCheck(pmset);
  if (sleep !== null) checks.push(sleep);
  // `sleep 0` does not cover the lid: a MacBook sleeps when it is closed, its VM with it.
  const lid = local === null || probes.macLid === undefined ? null : probes.macLid();
  const lidSleep = lid === null ? null : macLidSleepCheck(lid);
  if (lidSleep !== null) checks.push(lidSleep);

  return checks;
};

/** An executable of that name on PATH — the question `command -v` asks, without a subprocess. */
export const onPath = (command: string): boolean => {
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
};

/** Green observed · amber not started · red a blocker (DESIGN.md §4); plain text on a pipe. */
const paintMark = (state: CheckState, mark: string): string => {
  if (process.stdout.isTTY !== true) return mark;
  const code = state === "ok" ? "32" : state === "todo" ? "33" : "31";
  return `[${code}m${mark}[0m`;
};

export const doctorCommand = async (
  config: DoctorConfig,
  localCredential: (provider: Provider) => string | null,
  claudeGrant: () => string | null,
  localServer?: () => Promise<LocalServerFacts | null>,
): Promise<void> => {
  const checks = await runChecks(config, {
    localCredential,
    claudeGrant,
    onPath,
    dockerStop: observeHostDockerStop,
    ...(localServer === undefined ? {} : { localServer }),
    ...(process.platform === "darwin"
      ? { macPowerSettings: readMacPowerSettings, macLid: readMacLid }
      : {}),
  });
  for (const check of checks) {
    process.stdout.write(`${redactCredentials(formatCheck(check, paintMark))}\n`);
  }
  if (checks.some((check) => check.state === "failed")) process.exitCode = 1;
};
