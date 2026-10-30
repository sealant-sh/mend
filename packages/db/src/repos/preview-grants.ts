import { createHash, randomBytes } from "node:crypto";

import type { OrganizationId, PreviewId } from "@mend/domain";
import type { OrganizationRole, ProjectTenancy } from "@mend/domain/workbench";
import { and, asc, eq, gt, inArray, not, sql } from "drizzle-orm";
import { Context, DateTime, Effect, Layer, Redacted, Schema } from "effect";

import { MendDB } from "../client.ts";
import { organizationMembers, previewGrants, previews, projects } from "../schema/workbench.ts";
import { credentialStanding } from "./credential-standing.ts";
import { projectListed } from "./projects.ts";
import { isTicketCredential, type TicketCredential } from "./upgrade-tickets.ts";

const GRANT_PATTERN = /^mpg_[A-Za-z0-9_-]{43}$/;

export type PreviewGrantSecret = Redacted.Redacted<string>;

export const isPreviewGrantSecret = (value: string): boolean => GRANT_PATTERN.test(value);

const hashGrant = (grant: PreviewGrantSecret): string =>
  createHash("sha256").update(Redacted.value(grant), "utf8").digest("hex");

export interface PreviewGrantSubject {
  readonly userId: string;
  readonly credential: TicketCredential;
}

export interface PreviewGrantStanding {
  readonly subject: PreviewGrantSubject;
  readonly previewKept: boolean;
  readonly membership: {
    readonly organizationId: OrganizationId;
    readonly role: OrganizationRole;
  } | null;
  readonly project: ProjectTenancy;
}

export interface PreviewGrantKey {
  readonly grant: PreviewGrantSecret;
  readonly previewId: PreviewId;
  readonly origin: string;
}

export class PreviewGrantStorageError extends Schema.TaggedError<PreviewGrantStorageError>()(
  "PreviewGrantStorageError",
  { operation: Schema.Literals(["create", "standing", "cleanup"]), cause: Schema.Defect() },
) {}

export class PreviewGrantsRepo extends Context.Service<
  PreviewGrantsRepo,
  {
    readonly create: (input: {
      readonly subject: PreviewGrantSubject;
      readonly previewId: PreviewId;
      readonly origin: string;
    }) => Effect.Effect<PreviewGrantSecret, PreviewGrantStorageError>;
    readonly standing: (
      keys: ReadonlyArray<PreviewGrantKey>,
    ) => Effect.Effect<ReadonlyArray<PreviewGrantStanding | null>, PreviewGrantStorageError>;
    readonly cleanup: (options?: {
      readonly batch?: number;
    }) => Effect.Effect<number, PreviewGrantStorageError>;
  }
>()("@mend/db/PreviewGrantsRepo") {}

const grantStands = (now: Date) => sql<boolean>`(
  ${credentialStanding(previewGrants.credential, now, previewGrants.userId)}
  AND EXISTS (SELECT 1 FROM "user" u
    WHERE u.id = ${previewGrants.userId} AND u."deactivatedAt" IS NULL))`;

const previewKept = sql<boolean>`EXISTS (SELECT 1 FROM previews p
  WHERE p.id = ${previewGrants.previewId} AND p.worktree_id IS NOT NULL)`;

const failed =
  (operation: PreviewGrantStorageError["operation"]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new PreviewGrantStorageError({ operation, cause })));

export const PreviewGrantsRepoLive: Layer.Layer<PreviewGrantsRepo, never, MendDB> = Layer.effect(
  PreviewGrantsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const create = Effect.fn("PreviewGrantsRepo.create")(function* (input: {
      readonly subject: PreviewGrantSubject;
      readonly previewId: PreviewId;
      readonly origin: string;
    }) {
      const grant = Redacted.make(`mpg_${randomBytes(32).toString("base64url")}`);
      yield* db
        .insert(previewGrants)
        .values({
          tokenHash: hashGrant(grant),
          previewId: input.previewId,
          origin: input.origin,
          userId: input.subject.userId,
          credential: input.subject.credential,
        })
        .pipe(failed("create"));
      return grant;
    });

    const standing = Effect.fn("PreviewGrantsRepo.standing")(function* (
      keys: ReadonlyArray<PreviewGrantKey>,
    ) {
      if (keys.length === 0) return [];
      const now = yield* DateTime.nowAsDate;
      const hashes = keys.map((key) => hashGrant(key.grant));
      const rows = yield* db
        .select({
          tokenHash: previewGrants.tokenHash,
          previewId: previewGrants.previewId,
          origin: previewGrants.origin,
          userId: previewGrants.userId,
          credential: previewGrants.credential,
          worktreeId: previews.worktreeId,
          memberOf: organizationMembers.organizationId,
          role: organizationMembers.role,
          projectOrganizationId: projects.organizationId,
          visibility: projects.visibility,
          createdByUserId: projects.createdByUserId,
        })
        .from(previewGrants)
        .innerJoin(previews, eq(previews.id, previewGrants.previewId))
        .innerJoin(projects, and(projectListed, eq(projects.id, previews.projectId)))
        .leftJoin(organizationMembers, eq(organizationMembers.userId, previewGrants.userId))
        .where(and(inArray(previewGrants.tokenHash, [...new Set(hashes)]), grantStands(now)))
        .pipe(failed("standing"));
      const byHash = new Map(rows.map((row) => [row.tokenHash, row]));
      return keys.map((key, index): PreviewGrantStanding | null => {
        const row = byHash.get(hashes[index] ?? "");
        if (
          row === undefined ||
          row.previewId !== key.previewId ||
          row.origin !== key.origin ||
          !isTicketCredential(row.credential)
        ) {
          return null;
        }
        return {
          subject: { userId: row.userId, credential: row.credential },
          previewKept: row.worktreeId !== null,
          membership:
            row.memberOf === null || row.role === null
              ? null
              : { organizationId: row.memberOf, role: row.role },
          project: {
            organizationId: row.projectOrganizationId,
            visibility: row.visibility,
            createdByUserId: row.createdByUserId,
          },
        };
      });
    });

    const cleanup = Effect.fn("PreviewGrantsRepo.cleanup")(function* (options?: {
      readonly batch?: number;
    }) {
      const batch = options?.batch ?? 500;
      const now = yield* DateTime.nowAsDate;
      let after = "";
      let removed = 0;
      for (;;) {
        const rows = yield* db
          .select({ hash: previewGrants.tokenHash })
          .from(previewGrants)
          .where(gt(previewGrants.tokenHash, after))
          .orderBy(asc(previewGrants.tokenHash))
          .limit(batch)
          .pipe(failed("cleanup"));
        const last = rows.at(-1);
        if (last === undefined) return removed;
        const deleted = yield* db
          .delete(previewGrants)
          .where(
            and(
              inArray(
                previewGrants.tokenHash,
                rows.map((row) => row.hash),
              ),
              not(sql`${grantStands(now)} AND ${previewKept}`),
            ),
          )
          .returning({ hash: previewGrants.tokenHash })
          .pipe(failed("cleanup"));
        removed += deleted.length;
        if (rows.length < batch) return removed;
        after = last.hash;
      }
    });

    return { create, standing, cleanup };
  }),
);
