import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

/**
 * opencode keeps its conversations as rows in a SQLite database (`opencode.db`, with its
 * write-ahead log beside it), not as files Mend can name the way it names a Claude or Codex
 * transcript. This module reads which conversation an agent process held, so a resume opens
 * exactly that one (`opencode --session <id>`) and never another session's.
 *
 * Why identity and not isolation: a session's harness home is the worktree's in capture mode (the
 * head capture carries it to the next executor), so two sessions in one worktree see one
 * database. Giving each its own opencode data directory would take `XDG_DATA_HOME`, the only knob
 * opencode 1.18.34 has for it (`core/src/global.ts`), and every tool the agent runs would follow
 * it into the captured root (pnpm's store, uv, …). The conversation id is opencode's own handle
 * and `--session` takes it.
 */

/** Where Mend runs opencode: the conversations a resume may open are the ones started here. */
export const OPENCODE_WORKING_DIRECTORY = "/workspace/repo";

/** One top-level conversation: its id and times (milliseconds, the executor's clock). */
export interface OpencodeConversation {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * The top-level conversations an opencode database holds for `/workspace/repo`, newest first.
 * Null when the bytes do not open as opencode's database (empty, corrupt, torn mid-checkpoint, or
 * no `session` table): that is no conversation, never an empty list that reads as one.
 */
export const readOpencodeConversations = (
  database: Uint8Array,
  wal: Uint8Array | null,
): Effect.Effect<ReadonlyArray<OpencodeConversation> | null> =>
  Effect.promise(async () => {
    if (database.byteLength === 0) return null;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mend-opencode-db-"));
    try {
      const file = path.join(dir, "opencode.db");
      await fs.writeFile(file, database);
      if (wal !== null) await fs.writeFile(`${file}-wal`, wal);
      // Not read-only: the copy is ours, and SQLite replays the log into it only with write access.
      const db = new DatabaseSync(file);
      try {
        const verdict = db.prepare("pragma quick_check").get();
        if (verdict?.["quick_check"] !== "ok") return null;
        const rows = db
          .prepare(
            "select id, time_created, time_updated from session " +
              "where parent_id is null and directory = ? order by time_updated desc, id desc",
          )
          .all(OPENCODE_WORKING_DIRECTORY);
        return rows.flatMap((row): ReadonlyArray<OpencodeConversation> => {
          const id = row["id"];
          const createdAt = Number(row["time_created"]);
          const updatedAt = Number(row["time_updated"]);
          if (typeof id !== "string" || id === "") return [];
          if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return [];
          return [{ id, createdAt, updatedAt }];
        });
      } finally {
        db.close();
      }
    } catch {
      return null;
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

/** opencode's database, relative to the harness home (`$HOME`). */
export const OPENCODE_DATABASE = ".local/share/opencode/opencode.db";

/** A regular file's bytes; null for a link, a directory, or nothing there. */
const regularFile = async (file: string): Promise<Uint8Array | null> => {
  try {
    if (!(await fs.lstat(file)).isFile()) return null;
    return new Uint8Array(await fs.readFile(file));
  } catch {
    return null;
  }
};

/**
 * The conversations of the opencode database in a harness home on this machine (the co-located
 * store's durable home), as `readOpencodeConversations` reads them. A link where the database or
 * its log belongs is not read: it could lead anywhere.
 */
export const readOpencodeHome = (
  harnessHomePath: string,
): Effect.Effect<ReadonlyArray<OpencodeConversation> | null> =>
  Effect.promise(async () => {
    const file = path.join(harnessHomePath, OPENCODE_DATABASE);
    const database = await regularFile(file);
    if (database === null) return null;
    // No log is a database read whole; a log that is there but is not a plain file, or cannot be
    // read, is no answer: the database without it can be missing conversations.
    const present = await fs.lstat(`${file}-wal`).then(
      () => true,
      () => false,
    );
    if (!present) return { database, wal: null };
    const wal = await regularFile(`${file}-wal`);
    if (wal === null) return null;
    return { database, wal };
  }).pipe(
    Effect.flatMap((found) =>
      found === null ? Effect.succeed(null) : readOpencodeConversations(found.database, found.wal),
    ),
  );

/**
 * The conversation ids an opencode database in a harness home holds, as a launch snapshot needs
 * them: none when there is no database yet (a first launch), null when one is there but cannot be
 * read, which leaves the launch's conversations unknown.
 */
export const snapshotOpencodeHome = (
  harnessHomePath: string,
): Effect.Effect<ReadonlyArray<string> | null> =>
  Effect.promise(async () => {
    try {
      await fs.lstat(path.join(harnessHomePath, OPENCODE_DATABASE));
      return true;
    } catch {
      return false;
    }
  }).pipe(
    Effect.flatMap((present) =>
      present
        ? readOpencodeHome(harnessHomePath).pipe(
            Effect.map((listed) => (listed === null ? null : listed.map((entry) => entry.id))),
          )
        : Effect.succeed([]),
    ),
  );

/** Where an opencode process's launch snapshot is kept, in its process state directory. */
export const OPENCODE_LAUNCH_SNAPSHOT = "opencode-launch.json";

/** The launch snapshot kept in a process state directory; null when none was kept. */
export const readOpencodeLaunchSnapshot = (
  stateDir: string,
): Effect.Effect<ReadonlyArray<string> | null> =>
  Effect.promise(async () => {
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(path.join(stateDir, OPENCODE_LAUNCH_SNAPSHOT), "utf8"),
      );
      return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
        ? parsed.filter((id): id is string => typeof id === "string")
        : null;
    } catch {
      return null;
    }
  });

/** Keep a launch snapshot in a process state directory. */
export const writeOpencodeLaunchSnapshot = (
  stateDir: string,
  conversations: ReadonlyArray<string>,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(stateDir, { recursive: true });
      await fs.writeFile(
        path.join(stateDir, OPENCODE_LAUNCH_SNAPSHOT),
        JSON.stringify(conversations),
      );
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

/**
 * An opencode agent process as identity needs it: the conversation a resume named, when Mend
 * started it and recorded its end (Mend's own clock, never the executor's), and the conversations
 * its database already held when it started (`atLaunch`; null when that was not read).
 */
export interface OpencodeAgentSpan {
  readonly providerSessionId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly atLaunch: ReadonlyArray<string> | null;
}

/** An agent process row's span, with the launch snapshot recorded beside it. */
export const opencodeSpanOf = (
  row: {
    readonly providerSessionId: string | null;
    readonly createdAt: Date;
    readonly exitedAt: Date | null;
  },
  atLaunch: ReadonlyArray<string> | null,
): OpencodeAgentSpan => ({
  providerSessionId: row.providerSessionId,
  startedAt: row.createdAt.getTime(),
  endedAt: row.exitedAt?.getTime() ?? null,
  atLaunch,
});

/**
 * The conversation `agent` held, or null when that cannot be established, and a resume is then
 * refused rather than open a guess. No timestamp opencode wrote is compared with Mend's: the
 * executor's clock may be anywhere.
 *
 * - Its own are the conversation a resume named, while the database still has it, and every
 *   conversation the database did not hold when it launched (`atLaunch`). Without a snapshot only
 *   the named one is known.
 * - None another opencode process of the worktree is known to hold.
 * - Another opencode process of the worktree that was still running when this one launched could
 *   have started any new conversation: only the named one stays. One that launched after this one
 *   could have started any conversation its own snapshot does not hold: those go (all of them, when
 *   it has no snapshot).
 * - Of what remains, the most recently updated: a resumed session that opened a new conversation in
 *   opencode and worked in it last is recorded on that one at its next Stop.
 */
export const opencodeConversationOf = (
  conversations: ReadonlyArray<OpencodeConversation>,
  agent: OpencodeAgentSpan,
  others: ReadonlyArray<OpencodeAgentSpan>,
  now: number,
): string | null => {
  const claimed = new Set(
    others.flatMap((other) => (other.providerSessionId === null ? [] : [other.providerSessionId])),
  );
  const atLaunch = agent.atLaunch === null ? null : new Set(agent.atLaunch);
  const runningAtLaunch = others.some(
    (other) => other.startedAt <= agent.startedAt && (other.endedAt ?? now) > agent.startedAt,
  );
  const later = others.filter((other) => other.startedAt > agent.startedAt);
  const isNamed = (id: string) => id === agent.providerSessionId;
  const candidates = conversations.filter((conversation) => {
    const id = conversation.id;
    if (isNamed(id)) return true;
    if (atLaunch === null || atLaunch.has(id) || claimed.has(id) || runningAtLaunch) return false;
    return later.every((other) => other.atLaunch !== null && other.atLaunch.includes(id));
  });
  return (
    candidates.reduce<OpencodeConversation | null>(
      (newest, conversation) =>
        newest === null || conversation.updatedAt > newest.updatedAt ? conversation : newest,
      null,
    )?.id ?? null
  );
};
