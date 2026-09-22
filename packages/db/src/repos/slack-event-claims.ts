import { lt } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { slackEventClaims } from "../schema/workbench.ts";

/**
 * How long a claim is kept. Slack retries an unacknowledged event within minutes, so a day covers
 * every redelivery with room to spare.
 */
export const SLACK_EVENT_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Slack events some worker has claimed (docs/adr/0006-slack.md, "Socket Mode, outbound only").
 * Slack may deliver an event twice, or to two workers. The first claim acts; every later claim of
 * the same `event_id` is told no. A claimed event is done even if the work fails, and it is never
 * replayed.
 */
export class SlackEventClaimsRepo extends Context.Service<
  SlackEventClaimsRepo,
  {
    /** True for exactly one caller per event id, however many race. */
    readonly claim: (input: {
      readonly eventId: string;
      readonly teamId: string;
      readonly now?: Date;
    }) => Effect.Effect<boolean>;
    /** Delete claims made before `before`; returns how many went. */
    readonly sweep: (before: Date) => Effect.Effect<number>;
  }
>()("@mend/db/SlackEventClaimsRepo") {}

export const SlackEventClaimsRepoLive: Layer.Layer<SlackEventClaimsRepo, never, MendDB> =
  Layer.effect(
    SlackEventClaimsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const claim = Effect.fn("SlackEventClaimsRepo.claim")(function* (input: {
        readonly eventId: string;
        readonly teamId: string;
        readonly now?: Date;
      }) {
        const rows = yield* db
          .insert(slackEventClaims)
          .values({
            eventId: input.eventId,
            teamId: input.teamId,
            claimedAt: input.now ?? new Date(),
          })
          .onConflictDoNothing({ target: slackEventClaims.eventId })
          .returning({ eventId: slackEventClaims.eventId })
          .pipe(Effect.orDie);
        return rows.length === 1;
      });

      const sweep = Effect.fn("SlackEventClaimsRepo.sweep")(function* (before: Date) {
        const rows = yield* db
          .delete(slackEventClaims)
          .where(lt(slackEventClaims.claimedAt, before))
          .returning({ eventId: slackEventClaims.eventId })
          .pipe(Effect.orDie);
        return rows.length;
      });

      return { claim, sweep };
    }),
  );
