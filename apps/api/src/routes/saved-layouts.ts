import {
  CurrentUser,
  MendApi,
  SavedLayoutLimitReached,
  SavedLayoutNameTaken,
  SavedLayoutNotFound,
} from "@mend/api-contracts";
import {
  SavedLayoutsRepo,
  type SavedLayoutLimitError,
  type SavedLayoutNameTakenError,
  type SavedLayoutNotFoundError,
} from "@mend/db";
import { SavedLayoutRemoved, SavedLayoutsView } from "@mend/domain/workbench";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

const nameTaken = (error: SavedLayoutNameTakenError) =>
  new SavedLayoutNameTaken({
    name: error.name,
    message: `You already have a layout called “${error.name}”. Pick another name.`,
  });

const limitReached = (error: SavedLayoutLimitError) =>
  new SavedLayoutLimitReached({
    limit: error.limit,
    message: `You already have ${error.limit} saved layouts, the most Mend keeps. Remove one first.`,
  });

const notFound = (_: SavedLayoutNotFoundError) =>
  new SavedLayoutNotFound({ message: "That layout isn't saved any more." });

/**
 * The signed-in person's saved layouts (ADR 0026, "Layouts") over `SavedLayoutsRepo`. Only ever
 * the caller's own: every read and write is keyed by the signed-in account, so another person's
 * layout id is simply not found. The contract has already refused a layout or name it doesn't
 * know.
 */
export const SavedLayoutsGroupLive = HttpApiBuilder.group(MendApi, "savedLayouts", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return new SavedLayoutsView({
          layouts: yield* (yield* SavedLayoutsRepo).list(caller.user.id),
        });
      }),
    )
    .handle("save", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* SavedLayoutsRepo)
          .save(caller.user.id, { name: payload.name, layout: payload.layout })
          .pipe(
            Effect.catchTags({
              SavedLayoutNameTakenError: (error) => Effect.fail(nameTaken(error)),
              SavedLayoutLimitError: (error) => Effect.fail(limitReached(error)),
            }),
          );
      }),
    )
    .handle("rename", ({ params, payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return yield* (yield* SavedLayoutsRepo)
          .rename(caller.user.id, params.id, payload.name)
          .pipe(
            Effect.catchTags({
              SavedLayoutNameTakenError: (error) => Effect.fail(nameTaken(error)),
              SavedLayoutNotFoundError: (error) => Effect.fail(notFound(error)),
            }),
          );
      }),
    )
    .handle("remove", ({ params }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const removed = yield* (yield* SavedLayoutsRepo).remove(caller.user.id, params.id);
        return new SavedLayoutRemoved({ removed });
      }),
    ),
);
