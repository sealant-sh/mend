import * as fs from "node:fs";
import * as path from "node:path";

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
  readonly onPath: (command: string) => boolean;
}

const MARKS: Record<CheckState, string> = { ok: "✓", todo: "○", failed: "✗" };

const LABEL_WIDTH = 11;

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
}

/** A read that never throws and never blocks: the outcome is a value the checklist can print. */
const getJson = async <T>(config: DoctorConfig, route: string): Promise<Fetched<T>> => {
  try {
    const response = await fetch(`${config.url}/api${route}`, {
      headers: config.token === null ? {} : { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { value: null, status: response.status };
    return { value: (await response.json()) as T, status: response.status };
  } catch {
    return { value: null, status: null };
  }
};

interface HealthDto {
  readonly status: string;
  readonly version: string;
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
      ? "serve it over https and set APP_URL to that origin"
      : gateOpen === 0
        ? null
        : "mend operator exposure",
  };
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

/** Every fact the checklist prints, in the order a first run needs them. */
export const runChecks = async (
  config: DoctorConfig,
  probes: DoctorProbes,
): Promise<ReadonlyArray<Check>> => {
  const checks: Array<Check> = [];

  const health = await getJson<HealthDto>(config, "/health");
  checks.push(
    health.value === null
      ? {
          label: "server",
          state: "failed",
          detail: `cannot reach ${config.url}`,
          fix: "start the Mend server",
        }
      : {
          label: "server",
          state: "ok",
          detail: `${config.url} · mend ${health.value.version}`,
          fix: null,
        },
  );

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
            detail: account.status,
            fix: `mend connect ${provider}`,
          },
    );
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
): Promise<void> => {
  const checks = await runChecks(config, { localCredential, onPath });
  for (const check of checks) process.stdout.write(`${formatCheck(check, paintMark)}\n`);
  if (checks.some((check) => check.state === "failed")) process.exitCode = 1;
};
