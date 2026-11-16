import { CurrentUser, MendApi } from "@mend/api-contracts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { signInOf } from "../access.ts";
import { ConversationImport } from "../conversation-import.ts";

export const ConversationsGroupLive = HttpApiBuilder.group(MendApi, "conversations", (handlers) =>
  handlers
    .handle("lookup", ({ params, query }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const imports = yield* ConversationImport;
        return yield* imports.lookupAs(signInOf(caller), params.id, query);
      }),
    )
    .handle("import", ({ params, query, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const imports = yield* ConversationImport;
        return yield* imports.importAs(signInOf(caller), params.id, query, payload);
      }),
    ),
);
