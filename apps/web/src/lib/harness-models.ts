import { emptyHarnessModelCatalog, type HarnessModelCatalogView } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "./trpc.ts";

/**
 * The server-owned model catalog (docs/models-audit.md), one list per harness. Every picker in
 * the web app reads it from here; nothing in the app names a model of its own. A harness the
 * server lists nothing for gets an empty catalog, and so does every harness while the list loads:
 * the picker then shows no model control until the answer arrives.
 */
export const useHarnessCatalogs = (): ReadonlyArray<HarnessModelCatalogView> => {
  const trpc = useTRPC();
  const catalogs = useQuery(
    trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
  );
  return catalogs.data ?? [];
};

/** One harness's catalog out of the list, empty when the server lists none for it. */
export const catalogFor = (
  catalogs: ReadonlyArray<HarnessModelCatalogView>,
  harness: string,
): HarnessModelCatalogView =>
  catalogs.find((catalog) => catalog.harness === harness) ?? emptyHarnessModelCatalog(harness);
