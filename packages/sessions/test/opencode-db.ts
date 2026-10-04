import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A top-level opencode conversation as a test writes it. */
export interface OpencodeRow {
  readonly id: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly parentId?: string;
  readonly directory?: string;
}

/**
 * A real SQLite database shaped as opencode 1.18.34 keeps its conversations (`session` in
 * `core/src/session/sql.ts`, the columns Mend reads and the ones it cannot be without), in WAL
 * mode as opencode runs it. Returns the database file's path.
 */
export const writeOpencodeDatabase = (
  file: string,
  rows: ReadonlyArray<OpencodeRow>,
  options: { readonly checkpoint?: boolean } = {},
): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("pragma journal_mode = wal");
    db.exec(
      "create table if not exists session (id text primary key, project_id text not null, " +
        "parent_id text, slug text not null, directory text not null, title text not null, " +
        "version text not null, time_created integer not null, time_updated integer not null)",
    );
    const insert = db.prepare(
      "insert into session (id, project_id, parent_id, slug, directory, title, version, " +
        "time_created, time_updated) values (?, 'global', ?, ?, ?, 'a conversation', '1.18.34', ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.parentId ?? null,
        row.id,
        row.directory ?? "/workspace/repo",
        row.createdAt,
        row.updatedAt ?? row.createdAt,
      );
    }
    if (options.checkpoint === true) db.exec("pragma wal_checkpoint(truncate)");
  } finally {
    db.close();
  }
  return file;
};
