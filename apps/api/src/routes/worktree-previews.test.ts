import { WorktreeNotFoundError } from "@mend/db";
import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  ServiceId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import { type PreviewView } from "@mend/domain/workbench";
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
          },
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
        expect(await response.json()).toEqual([bound, unbound]);
      }
      expect(seen).toEqual([target.worktree, target.worktree]);
      expect(api.world.calls).toEqual(["previews.ensureForWorktree", "previews.ensureForWorktree"]);
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
          },
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
      expect(await response.json()).toEqual([]);
    } finally {
      await api.dispose();
    }
  });
});
