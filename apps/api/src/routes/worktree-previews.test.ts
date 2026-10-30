import { type PreviewGatewaySnapshot, WorktreeNotFoundError } from "@mend/db";
import {
  AgentTurnId,
  PreviewId,
  PreviewLabel,
  ProjectId,
  SealantWorkspaceId,
  ServiceForwardId,
  ServiceId,
  ServiceObservationId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  type PreviewPreparation,
  type PreviewView,
  ServiceObservation,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createTenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

describe("GET /worktrees/:id/previews", () => {
  it("anyone who sees the project reads its previews, including unbound ones", async () => {
    const target = ids("shared-a");
    const bound: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: {
        _tag: "Bound",
        serviceId: ServiceId.make(target.service),
        attemptId: SessionProcessId.make(target.process),
        host: "rewrite",
        dial: "session-bound",
      },
    };
    const unbound: PreviewView = {
      preview: {
        ...bound.preview,
        id: PreviewId.make("preview-docs"),
        serviceName: "docs",
        label: PreviewLabel.make("bbbbbbbbbbbbbbbbbbbbbbbbba"),
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
    };
    const seen: Array<WorktreeId> = [];
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: (id) =>
              Effect.sync(() => {
                seen.push(id);
                return [bound, unbound];
              }),
            gatewaySnapshots: () => Effect.succeed(new Map()),
          },
          preparations: { latestForWorktree: () => Effect.succeed(null) },
        },
      },
    );
    try {
      for (const user of ["alice", "carol"] as const) {
        const response = await api.request(
          user,
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          previews: [
            { ...bound, status: [] },
            { ...unbound, status: [] },
          ],
          unprepared: null,
        });
      }
      expect(seen).toEqual([target.worktree, target.worktree]);
      expect(api.world.calls).toEqual([
        "previews.ensureForWorktree",
        "previews.gatewaySnapshots",
        "preparations.latestForWorktree",
        "previews.ensureForWorktree",
        "previews.gatewaySnapshots",
        "preparations.latestForWorktree",
      ]);
    } finally {
      await api.dispose();
    }
  });

  it("refused and missing worktrees have identical 404s before any preview read", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.die("authorization must run first"),
          },
        },
      },
    );
    try {
      const target = ids("private-alice").worktree;
      const hidden = await api.request("carol", "GET", `/api/worktrees/${target}/previews`);
      const missing = await api.request("carol", "GET", "/api/worktrees/missing/previews");
      expect(hidden.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await hidden.json()).toEqual({ _tag: "WorktreeNotFound", id: target });
      expect(await missing.json()).toEqual({ _tag: "WorktreeNotFound", id: "missing" });
      expect(api.world.calls).toEqual([]);
    } finally {
      await api.dispose();
    }
  });

  it("a worktree removed after authorization answers the missing-worktree 404", async () => {
    const target = ids("shared-a").worktree;
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: (id) => Effect.fail(new WorktreeNotFoundError({ id })),
          },
        },
      },
    );
    try {
      const response = await api.request("alice", "GET", `/api/worktrees/${target}/previews`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ _tag: "WorktreeNotFound", id: target });
    } finally {
      await api.dispose();
    }
  });

  it("an authorized worktree without browser Services returns an empty list", async () => {
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.succeed([]),
            gatewaySnapshots: () => Effect.succeed(new Map()),
          },
          preparations: { latestForWorktree: () => Effect.succeed(null) },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "GET",
        `/api/worktrees/${ids("shared-a").worktree}/previews`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ previews: [], unprepared: null });
    } finally {
      await api.dispose();
    }
  });

  it("says what the bound preview's HTTP check answered, and what the last turn's preparation recorded", async () => {
    const target = ids("shared-a");
    const now = Date.now();
    const web: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: {
        _tag: "Bound",
        serviceId: ServiceId.make(target.service),
        attemptId: SessionProcessId.make(target.process),
        host: "rewrite",
        dial: "session-bound",
      },
    };
    const snapshot: PreviewGatewaySnapshot = {
      preview: web.preview,
      resolution: {
        _tag: "Bound",
        revision: 0,
        attempt: {
          serviceId: ServiceId.make(target.service),
          attemptId: SessionProcessId.make(target.process),
          sessionId: SessionId.make(target.session),
          workspaceId: SealantWorkspaceId.make("ws"),
          port: 3000,
          platformSessionId: "pty",
          host: "rewrite",
          dial: "session-bound",
        },
      },
    };
    const notCaptured: PreviewPreparation = {
      turnId: AgentTurnId.make("turn-1"),
      sessionId: SessionId.make(target.session),
      worktreeId: WorktreeId.make(target.worktree),
      claimedAt: new Date(now - 10_000),
      state: {
        _tag: "Decided",
        decision: { _tag: "NotCaptured" },
        decidedAt: new Date(now - 9_000),
      },
    };
    const api = await createTenancyApi(
      {},
      {
        implement: {
          previews: {
            ensureForWorktree: () => Effect.succeed([web]),
            gatewaySnapshots: () => Effect.succeed(new Map([[web.preview.id, snapshot]])),
          },
          observations: {
            latestForService: (serviceId) =>
              Effect.succeed(
                new ServiceObservation({
                  id: ServiceObservationId.make("observation-1"),
                  serviceId,
                  forwardId: ServiceForwardId.make("forward-1"),
                  state: "reachable",
                  source: "probe",
                  error: null,
                  httpStatus: 200,
                  firstObservedAt: new Date(now - 60_000),
                  lastObservedAt: new Date(now - 4_000),
                }),
              ),
          },
          preparations: { latestForWorktree: () => Effect.succeed(notCaptured) },
        },
      },
    );
    try {
      const response = await api.request(
        "alice",
        "GET",
        `/api/worktrees/${target.worktree}/previews`,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        previews: [
          {
            ...web,
            status: [
              expect.stringMatching(/^preview · web · answered HTTP 200 · observed [45] s ago$/),
            ],
          },
        ],
        unprepared: "preview not prepared · change not captured",
      });
    } finally {
      await api.dispose();
    }
  });

  it("drops a refusal once the owner's Start began an attempt after it, though the preview now sleeps", async () => {
    const target = ids("shared-a");
    const web: PreviewView = {
      preview: {
        id: PreviewId.make("preview-web"),
        projectId: ProjectId.make(target.project),
        worktreeId: WorktreeId.make(target.worktree),
        serviceName: "web",
        label: PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa"),
        state: "kept",
      },
      binding: { _tag: "Unbound", reason: "no-live-attempt" },
    };
    const snapshot: PreviewGatewaySnapshot = {
      preview: web.preview,
      resolution: {
        _tag: "Dormant",
        revision: 0,
        source: {
          serviceId: ServiceId.make(target.service),
          sourceAttemptId: SessionProcessId.make(target.process),
        },
        workspaceId: null,
      },
    };
    const notApproved = (decidedAt: Date): PreviewPreparation => ({
      turnId: AgentTurnId.make("turn-1"),
      sessionId: SessionId.make(target.session),
      worktreeId: WorktreeId.make(target.worktree),
      claimedAt: decidedAt,
      state: {
        _tag: "Decided",
        decision: { _tag: "NotApproved", service: "web", previewId: web.preview.id },
        decidedAt,
      },
    });
    const statusWith = async (preparation: PreviewPreparation) => {
      const api = await createTenancyApi(
        {},
        {
          implement: {
            previews: {
              ensureForWorktree: () => Effect.succeed([web]),
              gatewaySnapshots: () => Effect.succeed(new Map([[web.preview.id, snapshot]])),
            },
            preparations: { latestForWorktree: () => Effect.succeed(preparation) },
          },
        },
      );
      try {
        const response = await api.request(
          "alice",
          "GET",
          `/api/worktrees/${target.worktree}/previews`,
        );
        const body: { previews: ReadonlyArray<{ status: ReadonlyArray<string> }> } =
          await response.json();
        return body.previews.map((preview) => preview.status);
      } finally {
        await api.dispose();
      }
    };

    expect(await statusWith(notApproved(new Date("2000-01-01T00:00:00Z")))).toEqual([[]]);
    expect(await statusWith(notApproved(new Date(Date.now() + 86_400_000)))).toEqual([
      ["preview not prepared · web · recipe not approved · the owner's Start runs it"],
    ]);
  });
});
