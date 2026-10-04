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
    let wal: Uint8Array | null = null;
    try {
      const stat = await fs.lstat(`${file}-wal`);
      if (!stat.isFile()) return null;
      wal = await regularFile(`${file}-wal`);
    } catch {
      wal = null;
    }
    return { database, wal };
  }).pipe(
    Effect.flatMap((found) =>
      found === null ? Effect.succeed(null) : readOpencodeConversations(found.database, found.wal),
    ),
  );

/** How far apart the executor's clock and Mend's may be when a conversation is tied to a launch. */
export const OPENCODE_CLOCK_SKEW_MS = 60_000;

/** An opencode agent process as identity needs it: what it is known to hold, and when it ran. */
export interface OpencodeAgentSpan {
  readonly providerSessionId: string | null;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** An agent process row's span: when Mend started it and recorded its end, and what it held. */
export const opencodeSpanOf = (row: {
  readonly providerSessionId: string | null;
  readonly createdAt: Date;
  readonly exitedAt: Date | null;
}): OpencodeAgentSpan => ({
  providerSessionId: row.providerSessionId,
  startedAt: row.createdAt.getTime(),
  endedAt: row.exitedAt?.getTime() ?? null,
});

/**
 * The conversation `agent` held, or null when that cannot be established, and a resume is then
 * refused rather than open a guess.
 *
 * - A process launched on a known conversation (a resume names it) holds that one, while the
 *   database still has it.
 * - Otherwise it holds the newest conversation started while it ran (within the clock skew) that
 *   no other opencode process of the worktree is known to hold. A conversation started while
 *   another opencode process of the worktree also ran could be either's: it is left out.
 */
export const opencodeConversationOf = (
  conversations: ReadonlyArray<OpencodeConversation>,
  agent: OpencodeAgentSpan,
  others: ReadonlyArray<OpencodeAgentSpan>,
  now: number,
): string | null => {
  if (agent.providerSessionId !== null) {
    return conversations.some((conversation) => conversation.id === agent.providerSessionId)
      ? agent.providerSessionId
      : null;
  }
  const claimed = new Set(
    others.flatMap((other) => (other.providerSessionId === null ? [] : [other.providerSessionId])),
  );
  const from = agent.startedAt - OPENCODE_CLOCK_SKEW_MS;
  const to = (agent.endedAt ?? now) + OPENCODE_CLOCK_SKEW_MS;
  // Exact spans here: widening them by the skew would make back-to-back sessions disown each other.
  const whileAnotherRan = (createdAt: number) =>
    others.some((other) => createdAt >= other.startedAt && createdAt <= (other.endedAt ?? now));
  const candidates = conversations.filter(
    (conversation) =>
      !claimed.has(conversation.id) &&
      conversation.createdAt >= from &&
      conversation.createdAt <= to &&
      !whileAnotherRan(conversation.createdAt),
  );
  return (
    candidates.reduce<OpencodeConversation | null>(
      (newest, conversation) =>
        newest === null || conversation.updatedAt > newest.updatedAt ? conversation : newest,
      null,
    )?.id ?? null
  );
};
