import { createHash } from "node:crypto";

import {
  PiProfile,
  type PiProfileFile,
  piProfileExtensions,
  piProfileFileBytes,
  piProfilePackages,
  validatePiProfile,
} from "@mend/domain/workbench";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userPiProfiles } from "../schema/workbench.ts";

export class PiProfileInvalidError extends Schema.TaggedErrorClass<PiProfileInvalidError>()(
  "PiProfileInvalidError",
  { message: Schema.String },
) {}

type ProfileFile = Pick<PiProfileFile, "path" | "encoding" | "contents">;

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * One digest for a profile's files: each file's path and the SHA-256 of its bytes, sorted by path,
 * as `skillTreeDigest` does for a skill. The session's delivery program computes the same digest
 * over what is on disk (`packages/sessions/src/pi-profile.ts`), so a profile already in place is
 * left alone.
 */
export const piProfileDigest = (files: ReadonlyArray<ProfileFile>): string =>
  sha256(
    files
      .map((file) => [file.path, sha256(piProfileFileBytes(file) ?? new Uint8Array())] as const)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([file, digest]) => `${file}\u0000${digest}\n`)
      .join(""),
  );

const totalBytes = (files: ReadonlyArray<ProfileFile>): number =>
  files.reduce((sum, file) => sum + (piProfileFileBytes(file)?.byteLength ?? 0), 0);

/** A saved profile, with its files: what the launch path delivers. */
export interface PiProfileWithFiles {
  readonly profile: PiProfile;
  readonly files: ReadonlyArray<ProfileFile>;
}

/**
 * Each person's pi setup (pi-profile.ts in @mend/domain), one row per account. A save replaces the
 * whole profile; one holding exactly the saved files changes nothing, not even the revision.
 */
export class PiProfilesRepo extends Context.Service<
  PiProfilesRepo,
  {
    readonly forUser: (userId: string) => Effect.Effect<PiProfileWithFiles | null>;
    readonly save: (
      userId: string,
      files: ReadonlyArray<ProfileFile>,
    ) => Effect.Effect<
      { readonly profile: PiProfile; readonly changed: boolean },
      PiProfileInvalidError
    >;
    /** Whether there was a profile to remove. */
    readonly remove: (userId: string) => Effect.Effect<boolean>;
  }
>()("@mend/db/PiProfilesRepo") {}

const toProfile = (row: typeof userPiProfiles.$inferSelect): PiProfile =>
  new PiProfile({
    fileCount: row.files.length,
    bytes: row.bytes,
    extensions: piProfileExtensions(row.files),
    packages: piProfilePackages(row.files),
    digest: row.digest,
    revision: row.revision,
    updatedAt: row.updatedAt,
  });

const sortFiles = (files: ReadonlyArray<ProfileFile>): Array<ProfileFile> =>
  files
    .map((file) => ({ path: file.path, encoding: file.encoding, contents: file.contents }))
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

export const PiProfilesRepoLive: Layer.Layer<PiProfilesRepo, never, MendDB> = Layer.effect(
  PiProfilesRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const readRow = (userId: string) =>
      db
        .select()
        .from(userPiProfiles)
        .where(eq(userPiProfiles.userId, userId))
        .limit(1)
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows[0] ?? null),
        );

    const forUser = Effect.fn("PiProfilesRepo.forUser")(function* (userId: string) {
      const row = yield* readRow(userId);
      return row === null ? null : { profile: toProfile(row), files: row.files };
    });

    const save = Effect.fn("PiProfilesRepo.save")(function* (
      userId: string,
      input: ReadonlyArray<ProfileFile>,
    ) {
      const issue = validatePiProfile(input);
      if (issue !== null) return yield* new PiProfileInvalidError({ message: issue });
      const files = sortFiles(input);
      const digest = piProfileDigest(files);
      const existing = yield* readRow(userId);
      if (existing !== null && existing.digest === digest) {
        return { profile: toProfile(existing), changed: false };
      }
      const values = { files, digest, bytes: totalBytes(files) };
      const [row] = yield* db
        .insert(userPiProfiles)
        .values({ userId, ...values })
        .onConflictDoUpdate({
          target: userPiProfiles.userId,
          set: {
            ...values,
            revision: sql`${userPiProfiles.revision} + 1`,
            updatedAt: new Date(),
          },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("pi profile upsert returned no row");
      return { profile: toProfile(row), changed: true };
    });

    const remove = Effect.fn("PiProfilesRepo.remove")(function* (userId: string) {
      const rows = yield* db
        .delete(userPiProfiles)
        .where(eq(userPiProfiles.userId, userId))
        .returning({ userId: userPiProfiles.userId })
        .pipe(Effect.orDie);
      return rows.length > 0;
    });

    return { forUser, save, remove };
  }),
);
