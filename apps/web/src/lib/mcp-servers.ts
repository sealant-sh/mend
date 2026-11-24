import {
  type McpSecretKind,
  mcpSecretNameIssue,
  mcpServerNameIssue,
  mcpServerUrlIssue,
  secretKindOf,
} from "@mend/domain/workbench";

import type { McpServerDto } from "./api.ts";

/**
 * A person's own MCP servers (docs/adr/0024) as Settings → MCP servers shows and edits them: the
 * line under each server's name, and the add and edit form, built into what `PUT
 * /me/mcp-servers/:name` takes. Every variable and header value is sealed when it is saved and
 * never comes back, so the form holds a value only while it is being typed.
 */

export type McpTransportKind = McpServerDto["transport"]["_tag"];

export const TRANSPORT_WORDS: Record<McpTransportKind, string> = {
  stdio: "stdio",
  http: "HTTP",
  sse: "SSE",
};

/** The transport and what it reaches: `HTTP · https://mcp.linear.app/mcp`, `stdio · npx -y …`. */
export const targetLine = (transport: McpServerDto["transport"]): string =>
  `${TRANSPORT_WORDS[transport._tag]} · ${
    transport._tag === "stdio" ? [transport.command, ...transport.args].join(" ") : transport.url
  }`;

/**
 * The state beside a server's switch: a stdio server runs in the session; an HTTP or SSE server
 * says when Mend keeps a sign-in for it. Mend doesn't know whether a server needs one, so a
 * server with none says nothing.
 */
export const stateWords = (server: McpServerDto): string | null =>
  server.transport._tag === "stdio"
    ? "Runs in the session"
    : server.signIn === null
      ? null
      : "Signed in";

/**
 * What Mend does with a server's saved values, by name and never by value: "Mend sends your
 * sealed Authorization header with each call." Null for a server with none.
 */
export const secretsLine = (server: McpServerDto): string | null => {
  const names = server.secretNames;
  if (names.length === 0) return null;
  const listed =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const kind = secretKindOf(server.transport);
  const noun = `${secretNoun(kind)}${names.length === 1 ? "" : "s"}`;
  return kind === "env"
    ? `Mend sets your sealed ${listed} ${noun} when the server starts.`
    : `Mend sends your sealed ${listed} ${noun} with each call.`;
};

/** The name a value of this kind of server goes by. */
export const secretNoun = (kind: McpSecretKind): string => (kind === "env" ? "variable" : "header");

/** A value saved before: kept while its field stays empty, replaced by what is typed, or removed. */
export interface SavedSecret {
  readonly name: string;
  readonly value: string;
  readonly removed: boolean;
}

/** A value added in this form. `key` tells the rows apart while their names are being typed. */
export interface NewSecret {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

export interface McpDraft {
  readonly name: string;
  readonly kind: McpTransportKind;
  readonly command: string;
  /** The arguments, one per line. */
  readonly args: string;
  readonly url: string;
  readonly saved: ReadonlyArray<SavedSecret>;
  readonly added: ReadonlyArray<NewSecret>;
}

/** The form for a new server (HTTP, with one empty header), or for a saved one. */
export const draftOf = (saved: McpServerDto | null): McpDraft => {
  if (saved === null) {
    return {
      name: "",
      kind: "http",
      command: "",
      args: "",
      url: "",
      saved: [],
      added: [{ key: 0, name: "", value: "" }],
    };
  }
  const { transport } = saved;
  return {
    name: saved.name,
    kind: transport._tag,
    command: transport._tag === "stdio" ? transport.command : "",
    args: transport._tag === "stdio" ? transport.args.join("\n") : "",
    url: transport._tag === "stdio" ? "" : transport.url,
    saved: saved.secretNames.map((name) => ({ name, value: "", removed: false })),
    added: [],
  };
};

type SecretEdit = { readonly _tag: "Keep" } | { readonly _tag: "Set"; readonly value: string };

export type McpWrite = {
  readonly transport:
    | { readonly _tag: "stdio"; readonly command: string; readonly args: ReadonlyArray<string> }
    | { readonly _tag: "http" | "sse"; readonly url: string };
  readonly secrets: Readonly<Record<string, SecretEdit>>;
};

/**
 * What the form can send: nothing yet (a required field is empty), a problem to say before
 * anything is sent, or the write. `taken` is the person's other servers' names.
 */
export type McpBuilt =
  | { readonly _tag: "Incomplete" }
  | { readonly _tag: "Issue"; readonly issue: string }
  | { readonly _tag: "Write"; readonly write: McpWrite };

/** Whether saved values carry over: a stdio server's are variables, an HTTP or SSE server's headers. */
export const savedApplies = (draft: McpDraft, saved: McpServerDto | null): boolean =>
  saved !== null && secretKindOf(saved.transport) === secretKindOf({ _tag: draft.kind });

export const buildWrite = (
  draft: McpDraft,
  saved: McpServerDto | null,
  taken: ReadonlyArray<string>,
): McpBuilt => {
  if (saved === null) {
    if (draft.name === "") return { _tag: "Incomplete" };
    const issue = mcpServerNameIssue(draft.name);
    if (issue !== null) return { _tag: "Issue", issue: sentence(issue) };
    if (taken.includes(draft.name)) {
      return { _tag: "Issue", issue: `You already have ${draft.name}. Edit it instead.` };
    }
  }
  let transport: McpWrite["transport"];
  if (draft.kind === "stdio") {
    if (draft.command.trim() === "") return { _tag: "Incomplete" };
    transport = {
      _tag: "stdio",
      command: draft.command.trim(),
      args: draft.args
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    };
  } else {
    const url = draft.url.trim();
    if (url === "") return { _tag: "Incomplete" };
    const issue = mcpServerUrlIssue(url);
    if (issue !== null) return { _tag: "Issue", issue: sentence(issue) };
    transport = { _tag: draft.kind, url };
  }
  const kind = secretKindOf({ _tag: draft.kind });
  const entries: Array<readonly [string, SecretEdit]> = [];
  if (savedApplies(draft, saved)) {
    for (const secret of draft.saved) {
      if (secret.removed) continue;
      entries.push([
        secret.name,
        secret.value === "" ? { _tag: "Keep" } : { _tag: "Set", value: secret.value },
      ]);
    }
  }
  for (const secret of draft.added) {
    const name = secret.name.trim();
    if (name === "" && secret.value === "") continue;
    if (name === "") return { _tag: "Issue", issue: `A ${secretNoun(kind)} value needs its name.` };
    const issue = mcpSecretNameIssue(kind, name);
    if (issue !== null) return { _tag: "Issue", issue: sentence(issue) };
    if (secret.value === "") return { _tag: "Incomplete" };
    const same = (other: string) =>
      kind === "header" ? other.toLowerCase() === name.toLowerCase() : other === name;
    if (entries.some(([other]) => same(other))) {
      return { _tag: "Issue", issue: `${name} is named twice.` };
    }
    entries.push([name, { _tag: "Set", value: secret.value }]);
  }
  return { _tag: "Write", write: { transport, secrets: Object.fromEntries(entries) } };
};

/** The domain's checks answer in lower-case fragments; the form says them as sentences. */
const sentence = (issue: string): string =>
  `${issue.charAt(0).toUpperCase()}${issue.slice(1)}${issue.endsWith(".") ? "" : "."}`;

/** Whether the URL in the form is the one shown for a saved server, with `…` for its sealed parts. */
export const keepsSealedUrl = (draft: McpDraft, saved: McpServerDto | null): boolean =>
  saved !== null &&
  saved.transport._tag !== "stdio" &&
  draft.kind !== "stdio" &&
  draft.url.trim() === saved.transport.url &&
  saved.transport.url.includes("…");

/**
 * The hosts of a person's enabled HTTP and SSE MCP servers, which a Restricted worktree they start
 * reaches without its policy listing them. A stdio server runs in the workspace and has none.
 */
export const mcpServerHosts = (servers: ReadonlyArray<McpServerDto>): ReadonlyArray<string> => {
  const hosts = servers.flatMap((server) => {
    // A launch reaches only the person's enabled servers; a stdio one runs in the workspace.
    if (!server.enabled || server.transport._tag === "stdio") return [];
    const parsed = URL.parse(server.transport.url);
    return parsed === null ? [] : [parsed.hostname.toLowerCase()];
  });
  return [...new Set(hosts)].toSorted();
};
