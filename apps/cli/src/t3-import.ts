/**
 * The read side of `mend import t3`: T3 Code's state on this machine, read without writing, as the
 * threads an import could bring into Mend. Each top-level thread is either ready, with what the
 * import needs (checkout, harness, native conversation and its files), or skipped with one reason.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { PermissionMode } from "@mend/domain/workbench";
import { checkoutOf } from "@mend/local-git/handoff";
import { Effect, Schema } from "effect";

export type ImportHarness = "claude" | "codex";

/** T3 Code's state database is not where it was looked for. */
export class T3StateMissing extends Schema.TaggedError<T3StateMissing>()("T3StateMissing", {
  databasePath: Schema.String,
}) {
  override get message(): string {
    return `No T3 Code state at ${this.databasePath}.`;
  }
}

/** T3 Code's state lacks a table, column or field this reader relies on. */
export class T3StateSchemaUnknown extends Schema.TaggedError<T3StateSchemaUnknown>()(
  "T3StateSchemaUnknown",
  { databasePath: Schema.String, missing: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `T3 Code's state at ${this.databasePath} has a schema this Mend does not know: ${this.missing.join("; ")}.`;
  }
}

/** T3 Code's state database or settings exist but could not be read. */
export class T3StateUnreadable extends Schema.TaggedError<T3StateUnreadable>()(
  "T3StateUnreadable",
  { path: Schema.String, message: Schema.String },
) {}

export type T3ImportError = T3StateMissing | T3StateSchemaUnknown | T3StateUnreadable;

export interface T3ImportFilter {
  /** A project's id, title or root directory. */
  readonly project?: string;
  readonly threadIds?: ReadonlyArray<string>;
}

export interface T3ImportScanInput {
  /** T3 Code's data directory; by default where T3 Code puts it: `T3CODE_HOME`, else `~/.t3`. */
  readonly t3Home?: string;
  /** What `~` means, and where the harnesses' default homes (`~/.claude`, `~/.codex`) are. */
  readonly homeDirectory?: string;
  /**
   * Read for `T3CODE_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, which T3 Code's process may have
   * had; `process.env` by default.
   */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly filter?: T3ImportFilter;
}

export interface T3ImportThread {
  readonly threadId: string;
  readonly title: string;
  readonly archived: boolean;
  /** Null title and root when T3 Code no longer lists the project. */
  readonly project: {
    readonly id: string;
    readonly title: string | null;
    readonly root: string | null;
  };
}

/** One file of a native conversation, relative to its harness home, with `/` separators. */
export interface ConversationFile {
  readonly relativePath: string;
  readonly bytes: number;
}

export interface ImportCheckout {
  /** The directory the thread ran in, as T3 Code recorded it: its worktree, else the project root. */
  readonly workingDirectory: string;
  /** The checkout's top level, symlinks resolved. Threads share a checkout exactly when equal. */
  readonly root: string;
  readonly originUrl: string;
}

export interface ReadyCandidate {
  readonly _tag: "ready";
  readonly thread: T3ImportThread;
  readonly checkout: ImportCheckout;
  readonly branch: string | null;
  readonly harness: ImportHarness;
  /** The harness's home on this machine that `files` are relative to (`~/.claude`, `~/.codex`). */
  readonly harnessHome: string;
  readonly nativeId: string;
  /** The conversation's own transcript (Codex: its rollout), one of `files`. */
  readonly transcript: string;
  /**
   * Every file of the conversation, sorted. Claude: the transcript, its sibling directory
   * (tool results, subagents), its tasks and its todo list; plan files are named only inside the
   * transcript and are not listed. Codex: the rollout and every ancestor named by `history_base`.
   */
  readonly files: ReadonlyArray<ConversationFile>;
  /** Null when T3 Code's model choice belongs to another provider instance than the conversation. */
  readonly model: string | null;
  readonly effort: string | null;
  /** ADR 0012: `full-access` is `bypass`; `approval-required`, and anything else, is `ask`. */
  readonly permissionMode: PermissionMode;
  /** T3 Code's own runtime mode, for saying so when it is neither of Mend's. */
  readonly runtimeMode: string;
}

export type SkipReason =
  | { readonly reason: "no-native-conversation" }
  | { readonly reason: "several-native-conversations"; readonly nativeIds: ReadonlyArray<string> }
  | { readonly reason: "unsupported-harness"; readonly driver: string }
  | {
      readonly reason: "conversation-not-on-machine";
      readonly harness: ImportHarness;
      /** Every home searched, most likely first. */
      readonly harnessHomes: ReadonlyArray<string>;
      /** The conversation whose file is missing: the thread's own, or a Codex ancestor's. */
      readonly nativeId: string;
    }
  | { readonly reason: "checkout-gone"; readonly workingDirectory: string | null }
  | { readonly reason: "not-a-git-checkout"; readonly workingDirectory: string }
  | {
      readonly reason: "checkout-unreadable";
      readonly workingDirectory: string;
      readonly message: string;
    }
  | { readonly reason: "no-origin"; readonly workingDirectory: string; readonly root: string };

export interface SkippedCandidate {
  readonly _tag: "skipped";
  readonly thread: T3ImportThread;
  readonly skip: SkipReason;
}

export type ImportCandidate = ReadyCandidate | SkippedCandidate;

type Environment = Readonly<Record<string, string | undefined>>;

/** `~` as T3 Code expands it: alone, or before a separator. */
const expandHome = (value: string, home: string): string =>
  value === "~"
    ? home
    : value.startsWith("~/") || value.startsWith("~\\")
      ? path.join(home, value.slice(2))
      : value;

/** T3 Code's data directory as T3 Code resolves it: `T3CODE_HOME`, else `~/.t3`. */
export const defaultT3Home = (
  environment: Environment = process.env,
  homeDirectory: string = os.homedir(),
): string => {
  const raw = environment["T3CODE_HOME"]?.trim() ?? "";
  return raw === ""
    ? path.join(homeDirectory, ".t3")
    : path.resolve(expandHome(raw, homeDirectory));
};

// What T3 Code's migrations define and this reader selects; anything absent fails the read.
const REQUIRED_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
  projection_projects: ["project_id", "title", "workspace_root"],
  orchestration_v2_projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "runtime_mode",
    "active_provider_thread_id",
    "created_at",
    "archived_at",
    "deleted_at",
    "payload_json",
  ],
  orchestration_v2_projection_provider_threads: [
    "provider_thread_id",
    "thread_id",
    "provider",
    "payload_json",
  ],
};

const NullableString = Schema.NullOr(Schema.String);

const ThreadRow = Schema.Struct({
  thread_id: Schema.String,
  project_id: Schema.String,
  title: Schema.String,
  runtime_mode: Schema.String,
  active_provider_thread_id: NullableString,
  created_at: Schema.String,
  archived_at: NullableString,
  payload_json: Schema.String,
  project_title: NullableString,
  workspace_root: NullableString,
});

const ThreadPayload = Schema.Struct({
  branch: Schema.optionalKey(NullableString),
  worktreePath: Schema.optionalKey(NullableString),
  modelSelection: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        options: Schema.optionalKey(
          Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
        ),
      }),
    ),
  ),
  lineage: Schema.Struct({
    parentThreadId: NullableString,
    relationshipToParent: NullableString,
    sideChat: Schema.optionalKey(Schema.Boolean),
  }),
});

const ProviderThreadRow = Schema.Struct({
  provider_thread_id: Schema.String,
  provider: Schema.String,
  payload_json: Schema.String,
});

const ProviderThreadPayload = Schema.Struct({
  providerInstanceId: Schema.optionalKey(Schema.String),
  nativeThreadRef: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ driver: Schema.String, nativeId: NullableString })),
  ),
});

const ProviderInstance = Schema.Struct({
  driver: Schema.String,
  environment: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.optionalKey(Schema.String) })),
  ),
  config: Schema.optionalKey(Schema.Unknown),
});
type ProviderInstance = typeof ProviderInstance.Type;

const Settings = Schema.Struct({
  providerInstances: Schema.optionalKey(Schema.Record(Schema.String, ProviderInstance)),
});

const HomeConfig = Schema.Struct({
  homePath: Schema.optionalKey(Schema.String),
  shadowHomePath: Schema.optionalKey(Schema.String),
});

const HARNESS_OF_DRIVER: Readonly<Record<string, ImportHarness>> = {
  claudeAgent: "claude",
  codex: "codex",
};

// The model-selection option each driver keeps its effort in (t3-gateway's HARNESS_DRIVERS).
const EFFORT_OPTION: Readonly<Record<ImportHarness, string>> = {
  claude: "effort",
  codex: "reasoningEffort",
};

// Threads T3 Code lists: subagents and side chats live inside their parent's conversation.
const LISTED_THREADS = `
  t.deleted_at IS NULL
  AND CASE WHEN json_valid(t.payload_json) THEN
    coalesce(json_extract(t.payload_json, '$.lineage.relationshipToParent'), '') <> 'subagent'
    AND coalesce(json_extract(t.payload_json, '$.lineage.sideChat'), 0) = 0
  ELSE 1 END`;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The harness homes a provider instance's conversations can be in, most likely first, resolved as
 * T3 Code resolves them on macOS and Linux alike. The instance's own `homePath`, or its own
 * `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, is the one home. Otherwise T3 Code used its process's variable,
 * else `~/.claude`/`~/.codex`. T3 Code started from a terminal sees the shell's variable; the macOS
 * app does not (it copies only PATH and a few others from the login shell), so with the variable set
 * both homes are searched. A Codex shadow home holds credentials only; conversations stay shared.
 */
const harnessHomesOf = (
  harness: ImportHarness,
  instance: ProviderInstance | undefined,
  environment: Environment,
  homeDirectory: string,
): ReadonlyArray<string> => {
  const variable = harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
  const resolved = (value: string) => path.resolve(expandHome(value.trim(), homeDirectory));
  const fallback = path.join(homeDirectory, harness === "claude" ? ".claude" : ".codex");
  const config = Schema.decodeUnknownOption(HomeConfig)(instance?.config ?? {});
  const homePath = config._tag === "Some" ? (config.value.homePath ?? "") : "";
  const shadowHomePath = config._tag === "Some" ? (config.value.shadowHomePath ?? "") : "";
  if (homePath.trim() !== "") return [resolved(homePath)];
  // Codex takes the variable only when neither home is configured.
  if (harness === "codex" && shadowHomePath.trim() !== "") return [fallback];
  const own = instance?.environment?.findLast((entry) => entry.name === variable)?.value;
  if (typeof own === "string") return [own.trim() === "" ? fallback : resolved(own)];
  const inherited = environment[variable]?.trim() ?? "";
  return inherited === "" ? [fallback] : [...new Set([resolved(inherited), fallback])];
};

const regularSize = (file: string): number | null => {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
};

const fileAt = (home: string, relativePath: string): ConversationFile | null => {
  const bytes = regularSize(path.join(home, relativePath));
  return bytes === null ? null : { relativePath, bytes };
};

/** Every regular file under `relativeDir` of `home`; symlinks are not followed. */
const filesUnder = (home: string, relativeDir: string): ReadonlyArray<ConversationFile> => {
  let entries: ReadonlyArray<fs.Dirent>;
  try {
    entries = fs.readdirSync(path.join(home, relativeDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) return filesUnder(home, relativePath);
    const file = entry.isFile() ? fileAt(home, relativePath) : null;
    return file === null ? [] : [file];
  });
};

const readDirectory = (dir: string): ReadonlyArray<fs.Dirent> => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Claude's transcripts by session id: the project directories (`projects/<key>`) holding each. */
const claudeTranscripts = (home: string): ReadonlyMap<string, ReadonlyArray<string>> => {
  const byId = new Map<string, Array<string>>();
  for (const project of readDirectory(path.join(home, "projects"))) {
    if (!project.isDirectory()) continue;
    for (const entry of readDirectory(path.join(home, "projects", project.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      byId.set(id, [...(byId.get(id) ?? []), project.name]);
    }
  }
  return byId;
};

const ROLLOUT =
  /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Codex's rollouts by thread id, relative to its home; a live rollout wins over an archived one. */
const codexRollouts = (home: string): ReadonlyMap<string, string> => {
  const byId = new Map<string, string>();
  const walk = (relativeDir: string, depth: number): void => {
    for (const entry of readDirectory(path.join(home, relativeDir))) {
      const relativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory() && depth > 0) walk(relativePath, depth - 1);
      const id = entry.isFile() ? ROLLOUT.exec(entry.name)?.[1] : undefined;
      if (id !== undefined && !byId.has(id)) byId.set(id, relativePath);
    }
  };
  // sessions/YYYY/MM/DD; archived_sessions is flat in current Codex, dated in older ones.
  walk("sessions", 3);
  walk("archived_sessions", 3);
  return byId;
};

const FIRST_LINE_LIMIT = 16 * 1024 * 1024;

/** The ancestor a Codex rollout names in its first line (`payload.history_base.thread_id`). */
const codexAncestor = (file: string): string | null => {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const chunks: Array<Buffer> = [];
    let total = 0;
    while (total < FIRST_LINE_LIMIT) {
      const chunk = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const end = chunk.subarray(0, read).indexOf(0x0a);
      chunks.push(chunk.subarray(0, end === -1 ? read : end));
      total += read;
      if (end !== -1) break;
    }
    const first = parseJson(Buffer.concat(chunks).toString("utf8"));
    const payload =
      typeof first === "object" && first !== null ? Reflect.get(first, "payload") : undefined;
    const base =
      typeof payload === "object" && payload !== null
        ? Reflect.get(payload, "history_base")
        : undefined;
    const ancestor =
      typeof base === "object" && base !== null ? Reflect.get(base, "thread_id") : undefined;
    return typeof ancestor === "string" && ancestor !== "" ? ancestor : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

type Conversation =
  | {
      readonly _tag: "found";
      readonly transcript: string;
      readonly files: ReadonlyArray<ConversationFile>;
    }
  | { readonly _tag: "missing"; readonly nativeId: string };

const claudeConversation = (
  home: string,
  transcripts: ReadonlyMap<string, ReadonlyArray<string>>,
  nativeId: string,
  workingDirectory: string | null,
): Conversation => {
  const dirs = transcripts.get(nativeId) ?? [];
  // Claude keys a project directory by its cwd, every character but a letter or digit as `-`.
  const key = workingDirectory?.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = dirs.find((name) => name === key) ?? dirs.toSorted()[0];
  if (dir === undefined) return { _tag: "missing", nativeId };
  const transcript = path.posix.join("projects", dir, `${nativeId}.jsonl`);
  const todo = fileAt(home, path.posix.join("todos", `${nativeId}-agent-${nativeId}.json`));
  const files = [
    ...[fileAt(home, transcript), todo].flatMap((file) => (file === null ? [] : [file])),
    ...filesUnder(home, path.posix.join("projects", dir, nativeId)),
    ...filesUnder(home, path.posix.join("tasks", nativeId)),
  ];
  return { _tag: "found", transcript, files };
};

const codexConversation = (
  home: string,
  rollouts: ReadonlyMap<string, string>,
  nativeId: string,
): Conversation => {
  const files: Array<ConversationFile> = [];
  const seen = new Set<string>();
  for (let id: string | null = nativeId; id !== null && !seen.has(id); ) {
    seen.add(id);
    const rollout = rollouts.get(id);
    const file = rollout === undefined ? null : fileAt(home, rollout);
    if (rollout === undefined || file === null) return { _tag: "missing", nativeId: id };
    files.push(file);
    id = codexAncestor(path.join(home, rollout));
  }
  const transcript = files[0]?.relativePath;
  return transcript === undefined
    ? { _tag: "missing", nativeId }
    : { _tag: "found", transcript, files };
};

type CheckoutCheck =
  | { readonly _tag: "checkout"; readonly root: string; readonly originUrl: string }
  | { readonly _tag: "skip"; readonly skip: SkipReason };

const realDirectory = (dir: string): string | null => {
  try {
    const real = fs.realpathSync(dir);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
};

const checkCheckout = (workingDirectory: string, real: string): CheckoutCheck => {
  const outcome = checkoutOf(real);
  if (outcome._tag === "checkout") {
    const root = realDirectory(outcome.checkout.top) ?? outcome.checkout.top;
    return outcome.checkout.originUrl === null
      ? { _tag: "skip", skip: { reason: "no-origin", workingDirectory, root } }
      : { _tag: "checkout", root, originUrl: outcome.checkout.originUrl };
  }
  if (outcome._tag === "refused" && outcome.why.reason === "not-a-checkout") {
    return { _tag: "skip", skip: { reason: "not-a-git-checkout", workingDirectory } };
  }
  return {
    _tag: "skip",
    skip: {
      reason: "checkout-unreadable",
      workingDirectory,
      message: outcome._tag === "refused" ? outcome.message : "cancelled",
    },
  };
};

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

interface ProviderThread {
  readonly providerThreadId: string;
  readonly instanceId: string;
  readonly driver: string | null;
  readonly nativeId: string | null;
}

/**
 * The conversation a thread continues: the active provider thread's, or the only one recorded.
 * Several recorded with none active (a provider switched mid-thread) cannot be told apart.
 */
const nativeOf = (
  activeProviderThreadId: string | null,
  providerThreads: ReadonlyArray<ProviderThread>,
):
  | { readonly _tag: "native"; readonly providerThread: ProviderThread; readonly nativeId: string }
  | { readonly _tag: "skip"; readonly skip: SkipReason } => {
  const recorded = providerThreads.flatMap((providerThread) =>
    providerThread.nativeId === null ? [] : [{ providerThread, nativeId: providerThread.nativeId }],
  );
  const active = recorded.find(
    ({ providerThread }) => providerThread.providerThreadId === activeProviderThreadId,
  );
  const chosen =
    active ?? (activeProviderThreadId === null && recorded.length === 1 ? recorded[0] : undefined);
  if (chosen !== undefined) return { _tag: "native", ...chosen };
  return recorded.length === 0
    ? { _tag: "skip", skip: { reason: "no-native-conversation" } }
    : {
        _tag: "skip",
        skip: {
          reason: "several-native-conversations",
          nativeIds: recorded.map(({ nativeId }) => nativeId).toSorted(),
        },
      };
};

type SqliteDatabase = import("node:sqlite").DatabaseSync;

const openReadOnly = (databasePath: string) =>
  Effect.gen(function* () {
    if (regularSize(databasePath) === null) return yield* new T3StateMissing({ databasePath });
    // Loaded here, not at the top: on Node 22 node:sqlite warns that it is experimental as it
    // loads, and only this command reads a database (main filters that warning out).
    const { DatabaseSync } = yield* Effect.tryPromise({
      try: () => import("node:sqlite"),
      catch: (cause) => new T3StateUnreadable({ path: databasePath, message: String(cause) }),
    });
    return yield* Effect.try({
      try: () => {
        // Read-only, never immutable: T3 Code may be writing, and WAL readers see its commits.
        const database = new DatabaseSync(databasePath, { readOnly: true });
        database.exec("PRAGMA query_only = ON");
        return database;
      },
      catch: (cause) => new T3StateUnreadable({ path: databasePath, message: String(cause) }),
    });
  });

const missingColumns = (database: SqliteDatabase): ReadonlyArray<string> =>
  Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) => {
    const present = new Set(
      database
        .prepare("SELECT name FROM pragma_table_info(?)")
        .all(table)
        .map((row) => row["name"]),
    );
    if (present.size === 0) return [`table ${table}`];
    return columns.filter((column) => !present.has(column)).map((column) => `${table}.${column}`);
  });

const readProviderInstances = (settingsPath: string) =>
  Effect.gen(function* () {
    if (regularSize(settingsPath) === null) return {};
    const text = yield* Effect.try({
      try: () => fs.readFileSync(settingsPath, "utf8"),
      catch: (cause) => new T3StateUnreadable({ path: settingsPath, message: String(cause) }),
    });
    const settings = yield* Schema.decodeUnknownEffect(Settings)(parseJson(text)).pipe(
      Effect.mapError(
        (error) => new T3StateUnreadable({ path: settingsPath, message: error.message }),
      ),
    );
    return settings.providerInstances ?? {};
  });

interface ThreadRecord {
  readonly row: typeof ThreadRow.Type;
  readonly payload: typeof ThreadPayload.Type;
  readonly providerThreads: ReadonlyArray<ProviderThread>;
}

interface RawThread {
  readonly row: unknown;
  readonly providerRows: ReadonlyArray<unknown>;
}

/**
 * The listed threads' rows and their provider threads' rows, in one read transaction so both come
 * from one snapshot. Uses the threads table and the provider threads' thread index only.
 */
const queryThreads = (database: SqliteDatabase): ReadonlyArray<RawThread> => {
  database.exec("BEGIN");
  try {
    const byThread = database.prepare(
      `SELECT provider_thread_id, provider, payload_json
       FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?`,
    );
    return database
      .prepare(
        `SELECT t.thread_id, t.project_id, t.title, t.runtime_mode, t.active_provider_thread_id,
                t.created_at, t.archived_at, t.payload_json,
                p.title AS project_title, p.workspace_root
         FROM orchestration_v2_projection_threads t
         LEFT JOIN projection_projects p ON p.project_id = t.project_id
         WHERE ${LISTED_THREADS}`,
      )
      .all()
      .map((row) => ({ row, providerRows: byThread.all(row["thread_id"] ?? null) }));
  } finally {
    database.exec("COMMIT");
  }
};

const readThreads = (database: SqliteDatabase, databasePath: string) =>
  Effect.gen(function* () {
    const absent = missingColumns(database);
    if (absent.length > 0)
      return yield* new T3StateSchemaUnknown({ databasePath, missing: absent });
    return queryThreads(database);
  });

const decodeThread = (raw: RawThread, databasePath: string) =>
  Effect.gen(function* () {
    const unknown = (missing: string) => (error: Schema.SchemaError) =>
      new T3StateSchemaUnknown({ databasePath, missing: [`${missing}: ${error.message}`] });
    const row = yield* Schema.decodeUnknownEffect(ThreadRow)(raw.row).pipe(
      Effect.mapError(unknown("a thread row")),
    );
    const payload = yield* Schema.decodeUnknownEffect(ThreadPayload)(
      parseJson(row.payload_json),
    ).pipe(Effect.mapError(unknown(`payload_json of thread ${row.thread_id}`)));
    const providerThreads: Array<ProviderThread> = [];
    for (const rawProvider of raw.providerRows) {
      const provider = yield* Schema.decodeUnknownEffect(ProviderThreadRow)(rawProvider).pipe(
        Effect.mapError(unknown(`a provider thread row of thread ${row.thread_id}`)),
      );
      const providerPayload = yield* Schema.decodeUnknownEffect(ProviderThreadPayload)(
        parseJson(provider.payload_json),
      ).pipe(
        Effect.mapError(unknown(`payload_json of provider thread ${provider.provider_thread_id}`)),
      );
      const ref = providerPayload.nativeThreadRef ?? null;
      providerThreads.push({
        providerThreadId: provider.provider_thread_id,
        instanceId: providerPayload.providerInstanceId ?? provider.provider,
        driver: ref?.driver ?? null,
        nativeId: ref?.nativeId?.trim() || null,
      });
    }
    const listed =
      payload.lineage.relationshipToParent !== "subagent" && payload.lineage.sideChat !== true;
    return listed ? [{ row, payload, providerThreads }] : [];
  });

const cached = <K, V>(cache: Map<K, V>, key: K, make: () => V): V => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = make();
  cache.set(key, value);
  return value;
};

const matchesFilter = (record: ThreadRecord, filter: T3ImportFilter, homeDirectory: string) => {
  if (filter.threadIds !== undefined && !filter.threadIds.includes(record.row.thread_id))
    return false;
  const wanted = filter.project;
  if (wanted === undefined) return true;
  const { project_id: id, project_title: title, workspace_root: root } = record.row;
  if (wanted === id || wanted === title) return true;
  if (root === null) return false;
  const wantedDir = path.resolve(expandHome(wanted, homeDirectory));
  if (wantedDir === path.resolve(root)) return true;
  const real = realDirectory(wantedDir);
  return real !== null && real === realDirectory(root);
};

/**
 * T3 Code's top-level threads on this machine as import candidates, in a stable order (project
 * title, then creation time). Deleted threads are left out; archived ones are included and marked.
 * Subagents and side chats are not candidates: their conversations live inside their parent's.
 * Reads T3 Code's database, settings, the harnesses' homes and each checkout's git; writes nothing.
 */
export const readT3ImportCandidates = (
  input: T3ImportScanInput = {},
): Effect.Effect<ReadonlyArray<ImportCandidate>, T3ImportError> =>
  Effect.gen(function* () {
    const environment = input.environment ?? process.env;
    const homeDirectory = input.homeDirectory ?? os.homedir();
    const t3Home = input.t3Home ?? defaultT3Home(environment, homeDirectory);
    const databasePath = path.join(t3Home, "userdata", "statev2.sqlite");
    const instances = yield* readProviderInstances(path.join(t3Home, "userdata", "settings.json"));
    const rawThreads = yield* Effect.acquireUseRelease(
      openReadOnly(databasePath),
      (database) => readThreads(database, databasePath),
      (database) => Effect.sync(() => database.close()),
    );
    const records: ReadonlyArray<ThreadRecord> = (yield* Effect.forEach(rawThreads, (raw) =>
      decodeThread(raw, databasePath),
    )).flat();

    const claudeIndexes = new Map<string, ReadonlyMap<string, ReadonlyArray<string>>>();
    const codexIndexes = new Map<string, ReadonlyMap<string, string>>();
    const checkouts = new Map<string, CheckoutCheck>();

    const candidateOf = (record: ThreadRecord): ImportCandidate => {
      const { row, payload } = record;
      const thread: T3ImportThread = {
        threadId: row.thread_id,
        title: row.title,
        archived: row.archived_at !== null,
        project: { id: row.project_id, title: row.project_title, root: row.workspace_root },
      };
      const skipped = (skip: SkipReason): SkippedCandidate => ({ _tag: "skipped", thread, skip });

      const native = nativeOf(row.active_provider_thread_id, record.providerThreads);
      if (native._tag === "skip") return skipped(native.skip);
      const driver = native.providerThread.driver ?? "";
      const harness = HARNESS_OF_DRIVER[driver];
      if (harness === undefined) return skipped({ reason: "unsupported-harness", driver });

      const workingDirectory = payload.worktreePath?.trim() || row.workspace_root?.trim() || null;
      const harnessHomes = harnessHomesOf(
        harness,
        instances[native.providerThread.instanceId],
        environment,
        homeDirectory,
      );
      const conversationIn = (home: string): Conversation =>
        harness === "claude"
          ? claudeConversation(
              home,
              cached(claudeIndexes, home, () => claudeTranscripts(home)),
              native.nativeId,
              workingDirectory,
            )
          : codexConversation(
              home,
              cached(codexIndexes, home, () => codexRollouts(home)),
              native.nativeId,
            );
      const searched = harnessHomes.map((home) => ({ home, conversation: conversationIn(home) }));
      const found = searched.find(({ conversation }) => conversation._tag === "found");
      if (found === undefined || found.conversation._tag !== "found") {
        return skipped({
          reason: "conversation-not-on-machine",
          harness,
          harnessHomes,
          nativeId:
            searched[0]?.conversation._tag === "missing"
              ? searched[0].conversation.nativeId
              : native.nativeId,
        });
      }
      const { home: harnessHome, conversation } = found;

      const real = workingDirectory === null ? null : realDirectory(workingDirectory);
      if (workingDirectory === null || real === null)
        return skipped({ reason: "checkout-gone", workingDirectory });
      const checkout = cached(checkouts, real, () => checkCheckout(workingDirectory, real));
      if (checkout._tag === "skip") {
        // A cached skip names the first thread's recorded path; name this thread's own.
        return skipped(
          "workingDirectory" in checkout.skip
            ? { ...checkout.skip, workingDirectory }
            : checkout.skip,
        );
      }

      const selection = payload.modelSelection ?? null;
      const ownSelection =
        selection !== null && selection.instanceId === native.providerThread.instanceId
          ? selection
          : null;
      const effort = ownSelection?.options?.find(
        (option) => option.id === EFFORT_OPTION[harness],
      )?.value;
      return {
        _tag: "ready",
        thread,
        checkout: { workingDirectory, root: checkout.root, originUrl: checkout.originUrl },
        branch: payload.branch?.trim() || null,
        harness,
        harnessHome,
        nativeId: native.nativeId,
        transcript: conversation.transcript,
        files: conversation.files.toSorted((left, right) =>
          compareText(left.relativePath, right.relativePath),
        ),
        model: ownSelection?.model ?? null,
        effort: typeof effort === "string" ? effort : null,
        permissionMode: row.runtime_mode === "full-access" ? "bypass" : "ask",
        runtimeMode: row.runtime_mode,
      };
    };

    return records
      .filter((record) => matchesFilter(record, input.filter ?? {}, homeDirectory))
      .toSorted(
        (left, right) =>
          (left.row.project_title === null ? 1 : 0) - (right.row.project_title === null ? 1 : 0) ||
          compareText(left.row.project_title ?? "", right.row.project_title ?? "") ||
          compareText(left.row.created_at, right.row.created_at) ||
          compareText(left.row.thread_id, right.row.thread_id),
      )
      .map(candidateOf);
  });
