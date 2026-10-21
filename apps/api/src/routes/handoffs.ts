import { CurrentUser, MendApi } from "@mend/api-contracts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { HandoffStart } from "../handoff-start.ts";

export const HandoffsGroupLive = HttpApiBuilder.group(MendApi, "handoffs", (handlers) =>
  handlers
    .handle("terms", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const start = yield* HandoffStart;
        return yield* start.termsAs(caller.user.id, params.id);
      }),
    )
    .handle("receive", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const start = yield* HandoffStart;
        return yield* start.receiveAs(caller.user.id, params.id, query, payload);
      }),
    ),
);
