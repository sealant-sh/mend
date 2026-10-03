import { CurrentUser, MendApi, NotFound } from "@mend/api-contracts";
import { AgentMemoryRepo } from "@mend/db";
import type { ProjectId } from "@mend/domain";
import {
  AgentMemoryFileView,
  type AgentMemoryImport,
  AgentMemoryImported,
  AgentMemoryImportMerge,
  AgentMemoryRemoved,
  AgentMemoryView,
} from "@mend/domain/workbench";
import { mergeCodexDatabases, mergeTextUnion } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { ProjectAccess } from "../access.ts";

/**
 * The signed-in account's agent memory in a project (docs/adr/0009) over `AgentMemoryRepo`. The
 * project must be one the caller can see; the memory is always the caller's own.
 */
const caller = (projectId: ProjectId) =>
  Effect.gen(function* () {
    yield* (yield* ProjectAccess).project(projectId);
    return (yield* CurrentUser).user.id;
  });

/** An import, or its plan: merged as Mend merges a session's read-back (docs/adr/0009). */
const importFiles = (projectId: ProjectId, payload: AgentMemoryImport, dryRun: boolean) =>
  Effect.gen(function* () {
    const userId = yield* caller(projectId);
    const report = yield* (yield* AgentMemoryRepo).importFiles({
      userId,
      projectId,
      files: payload.files,
      source: payload.source ?? null,
      dryRun,
      merge: mergeTextUnion,
      mergeDatabase: mergeCodexDatabases,
    });
    return new AgentMemoryImported({
      ...report,
      merged: report.merged.map((merge) => new AgentMemoryImportMerge(merge)),
    });
  });

export const AgentMemoryGroupLive = HttpApiBuilder.group(MendApi, "agentMemory", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const userId = yield* caller(params.id);
        return new AgentMemoryView({
          files: yield* (yield* AgentMemoryRepo).list(userId, params.id),
        });
      }),
    )
    .handle("file", ({ params, query }) =>
      Effect.gen(function* () {
        const userId = yield* caller(params.id);
        const found = yield* (yield* AgentMemoryRepo).read(userId, params.id, query.path);
        if (found === null) return yield* new NotFound({ id: query.path });
        return new AgentMemoryFileView({
          entry: found.entry,
          encoding: found.file.encoding,
          contents: found.file.contents,
        });
      }),
    )
    .handle("remove", ({ params, query }) =>
      Effect.gen(function* () {
        const userId = yield* caller(params.id);
        const removed = yield* (yield* AgentMemoryRepo).remove(userId, params.id, query.path);
        return new AgentMemoryRemoved({ removed });
      }),
    )
    .handle("import", ({ params, payload }) => importFiles(params.id, payload, false))
    .handle("importPlan", ({ params, payload }) => importFiles(params.id, payload, true)),
);
