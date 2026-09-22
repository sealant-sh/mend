import type { ProjectId } from "@mend/domain";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { slackChannelDefaults, slackUserDefaults } from "../schema/workbench.ts";

/** A channel's default project, and who set it. */
export interface SlackChannelDefault {
  readonly teamId: string;
  readonly channelId: string;
  readonly projectId: ProjectId;
  readonly setByUserId: string;
  readonly updatedAt: Date;
}

/**
 * The last two answers to "which project does a mention run in" (docs/adr/0006-slack.md): the
 * channel's default, set with `@mend settings`, and the person's own, set in Mend. Both only
 * name a project. Whether the person may run there is checked when the mention runs.
 */
export class SlackDefaultsRepo extends Context.Service<
  SlackDefaultsRepo,
  {
    readonly channelDefault: (
      teamId: string,
      channelId: string,
    ) => Effect.Effect<SlackChannelDefault | null>;
    /** Set or replace the channel's default. */
    readonly setChannelDefault: (input: {
      readonly teamId: string;
      readonly channelId: string;
      readonly projectId: ProjectId;
      readonly setByUserId: string;
    }) => Effect.Effect<SlackChannelDefault>;
    /** Returns whether there was one to clear. */
    readonly clearChannelDefault: (teamId: string, channelId: string) => Effect.Effect<boolean>;
    readonly personalDefault: (userId: string) => Effect.Effect<ProjectId | null>;
    /** Null clears it. */
    readonly setPersonalDefault: (
      userId: string,
      projectId: ProjectId | null,
    ) => Effect.Effect<void>;
  }
>()("@mend/db/SlackDefaultsRepo") {}

const channel = (teamId: string, channelId: string) =>
  and(eq(slackChannelDefaults.teamId, teamId), eq(slackChannelDefaults.channelId, channelId));

export const SlackDefaultsRepoLive: Layer.Layer<SlackDefaultsRepo, never, MendDB> = Layer.effect(
  SlackDefaultsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const channelDefault = Effect.fn("SlackDefaultsRepo.channelDefault")(function* (
      teamId: string,
      channelId: string,
    ) {
      const [row] = yield* db
        .select()
        .from(slackChannelDefaults)
        .where(channel(teamId, channelId))
        .limit(1)
        .pipe(Effect.orDie);
      return row ?? null;
    });

    const setChannelDefault = Effect.fn("SlackDefaultsRepo.setChannelDefault")(function* (input: {
      readonly teamId: string;
      readonly channelId: string;
      readonly projectId: ProjectId;
      readonly setByUserId: string;
    }) {
      const now = new Date();
      const [row] = yield* db
        .insert(slackChannelDefaults)
        .values({ ...input, updatedAt: now })
        .onConflictDoUpdate({
          target: [slackChannelDefaults.teamId, slackChannelDefaults.channelId],
          set: { projectId: input.projectId, setByUserId: input.setByUserId, updatedAt: now },
        })
        .returning()
        .pipe(Effect.orDie);
      if (row === undefined) return yield* Effect.die("channel default upsert returned no row");
      return row;
    });

    const clearChannelDefault = Effect.fn("SlackDefaultsRepo.clearChannelDefault")(function* (
      teamId: string,
      channelId: string,
    ) {
      const rows = yield* db
        .delete(slackChannelDefaults)
        .where(channel(teamId, channelId))
        .returning({ channelId: slackChannelDefaults.channelId })
        .pipe(Effect.orDie);
      return rows.length > 0;
    });

    const personalDefault = Effect.fn("SlackDefaultsRepo.personalDefault")(function* (
      userId: string,
    ) {
      const [row] = yield* db
        .select({ projectId: slackUserDefaults.projectId })
        .from(slackUserDefaults)
        .where(eq(slackUserDefaults.userId, userId))
        .limit(1)
        .pipe(Effect.orDie);
      return row?.projectId ?? null;
    });

    const setPersonalDefault = Effect.fn("SlackDefaultsRepo.setPersonalDefault")(function* (
      userId: string,
      projectId: ProjectId | null,
    ) {
      if (projectId === null) {
        yield* db
          .delete(slackUserDefaults)
          .where(eq(slackUserDefaults.userId, userId))
          .pipe(Effect.orDie);
        return;
      }
      const now = new Date();
      yield* db
        .insert(slackUserDefaults)
        .values({ userId, projectId, updatedAt: now })
        .onConflictDoUpdate({
          target: slackUserDefaults.userId,
          set: { projectId, updatedAt: now },
        })
        .pipe(Effect.orDie);
    });

    return {
      channelDefault,
      setChannelDefault,
      clearChannelDefault,
      personalDefault,
      setPersonalDefault,
    };
  }),
);
