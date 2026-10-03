import { SecretFileId } from "@mend/domain";
import {
  SECRET_FILE_MAX_BYTES,
  SECRET_FILE_MAX_FILES,
  SECRET_FILES_MAX_TOTAL_BYTES,
  SecretFile,
  secretFileNameOf,
  validateSecretFilePath,
} from "@mend/domain/workbench";
import { and, asc, eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB, type MendDatabase } from "../client.ts";
import { userSecretFiles } from "../schema/workbench.ts";

/** The path or the person's total is not acceptable; the message says which rule. */
export class SecretFileInvalidError extends Schema.TaggedErrorClass<SecretFileInvalidError>()(
  "SecretFileInvalidError",
  { message: Schema.String },
) {}

/** A file as the launch path needs it: its path and its SEALED content. */
export interface SealedSecretFile {
  readonly path: string;
  readonly sealedContents: string;
}

/**
 * Each person's secret files (docs/adr/0010-secret-files.md). Rows hold ciphertext only: sealing
 * and unsealing are the caller's (`@mend/store` SecretCipher), so this package never sees a
 * file's bytes. The one content-bearing read is `sealedForLaunch`, consumed once per launch.
 */
export class SecretFilesRepo extends Context.Service<
  SecretFilesRepo,
  {
    /** Paths and sizes only, by path. */
    readonly list: (userId: string) => Effect.Effect<ReadonlyArray<SecretFile>>;
    /** The launch read: every file, sealed, by path. */
    readonly sealedForLaunch: (userId: string) => Effect.Effect<ReadonlyArray<SealedSecretFile>>;
    /** Create or replace the file at `path`; `bytes` is the plaintext size the caller measured. */
    readonly save: (
      userId: string,
      input: { readonly path: string; readonly sealedContents: string; readonly bytes: number },
    ) => Effect.Effect<
      { readonly file: SecretFile; readonly action: "created" | "replaced" },
      SecretFileInvalidError
    >;
    /** Whether there was a file at `path` to remove. */
    readonly remove: (userId: string, path: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/SecretFilesRepo") {}

type Tx = Pick<MendDatabase, "select" | "insert" | "update" | "delete" | "execute">;

const toFile = (row: typeof userSecretFiles.$inferSelect): SecretFile =>
  new SecretFile({
    id: row.id,
    path: row.path,
    name: secretFileNameOf(row.path),
    bytes: row.bytes,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

/** One save or removal at a time per person: the count and total limits read what they add to. */
const lock = (tx: Tx, userId: string) =>
  tx
    .execute(sql`select pg_advisory_xact_lock(hashtext(${`mend:secret-files:${userId}`}))`)
    .pipe(Effect.orDie);

/** One person's files, by path. */
const rowsOf = (tx: Tx, userId: string) =>
  tx
    .select()
    .from(userSecretFiles)
    .where(eq(userSecretFiles.userId, userId))
    .orderBy(asc(userSecretFiles.path))
    .pipe(Effect.orDie);

export const SecretFilesRepoLive: Layer.Layer<SecretFilesRepo, never, MendDB> = Layer.effect(
  SecretFilesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("SecretFilesRepo.list")(function* (userId: string) {
      return (yield* rowsOf(db, userId)).map(toFile);
    });

    const sealedForLaunch = Effect.fn("SecretFilesRepo.sealedForLaunch")(function* (
      userId: string,
    ) {
      return (yield* rowsOf(db, userId)).map((row) => ({
        path: row.path,
        sealedContents: row.sealedContents,
      }));
    });

    const save = Effect.fn("SecretFilesRepo.save")(function* (
      userId: string,
      input: { readonly path: string; readonly sealedContents: string; readonly bytes: number },
    ) {
      const issue = validateSecretFilePath(input.path);
      if (issue !== null) return yield* new SecretFileInvalidError({ message: issue });
      // The route measured the plaintext; the row's size still has to be one a file can have.
      if (
        !Number.isInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > SECRET_FILE_MAX_BYTES
      ) {
        return yield* new SecretFileInvalidError({
          message: `a secret file is between 1 byte and ${SECRET_FILE_MAX_BYTES / 1024} KB`,
        });
      }
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId);
            const existing = yield* rowsOf(tx, userId);
            const current = existing.find((row) => row.path === input.path);
            const others = existing.filter((row) => row.path !== input.path);
            if (current === undefined && others.length + 1 > SECRET_FILE_MAX_FILES) {
              return yield* new SecretFileInvalidError({
                message: `you already keep ${SECRET_FILE_MAX_FILES} secret files, the most Mend holds per person`,
              });
            }
            const total = others.reduce((sum, row) => sum + row.bytes, 0) + input.bytes;
            if (total > SECRET_FILES_MAX_TOTAL_BYTES) {
              return yield* new SecretFileInvalidError({
                message: `your secret files would total over ${SECRET_FILES_MAX_TOTAL_BYTES / 1024} KB`,
              });
            }
            if (current === undefined) {
              const [created] = yield* tx
                .insert(userSecretFiles)
                .values({
                  id: SecretFileId.make(crypto.randomUUID()),
                  userId,
                  path: input.path,
                  sealedContents: input.sealedContents,
                  bytes: input.bytes,
                })
                .returning()
                .pipe(Effect.orDie);
              if (created === undefined)
                return yield* Effect.die("secret file insert returned no row");
              return { file: toFile(created), action: "created" as const };
            }
            const [replaced] = yield* tx
              .update(userSecretFiles)
              .set({
                sealedContents: input.sealedContents,
                bytes: input.bytes,
                revision: current.revision + 1,
                updatedAt: new Date(),
              })
              .where(eq(userSecretFiles.id, current.id))
              .returning()
              .pipe(Effect.orDie);
            if (replaced === undefined) return yield* Effect.die("secret file update lost the row");
            return { file: toFile(replaced), action: "replaced" as const };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const remove = Effect.fn("SecretFilesRepo.remove")(function* (userId: string, path: string) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* lock(tx, userId);
            const deleted = yield* tx
              .delete(userSecretFiles)
              .where(and(eq(userSecretFiles.userId, userId), eq(userSecretFiles.path, path)))
              .returning({ id: userSecretFiles.id })
              .pipe(Effect.orDie);
            return deleted.length > 0;
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return { list, sealedForLaunch, save, remove };
  }),
);
