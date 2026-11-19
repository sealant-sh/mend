import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * The person's GitHub, as their own connected login sees it (or, for the operator of a
 * single-organization server with none, the server's `gh`): whether there is one, whose
 * repositories it can list, and an owner's repositories for the pickers to choose from. A failed
 * read answers with gh's own words.
 */
export const githubRouter = router({
  status: procedure.query(({ ctx }) => run(ctx, (api) => api.github.status())),
  owners: procedure.query(({ ctx }) => run(ctx, (api) => api.github.owners())),
  repos: procedure
    .input(input(Schema.Struct({ query: Schema.String, owner: Schema.optional(Schema.String) })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.github.repos({
          query: {
            ...(i.query.trim() === "" ? {} : { query: i.query.trim() }),
            ...(i.owner === undefined ? {} : { owner: i.owner }),
          },
        }),
      ),
    ),
});
