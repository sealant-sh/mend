import { ProjectId } from "@mend/domain";
import { Effect, Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

const byProject = input(Schema.Struct({ id: ProjectId }));
const byFile = input(Schema.Struct({ id: ProjectId, path: Schema.String }));

/** Why one file wasn't removed, in the API's words when it gave any. */
const failureMessage = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const message = Reflect.get(cause, "message");
    if (typeof message === "string" && message !== "") return message;
  }
  return "Mend didn't answer.";
};

/**
 * The signed-in person's agent memory in one project (docs/adr/0009; references S21 of the web
 * rebuild): what their sessions there receive and save, over the API's `/projects/:id/memory`.
 * Only ever the caller's own: the API answers with no one else's.
 */
export const memoryRouter = router({
  list: procedure
    .input(byProject)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.agentMemory.list({ params: { id: i.id } })),
    ),
  file: procedure
    .input(byFile)
    .query(({ ctx, input: i }) =>
      run(ctx, (api) => api.agentMemory.file({ params: { id: i.id }, query: { path: i.path } })),
    ),
  remove: procedure
    .input(byFile)
    .mutation(({ ctx, input: i }) =>
      run(ctx, (api) => api.agentMemory.remove({ params: { id: i.id }, query: { path: i.path } })),
    ),
  /**
   * Clear memory: every file the person's memory holds in the project, each removed through the
   * API's own remove, so each keeps its last version on the server as a single remove does. The API
   * has no route that removes them all; one file Mend can't remove doesn't stop the others, and the
   * answer says which were removed and which weren't, with why.
   */
  clear: procedure.input(byProject).mutation(({ ctx, input: i }) =>
    run(ctx, (api) =>
      Effect.gen(function* () {
        const { files } = yield* api.agentMemory.list({ params: { id: i.id } });
        const outcomes = yield* Effect.forEach(
          files,
          (file) =>
            api.agentMemory.remove({ params: { id: i.id }, query: { path: file.path } }).pipe(
              Effect.map(() => ({ ok: true as const, path: file.path, name: file.name })),
              Effect.catch((cause) =>
                Effect.succeed({
                  ok: false as const,
                  path: file.path,
                  name: file.name,
                  message: failureMessage(cause),
                }),
              ),
            ),
          // One at a time: a person's memory holds a handful of files, and each remove writes.
        );
        return {
          removed: outcomes
            .filter((outcome) => outcome.ok)
            .map(({ path, name }) => ({ path, name })),
          failed: outcomes.flatMap((outcome) =>
            outcome.ok
              ? []
              : [{ path: outcome.path, name: outcome.name, message: outcome.message }],
          ),
        };
      }),
    ),
  ),
});
