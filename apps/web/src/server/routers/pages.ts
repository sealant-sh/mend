import { PageAppearance } from "@mend/api-contracts";
import { PageId } from "@mend/domain";
import { Schema } from "effect";

import { run } from "../api/index.ts";
import { input, procedure, router } from "./trpc.ts";

export const pagesRouter = router({
  frame: procedure
    .input(input(Schema.Struct({ id: PageId, appearance: PageAppearance })))
    .query(({ ctx, input: i }) =>
      run(ctx, (api) =>
        api.pages.frame({ params: { id: i.id }, query: { appearance: i.appearance } }),
      ),
    ),
});
