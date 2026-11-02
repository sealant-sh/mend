import type { WorktreeId } from "@mend/domain";
import {
  type ResourceDefinition,
  type ResourceAddRequest,
  type ResourceLevel,
  type WorktreeChoice,
} from "@mend/domain/workbench";
import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "../server/routers/index.ts";
import { orLogin, trpcClient } from "./trpc.ts";

type Outputs = inferRouterOutputs<AppRouter>["resources"];
export type ResourcesPageView = Outputs["list"];
export type ResourceSettingView = ResourcesPageView["settings"][number];
export type ResourceFileView = ResourcesPageView["file"];
export type ResourceFileTableView = Extract<ResourceFileView, { kind: "read" }>["tables"][number];
/** Status line clock times use the reader's zone. */
export const readerZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const at = (projectId: string) => ({ projectId, timeZone: readerZone() });
/** Start explicitly at one level or stop a remembered instance. */
export const controlResource = (
  projectId: string,
  entry: { readonly spec: ResourceDefinition },
  worktreeId: WorktreeId | null,
  verb: "start" | "stop",
  level: ResourceLevel,
  restart = false,
) =>
  orLogin(
    trpcClient.resources.control.mutate({
      ...at(projectId),
      name: entry.spec.name,
      worktreeId,
      verb,
      level,
      restart,
    }),
  );
/** Archive one instance, retaining all its volumes. */
export const removeResourceInstance = (
  projectId: string,
  entry: ResourceSettingView,
  worktreeId: WorktreeId | null,
) =>
  orLogin(
    trpcClient.resources.remove.mutate({
      projectId,
      name: entry.spec.name,
      level: entry.level,
      worktreeId,
    }),
  );
/** A choice changes reach and the env of future processes. */
export const chooseResource = (
  projectId: string,
  worktreeId: WorktreeId,
  name: string,
  mode: WorktreeChoice,
) => orLogin(trpcClient.resources.use.mutate({ ...at(projectId), worktreeId, name, mode }));
/** Postgres names databases; other resources name container levels. */
export const choiceWords = (
  spec: ResourceDefinition,
  choice: WorktreeChoice,
): { readonly label: string; readonly meaning: string } => {
  switch (choice) {
    case "project":
      return {
        label: spec.preset === "postgres" ? "shared database" : "project",
        meaning: "Uses the project's running resource. Visibility never performs its first start.",
      };
    case "worktree":
      return {
        label: spec.preset === "postgres" ? "own database" : "worktree",
        meaning: "Uses this worktree's resource. Start it explicitly before selecting it.",
      };
    case "off":
      return {
        label: "off",
        meaning: "Gives this worktree no env or network reach for this resource.",
      };
  }
};
/** The server supplies the worktree's effective default in each read. */
export const choiceInUse = (
  entry: Pick<ResourceSettingView, "spec" | "choice">,
): { readonly choice: WorktreeChoice; readonly stored: boolean } => ({
  choice: entry.choice ?? "project",
  stored: entry.choice !== null,
});

/** Writes one declaration into the selected worktree, or previews a table when none exists. */
export const addResource = (projectId: string, request: ResourceAddRequest) =>
  orLogin(trpcClient.resources.add.mutate({ projectId, ...request }));
