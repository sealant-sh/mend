import { createHash } from "node:crypto";

import type { ProjectId } from "@mend/domain";
import {
  AGENT_MEMORY_MAX_BYTES,
  agentMemoryMaxFileBytes,
  AGENT_MEMORY_MAX_FILES,
  AgentMemoryEntry,
  type AgentMemoryImportMerge,
  type AgentMemoryImportSource,
  agentMemoryNameOf,
  CODEX_MEMORY_DATABASE,
  isAgentMemoryIndex,
  joinFrontmatter,
  mergeFrontmatterLines,
  piProfileFileBytes,
  splitFrontmatter,
  missingLines,
  unionLines,
  validateAgentMemoryPath,
  withoutRepeatedEntries,
} from "@mend/domain/workbench";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import {
  agentMemoryFiles,
  agentMemoryImportBases,
  agentMemoryVersions,
} from "../schema/workbench.ts";

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

/** What `mend memory import` last imported from one checkout on one machine, for one file. */
export interface AgentMemoryImportBase {
  readonly path: string;
  readonly digest: string;
  /** A text file's contents; null for a binary one. */
  readonly contents: string | null;
}

/** One thing an import does to the store (docs/adr/0009, decision 4). */
export type ImportStep =
  | { readonly kind: "add"; readonly file: DigestedFile }
  | { readonly kind: "unchanged"; readonly file: DigestedFile }
  | { readonly kind: "update"; readonly file: DigestedFile; readonly replacing: StoredMemoryFile }
  | { readonly kind: "keepStored"; readonly file: DigestedFile }
  | { readonly kind: "removedInMend"; readonly file: DigestedFile }
  | {
      readonly kind: "merge";
      readonly file: DigestedFile;
      readonly stored: StoredMemoryFile;
      /** What this machine sent last time, when it was text; null for no shared version. */
      readonly base: string | null;
    }
  | {
      readonly kind: "mergeDatabase";
      readonly file: DigestedFile;
      readonly stored: StoredMemoryFile;
    }
  | { readonly kind: "conflict"; readonly file: DigestedFile; readonly stored: StoredMemoryFile };

type DigestedFile = MemoryFile & { readonly digest: string };

/**
 * What files from a person's machine do to the store (docs/adr/0009, decision 4). `bases` is what
 * Mend last imported from the same checkout on the same machine; empty the first time, or from a
 * CLI that does not say where it runs. Nothing either side wrote is dropped:
 *
 * - A file Mend does not have is added, unless Mend removed it since the last import and this
 *   machine has not changed it since: then it is not added again.
 * - A file one side changed since the last import takes that side's.
 * - A file both changed, or any differing file with no last import, is merged: text keeping both
 *   sides' lines (three-way against the last import when there is one), Codex's summary database
 *   by conversation. Anything else is a conflict: Mend's stays.
 *
 * A file Mend has and this machine no longer sends is left in Mend.
 */
export const planAgentMemoryImport = (input: {
  readonly files: ReadonlyArray<DigestedFile>;
  readonly stored: ReadonlyMap<string, StoredMemoryFile>;
  readonly bases: ReadonlyMap<string, AgentMemoryImportBase>;
}): ReadonlyArray<ImportStep> =>
  input.files.map((file): ImportStep => {
    const stored = input.stored.get(file.path);
    const base = input.bases.get(file.path);
    if (stored === undefined) {
      return base?.digest === file.digest ? { kind: "removedInMend", file } : { kind: "add", file };
    }
    if (stored.digest === file.digest) return { kind: "unchanged", file };
    if (base?.digest === file.digest) return { kind: "keepStored", file };
    if (base?.digest === stored.digest) return { kind: "update", file, replacing: stored };
    if (file.encoding === "utf8" && stored.encoding === "utf8") {
      return { kind: "merge", file, stored, base: base?.contents ?? null };
    }
    if (file.path === CODEX_MEMORY_DATABASE && file.encoding === stored.encoding) {
      return { kind: "mergeDatabase", file, stored };
    }
    return { kind: "conflict", file, stored };
  });

/** What an import did, or would do (`AgentMemoryImported` on the wire). */
export interface AgentMemoryImportReport {
  readonly added: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly merged: ReadonlyArray<{
    readonly path: string;
    readonly against: AgentMemoryImportMerge["against"];
    readonly missingLines: number;
  }>;
  readonly keptStored: ReadonlyArray<string>;
  readonly removedInMend: ReadonlyArray<string>;
  readonly conflicting: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/** A report's list, as an import fills it in. */
type Mutable<K extends keyof AgentMemoryImportReport> = Array<AgentMemoryImportReport[K][number]>;

/** Merges three versions of a text file; the session engine supplies it (`git merge-file`). */
export type MergeText = (input: {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
}) => Effect.Effect<string>;

/**
 * Merges two of Codex's summary databases, each conversation's newer summary from either; the
 * server supplies it (SQLite). Null when the two cannot be merged (another schema, not a database).
 */
export type MergeDatabase = (input: {
  readonly ours: Uint8Array;
  readonly theirs: Uint8Array;
}) => Effect.Effect<Uint8Array | null>;

/**
 * What merging two versions of a memory file gave:
 * - `merged`: the contents, and the lines of `theirs` they do not hold (`missingLines`); when there
 *   are any, the caller keeps `theirs` whole as a version and says so;
 * - `unmergeable`: frontmatter outside the subset merged by key that differs, or files too
 *   different to align with no shared version. The caller keeps both whole.
 */
export type AgentMemoryTextMerge =
  | { readonly kind: "merged"; readonly contents: string; readonly missing: ReadonlyArray<string> }
  | { readonly kind: "unmergeable" };

/** Text with LF line endings: how a merge compares lines. */
const lf = (text: string) => text.replaceAll("\r\n", "\n");

/**
 * Two versions of a memory file merged keeping both sides' lines (docs/adr/0009): three-way with
 * `merge` against `base`, else `unionLines`. Frontmatter on both sides is merged key by key, so a
 * union never writes a key twice; a key both set differently keeps `ours` and notes `theirs` as a
 * comment (`note`). An index (`MEMORY.md`) keeps each entry once. Line endings are compared as
 * LF; the result keeps `ours`' (CRLF when `ours` has any).
 */
export const mergeAgentMemoryText = (input: {
  readonly path: string;
  readonly ours: string;
  readonly theirs: string;
  /** The shared version; null (or empty) for none. */
  readonly base: string | null;
  readonly note: string;
  readonly merge: MergeText;
}): Effect.Effect<AgentMemoryTextMerge> =>
  Effect.gen(function* () {
    const crlf = input.ours.includes("\r\n");
    const oursText = lf(input.ours);
    const theirsText = lf(input.theirs);
    const baseText = input.base === null || input.base === "" ? null : lf(input.base);
    const lines = (ours: string, theirs: string, base: string | null) =>
      base === null || base === ""
        ? Effect.succeed(unionLines(ours, theirs))
        : input.merge({ base, ours, theirs });
    const index = (text: string) =>
      isAgentMemoryIndex(input.path) ? withoutRepeatedEntries(text) : text;
    const ours = splitFrontmatter(oursText);
    const theirs = splitFrontmatter(theirsText);
    const base = baseText === null ? null : splitFrontmatter(baseText);
    let merged: string | null;
    if (ours !== null && theirs !== null) {
      const front = mergeFrontmatterLines({
        ours: ours.lines,
        theirs: theirs.lines,
        base: base?.lines ?? null,
        note: input.note,
      });
      const body =
        front === null ? null : yield* lines(ours.body, theirs.body, base?.body ?? baseText);
      merged =
        front === null || body === null
          ? null
          : joinFrontmatter({ lines: front, body: index(body) });
    } else {
      const whole = yield* lines(oursText, theirsText, baseText);
      merged = whole === null ? null : index(whole);
    }
    if (merged === null) return { kind: "unmergeable" };
    const missing = missingLines({
      path: input.path,
      merged,
      theirs: theirsText,
      ours: oursText,
      base: baseText,
    });
    return { kind: "merged", contents: crlf ? merged.replaceAll("\n", "\r\n") : merged, missing };
  });

/** `from <who>, <yyyy-mm-dd>`: who the second side of a merge came from, as its notes say. */
const mergeNote = (who: string, at: Date) => `from ${who}, ${at.toISOString().slice(0, 10)}`;

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
    /**
     * Files from the person's own machine (`planAgentMemoryImport`). With a `source`, what was
     * imported is recorded as the next import's shared version. A dry run plans, merges and
     * writes nothing.
     */
    readonly importFiles: (input: {
      readonly userId: string;
      readonly projectId: ProjectId;
      readonly files: ReadonlyArray<MemoryFile>;
      readonly source: Pick<AgentMemoryImportSource, "id" | "label"> | null;
      readonly dryRun: boolean;
      readonly merge: MergeText;
      readonly mergeDatabase: MergeDatabase;
    }) => Effect.Effect<AgentMemoryImportReport>;
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
  (piProfileFileBytes(file)?.byteLength ?? Number.POSITIVE_INFINITY) <=
    agentMemoryMaxFileBytes(file.path);

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
              // A file the session made itself, or whose delivered version is no longer kept, has
              // no shared version: both sides' lines, each shared one once.
              const outcome = yield* mergeAgentMemoryText({
                path: step.file.path,
                ours: step.stored.contents,
                theirs: step.file.contents,
                base: base?.contents ?? null,
                note: mergeNote(`session ${sessionId.slice(0, 8)}`, new Date()),
                merge: input.merge,
              });
              yield* keepVersion(tx, userId, projectId, step.stored);
              if (outcome.kind === "unmergeable") {
                // As for a file that is not text: the session's, with the stored one kept.
                yield* write(tx, userId, projectId, step.file, sessionId);
                saved.push(step.file.path);
                continue;
              }
              if (outcome.missing.length > 0) {
                // The merge does not hold every line the session wrote: its file is kept whole.
                yield* keepVersion(tx, userId, projectId, {
                  ...step.file,
                  digest: agentMemoryDigest(step.file),
                  updatedBySession: sessionId,
                });
              }
              yield* write(
                tx,
                userId,
                projectId,
                { path: step.file.path, encoding: "utf8", contents: outcome.contents },
                sessionId,
              );
              merged.push(step.file.path);
            }
            return { saved, merged, deleted, skipped };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const importFiles = Effect.fn("AgentMemoryRepo.importFiles")(function* (input: {
      readonly userId: string;
      readonly projectId: ProjectId;
      readonly files: ReadonlyArray<MemoryFile>;
      readonly source: Pick<AgentMemoryImportSource, "id" | "label"> | null;
      readonly dryRun: boolean;
      readonly merge: MergeText;
      readonly mergeDatabase: MergeDatabase;
    }) {
      const { userId, projectId, source, dryRun } = input;
      // The API refuses these (AgentMemoryImportInvalid); every file is planned against one
      // snapshot of the store, so a path named twice would be written twice.
      if (new Set(input.files.map((file) => file.path)).size !== input.files.length) {
        return yield* Effect.die(new Error("an agent memory import names a path twice"));
      }
      const kept = withinLimits(input.files);
      const keptPaths = new Set(kept.map((file) => file.path));
      const files = kept.map((file) => ({ ...file, digest: agentMemoryDigest(file) }));
      const note = mergeNote(source?.label ?? "an import", new Date());
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
            const baseRows =
              source === null
                ? []
                : yield* tx
                    .select()
                    .from(agentMemoryImportBases)
                    .where(
                      and(
                        eq(agentMemoryImportBases.userId, userId),
                        eq(agentMemoryImportBases.projectId, projectId),
                        eq(agentMemoryImportBases.source, source.id),
                      ),
                    )
                    .pipe(Effect.orDie);
            const bases = new Map(
              baseRows.map((row) => [
                row.path,
                {
                  path: row.path,
                  digest: row.digest,
                  contents: row.encoding === "utf8" ? row.contents : null,
                },
              ]),
            );
            const steps = planAgentMemoryImport({ files, stored, bases });
            const report: { readonly [K in keyof AgentMemoryImportReport]: Mutable<K> } = {
              added: [],
              unchanged: [],
              updated: [],
              merged: [],
              keptStored: [],
              removedInMend: [],
              conflicting: [],
              skipped: input.files.map((file) => file.path).filter((p) => !keptPaths.has(p)),
            };
            /** Writes, skipped on a dry run. */
            const apply = <A>(effect: Effect.Effect<A>) => (dryRun ? Effect.void : effect);
            /** This file is now what the store holds from this machine: the next import's base. */
            const recordBase = (file: DigestedFile) =>
              source === null || bases.get(file.path)?.digest === file.digest
                ? Effect.void
                : apply(
                    tx
                      .insert(agentMemoryImportBases)
                      .values({
                        userId,
                        projectId,
                        source: source.id,
                        path: file.path,
                        digest: file.digest,
                        encoding: file.encoding,
                        contents: file.encoding === "utf8" ? file.contents : null,
                      })
                      .onConflictDoUpdate({
                        target: [
                          agentMemoryImportBases.userId,
                          agentMemoryImportBases.projectId,
                          agentMemoryImportBases.source,
                          agentMemoryImportBases.path,
                        ],
                        set: {
                          digest: file.digest,
                          encoding: file.encoding,
                          contents: file.encoding === "utf8" ? file.contents : null,
                          importedAt: new Date(),
                        },
                      })
                      .pipe(Effect.orDie),
                  );
            /** Mend's stays; this machine's is kept as a version, and its base is not moved. */
            const conflict = (file: DigestedFile) =>
              Effect.gen(function* () {
                yield* apply(
                  keepVersion(tx, userId, projectId, { ...file, updatedBySession: null }),
                );
                report.conflicting.push(file.path);
              });
            /** Both sides' contents become `merged`; each is kept as a version. */
            const replaceMerged = (
              step: { file: DigestedFile; stored: StoredMemoryFile },
              merged: MemoryFile,
            ) =>
              apply(
                Effect.gen(function* () {
                  yield* keepVersion(tx, userId, projectId, step.stored);
                  yield* keepVersion(tx, userId, projectId, {
                    ...step.file,
                    updatedBySession: null,
                  });
                  yield* write(tx, userId, projectId, merged, null);
                }),
              );
            let count = stored.size;
            for (const step of steps) {
              const { file } = step;
              switch (step.kind) {
                case "add": {
                  if (count >= AGENT_MEMORY_MAX_FILES) {
                    report.skipped.push(file.path);
                    break;
                  }
                  count += 1;
                  yield* apply(write(tx, userId, projectId, file, null));
                  yield* recordBase(file);
                  report.added.push(file.path);
                  break;
                }
                case "unchanged": {
                  yield* recordBase(file);
                  report.unchanged.push(file.path);
                  break;
                }
                case "update": {
                  yield* apply(keepVersion(tx, userId, projectId, step.replacing));
                  yield* apply(write(tx, userId, projectId, file, null));
                  yield* recordBase(file);
                  report.updated.push(file.path);
                  break;
                }
                case "keepStored": {
                  report.keptStored.push(file.path);
                  break;
                }
                case "removedInMend": {
                  report.removedInMend.push(file.path);
                  break;
                }
                case "merge": {
                  const outcome = yield* mergeAgentMemoryText({
                    path: file.path,
                    ours: step.stored.contents,
                    theirs: file.contents,
                    base: step.base,
                    note,
                    merge: input.merge,
                  });
                  const merged =
                    outcome.kind === "merged"
                      ? { path: file.path, encoding: "utf8" as const, contents: outcome.contents }
                      : null;
                  if (outcome.kind === "unmergeable" || merged === null || !storable(merged)) {
                    yield* conflict(file);
                    break;
                  }
                  if (merged.contents !== step.stored.contents) yield* replaceMerged(step, merged);
                  else if (outcome.missing.length > 0) {
                    yield* apply(
                      keepVersion(tx, userId, projectId, { ...file, updatedBySession: null }),
                    );
                  }
                  // A merge that does not hold every line this machine sent keeps its file as a
                  // version and does not move the base: the next import merges and says so again.
                  if (outcome.missing.length === 0) yield* recordBase(file);
                  report.merged.push({
                    path: file.path,
                    against:
                      step.base === null || step.base === "" ? "no-shared-version" : "last-import",
                    missingLines: outcome.missing.length,
                  });
                  break;
                }
                case "mergeDatabase": {
                  const bytes = yield* input.mergeDatabase({
                    ours: piProfileFileBytes(step.stored) ?? new Uint8Array(),
                    theirs: piProfileFileBytes(file) ?? new Uint8Array(),
                  });
                  const merged =
                    bytes === null
                      ? null
                      : {
                          path: file.path,
                          encoding: "base64" as const,
                          contents: Buffer.from(bytes).toString("base64"),
                        };
                  if (merged === null || !storable(merged)) {
                    yield* conflict(file);
                    break;
                  }
                  yield* replaceMerged(step, merged);
                  yield* recordBase(file);
                  report.merged.push({ path: file.path, against: "summaries", missingLines: 0 });
                  break;
                }
                case "conflict": {
                  yield* conflict(file);
                  break;
                }
              }
            }
            return report;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return { forLaunch, list, read, remove, readBack, importFiles };
  }),
);
