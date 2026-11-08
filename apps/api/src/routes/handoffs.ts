import { CurrentUser, MendApi } from "@mend/api-contracts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { signInOf } from "../access.ts";
import { HandoffStart } from "../handoff-start.ts";

export const HandoffsGroupLive = HttpApiBuilder.group(MendApi, "handoffs", (handlers) =>
  handlers
    .handle("terms", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const start = yield* HandoffStart;
        return yield* start.termsAs(signInOf(caller), params.id);
      }),
    )
    .handle("instanceTerms", () =>
      Effect.gen(function* () {
        const start = yield* HandoffStart;
        return yield* start.instanceTerms;
      }),
    )
    .handle("receive", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const start = yield* HandoffStart;
        return yield* start.receiveAs(signInOf(caller), params.id, query, payload);
      }),
    ),
);
