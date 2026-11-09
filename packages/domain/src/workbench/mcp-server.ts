import { Redacted, Result, Schema } from "effect";

import { McpServerId } from "../ids.ts";
import { Timestamp } from "../timestamp.ts";

/**
 * A person's own MCP servers: tools they add once and keep across organizations, as their secret
 * files are. Every env value (stdio) and header value (HTTP, SSE) is a secret, sealed at rest with
 * the machine's secrets key (`@mend/store` SecretCipher); every surface sees the secret's name,
 * never its value. The name is the server's key and never changes.
 *
 * Every rejection here has a fixed message: none repeats what was submitted, so a token pasted
 * into the wrong field never comes back in an answer or a log.
 */

export const MCP_SERVER_LIMITS = {
  servers: 16,
  secretsPerServer: 16,
  secretValueBytes: 8 * 1024,
  args: 32,
  argBytes: 1024,
  /** The sealed secrets of one server, as stored. */
  sealedBytes: 64 * 1024,
} as const;

/** `mend` is Mend's own server in every session; `executor` is the organization's Executor. */
export const RESERVED_MCP_SERVER_NAMES: ReadonlyArray<string> = ["mend", "executor"];
export const RESERVED_MCP_SERVER_PREFIX = "mend-";

const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** RFC 9110 §5.6.2 `token`. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SECRET_NAME_MAX = 128;
const URL_MAX = 2048;
const encoder = new TextEncoder();
const bytesOf = (value: string) => encoder.encode(value).byteLength;

/** The first thing wrong with a server name, or null. */
export const mcpServerNameIssue = (name: string): string | null => {
  if (!NAME_PATTERN.test(name)) {
    return "a server name is 1 to 48 lowercase letters, digits, - or _, starting with a letter";
  }
  if (RESERVED_MCP_SERVER_NAMES.includes(name) || name.startsWith(RESERVED_MCP_SERVER_PREFIX)) {
    return "mend, executor and names starting with mend- are Mend's own";
  }
  return null;
};

export const McpServerName = Schema.String.pipe(
  Schema.check(Schema.makeFilter((name: string) => mcpServerNameIssue(name) ?? undefined)),
  Schema.brand("McpServerName"),
);
export type McpServerName = typeof McpServerName.Type;

/** The first thing wrong with a server URL, or null: http(s), with no user name or password. */
export const mcpServerUrlIssue = (url: string): string | null => {
  if (url.length > URL_MAX) return `a server URL is at most ${URL_MAX} characters`;
  if (!URL.canParse(url)) return "the server URL is not a URL";
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "a server URL starts with http:// or https://";
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "a server URL carries no user name or password: send them as a header";
  }
  return null;
};

export const McpServerUrl = Schema.String.pipe(
  Schema.check(Schema.makeFilter((url: string) => mcpServerUrlIssue(url) ?? undefined)),
  Schema.brand("McpServerUrl"),
);
export type McpServerUrl = typeof McpServerUrl.Type;

export const McpStdioTransport = Schema.TaggedStruct("stdio", {
  command: Schema.String,
  args: Schema.Array(Schema.String),
});
export const McpHttpTransport = Schema.TaggedStruct("http", { url: McpServerUrl });
export const McpSseTransport = Schema.TaggedStruct("sse", { url: McpServerUrl });
export const McpTransport = Schema.Union([McpStdioTransport, McpHttpTransport, McpSseTransport]);
export type McpTransport = typeof McpTransport.Type;

/**
 * A transport as a request carries it, before `parseMcpTransport`: plain strings, so a bad URL is
 * answered with this module's message rather than a decode error that would quote it.
 */
export const McpTransportInput = Schema.Union([
  McpStdioTransport,
  Schema.TaggedStruct("http", { url: Schema.String }),
  Schema.TaggedStruct("sse", { url: Schema.String }),
]);
export type McpTransportInput = typeof McpTransportInput.Type;

/** stdio servers take env variables; HTTP and SSE servers take headers. Never stored. */
export type McpSecretKind = "env" | "header";
export const secretKindOf = (transport: { readonly _tag: McpTransport["_tag"] }): McpSecretKind =>
  transport._tag === "stdio" ? "env" : "header";

const hasNul = (value: string) => value.includes("\u0000");
const hasHeaderControl = (value: string) =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f;
  });

/** A request's transport, checked: the command and its arguments, or the URL. */
export const parseMcpTransport = (
  input: McpTransportInput,
): Result.Result<McpTransport, string> => {
  if (input._tag !== "stdio") {
    const issue = mcpServerUrlIssue(input.url);
    return issue === null
      ? Result.succeed({ _tag: input._tag, url: McpServerUrl.make(input.url) })
      : Result.fail(issue);
  }
  if (input.command.trim() === "") return Result.fail("a stdio server needs a command");
  if (input.args.length > MCP_SERVER_LIMITS.args) {
    return Result.fail(`a stdio server takes at most ${MCP_SERVER_LIMITS.args} arguments`);
  }
  if ([input.command, ...input.args].some((word) => bytesOf(word) > MCP_SERVER_LIMITS.argBytes)) {
    return Result.fail(
      `a command and each argument are at most ${MCP_SERVER_LIMITS.argBytes / 1024} KB`,
    );
  }
  if ([input.command, ...input.args].some(hasNul)) {
    return Result.fail("a command or argument contains a NUL character");
  }
  return Result.succeed({ _tag: "stdio", command: input.command, args: input.args });
};

/** The first thing wrong with a secret's name for its kind, or null. */
export const mcpSecretNameIssue = (kind: McpSecretKind, name: string): string | null => {
  if (name.length > SECRET_NAME_MAX) {
    return `a variable or header name is at most ${SECRET_NAME_MAX} characters`;
  }
  if (kind === "env") {
    return ENV_NAME_PATTERN.test(name)
      ? null
      : "a variable name is letters, digits and _, and does not start with a digit";
  }
  return HEADER_NAME_PATTERN.test(name)
    ? null
    : "a header name is letters, digits and !#$%&'*+-.^_`|~ only";
};

/** The first thing wrong with a server's secrets as they would be stored, or null. */
export const mcpSecretsIssue = (
  kind: McpSecretKind,
  secrets: Readonly<Record<string, string>>,
): string | null => {
  const names = Object.keys(secrets);
  if (names.length > MCP_SERVER_LIMITS.secretsPerServer) {
    return `a server keeps at most ${MCP_SERVER_LIMITS.secretsPerServer} ${kind === "env" ? "variables" : "headers"}`;
  }
  for (const name of names) {
    const issue = mcpSecretNameIssue(kind, name);
    if (issue !== null) return issue;
  }
  if (kind === "header" && new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    return "two headers differ only in case";
  }
  for (const value of Object.values(secrets)) {
    if (value === "") return "a variable or header value is empty";
    if (bytesOf(value) > MCP_SERVER_LIMITS.secretValueBytes) {
      return `a variable or header value is at most ${MCP_SERVER_LIMITS.secretValueBytes / 1024} KB`;
    }
    if (kind === "env" && hasNul(value)) return "a variable value contains a NUL character";
    if (kind === "header" && hasHeaderControl(value)) {
      return "a header value contains a line break or control character";
    }
  }
  return null;
};

/** What every surface sees of a server: the names of its secrets, never their values. */
export class McpServer extends Schema.Class<McpServer>("McpServer")({
  id: McpServerId,
  scope: Schema.Literal("person"),
  name: McpServerName,
  transport: McpTransport,
  secretNames: Schema.Array(Schema.String),
  enabled: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** `GET /me/mcp-servers`: the signed-in person's servers by name, and the limits they live in. */
export class McpServersView extends Schema.Class<McpServersView>("McpServersView")({
  servers: Schema.Array(McpServer),
  limits: Schema.Struct({
    servers: Schema.Int,
    secretsPerServer: Schema.Int,
    secretValueBytes: Schema.Int,
    args: Schema.Int,
    argBytes: Schema.Int,
  }),
}) {}

/** Keep a saved secret as it is, or set it to a new value. */
export const McpSecretEdit = Schema.Union([
  Schema.TaggedStruct("Keep", {}),
  Schema.TaggedStruct("Set", { value: Schema.RedactedFromValue(Schema.String) }),
]);
export type McpSecretEdit = typeof McpSecretEdit.Type;
export const McpSecretEdits = Schema.Record(Schema.String, McpSecretEdit);
export type McpSecretEdits = typeof McpSecretEdits.Type;

/**
 * `PUT /me/mcp-servers/:name`: create the server, or replace it. With no `secrets`, every saved
 * secret is kept; with `secrets`, a name left out is removed. With no `enabled`, a new server is
 * on and a saved one keeps its state.
 */
export class McpServerWrite extends Schema.Class<McpServerWrite>("McpServerWrite")({
  transport: McpTransportInput,
  secrets: Schema.optionalKey(McpSecretEdits),
  enabled: Schema.optionalKey(Schema.Boolean),
}) {}

/** `DELETE /me/mcp-servers/:name`: whether there was one by that name. */
export class McpServerRemoved extends Schema.Class<McpServerRemoved>("McpServerRemoved")({
  removed: Schema.Boolean,
}) {}

/** A server's next secrets from its saved ones and an edit. */
export const applySecretEdits = (
  current: Readonly<Record<string, string>>,
  edits: McpSecretEdits | undefined,
): Result.Result<Readonly<Record<string, string>>, string> => {
  if (edits === undefined) return Result.succeed(current);
  const next: Array<readonly [string, string]> = [];
  for (const [name, edit] of Object.entries(edits)) {
    if (edit._tag === "Set") {
      next.push([name, Redacted.value(edit.value)]);
      continue;
    }
    const kept = Object.hasOwn(current, name) ? current[name] : undefined;
    if (kept === undefined) return Result.fail("Keep names a secret this server does not have");
    next.push([name, kept]);
  }
  // fromEntries defines each name as an own property, `__proto__` included.
  return Result.succeed(Object.fromEntries(next));
};
