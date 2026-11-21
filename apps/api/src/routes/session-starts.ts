import { CurrentUser, MendApi, WorktreeNotFound } from "@mend/api-contracts";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess, signInOf } from "../access.ts";
import { SessionStarts } from "../session-starts.ts";

/** Sessions made and launched in one request, named by the client's key (SLNT-1239). */
export const SessionStartsGroupLive = HttpApiBuilder.group(MendApi, "sessionStarts", (handlers) =>
  handlers
    .handle("start", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const { target } = payload;
        // Read as the caller, here: the start itself runs past this request.
        const worktree =
          target._tag === "Worktree"
            ? yield* (yield* ProjectAccess)
                .worktree(target.worktreeId)
                .pipe(Effect.mapError(() => new WorktreeNotFound({ id: target.worktreeId })))
            : null;
        return yield* (yield* SessionStarts).start(signInOf(caller), payload, worktree);
      }),
    )
    .handle("read", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* SessionStarts).read(signInOf(caller), params.id);
      }),
    ),
);
