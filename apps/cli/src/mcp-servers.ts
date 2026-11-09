import {
  type McpSecretKind,
  McpServer,
  McpServerRemoved,
  McpServersView,
  mcpSecretNameIssue,
  mcpServerNameIssue,
  mcpServerUrlIssue,
  secretKindOf,
} from "@mend/domain/workbench";
import { Schema } from "effect";

import { usageOf } from "./help.ts";
import type { ApiCall } from "./pair.ts";
import { MendRequestError } from "./server-request.ts";
import { isFlag, jsonWithoutCredentials, redactCredentials } from "./shared.ts";

const ROUTE = "/me/mcp-servers";

const ServerWire = Schema.toEncoded(McpServer);
type ServerWire = typeof ServerWire.Type;
type TransportWire = ServerWire["transport"];

export const VALUES_ON_ARGV =
  "values are never read from the command line: they would land in your shell history";

type McpRequest =
  | { readonly _tag: "List" }
  | {
      readonly _tag: "Add";
      readonly name: string;
      readonly transport: TransportWire;
      readonly secretNames: ReadonlyArray<string>;
    }
  | { readonly _tag: "Remove"; readonly name: string }
  | { readonly _tag: "Switch"; readonly name: string; readonly enabled: boolean }
  | { readonly _tag: "Invalid"; readonly message: string };

const invalid = (message: string): McpRequest => ({ _tag: "Invalid", message });

export const requestOf = (args: ReadonlyArray<string>): McpRequest => {
  const separator = args.indexOf("--");
  const own = separator === -1 ? args : args.slice(0, separator);
  const command = separator === -1 ? null : args.slice(separator + 1);
  const words: Array<string> = [];
  const env: Array<string> = [];
  const headers: Array<string> = [];
  let sse = false;
  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index] ?? "";
    if (arg === "--env" || arg === "--header") {
      const next = own[index + 1];
      if (next === undefined || isFlag(next))
        return invalid(`${arg} needs a name · ${usageOf("mcp add")}`);
      if (next.includes("="))
        return invalid(`${arg} ${next.split("=")[0] ?? ""}: ${VALUES_ON_ARGV}`);
      (arg === "--env" ? env : headers).push(next);
      index += 1;
    } else if (arg === "--sse") sse = true;
    else if (arg !== "--json") words.push(arg);
  }
  const [verb, name, ...extra] = words;
  const adding = verb === "add";
  if (!adding && (env.length > 0 || headers.length > 0 || sse || command !== null))
    return invalid(usageOf(verb === undefined ? "mcp" : `mcp ${verb === "rm" ? "remove" : verb}`));
  switch (verb) {
    case undefined:
    case "list":
      return name === undefined ? { _tag: "List" } : invalid(usageOf("mcp"));
    case "remove":
    case "rm":
    case "on":
    case "off": {
      const page = verb === "rm" ? "remove" : verb;
      if (name === undefined || extra.length > 0) return invalid(usageOf(`mcp ${page}`));
      if (page === "remove") return { _tag: "Remove", name };
      return { _tag: "Switch", name, enabled: page === "on" };
    }
    case "add":
      return addRequest(name, extra, { env, headers, sse, command });
    default:
      return invalid(`unknown subcommand ${verb} · mend help mcp`);
  }
};

const addRequest = (
  name: string | undefined,
  extra: ReadonlyArray<string>,
  flags: {
    readonly env: ReadonlyArray<string>;
    readonly headers: ReadonlyArray<string>;
    readonly sse: boolean;
    readonly command: ReadonlyArray<string> | null;
  },
): McpRequest => {
  if (name === undefined) return invalid(usageOf("mcp add"));
  const nameIssue = mcpServerNameIssue(name);
  if (nameIssue !== null) return invalid(nameIssue);
  let transport: TransportWire;
  let secretNames: ReadonlyArray<string>;
  if (flags.command !== null) {
    const [program, ...args] = flags.command;
    if (program === undefined || program.trim() === "" || extra.length > 0)
      return invalid(`a stdio server is its command after -- · ${usageOf("mcp add")}`);
    if (flags.headers.length > 0 || flags.sse)
      return invalid("--header and --sse are for a URL; a command takes --env");
    transport = { _tag: "stdio", command: program, args };
    secretNames = flags.env;
  } else {
    const [url, ...more] = extra;
    if (url === undefined || more.length > 0) return invalid(usageOf("mcp add"));
    const urlIssue = mcpServerUrlIssue(url);
    if (urlIssue !== null) return invalid(urlIssue);
    if (flags.env.length > 0) return invalid("--env is for a command; a URL takes --header");
    transport = { _tag: flags.sse ? "sse" : "http", url };
    secretNames = flags.headers;
  }
  const kind = secretKindOf(transport);
  for (const secret of secretNames) {
    const issue = mcpSecretNameIssue(kind, secret);
    if (issue !== null) return invalid(issue);
  }
  const folded = secretNames.map((secret) => (kind === "header" ? secret.toLowerCase() : secret));
  if (new Set(folded).size !== folded.length) return invalid("a name is given twice");
  return { _tag: "Add", name, transport, secretNames };
};

const TRANSPORT_WORDS: Record<TransportWire["_tag"], string> = {
  stdio: "stdio",
  http: "http",
  sse: "sse",
};

const targetOf = (transport: TransportWire): string =>
  transport._tag === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : (URL.parse(transport.url)?.host ?? transport.url);

const secretsOf = (kind: McpSecretKind, names: ReadonlyArray<string>): string =>
  names.length === 0 ? "-" : `${kind === "env" ? "env" : "header"} ${names.join(", ")}`;

const TARGET_WIDTH = 48;
const clip = (text: string) =>
  text.length <= TARGET_WIDTH ? text : `${text.slice(0, TARGET_WIDTH - 3)}...`;

export const renderServers = (servers: ReadonlyArray<ServerWire>): ReadonlyArray<string> => {
  if (servers.length === 0)
    return ["no MCP servers · add one with mend mcp add <name> <url>, or a command after --"];
  const rows = [
    ["NAME", "TRANSPORT", "TARGET", "SECRETS", "STATE"],
    ...servers.map((server) => [
      server.name,
      TRANSPORT_WORDS[server.transport._tag],
      clip(targetOf(server.transport)),
      secretsOf(secretKindOf(server.transport), server.secretNames),
      server.enabled ? "on" : "off",
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join("  "),
  );
};

const summaryOf = (server: ServerWire): string =>
  [
    server.name,
    TRANSPORT_WORDS[server.transport._tag],
    targetOf(server.transport),
    server.secretNames.length === 0
      ? null
      : secretsOf(secretKindOf(server.transport), server.secretNames),
    server.enabled ? "on" : "off",
  ]
    .filter((part) => part !== null)
    .join(" · ");

export const valuesFromLines = (
  text: string,
  names: ReadonlyArray<string>,
): { readonly values: Readonly<Record<string, string>> } | { readonly issue: string } => {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    const name = at === -1 ? line.trim() : line.slice(0, at).trim();
    if (at === -1) return { issue: `stdin: the line for ${name} has no =value` };
    if (!names.includes(name)) return { issue: `stdin names ${name}, which this command did not` };
    if (values.has(name)) return { issue: `stdin gives ${name} twice` };
    const value = line.slice(at + 1);
    if (value === "") return { issue: `stdin: ${name} is empty` };
    values.set(name, value);
  }
  const missing = names.filter((name) => !values.has(name));
  if (missing.length > 0)
    return { issue: `stdin has no NAME=value line for ${missing.join(", ")}` };
  return { values: Object.fromEntries(values) };
};

export const promptHidden = (
  label: string,
  input: NodeJS.ReadStream,
  output: NodeJS.WritableStream,
): Promise<string | null> =>
  new Promise((resolve) => {
    output.write(label);
    let value = "";
    const finish = (answer: string | null) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resolve(answer);
    };
    const onData = (chunk: Buffer | string) => {
      for (const char of String(chunk)) {
        if (char === "\r" || char === "\n") return finish(value);
        if (char === "\u0003" || char === "\u0004") return finish(null);
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });

const tagOf = (error: unknown): string => {
  if (!(error instanceof MendRequestError)) return "McpServersUnreadable";
  if (error.refused?.tag) return error.refused.tag;
  if (error.status === 401) return "Unauthorized";
  return error.kind === "http" ? "McpServersRefused" : "McpServersNoAnswer";
};

export interface McpServersBoundary {
  readonly connect: () => { readonly api: ApiCall };
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly terminal: boolean;
  readonly askHidden: (label: string) => Promise<string | null>;
  readonly readStdin: () => Promise<string>;
}

export const mcpServersCommand = async (
  args: ReadonlyArray<string>,
  boundary: McpServersBoundary,
): Promise<0 | 1> => {
  const ownArgs = args.indexOf("--") === -1 ? args : args.slice(0, args.indexOf("--"));
  const json = ownArgs.includes("--json");
  const asked = requestOf(args);
  const fail = (tag: string, message: string): 1 => {
    if (json)
      boundary.stdout(`${jsonWithoutCredentials({ version: 1, error: { tag, message } })}\n`);
    else boundary.stderr(`mend: ${redactCredentials(message)}\n`);
    return 1;
  };
  const print = (lines: ReadonlyArray<string>) =>
    boundary.stdout(lines.map((line) => `${redactCredentials(line)}\n`).join(""));
  if (asked._tag === "Invalid") return fail("InvalidMcpArguments", asked.message);
  let api: ApiCall;
  try {
    api = boundary.connect().api;
  } catch (error) {
    return fail("CliConfigUnreadable", error instanceof Error ? error.message : String(error));
  }
  const call = async <A>(
    schema: Schema.Decoder<A>,
    method: "GET" | "PUT" | "DELETE",
    route: string,
    body?: unknown,
  ): Promise<{ readonly ok: A } | { readonly failed: 1 }> => {
    let raw: unknown;
    try {
      raw = await api<unknown>(method, route, body);
    } catch (error) {
      return { failed: fail(tagOf(error), error instanceof Error ? error.message : String(error)) };
    }
    const decoded = Schema.decodeUnknownResult(schema)(raw);
    return decoded._tag === "Failure"
      ? { failed: fail("McpServersUnreadable", "this CLI could not read the server's answer") }
      : { ok: decoded.success };
  };
  const routeOf = (name: string) => `${ROUTE}/${encodeURIComponent(name)}`;
  const listed = () => call(Schema.toEncoded(McpServersView), "GET", ROUTE);
  const printServer = (server: ServerWire, line: string) => {
    if (json) boundary.stdout(`${jsonWithoutCredentials({ version: 1, server })}\n`);
    else print([line]);
  };

  switch (asked._tag) {
    case "List": {
      const answer = await listed();
      if ("failed" in answer) return answer.failed;
      if (json)
        boundary.stdout(`${jsonWithoutCredentials({ version: 1, servers: answer.ok.servers })}\n`);
      else print(renderServers(answer.ok.servers));
      return 0;
    }
    case "Add": {
      const current = await listed();
      if ("failed" in current) return current.failed;
      if (current.ok.servers.some((server) => server.name === asked.name))
        return fail(
          "McpServerExists",
          `${asked.name} exists: change it in Settings → MCP servers, or remove it first with mend mcp remove ${asked.name}`,
        );
      const values: Record<string, string> = {};
      if (asked.secretNames.length > 0 && boundary.terminal) {
        for (const name of asked.secretNames) {
          const value = await boundary.askHidden(`${name} (not shown): `);
          if (value === null)
            return fail("McpValueNotGiven", `no value for ${name} · nothing added`);
          if (value === "") return fail("McpValueNotGiven", `${name} is empty · nothing added`);
          values[name] = value;
        }
      } else if (asked.secretNames.length > 0) {
        const read = valuesFromLines(await boundary.readStdin(), asked.secretNames);
        if ("issue" in read) return fail("McpValueNotGiven", `${read.issue} · nothing added`);
        Object.assign(values, read.values);
      }
      const answer = await call(ServerWire, "PUT", routeOf(asked.name), {
        transport: asked.transport,
        secrets: Object.fromEntries(
          Object.entries(values).map(([name, value]) => [name, { _tag: "Set", value }]),
        ),
      });
      if ("failed" in answer) return answer.failed;
      printServer(answer.ok, `✓ added ${summaryOf(answer.ok)}`);
      return 0;
    }
    case "Switch": {
      const current = await listed();
      if ("failed" in current) return current.failed;
      const server = current.ok.servers.find((candidate) => candidate.name === asked.name);
      if (server === undefined)
        return fail(
          "McpServerNotFound",
          `no MCP server named ${asked.name} · mend mcp lists yours`,
        );
      const answer = await call(ServerWire, "PUT", routeOf(asked.name), {
        transport: server.transport,
        enabled: asked.enabled,
      });
      if ("failed" in answer) return answer.failed;
      printServer(answer.ok, `✓ ${summaryOf(answer.ok)}`);
      return 0;
    }
    case "Remove": {
      const answer = await call(Schema.toEncoded(McpServerRemoved), "DELETE", routeOf(asked.name));
      if ("failed" in answer) return answer.failed;
      if (json)
        boundary.stdout(
          `${jsonWithoutCredentials({ version: 1, name: asked.name, removed: answer.ok.removed })}\n`,
        );
      else
        print([
          answer.ok.removed
            ? `✓ removed ${asked.name} and its saved values`
            : `no MCP server named ${asked.name} · nothing removed`,
        ]);
      return 0;
    }
  }
};
