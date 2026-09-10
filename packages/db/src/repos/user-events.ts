import { PgClient } from "@effect/sql-pg";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { notifyEvent } from "../events.ts";

/** Which of one account's own facts moved. */
export type UserEventFacet = "accounts" | "devices" | "git-access";

/**
 * Announces that one account's own facts changed — connected accounts, device
 * tokens, the git access choice or key — as a `user` pointer on the event
 * channel. Route handlers ask this instead of reaching for the SQL client, so
 * a test without a database can let the announcement pass and keep every
 * other database access a defect.
 */
export class UserEvents extends Context.Service<
  UserEvents,
  {
    readonly changed: (userId: string, facet: UserEventFacet) => Effect.Effect<void>;
  }
>()("@mend/db/UserEvents") {}

export const UserEventsLive: Layer.Layer<UserEvents, never, PgClient.PgClient> = Layer.effect(
  UserEvents,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;

    const changed = Effect.fn("UserEvents.changed")(function* (
      userId: string,
      facet: UserEventFacet,
    ) {
      yield* notifyEvent(sql, { type: "user", userId, facet });
    });

    return { changed };
  }),
);
