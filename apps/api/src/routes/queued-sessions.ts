import { CurrentUser, MendApi } from "@mend/api-contracts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { signInOf } from "../access.ts";
import { QueuedSessions } from "../queued-sessions.ts";

/** Sessions started while their project still clones (SLNT-1099). */
export const QueuedSessionsGroupLive = HttpApiBuilder.group(MendApi, "queuedSessions", (handlers) =>
  handlers
    .handle("queue", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* QueuedSessions).queue(signInOf(caller), payload);
      }),
    )
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* QueuedSessions).list(signInOf(caller));
      }),
    )
    .handle("read", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* QueuedSessions).read(signInOf(caller), params.id);
      }),
    )
    .handle("start", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* QueuedSessions).start(signInOf(caller), params.id, payload);
      }),
    )
    .handle("cancel", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* QueuedSessions).cancel(signInOf(caller), params.id);
      }),
    ),
);
