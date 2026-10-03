import { MendApi } from "@mend/api-contracts";
import { HarnessModelsRepo } from "@mend/db";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

/**
 * The server-owned model catalog (docs/models-audit.md), read by every picker. One list for every
 * signed-in account: which models a harness takes is a fact about the machine, not about a person
 * or a project.
 */
export const HarnessModelsGroupLive = HttpApiBuilder.group(MendApi, "harnessModels", (handlers) =>
  handlers.handle("list", () => Effect.flatMap(HarnessModelsRepo, (repo) => repo.list())),
);
