import type { OrganizationId } from "@mend/domain";
import type { SlackInstallSettings } from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { slackInstalls } from "../schema/workbench.ts";
import { isUniqueViolation } from "./unique-violation.ts";

/** Another organization on this instance has already installed Mend in that Slack workspace. */
export class SlackTeamTakenError extends Schema.TaggedErrorClass<SlackTeamTakenError>()(
  "SlackTeamTakenError",
  { teamId: Schema.String },
) {}

/** The organization has no Slack app installed. */
export class SlackInstallNotFoundError extends Schema.TaggedErrorClass<SlackInstallNotFoundError>()(
  "SlackInstallNotFoundError",
  { organizationId: Schema.String },
) {}

/**
 * An install as the worker and the settings routes need it: the Slack identity, the SEALED tokens
 * and the owner's settings. Unsealing is the caller's job (`@mend/store` SecretCipher), so this
 * package never sees a token.
 */
export interface SealedSlackInstall {
  readonly organizationId: OrganizationId;
  readonly teamId: string;
  readonly teamName: string;
  readonly botUserId: string;
  readonly appId: string;
  readonly sealedAppToken: string;
  readonly sealedBotToken: string;
  /** The origin the owner connected from; every link Mend posts into Slack starts with it. */
  readonly webOrigin: string;
  readonly settings: SlackInstallSettings;
  readonly installedByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What `auth.test` answered for both tokens, sealed, and who connected them from where. */
export interface NewSlackInstall {
  readonly organizationId: OrganizationId;
  readonly teamId: string;
  readonly teamName: string;
  readonly botUserId: string;
  readonly appId: string;
  readonly sealedAppToken: string;
  readonly sealedBotToken: string;
  readonly webOrigin: string;
  readonly installedByUserId: string;
}

/**
 * Organizations' Slack apps (docs/adr/0006-slack.md, "One Slack app per organization"). One row
 * per organization; a Slack workspace belongs to at most one organization on the instance.
 */
export class SlackInstallsRepo extends Context.Service<
  SlackInstallsRepo,
  {
    /** Every install on the instance, oldest first: the worker opens one socket for each. */
    readonly list: () => Effect.Effect<ReadonlyArray<SealedSlackInstall>>;
    readonly byOrganization: (
      organizationId: OrganizationId,
    ) => Effect.Effect<SealedSlackInstall | null>;
    readonly byTeam: (teamId: string) => Effect.Effect<SealedSlackInstall | null>;
    /**
     * Install, or replace the organization's install. The same Slack workspace keeps its settings,
     * links and channel defaults, and only the tokens and names change. Another workspace starts
     * over: the old install goes, and its links, link codes and channel defaults with it.
     * `previous` is the install this replaced, if any.
     */
    readonly save: (
      install: NewSlackInstall,
    ) => Effect.Effect<
      { readonly install: SealedSlackInstall; readonly previous: SealedSlackInstall | null },
      SlackTeamTakenError
    >;
    readonly updateSettings: (
      organizationId: OrganizationId,
      settings: SlackInstallSettings,
    ) => Effect.Effect<SealedSlackInstall, SlackInstallNotFoundError>;
    /**
     * Remove the install, its tokens, links, link codes and channel defaults. Sessions and their
     * threads stay. Returns what was removed, or null when nothing was installed.
     */
    readonly remove: (organizationId: OrganizationId) => Effect.Effect<SealedSlackInstall | null>;
  }
>()("@mend/db/SlackInstallsRepo") {}

const toInstall = (row: typeof slackInstalls.$inferSelect): SealedSlackInstall => ({
  organizationId: row.organizationId,
  teamId: row.teamId,
  teamName: row.teamName,
  botUserId: row.botUserId,
  appId: row.appId,
  sealedAppToken: row.sealedAppToken,
  sealedBotToken: row.sealedBotToken,
  webOrigin: row.webOrigin,
  settings: {
    defaultHarness: row.defaultHarness,
    showAgentMessages: row.showAgentMessages,
    showDiffs: row.showDiffs,
    externalChannels: row.externalChannels,
  },
  installedByUserId: row.installedByUserId,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const SlackInstallsRepoLive: Layer.Layer<SlackInstallsRepo, never, MendDB> = Layer.effect(
  SlackInstallsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("SlackInstallsRepo.list")(function* () {
      const rows = yield* db
        .select()
        .from(slackInstalls)
        .orderBy(asc(slackInstalls.createdAt), asc(slackInstalls.organizationId))
        .pipe(Effect.orDie);
      return rows.map(toInstall);
    });

    const byOrganization = Effect.fn("SlackInstallsRepo.byOrganization")(function* (
      organizationId: OrganizationId,
    ) {
      const [row] = yield* db
        .select()
        .from(slackInstalls)
        .where(eq(slackInstalls.organizationId, organizationId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toInstall(row);
    });

    const byTeam = Effect.fn("SlackInstallsRepo.byTeam")(function* (teamId: string) {
      const [row] = yield* db
        .select()
        .from(slackInstalls)
        .where(eq(slackInstalls.teamId, teamId))
        .limit(1)
        .pipe(Effect.orDie);
      return row === undefined ? null : toInstall(row);
    });

    const save = Effect.fn("SlackInstallsRepo.save")(function* (install: NewSlackInstall) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const [previous] = yield* tx
              .select()
              .from(slackInstalls)
              .where(eq(slackInstalls.organizationId, install.organizationId))
              .for("update")
              .pipe(Effect.orDie);
            // Links and channel defaults name users and channels of one workspace; a new
            // workspace must not inherit them, so the old row and everything under it goes.
            if (previous !== undefined && previous.teamId !== install.teamId) {
              yield* tx
                .delete(slackInstalls)
                .where(eq(slackInstalls.organizationId, install.organizationId))
                .pipe(Effect.orDie);
            }
            const now = new Date();
            const [row] = yield* tx
              .insert(slackInstalls)
              .values({ ...install, createdAt: now, updatedAt: now })
              .onConflictDoUpdate({
                target: slackInstalls.organizationId,
                set: {
                  teamName: install.teamName,
                  botUserId: install.botUserId,
                  appId: install.appId,
                  sealedAppToken: install.sealedAppToken,
                  sealedBotToken: install.sealedBotToken,
                  webOrigin: install.webOrigin,
                  installedByUserId: install.installedByUserId,
                  updatedAt: now,
                },
              })
              .returning()
              .pipe(
                Effect.catchTag("EffectDrizzleQueryError", (error) =>
                  isUniqueViolation(error)
                    ? Effect.fail(new SlackTeamTakenError({ teamId: install.teamId }))
                    : Effect.die(error),
                ),
              );
            if (row === undefined) return yield* Effect.die("slack install upsert returned no row");
            return {
              install: toInstall(row),
              previous: previous === undefined ? null : toInstall(previous),
            };
          }),
        )
        .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));
    });

    const updateSettings = Effect.fn("SlackInstallsRepo.updateSettings")(function* (
      organizationId: OrganizationId,
      settings: SlackInstallSettings,
    ) {
      const [row] = yield* db
        .update(slackInstalls)
        .set({ ...settings, updatedAt: new Date() })
        .where(eq(slackInstalls.organizationId, organizationId))
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* new SlackInstallNotFoundError({ organizationId });
      return toInstall(row);
    });

    const remove = Effect.fn("SlackInstallsRepo.remove")(function* (
      organizationId: OrganizationId,
    ) {
      const [row] = yield* db
        .delete(slackInstalls)
        .where(eq(slackInstalls.organizationId, organizationId))
        .returning()
        .pipe(Effect.orDie);
      return row === undefined ? null : toInstall(row);
    });

    return { list, byOrganization, byTeam, save, updateSettings, remove };
  }),
);
