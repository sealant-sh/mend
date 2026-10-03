import { ProjectId } from "@mend/domain";
import {
  AgentMemoryFileView,
  AgentMemoryImport,
  AgentMemoryImported,
  AgentMemoryRemoved,
  AgentMemoryView,
} from "@mend/domain/workbench";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

import { NotFound } from "./accounts.ts";
import { AuthMiddleware } from "./common.ts";

/**
 * The signed-in account's agent memory in one project (docs/adr/0009): what its sessions there
 * receive and save. Only ever the caller's own, in a project the caller can see.
 */
export const agentMemoryGroup = HttpApiGroup.make("agentMemory")
  .add(
    HttpApiEndpoint.get("list", "/projects/:id/memory", {
      params: { id: ProjectId },
      success: AgentMemoryView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("file", "/projects/:id/memory/file", {
      params: { id: ProjectId },
      query: { path: Schema.String },
      success: AgentMemoryFileView,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/projects/:id/memory/file", {
      params: { id: ProjectId },
      query: { path: Schema.String },
      success: AgentMemoryRemoved,
      error: NotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/projects/:id/memory/import", {
      params: { id: ProjectId },
      payload: AgentMemoryImport,
      success: AgentMemoryImported,
      error: NotFound,
    }),
  )
  .add(
    // What `import` would do with the same files, written nowhere: `mend memory import --dry-run`.
    HttpApiEndpoint.post("importPlan", "/projects/:id/memory/import/plan", {
      params: { id: ProjectId },
      payload: AgentMemoryImport,
      success: AgentMemoryImported,
      error: NotFound,
    }),
  )
  .middleware(AuthMiddleware);
