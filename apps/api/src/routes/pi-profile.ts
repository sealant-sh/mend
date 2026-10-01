import { CurrentUser, MendApi, PiProfileRejected } from "@mend/api-contracts";
import { PiProfilesRepo } from "@mend/db";
import { PiProfileRemoved, PiProfileSaved, PiProfileView } from "@mend/domain/workbench";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * The signed-in account's pi setup over `PiProfilesRepo`. Only ever the caller's own: there is no
 * route to anyone else's. A session reads it at launch, so nothing running changes on a save.
 */
export const PiProfileGroupLive = HttpApiBuilder.group(MendApi, "piProfile", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const saved = yield* (yield* PiProfilesRepo).forUser(caller.user.id);
        return new PiProfileView({ profile: saved?.profile ?? null });
      }),
    )
    .handle("save", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const saved = yield* (yield* PiProfilesRepo)
          .save(caller.user.id, payload.files)
          .pipe(Effect.mapError((error) => new PiProfileRejected({ message: error.message })));
        return new PiProfileSaved(saved);
      }),
    )
    .handle("remove", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const removed = yield* (yield* PiProfilesRepo).remove(caller.user.id);
        return new PiProfileRemoved({ removed });
      }),
    ),
);
