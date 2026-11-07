import { OrganizationId, ProjectId, SessionId, WorktreeId, CheckpointId } from "@mend/domain";
import {
  HistoryOperationId,
  TurnBoundaryId,
  type RollbackOperation,
  RollbackRefusedError,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

it("forwards the authenticated actor and exact rollback request to the engine", async () => {
  let observed: unknown;
  const api = await createTenancyApi(
    {},
    {
      implement: {
        engine: {
          launchUnderWay: () => false,
          rollbackSession: (input) =>
            Effect.sync(() => {
              observed = input;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new RollbackRefusedError({ code: "busy", message: "A turn is running." }),
                ),
              ),
            ),
        },
      },
    },
  );
  try {
    const body = {
      commandId: "undo-command",
      at: { checkpointId: "checkpoint", boundaryId: "boundary" },
      expected: { historyRevision: 2, worktreeEpoch: 3 },
      restoreFiles: false,
    };
    const response = await api.request(
      "alice",
      "POST",
      `/api/sessions/${ids("shared-a").session}/rollbacks`,
      body,
    );
    expect(response.status).toBe(409);
    expect(observed).toEqual({
      actor: "alice",
      commandId: body.commandId,
      request: {
        sessionId: ids("shared-a").session,
        at: body.at,
        expected: body.expected,
        restoreFiles: false,
      },
    });
    expect(await response.json()).toMatchObject({ _tag: "RollbackRefusedError", code: "busy" });
  } finally {
    await api.dispose();
  }
});

const receipt = (sessionId: string): RollbackOperation => ({
  id: HistoryOperationId.make("rollback"),
  organizationId: OrganizationId.make("org-a"),
  actorId: "alice",
  commandId: "undo",
  intentDigest: "a".repeat(64),
  request: {
    sessionId: SessionId.make(sessionId),
    at: {
      checkpointId: CheckpointId.make("checkpoint"),
      boundaryId: TurnBoundaryId.make("boundary"),
    },
    expected: { historyRevision: 0, worktreeEpoch: 0 },
  },
  intent: {
    kind: "rollback",
    sessionId: SessionId.make(sessionId),
    projectId: ProjectId.make("project"),
    worktreeId: WorktreeId.make("worktree"),
    targetBoundaryId: TurnBoundaryId.make("boundary"),
    from: { historyRevision: 0, worktreeEpoch: 0 },
    toRevision: 1,
    restoreFiles: true,
    removedTurnIds: [],
    candidateKey: "candidate",
  },
  progress: {
    kind: "recoveryRequired",
    recoveryId: null,
    reason: { code: "authority_uncertain", message: "Observe the old workspace exit." },
  },
  version: 4,
  generation: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});
it("forwards recovery as the current authenticated person and reads its durable receipt", async () => {
  let observed: unknown;
  const operation = receipt(ids("shared-a").session);
  const api = await createTenancyApi(
    {},
    {
      implement: {
        history: { rollback: () => Effect.succeed(operation) },
        engine: {
          launchUnderWay: () => false,
          recoverRollback: (input) =>
            Effect.sync(() => {
              observed = input;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new RollbackRefusedError({
                    code: "actor_revoked",
                    message: "Current file authority is required.",
                  }),
                ),
              ),
            ),
        },
      },
    },
  );
  try {
    const base = `/api/sessions/${ids("shared-a").session}/rollbacks/rollback`;
    const read = await api.request("carol", "GET", base);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      id: "rollback",
      version: 4,
      progress: { kind: "recoveryRequired" },
    });
    const recovered = await api.request("carol", "POST", `${base}/recovery`, {
      expectedProgressVersion: 4,
      action: "restoreSaved",
    });
    expect(recovered.status).toBe(409);
    expect(observed).toEqual({
      actor: "carol",
      operationId: "rollback",
      expectedProgressVersion: 4,
      action: "restoreSaved",
    });
  } finally {
    await api.dispose();
  }
});
it("refuses an operation from another session before invoking recovery", async () => {
  let invoked = false;
  const api = await createTenancyApi(
    {},
    {
      implement: {
        history: { rollback: () => Effect.succeed(receipt("different-session")) },
        engine: {
          launchUnderWay: () => false,
          recoverRollback: () =>
            Effect.sync(() => {
              invoked = true;
              return receipt("different-session");
            }),
        },
      },
    },
  );
  try {
    for (const method of ["GET", "POST"] as const) {
      const response = await api.request(
        "alice",
        method,
        `/api/sessions/${ids("shared-a").session}/rollbacks/rollback${method === "POST" ? "/recovery" : ""}`,
        method === "POST" ? { expectedProgressVersion: 4, action: "finish" } : undefined,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ _tag: "NotFound", id: "rollback" });
    }
    expect(invoked).toBe(false);
  } finally {
    await api.dispose();
  }
});
