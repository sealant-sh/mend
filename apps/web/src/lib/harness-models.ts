import type { HarnessModelCatalogView } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "./trpc.ts";

/**
 * The server-owned model catalog (docs/models-audit.md), one list per harness. Every picker in
 * the web app reads it from here; nothing in the app names a model of its own. Undefined until
 * the server answers (and when it cannot): the picker then passes the sticky choice through and
 * the server resolves the rest (`modelPickerFor`).
 */
export const useHarnessCatalogs = (): ReadonlyArray<HarnessModelCatalogView> | undefined => {
  const trpc = useTRPC();
  const catalogs = useQuery(
    trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
  );
  return catalogs.data;
};
