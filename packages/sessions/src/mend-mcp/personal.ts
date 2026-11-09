/**
 * A person's own MCP servers at launch (docs/adr/0024): whose a process carries, and what each
 * harness is given. Pure; the engine reads, unseals and writes (`personalMcpFor`).
 *
 * No value ever rides argv, which Core keeps for good and other users can read: Claude gets a file
 * path, Codex a path or a URL, and every value is in a file written 0600 as the process's user.
 */
import {
  mcpServerNameIssue,
  mcpUrlMayCarryKey,
  type McpServerName,
  type McpTransport,
} from "@mend/domain/workbench";

import { shellQuote } from "../workspace-files.ts";

/** A server as a launch delivers it, its secrets unsealed: env (stdio) or headers (HTTP, SSE). */
export interface UnsealedMcpServer {
  readonly name: McpServerName;
  readonly transport: McpTransport;
  readonly secrets: Readonly<Record<string, string>>;
}

/** Whose servers a process carries, or why it carries none. */
export type McpPerson =
  | { readonly _tag: "Deliver"; readonly accountId: string }
  | {
      readonly _tag: "Withhold";
      /** Whose servers are kept back, said on the session line when they have any. */
      readonly accountId: string | null;
      readonly why: string;
    };

/** Why a join in a home that shares one set of logins carries none of the joiner's servers. */
export const ANOTHER_PERSONS_HOME = "this workspace is another person's";

/** The words when a workspace with one home runs a once-shared conversation (ADR 0016, 7a). */
export const WITHHELD_UNDER_SHARED_CONTROL =
  "this workspace shares one home, and the session is under shared control";

/**
 * The one rule (docs/adr/0024, "Whose servers"). A process carries at most one person's servers:
 * the person whose login it spends, and never where another person's turn runs.
 *
 * - A person executor: the person the process runs as. A steer hands over to a process of the
 *   steerer's, with the steerer's servers; a terminal never hands over and keeps the owner's.
 * - An executor that shares one home (ADR 0016, 7a): its holder's, only for the holder's own
 *   session and never for a once-shared conversation, whose turns other people send. A terminal
 *   under shared control stays 7a's documented exception: whoever types there uses the owner's.
 */
export const mcpPersonOf = (input: {
  /** A person executor: the account the process runs as. Null: the executor shares one home. */
  readonly runsAs: string | null;
  /** Whose logins a shared home holds; null when Mend cannot say. */
  readonly holder: string | null;
  readonly sessionOwner: string | null;
  /** Shared control was ever turned on for the session. */
  readonly onceShared: boolean;
  /** A terminal agent, which never hands over to another person. */
  readonly terminal: boolean;
}): McpPerson => {
  if (input.runsAs !== null) return { _tag: "Deliver", accountId: input.runsAs };
  const owner = input.sessionOwner;
  if (owner === null) return { _tag: "Withhold", accountId: null, why: "the session has no owner" };
  if (input.holder === null) {
    return { _tag: "Withhold", accountId: owner, why: "Mend cannot say whose this workspace is" };
  }
  if (input.holder !== owner) {
    return { _tag: "Withhold", accountId: owner, why: ANOTHER_PERSONS_HOME };
  }
  if (input.onceShared && !input.terminal) {
    return { _tag: "Withhold", accountId: owner, why: WITHHELD_UNDER_SHARED_CONTROL };
  }
  return { _tag: "Deliver", accountId: owner };
};

/**
 * Where a process's server files go: `<home>/.mend/mcp` in a person's own home, which is never
 * saved (ADR 0016, decision 2), or `/run/mend/mcp` for root, outside every capture root.
 */
export const personalMcpDir = (personHome: string | null): string =>
  personHome === null ? "/run/mend/mcp" : `${personHome}/.mend/mcp`;

/** What argv-shaping code adds for the person: nothing must be said with a reason. */
export type PersonalMcp =
  | { readonly _tag: "None"; readonly why: string }
  | {
      readonly _tag: "Delivered";
      /** The command these flags are for; any other command gets none of them. */
      readonly harness: string;
      readonly flags: ReadonlyArray<string>;
    };

export const PersonalMcp = {
  none: (why: string): PersonalMcp => ({ _tag: "None", why }),
};

export interface PersonalMcpPlan {
  /** Paths and URLs only, never a value. */
  readonly flags: ReadonlyArray<string>;
  /** Each written 0600 as the process's user. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NO_PLAN: PersonalMcpPlan = { flags: [], files: [], skipped: [] };

const isNonEmpty = (record: Readonly<Record<string, string>>) => Object.keys(record).length > 0;

const claudeEntry = (server: UnsealedMcpServer) =>
  server.transport._tag === "stdio"
    ? {
        type: "stdio",
        command: server.transport.command,
        args: server.transport.args,
        ...(isNonEmpty(server.secrets) ? { env: server.secrets } : {}),
      }
    : {
        type: server.transport._tag,
        url: server.transport.url,
        ...(isNonEmpty(server.secrets) ? { headers: server.secrets } : {}),
      };

/** A TOML basic string; null for text TOML cannot hold (a lone surrogate). */
const tomlString = (value: string): string | null => {
  if (!value.isWellFormed()) return null;
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out +=
      char === '"'
        ? '\\"'
        : char === "\\"
          ? "\\\\"
          : code < 0x20 || code === 0x7f
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : char;
  }
  return `${out}"`;
};

/** A script that exports the server's env and runs it: Codex's environment never holds a value. */
const codexStdioScript = (
  transport: Extract<McpTransport, { _tag: "stdio" }>,
  env: Readonly<Record<string, string>>,
): string =>
  [
    ...Object.entries(env).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    `exec ${[transport.command, ...transport.args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");

type CodexServer =
  | {
      readonly flag: string;
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
    }
  | { readonly skipped: string };

/**
 * Codex is given its URL on argv, which Core keeps and other users can read, so a server whose URL
 * may carry a key (`mcpUrlMayCarryKey`) is left out of Codex rather than guessed at.
 */
const codexServer = (dir: string, server: UnsealedMcpServer): CodexServer => {
  const { name, transport, secrets } = server;
  // One attached word a server: Core takes at most 64 words a command.
  const flag = (table: string) => `--config=mcp_servers.${name}={${table}}`;
  if (transport._tag === "sse") return { skipped: "SSE" };
  if (transport._tag === "stdio") {
    const script = `${dir}/codex/${name}.sh`;
    return {
      flag: flag(`command="/bin/sh", args=[${tomlString(script) ?? '""'}]`),
      files: [{ path: script, content: codexStdioScript(transport, secrets) }],
    };
  }
  if (mcpUrlMayCarryKey(transport.url)) return { skipped: "its URL may carry a key" };
  const url = tomlString(transport.url);
  if (url === null) return { skipped: "a URL Codex cannot read" };
  if (!isNonEmpty(secrets)) return { flag: flag(`url=${url}`), files: [] };
  const headers = `${dir}/codex/${name}.headers.json`;
  // Codex runs the helper with `sh -c` and reads a JSON object of headers from its stdout.
  const helper = tomlString(`cat ${shellQuote(headers)}`) ?? '""';
  return {
    flag: flag(`url=${url}, http_headers_helper=${helper}`),
    files: [{ path: headers, content: JSON.stringify(secrets) }],
  };
};

/**
 * What a harness is given for the person's servers, under `dir` (`personalMcpDir`).
 *
 * - Claude: a second `--mcp-config=` after Mend's own, naming a file that holds every server with
 *   its values. Claude loads both, and the repository's `.mcp.json` still.
 * - Codex: one `--config=mcp_servers.<name>={…}` a server. A stdio server runs `/bin/sh` on a script
 *   that exports its env; an HTTP server's headers come from a file its helper prints. SSE is
 *   skipped: Codex has no SSE transport.
 * - pi and opencode: nothing on argv (pi's come through its profile, `piMcpJsonWith`).
 *
 * A server whose name or variable names could not be written safely is skipped, never quoted
 * around: they were checked when it was saved.
 */
export const planPersonalMcp = (input: {
  readonly harness: string;
  readonly dir: string;
  readonly servers: ReadonlyArray<UnsealedMcpServer>;
}): PersonalMcpPlan => {
  const skipped: Array<{ readonly name: string; readonly why: string }> = [];
  const servers = input.servers.filter((server) => {
    const unsafe =
      mcpServerNameIssue(server.name) !== null ||
      (server.transport._tag === "stdio" &&
        Object.keys(server.secrets).some((name) => !ENV_NAME.test(name)));
    if (unsafe) skipped.push({ name: server.name, why: "a name Mend cannot use" });
    return !unsafe;
  });
  if (servers.length === 0) return { ...NO_PLAN, skipped };
  if (input.harness === "claude") {
    const config = `${input.dir}/claude.json`;
    const mcpServers = Object.fromEntries(
      servers.map((server) => [server.name, claudeEntry(server)]),
    );
    return {
      flags: [`--mcp-config=${config}`],
      files: [{ path: config, content: JSON.stringify({ mcpServers }) }],
      skipped,
    };
  }
  if (input.harness === "codex") {
    const flags: Array<string> = [];
    const files: Array<{ readonly path: string; readonly content: string }> = [];
    for (const server of servers) {
      const planned = codexServer(input.dir, server);
      if ("skipped" in planned) {
        skipped.push({ name: server.name, why: planned.skipped });
        continue;
      }
      flags.push(planned.flag);
      files.push(...planned.files);
    }
    return { flags, files, skipped };
  }
  return { ...NO_PLAN, skipped };
};

const piEntry = (server: UnsealedMcpServer) =>
  server.transport._tag === "stdio"
    ? {
        command: server.transport.command,
        args: server.transport.args,
        ...(isNonEmpty(server.secrets) ? { env: server.secrets } : {}),
      }
    : {
        url: server.transport.url,
        ...(isNonEmpty(server.secrets) ? { headers: server.secrets } : {}),
        ...(server.transport._tag === "sse" ? { httpTransport: "sse" } : {}),
      };

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * pi's `mcp.json` with the person's servers beside the profile's own: the person's Mend list wins
 * a name, as the explicit and newer source. Null when the profile's file is not a JSON object
 * (with an object for `mcpServers`): it is theirs, and is left as it is.
 */
export const piMcpJsonWith = (
  profileMcpJson: string | null,
  servers: ReadonlyArray<UnsealedMcpServer>,
): string | null => {
  let profile: unknown = {};
  if (profileMcpJson !== null) {
    try {
      profile = JSON.parse(profileMcpJson.replace(/^﻿/, ""));
    } catch {
      return null;
    }
  }
  if (!isObject(profile)) return null;
  const own = profile.mcpServers ?? {};
  if (!isObject(own)) return null;
  const mend = Object.fromEntries(servers.map((server) => [server.name, piEntry(server)]));
  return JSON.stringify({ ...profile, mcpServers: { ...own, ...mend } }, null, 2);
};

const HARNESS_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  pi: "pi",
  opencode: "opencode",
};

/** The session line's words: `MCP servers · figma, github · not for Codex: slack (SSE)`. */
export const personalMcpWords = (input: {
  readonly harness: string;
  readonly delivered: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly why: string }>;
}): string | null => {
  const notFor =
    input.skipped.length === 0
      ? []
      : [
          `not for ${HARNESS_NAMES[input.harness] ?? input.harness}: ${input.skipped
            .map((server) => `${server.name} (${server.why})`)
            .join(", ")}`,
        ];
  const parts = [...(input.delivered.length === 0 ? [] : [input.delivered.join(", ")]), ...notFor];
  return parts.length === 0 ? null : ["MCP servers", ...parts].join(" · ");
};

/** The session line's words when a person's servers are kept back. */
export const personalMcpWithheldWords = (why: string): string =>
  `MCP servers not delivered: ${why}`;

/**
 * The session line when a process carries no one's servers. A pi joining a home that shares one
 * profile says so even without servers of its own: a pi already running there keeps that profile,
 * MCP servers included (docs/adr/0024).
 */
export const withheldMcpWords = (input: {
  readonly harness: string;
  readonly why: string;
  readonly hasServers: boolean;
}): string | null =>
  input.harness === "pi" && input.why === ANOTHER_PERSONS_HOME
    ? personalMcpWithheldWords(
        `${ANOTHER_PERSONS_HOME}, and a pi already running here shares its profile with you, MCP servers included`,
      )
    : input.hasServers
      ? personalMcpWithheldWords(input.why)
      : null;
