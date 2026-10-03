import {
  emptyHarnessModelCatalog,
  HarnessModel,
  harnessModelCatalog,
  type HarnessModelCatalog,
} from "@mend/domain/workbench";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { harnessModels } from "../schema/workbench.ts";

/**
 * The server-owned model catalog (docs/models-audit.md): what every picker lists and what a launch
 * resolves a missing model against. Read-only here; migration 0101 seeds it and an operator edits
 * the rows in place until there is a write route.
 */
export class HarnessModelsRepo extends Context.Service<
  HarnessModelsRepo,
  {
    /** Every harness that lists models, each with its catalog, harnesses in alphabetical order. */
    readonly list: () => Effect.Effect<ReadonlyArray<HarnessModelCatalog>>;
    /** One harness's catalog; a harness nobody listed models for gets an empty one. */
    readonly forHarness: (harness: string) => Effect.Effect<HarnessModelCatalog>;
  }
>()("@mend/db/HarnessModelsRepo") {}

const toModel = (row: typeof harnessModels.$inferSelect): HarnessModel =>
  new HarnessModel({
    id: row.id,
    label: row.label,
    isDefault: row.isDefault,
    efforts: row.efforts ?? null,
  });

export const HarnessModelsRepoLive: Layer.Layer<HarnessModelsRepo, never, MendDB> = Layer.effect(
  HarnessModelsRepo,
  Effect.gen(function* () {
    const db = yield* MendDB;

    const list = Effect.fn("HarnessModelsRepo.list")(function* () {
      const rows = yield* db
        .select()
        .from(harnessModels)
        .orderBy(asc(harnessModels.harness), asc(harnessModels.position), asc(harnessModels.id))
        .pipe(Effect.orDie);
      const byHarness = new Map<string, Array<HarnessModel>>();
      for (const row of rows) {
        const models = byHarness.get(row.harness) ?? [];
        models.push(toModel(row));
        byHarness.set(row.harness, models);
      }
      return [...byHarness.entries()].map(([harness, models]) =>
        harnessModelCatalog(harness, models),
      );
    });

    const forHarness = Effect.fn("HarnessModelsRepo.forHarness")(function* (harness: string) {
      const rows = yield* db
        .select()
        .from(harnessModels)
        .where(eq(harnessModels.harness, harness))
        .orderBy(asc(harnessModels.position), asc(harnessModels.id))
        .pipe(Effect.orDie);
      return rows.length === 0
        ? emptyHarnessModelCatalog(harness)
        : harnessModelCatalog(harness, rows.map(toModel));
    });

    return { list, forHarness };
  }),
);
