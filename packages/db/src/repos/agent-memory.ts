import { createHash } from "node:crypto";

import type { ProjectId } from "@mend/domain";
import {
  AGENT_MEMORY_MAX_BYTES,
  AGENT_MEMORY_MAX_FILE_BYTES,
  AGENT_MEMORY_MAX_FILES,
  AgentMemoryEntry,
  agentMemoryNameOf,
  piProfileFileBytes,
  validateAgentMemoryPath,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { agentMemoryFiles, agentMemoryVersions } from "../schema/workbench.ts";

/**
 * Each person's agent memory per project (docs/adr/0009-agent-memory-per-person-per-project.md):
 * what a session receives at launch, and what it saved when its agent ended. Every version Mend
 * replaces or deletes is kept (the newest `VERSIONS_KEPT` per file), so a save never loses what
 * another session wrote.
 */

type MemoryFile = {
  readonly path: string;
  readonly encoding: "utf8" | "base64";
  readonly contents: string;
};

/** A stored memory file, as the read-back rules see it. */
export interface StoredMemoryFile extends MemoryFile {
  readonly digest: string;
  readonly updatedBySession: string | null;
}

const VERSIONS_KEPT = 20;

/** The SHA-256 of a file's bytes: what the session's delivery program records for it on disk. */
export const agentMemoryDigest = (file: Pick<MemoryFile, "encoding" | "contents">): string =>
  createHash("sha256")
    .update(piProfileFileBytes(file) ?? new Uint8Array())
    .digest("hex");

/** One thing a read-back does to the store. */
export type ReadBackStep =
  | {
      readonly kind: "save";
      readonly file: MemoryFile;
      readonly replacing: StoredMemoryFile | null;
    }
  | {
      readonly kind: "merge";
      readonly file: MemoryFile;
      readonly stored: StoredMemoryFile;
      /** The delivered version's digest, or null for a file the session made itself. */
      readonly base: string | null;
    }
  | { readonly kind: "delete"; readonly stored: StoredMemoryFile };

/**
 * What a session's memory, read back when its agent ended, does to the store (docs/adr/0009,
 * decision 3). `delivered` is what the session received (path to digest); a file the session did
 * not change since is not saved again, so another session's later save of it stands.
 *
 * - A file the session added or changed is saved when the store has not changed it since delivery,
 *   or changed it only through this session's own earlier read-back.
 * - When both changed it, text is merged; anything else takes the session's, and the stored one is
 *   kept as a version.
 * - A delivered file the session deleted is deleted, unless the store changed it meanwhile.
 */
export const planAgentMemoryReadBack = (input: {
  readonly delivered: Readonly<Record<string, string>>;
  readonly session: ReadonlyArray<MemoryFile & { readonly digest: string }>;
  readonly stored: ReadonlyMap<string, StoredMemoryFile>;
  readonly sessionId: string;
}): ReadonlyArray<ReadBackStep> => {
  const steps: Array<ReadBackStep> = [];
  const has = (path: string) => Object.hasOwn(input.delivered, path);
  for (const file of input.session) {
    const base = has(file.path) ? (input.delivered[file.path] ?? null) : null;
    if (base === file.digest) continue;
    const stored = input.stored.get(file.path) ?? null;
    const bare = { path: file.path, encoding: file.encoding, contents: file.contents };
    if (stored === null) {
      steps.push({ kind: "save", file: bare, replacing: null });
      continue;
    }
    if (stored.digest === file.digest) continue;
    if (stored.digest === base || stored.updatedBySession === input.sessionId) {
      steps.push({ kind: "save", file: bare, replacing: stored });
      continue;
    }
    steps.push(
      file.encoding === "utf8" && stored.encoding === "utf8"
        ? { kind: "merge", file: bare, stored, base }
        : { kind: "save", file: bare, replacing: stored },
    );
  }
  const read = new Set(input.session.map((file) => file.path));
  for (const [path, digest] of Object.entries(input.delivered)) {
    if (read.has(path)) continue;
    const stored = input.stored.get(path);
    if (stored !== undefined && stored.digest === digest) steps.push({ kind: "delete", stored });
  }
  return steps;
};

/** What one read-back did, path by path. */
export interface AgentMemoryReadBack {
  readonly saved: ReadonlyArray<string>;
  readonly merged: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  /** Files the session holds that Mend does not store: outside the limits. */
  readonly skipped: ReadonlyArray<string>;
}

export interface AgentMemoryImportReport {
  readonly added: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  readonly conflicting: ReadonlyArray<string>;
}

/** Merges three versions of a text file; the session engine supplies it (`git merge-file`). */
export type MergeText = (input: {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}) => Effect.Effect<string>;

export class AgentMemoryRepo extends Context.Service<
  AgentMemoryRepo,
  {
    /** Every stored file, with contents: what a session receives at launch. */
    readonly forLaunch: (
      userId: string,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<StoredMemoryFile>>;
    readonly list: (
      userId: string,
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<AgentMemoryEntry>>;
    readonly read: (
      userId: string,
      projectId: ProjectId,
      path: string,
    ) => Effect.Effect<{ readonly entry: AgentMemoryEntry; readonly file: MemoryFile } | null>;
    /** Remove one file; its last version is kept. Whether there was one. */
    readonly remove: (userId: string, projectId: ProjectId, path: string) => Effect.Effect<boolean>;
    /** Apply a session's memory, read back when its agent ended (`planAgentMemoryReadBack`). */
    readonly readBack: (input: {
      readonly userId: string;
      readonly projectId: ProjectId;
      readonly sessionId: string;
      readonly delivered: Readonly<Record<string, string>>;
      readonly session: ReadonlyArray<MemoryFile>;
      readonly merge: MergeText;
    }) => Effect.Effect<AgentMemoryReadBack>;
    /** Files from the person's own machine: added where absent, never replacing a stored file. */
    readonly importFiles: (
      userId: string,
      projectId: ProjectId,
      files: ReadonlyArray<MemoryFile>,
    ) => Effect.Effect<AgentMemoryImportReport>;
  }
>()("@mend/db/AgentMemoryRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;

const toEntry = (row: typeof agentMemoryFiles.$inferSelect): AgentMemoryEntry => {
  const named = agentMemoryNameOf(row.path);
  return new AgentMemoryEntry({
    path: row.path,
    harness: named?.harness ?? "unknown",
    name: named?.name ?? row.path,
    bytes: row.bytes,
    digest: row.digest,
    updatedAt: row.updatedAt,
    updatedBySession: row.updatedBySession,
  });
};

const toStored = (row: typeof agentMemoryFiles.$inferSelect): StoredMemoryFile => ({
  path: row.path,
  encoding: row.encoding,
  contents: row.contents,
  digest: row.digest,
  updatedBySession: row.updatedBySession,
});

/** A file Mend stores: a memory path, and within the per-file limit. */
const storable = (file: MemoryFile): boolean =>
  validateAgentMemoryPath(file.path) === null &&
  (piProfileFileBytes(file)?.byteLength ?? Number.POSITIVE_INFINITY) <= AGENT_MEMORY_MAX_FILE_BYTES;

/** One person's memory in one project. */
const of = (userId: string, projectId: ProjectId) =>
  and(eq(agentMemoryFiles.userId, userId), eq(agentMemoryFiles.projectId, projectId));

/** One read-back, import or removal at a time per person and project. */
const lock = (tx: Tx, userId: string, projectId: ProjectId) =>
  tx
    .execute(
      sql`select pg_advisory_xact_lock(hashtext(${`mend:agent-memory:${userId}:${projectId}`}))`,
    )
    .pipe(Effect.orDie);

/** The files Mend stores out of `files`, in order, within the count and total-size limits. */
const withinLimits = <F extends MemoryFile>(files: ReadonlyArray<F>): ReadonlyArray<F> => {
  const kept: Array<F> = [];
  let total = 0;
  for (const file of files) {
    if (!storable(file) || kept.length >= AGENT_MEMORY_MAX_FILES) continue;
    const bytes = piProfileFileBytes(file)?.byteLength ?? 0;
    if (total + bytes > AGENT_MEMORY_MAX_BYTES) continue;
    total += bytes;
    kept.push(file);
  }
  return kept;
};

export const AgentMemoryRepoLive: Layer.Layer<AgentMemoryRepo, never, MendDB> = Layer.effect(
  AgentMemoryRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;
    /** Keep `stored` as a version, and only the newest few of its path. */
    const keepVersion = (tx: Tx, userId: string, projectId: ProjectId, stored: StoredMemoryFile) =>
      Effect.gen(function* () {
        yield* tx
          .insert(agentMemoryVersions)
          .values({
            userId,
            projectId,
            path: stored.path,
            digest: stored.digest,
            encoding: stored.encoding,
            contents: stored.contents,
          })
          .onConflictDoUpdate({
            target: [
              agentMemoryVersions.userId,
              agentMemoryVersions.projectId,
              agentMemoryVersions.path,
              agentMemoryVersions.digest,
            ],
            set: { savedAt: new Date() },
          })
          .pipe(Effect.orDie);
        yield* tx
          .execute(
            sql`delete from agent_memory_versions where user_id = ${userId} and project_id = ${projectId}
              and path = ${stored.path} and digest not in (
                select digest from agent_memory_versions where user_id = ${userId}
                  and project_id = ${projectId} and path = ${stored.path}
                order by saved_at desc limit ${VERSIONS_KEPT})`,
          )
          .pipe(Effect.orDie);
      });

    const write = (
      tx: Tx,
      userId: string,
      projectId: ProjectId,
      file: MemoryFile,
      sessionId: string | null,
    ) => {
      const values = {
        encoding: file.encoding,
        contents: file.contents,
        digest: agentMemoryDigest(file),
        bytes: piProfileFileBytes(file)?.byteLength ?? 0,
        updatedAt: new Date(),
        updatedBySession: sessionId,
      };
      return tx
        .insert(agentMemoryFiles)
        .values({ userId, projectId, path: file.path, ...values })
        .onConflictDoUpdate({
          target: [agentMemoryFiles.userId, agentMemoryFiles.projectId, agentMemoryFiles.path],
          set: values,
        })
        .pipe(Effect.orDie);
    };

    const forLaunch = Effect.fn("AgentMemoryRepo.forLaunch")(function* (
      userId: string,
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(agentMemoryFiles)
        .where(of(userId, projectId))
        .orderBy(asc(agentMemoryFiles.path))
        .pipe(Effect.orDie);
      return rows.map(toStored);
    });

    const list = Effect.fn("AgentMemoryRepo.list")(function* (
      userId: string,
      projectId: ProjectId,
    ) {
      const rows = yield* db
        .select()
        .from(agentMemoryFiles)
        .where(of(userId, projectId))
        .orderBy(desc(agentMemoryFiles.updatedAt), asc(agentMemoryFiles.path))
        .pipe(Effect.orDie);
      return rows.map(toEntry);
    });

    const read = Effect.fn("AgentMemoryRepo.read")(function* (
      userId: string,
      projectId: ProjectId,
      path: string,
    ) {
      const [row] = yield* db
        .select()
        .from(agentMemoryFiles)
        .where(and(of(userId, projectId), eq(agentMemoryFiles.path, path)))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined
        ? null
        : {
            entry: toEntry(row),
            file: { path: row.path, encoding: row.encoding, contents: row.contents },
          };
    });

    const remove = Effect.fn("AgentMemoryRepo.remove")(function* (
      userId: string,
      projectId: ProjectId,
      path: string,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId, projectId);
            const [row] = yield* tx
              .select()
              .from(agentMemoryFiles)
              .where(and(of(userId, projectId), eq(agentMemoryFiles.path, path)))
              .pipe(Effect.orDie);
            if (row === undefined) return false;
            yield* keepVersion(tx, userId, projectId, toStored(row));
            yield* tx
              .delete(agentMemoryFiles)
              .where(and(of(userId, projectId), eq(agentMemoryFiles.path, path)))
              .pipe(Effect.orDie);
            return true;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const readBack = Effect.fn("AgentMemoryRepo.readBack")(function* (input: {
      readonly userId: string;
      readonly projectId: ProjectId;
      readonly sessionId: string;
      readonly delivered: Readonly<Record<string, string>>;
      readonly session: ReadonlyArray<MemoryFile>;
      readonly merge: MergeText;
    }) {
      const { userId, projectId, sessionId } = input;
      const kept = withinLimits(input.session);
      const keptPaths = new Set(kept.map((file) => file.path));
      const skipped = input.session.map((file) => file.path).filter((p) => !keptPaths.has(p));
      // A file read back but not storable is not "deleted in the session".
      const session = kept.map((file) => ({ ...file, digest: agentMemoryDigest(file) }));
      const delivered = Object.fromEntries(
        Object.entries(input.delivered).filter(([path]) => !skipped.includes(path)),
      );
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId, projectId);
            const rows = yield* tx
              .select()
              .from(agentMemoryFiles)
              .where(of(userId, projectId))
              .pipe(Effect.orDie);
            const stored = new Map(rows.map((row) => [row.path, toStored(row)] as const));
            const steps = planAgentMemoryReadBack({ delivered, session, stored, sessionId });
            const saved: Array<string> = [];
            const merged: Array<string> = [];
            const deleted: Array<string> = [];
            for (const step of steps) {
              if (step.kind === "delete") {
                yield* keepVersion(tx, userId, projectId, step.stored);
                yield* tx
                  .delete(agentMemoryFiles)
                  .where(and(of(userId, projectId), eq(agentMemoryFiles.path, step.stored.path)))
                  .pipe(Effect.orDie);
                deleted.push(step.stored.path);
                continue;
              }
              if (step.kind === "save") {
                if (step.replacing !== null) {
                  yield* keepVersion(tx, userId, projectId, step.replacing);
                }
                yield* write(tx, userId, projectId, step.file, sessionId);
                saved.push(step.file.path);
                continue;
              }
              const [base] =
                step.base === null
                  ? []
                  : yield* tx
                      .select({ contents: agentMemoryVersions.contents })
                      .from(agentMemoryVersions)
                      .where(
                        and(
                          eq(agentMemoryVersions.userId, userId),
                          eq(agentMemoryVersions.projectId, projectId),
                          eq(agentMemoryVersions.path, step.file.path),
                          eq(agentMemoryVersions.digest, step.base),
                        ),
                      )
                      .pipe(Effect.orDie);
              const contents = yield* input.merge({
                base: base?.contents ?? "",
                ours: step.stored.contents,
                theirs: step.file.contents,
              });
              yield* keepVersion(tx, userId, projectId, step.stored);
              yield* write(
                tx,
                userId,
                projectId,
                { path: step.file.path, encoding: "utf8", contents },
                sessionId,
              );
              merged.push(step.file.path);
            }
            return { saved, merged, deleted, skipped };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const importFiles = Effect.fn("AgentMemoryRepo.importFiles")(function* (
      userId: string,
      projectId: ProjectId,
      files: ReadonlyArray<MemoryFile>,
    ) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId, projectId);
            const rows = yield* tx
              .select()
              .from(agentMemoryFiles)
              .where(of(userId, projectId))
              .pipe(Effect.orDie);
            const stored = new Map(rows.map((row) => [row.path, row.digest] as const));
            const added: Array<string> = [];
            const unchanged: Array<string> = [];
            const conflicting: Array<string> = [];
            for (const file of withinLimits(files)) {
              const digest = stored.get(file.path);
              if (digest === undefined) {
                if (stored.size + added.length >= AGENT_MEMORY_MAX_FILES) break;
                yield* write(tx, userId, projectId, file, null);
                added.push(file.path);
              } else if (digest === agentMemoryDigest(file)) unchanged.push(file.path);
              else conflicting.push(file.path);
            }
            return { added, unchanged, conflicting };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return { forLaunch, list, read, remove, readBack, importFiles };
  }),
);
