/**
 * Sign-ins that last (docs/adr/0024, decision 5). Claude keeps an OAuth sign-in for an MCP server
 * in `mcpOAuth["<name>|<hash>"]` of `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`. Mend
 * never runs OAuth: it keeps what Claude wrote and gives it back.
 *
 * - Harvest: Mend's helper (`mend mcp`, a stdio child of every Claude process) watches that file
 *   (`SIGN_IN_WATCH_SOURCE`) and posts the entries of the person's delivered HTTP and SSE servers
 *   to `MEND_MCP_SIGN_INS_PATH`. The channel credits them to the person `mcpPersonOf` names for
 *   the process (`keepHarvestedSignIns`), newest wins.
 * - Put-back: a launch whose person has kept sign-ins wraps Claude (`withClaudeSignIns`) in a
 *   program that merges them into the credentials file before Claude starts.
 */
import type { McpSignInKept, McpSignInObserved } from "@mend/db";
import { MCP_SERVER_LIMITS, type McpTransport } from "@mend/domain/workbench";
import { Effect } from "effect";

import type { McpPerson } from "./personal.ts";

export const MEND_MCP_SIGN_INS_PATH = "/session/mcp-sign-ins";

/** The put-back's file beside the delivered `claude.json`, under `personalMcpDir`. */
export const CLAUDE_SIGN_INS_FILE = "claude-sign-ins.json";

const KEY_MAX = 512;
const ENTRY_MAX_BYTES = 16 * 1024;

/** The largest harvest body the channel reads: every server's entry at its largest. */
export const SIGN_INS_BODY_MAX_BYTES = MCP_SERVER_LIMITS.servers * (ENTRY_MAX_BYTES + KEY_MAX + 64);

/** One `mcpOAuth` entry as the helper posts it: Claude's key and the entry, kept whole. */
export interface HarvestedSignIn {
  readonly key: string;
  readonly serverName: string;
  readonly serverUrl: string;
  readonly expiresAt: Date;
  /** The entry as JSON, unknown fields included. Token material: sealed, never logged. */
  readonly document: string;
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const harvestedOf = (item: unknown): HarvestedSignIn | null => {
  if (!isObject(item)) return null;
  const { key, entry } = item;
  if (typeof key !== "string" || key === "" || key.length > KEY_MAX || !isObject(entry)) {
    return null;
  }
  const { serverName, serverUrl, expiresAt } = entry;
  if (typeof serverName !== "string" || typeof serverUrl !== "string") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  const document = JSON.stringify(entry);
  if (document.length > ENTRY_MAX_BYTES) return null;
  return { key, serverName, serverUrl, expiresAt: new Date(expiresAt), document };
};

/** The entries a harvest body carries; null when it is not one. An unreadable entry is dropped. */
export const harvestedSignInsOf = (body: unknown): ReadonlyArray<HarvestedSignIn> | null => {
  if (!isObject(body) || !Array.isArray(body.entries)) return null;
  if (body.entries.length > MCP_SERVER_LIMITS.servers) return null;
  return body.entries.flatMap((item) => harvestedOf(item) ?? []);
};

/** What the channel answers a harvest: each entry's outcome by key, or why none was kept. */
export type KeepSignInsAnswer =
  | {
      readonly _tag: "Kept";
      readonly outcomes: ReadonlyArray<{ readonly key: string; readonly kept: McpSignInKept }>;
    }
  | { readonly _tag: "Refused"; readonly why: string };

/**
 * Credit a process's harvest to the person whose servers it carries (`mcpPersonOf`), sealed, newest
 * wins. A process that carries no one's servers keeps nothing: in a home another person's turn
 * also uses, a sign-in cannot be said to be anyone's.
 */
export const keepHarvestedSignIns = <E, R>(input: {
  readonly person: McpPerson;
  readonly processStartedAt: Date;
  readonly entries: ReadonlyArray<HarvestedSignIn>;
  readonly seal: (document: string) => Effect.Effect<string, E, R>;
  readonly keep: (
    accountId: string,
    observed: McpSignInObserved,
  ) => Effect.Effect<McpSignInKept, never, R>;
}): Effect.Effect<KeepSignInsAnswer, E, R> => {
  const { person } = input;
  if (person._tag === "Withhold") return Effect.succeed({ _tag: "Refused", why: person.why });
  return Effect.forEach(
    input.entries,
    (entry) =>
      input.seal(entry.document).pipe(
        Effect.flatMap((sealed) =>
          input.keep(person.accountId, {
            serverName: entry.serverName,
            serverUrl: entry.serverUrl,
            key: entry.key,
            sealed,
            expiresAt: entry.expiresAt,
            processStartedAt: input.processStartedAt,
          }),
        ),
        Effect.map((kept) => ({ key: entry.key, kept })),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((outcomes): KeepSignInsAnswer => ({ _tag: "Kept", outcomes })));
};

/** A delivered server's kept sign-in, unsealed, as a launch puts it back. */
export interface ServerSignIns {
  readonly name: string;
  readonly transport: McpTransport;
  /** Claude's key and entry; null when Mend keeps none. */
  readonly signIn: {
    readonly key: string;
    readonly entry: Readonly<Record<string, unknown>>;
  } | null;
  /** Forgotten, or its URL or transport changed, and not signed in since. */
  readonly forgotten: boolean;
}

/** The entry a sealed document holds; null when it is not one Claude would read. */
export const signInEntryOf = (document: string): Readonly<Record<string, unknown>> | null => {
  try {
    const entry: unknown = JSON.parse(document);
    return isObject(entry) && typeof entry.expiresAt === "number" ? entry : null;
  } catch {
    return null;
  }
};

/**
 * The put-back's file: the kept entries to merge, and the forgotten servers whose entries come out
 * of the home, so a Forget holds in a home that still has the old sign-in. Null when there is
 * nothing to do. Values are token material: written 0600 like every delivered file.
 */
export const claudeSignInsFileOf = (input: {
  readonly dir: string;
  readonly servers: ReadonlyArray<ServerSignIns>;
}): { readonly path: string; readonly content: string } | null => {
  const keep: Array<readonly [string, Readonly<Record<string, unknown>>]> = [];
  const forget: Array<{ readonly serverName: string; readonly serverUrl: string }> = [];
  for (const server of input.servers) {
    if (server.transport._tag === "stdio") continue;
    if (server.signIn !== null) keep.push([server.signIn.key, server.signIn.entry]);
    else if (server.forgotten)
      forget.push({ serverName: server.name, serverUrl: server.transport.url });
  }
  if (keep.length === 0 && forget.length === 0) return null;
  return {
    path: `${input.dir}/${CLAUDE_SIGN_INS_FILE}`,
    // fromEntries defines each key as an own property, `__proto__` included.
    content: JSON.stringify({ keep: Object.fromEntries(keep), forget }),
  };
};

/**
 * The put-back, run as the process's user just before Claude, after any seed and after Core has
 * placed the login. An entry is written when its key is missing or holds an older `expiresAt`; a
 * forgotten server's entries are removed. Nothing else in the file changes, `claudeAiOauth`
 * included. Only a regular file is written, through a new 0600 file renamed over it; an absent
 * file is created. Any failure says one line and Claude starts anyway. No single quote: the
 * program sits inside one in `CLAUDE_SIGN_INS_LAUNCH`.
 */
export const CLAUDE_SIGN_INS_PROGRAM = `
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const say = (why) => process.stderr.write("mend: your MCP sign-ins were not put back: " + why + "\\n");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const main = () => {
  let plan = null;
  try { plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
  if (!isObject(plan) || !isObject(plan.keep) || !Array.isArray(plan.forget)) return say("the copy Mend keeps could not be read");
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const file = path.join(dir, ".credentials.json");
  let stat = null;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code !== "ENOENT") return say("the Claude credentials file could not be read"); }
  if (stat !== null && !stat.isFile()) return say("the Claude credentials file is not a regular file");
  let doc = {};
  if (stat !== null) {
    try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return say("the Claude credentials file is not JSON"); }
  }
  if (!isObject(doc) || (doc.mcpOAuth !== undefined && !isObject(doc.mcpOAuth))) return say("the Claude credentials file is not as Claude writes it");
  const held = new Map(Object.entries(doc.mcpOAuth || {}));
  let changed = false;
  for (const [key, entry] of Object.entries(plan.keep)) {
    if (!isObject(entry) || typeof entry.expiresAt !== "number") continue;
    const current = held.get(key);
    if (isObject(current) && typeof current.expiresAt === "number" && current.expiresAt >= entry.expiresAt) continue;
    held.set(key, entry);
    changed = true;
  }
  for (const [key, current] of [...held]) {
    if (isObject(current) && plan.forget.some((f) => isObject(f) && f.serverName === current.serverName && f.serverUrl === current.serverUrl)) {
      held.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  doc.mcpOAuth = Object.fromEntries(held);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = file + ".mend-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify(doc)); fs.fchmodSync(fd, 0o600); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } catch (e) {
    try { fs.unlinkSync(temporary); } catch {}
    throw e;
  }
};
try { main(); } catch { say("the Claude credentials file could not be written"); }
`;

export const CLAUDE_SIGN_INS_LAUNCH = `node -e '${CLAUDE_SIGN_INS_PROGRAM}' "$1"; shift; exec "$@"`;

const SIGN_INS_NAME = "mend-mcp-sign-ins";

/** Claude's `command` behind the put-back of `file` (`CLAUDE_SIGN_INS_PROGRAM`). */
export const withClaudeSignIns = (
  command: ReadonlyArray<string>,
  file: string,
): ReadonlyArray<string> => ["sh", "-c", CLAUDE_SIGN_INS_LAUNCH, SIGN_INS_NAME, file, ...command];

/**
 * The helper's watch over Claude's credentials file, as source the helper script includes:
 * `signInWatch(io)` returns `{ check }`, and each check stats the file and reads it only when its
 * mtime, size or inode changed. It posts the `mcpOAuth` entries of the servers the delivered
 * `claude.json` lists (HTTP and SSE, matched on name and URL) that differ from what it last posted.
 * A post the channel could not take (`"again"`) is tried at the next check. Nothing it says
 * carries an entry: `io` receives them only through `post`.
 *
 * `io`: `{ credentials, delivered, stat(path) → {mtimeMs,size,ino}|null, read(path) → text|null,
 * post(entries) → Promise<"done"|"again"> }`.
 */
export const SIGN_IN_WATCH_SOURCE = `
const signInWatch = (io) => {
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const sent = new Map();
  let seen = null;
  let queue = Promise.resolve();
  const listed = () => {
    const text = io.read(io.delivered);
    if (text === null) return [];
    try {
      const servers = JSON.parse(text).mcpServers;
      return Object.entries(isObject(servers) ? servers : {})
        .filter(([, s]) => isObject(s) && (s.type === "http" || s.type === "sse") && typeof s.url === "string")
        .map(([name, s]) => ({ name, url: s.url }));
    } catch {
      return [];
    }
  };
  const harvest = async () => {
    const stat = io.stat(io.credentials);
    const mark = stat === null ? "absent" : stat.mtimeMs + "/" + stat.size + "/" + stat.ino;
    if (mark === seen) return;
    seen = mark;
    const text = stat === null ? null : io.read(io.credentials);
    if (text === null) return;
    let oauth = null;
    try {
      const doc = JSON.parse(text);
      oauth = isObject(doc) && isObject(doc.mcpOAuth) ? doc.mcpOAuth : null;
    } catch {}
    if (oauth === null) return;
    const servers = listed();
    const changed = [];
    for (const [key, entry] of Object.entries(oauth)) {
      if (!isObject(entry) || typeof entry.expiresAt !== "number") continue;
      if (!servers.some((s) => s.name === entry.serverName && s.url === entry.serverUrl)) continue;
      const json = JSON.stringify(entry);
      if (sent.get(key) !== json) changed.push({ key, entry, json });
    }
    if (changed.length === 0) return;
    const answer = await io.post(changed.map(({ key, entry }) => ({ key, entry })));
    if (answer !== "done") {
      seen = null;
      return;
    }
    for (const { key, json } of changed) sent.set(key, json);
  };
  return {
    check: () => {
      queue = queue.then(harvest).catch(() => {
        seen = null;
      });
      return queue;
    },
  };
};
`;
