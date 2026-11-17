import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

/**
 * The person's GitHub, as the Mend server's `gh` sees it: whether it is signed in, and their
 * repositories for Adopt to search. A failed search answers with gh's own words.
 */
export const githubRouter = router({
  status: procedure.query(({ ctx }) => run(ctx, (api) => api.github.status())),
  repos: procedure
    .input(input(Schema.Struct({ query: Schema.String })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.github.repos({ query: i.query.trim() === "" ? {} : { query: i.query.trim() } }),
      ),
    ),
});
