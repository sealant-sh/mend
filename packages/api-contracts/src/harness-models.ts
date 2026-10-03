import { HarnessModelCatalog } from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { AuthMiddleware } from "./common.ts";

/**
 * The server-owned model catalog (docs/models-audit.md): every harness that lists models, each
 * with its models in picker order, its default, the efforts it accepts and whether it goes fast.
 * Every client's picker reads this; none carries a model id of its own. A launch that names no
 * model runs the harness's default from here and records it on the session.
 */
export const harnessModelsGroup = HttpApiGroup.make("harnessModels")
  .add(
    HttpApiEndpoint.get("list", "/harnesses/models", {
      success: Schema.Array(HarnessModelCatalog),
    }),
  )
  .middleware(AuthMiddleware);
