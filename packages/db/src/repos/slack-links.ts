import { createHash, randomBytes } from "node:crypto";

import type { OrganizationId } from "@mend/domain";
import type { SlackPendingMention } from "@mend/domain/workbench";
import { and, asc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import {
  organizationMembers,
  slackInstalls,
  slackLinkCodes,
  slackLinks,
} from "../schema/workbench.ts";

/**
 * Slack links (docs/adr/0006-slack.md, "A Slack user acts only once they have linked their
 * account"). A mention from an unlinked Slack user starts nothing; Mend answers with a link code
 * instead. The code is single use and lives ten minutes, and only its sha256 is stored. The person
 * redeems it signed in to Mend, which joins that Slack user to their account and hands back the
 * mention they made, so it can run.
 */
export const SLACK_LINK_CODE_TTL_MS = 10 * 60 * 1000;

export const hashSlackLinkCode = (code: string): string =>
  createHash("sha256").update(code, "utf8").digest("hex");

/** `msl_` + 32 random bytes, base64url: recognisable in a log, and safe in a URL path. */
export const mintSlackLinkCode = (): string => `msl_${randomBytes(32).toString("base64url")}`;

/** One Slack user in one Slack workspace, joined to one Mend account. */
export interface SlackLink {
  readonly organizationId: OrganizationId;
  readonly teamId: string;
  readonly slackUserId: string;
  readonly userId: string;
  readonly createdAt: Date;
}

/** An unspent code, as the link page shows it: who in which Slack workspace is asking. */
export interface PendingSlackLink {
  readonly organizationId: OrganizationId;
  readonly teamId: string;
  readonly teamName: string;
  readonly slackUserId: string;
  readonly request: SlackPendingMention;
  readonly expiresAt: Date;
}

/** The account redeeming a code is not a member of the organization that installed the app. */
export class SlackLinkNotMemberError extends Schema.TaggedErrorClass<SlackLinkNotMemberError>()(
  "SlackLinkNotMemberError",
  { teamId: Schema.String, userId: Schema.String },
) {}

export class SlackLinksRepo extends Context.Service<
  SlackLinksRepo,
  {
    /** The Mend account a Slack user acts as, or null when they have not linked. */
    readonly bySlackUser: (teamId: string, slackUserId: string) => Effect.Effect<SlackLink | null>;
    /** One account's links: at most one while an account belongs to one organization. */
    readonly listForUser: (userId: string) => Effect.Effect<ReadonlyArray<SlackLink>>;
    /** Every link in an organization, oldest first: what an owner manages. */
    readonly listForOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<SlackLink>>;
    /** Remove one link; returns it, or null when there was none. */
    readonly unlink: (teamId: string, slackUserId: string) => Effect.Effect<SlackLink | null>;
    /** Mint a code for a Slack user's mention; returns the plaintext ONCE. */
    readonly mintCode: (input: {
      readonly teamId: string;
      readonly slackUserId: string;
      readonly request: SlackPendingMention;
      readonly now?: Date;
    }) => Effect.Effect<{ readonly code: string; readonly expiresAt: Date }>;
    /** Read a code without spending it, or null when it is unknown, spent or expired. */
    readonly peekCode: (code: string, now?: Date) => Effect.Effect<PendingSlackLink | null>;
    /**
     * Spend a code and link its Slack user to `userId`, in one transaction. Null when the code is
     * unknown, spent or expired: of two requests racing one code, one links and the other gets
     * null. A link either side already had in that workspace is replaced, and `replaced` names
     * each one removed: the account's own earlier link, and the Slack user's link to another
     * account. An account outside the install's organization is refused, and the code stays
     * unspent.
     */
    readonly redeemCode: (input: {
      readonly code: string;
      readonly userId: string;
      readonly now?: Date;
    }) => Effect.Effect<
      {
        readonly link: SlackLink;
        readonly request: SlackPendingMention;
        readonly replaced: ReadonlyArray<SlackLink>;
      } | null,
      SlackLinkNotMemberError
    >;
  }
>()("@mend/db/SlackLinksRepo") {}

const toLink = (row: typeof slackLinks.$inferSelect): SlackLink => ({
  organizationId: row.organizationId,
  teamId: row.teamId,
  slackUserId: row.slackUserId,
  userId: row.userId,
  createdAt: row.createdAt,
});

/** The code, unspent and unexpired at `now`. */
const open = (code: string, now: Date) =>
  and(
    eq(slackLinkCodes.codeHash, hashSlackLinkCode(code)),
    isNull(slackLinkCodes.usedAt),
    gt(slackLinkCodes.expiresAt, now),
  );

export const SlackLinksRepoLive: Layer.Layer<SlackLinksRepo, never, MendDB> = Layer.effect(
  SlackLinksRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const bySlackUser = Effect.fn("SlackLinksRepo.bySlackUser")(function* (
      teamId: string,
      slackUserId: string,
    ) {
      const [row] = yield* db
        .select()
        .from(slackLinks)
        .where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.slackUserId, slackUserId)))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toLink(row);
    });

    const listForUser = Effect.fn("SlackLinksRepo.listForUser")(function* (userId: string) {
      const rows = yield* db
        .select()
        .from(slackLinks)
        .where(eq(slackLinks.userId, userId))
        .orderBy(asc(slackLinks.createdAt))
        .pipe(Effect.orDie);
      return rows.map(toLink);
    });

    const listForOrganization = Effect.fn("SlackLinksRepo.listForOrganization")(function* (
      organizationId: OrganizationId,
    ) {
      const rows = yield* db
        .select()
        .from(slackLinks)
        .where(eq(slackLinks.organizationId, organizationId))
        .orderBy(asc(slackLinks.createdAt), asc(slackLinks.slackUserId))
        .pipe(Effect.orDie);
      return rows.map(toLink);
    });

    const unlink = Effect.fn("SlackLinksRepo.unlink")(function* (
      teamId: string,
      slackUserId: string,
    ) {
      const [row] = yield* db
        .delete(slackLinks)
        .where(and(eq(slackLinks.teamId, teamId), eq(slackLinks.slackUserId, slackUserId)))
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toLink(row);
    });

    const mintCode = Effect.fn("SlackLinksRepo.mintCode")(function* (input: {
      readonly teamId: string;
      readonly slackUserId: string;
      readonly request: SlackPendingMention;
      readonly now?: Date;
    }) {
      const now = input.now ?? new Date();
      // Expired codes are dead weight, and minting is the only thing that grows the table.
      yield* db.delete(slackLinkCodes).where(lt(slackLinkCodes.expiresAt, now)).pipe(Effect.orDie);
      const code = mintSlackLinkCode();
      const expiresAt = new Date(now.getTime() + SLACK_LINK_CODE_TTL_MS);
      yield* db
        .insert(slackLinkCodes)
        .values({
          codeHash: hashSlackLinkCode(code),
          teamId: input.teamId,
          slackUserId: input.slackUserId,
          request: input.request,
          expiresAt,
          createdAt: now,
        })
        .pipe(Effect.orDie);
      return { code, expiresAt };
    });

    const peekCode = Effect.fn("SlackLinksRepo.peekCode")(function* (code: string, now?: Date) {
      const [row] = yield* db
        .select({
          organizationId: slackInstalls.organizationId,
          teamId: slackLinkCodes.teamId,
          teamName: slackInstalls.teamName,
          slackUserId: slackLinkCodes.slackUserId,
          request: slackLinkCodes.request,
          expiresAt: slackLinkCodes.expiresAt,
        })
        .from(slackLinkCodes)
        .innerJoin(slackInstalls, eq(slackInstalls.teamId, slackLinkCodes.teamId))
        .where(open(code, now ?? new Date()))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const redeemCode = Effect.fn("SlackLinksRepo.redeemCode")(function* (input: {
      readonly code: string;
      readonly userId: string;
      readonly now?: Date;
    }) {
      const now = input.now ?? new Date();
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            // The spend is the claim: one statement, so two racing redeems cannot both win.
            const [spent] = yield* tx
              .update(slackLinkCodes)
              .set({ usedAt: now })
              .where(open(input.code, now))
              .returning({
                teamId: slackLinkCodes.teamId,
                slackUserId: slackLinkCodes.slackUserId,
                request: slackLinkCodes.request,
              })
              .pipe(Effect.orDie);
            if (spent === undefined) return null;
            const [member] = yield* tx
              .select({ organizationId: slackInstalls.organizationId })
              .from(slackInstalls)
              .innerJoin(
                organizationMembers,
                eq(organizationMembers.organizationId, slackInstalls.organizationId),
              )
              .where(
                and(
                  eq(slackInstalls.teamId, spent.teamId),
                  eq(organizationMembers.userId, input.userId),
                ),
              )
              .limit(1)
              .pipe(Effect.orDie);
            if (member === undefined) {
              return yield* new SlackLinkNotMemberError({
                teamId: spent.teamId,
                userId: input.userId,
              });
            }
            const replaced = yield* tx
              .delete(slackLinks)
              .where(
                and(
                  eq(slackLinks.teamId, spent.teamId),
                  or(
                    eq(slackLinks.slackUserId, spent.slackUserId),
                    eq(slackLinks.userId, input.userId),
                  ),
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            const [row] = yield* tx
              .insert(slackLinks)
              .values({
                organizationId: member.organizationId,
                teamId: spent.teamId,
                slackUserId: spent.slackUserId,
                userId: input.userId,
                createdAt: now,
              })
              .returning()
              .pipe(Effect.orDie);
            if (row === undefined) return yield* Effect.die("slack link insert returned no row");
            return {
              link: toLink(row),
              request: spent.request,
              replaced: replaced.map(toLink),
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    return {
      bySlackUser,
      listForUser,
      listForOrganization,
      unlink,
      mintCode,
      peekCode,
      redeemCode,
    };
  }),
);
