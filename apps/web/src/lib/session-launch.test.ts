import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { QueryClient } from "@tanstack/react-query";
import { serialize } from "superjson";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { SessionDto, WorktreeDto } from "#/lib/api";
import {
  startComposedSession,
  startComposedSessionInWorktree,
  type SessionStartSpec,
} from "#/lib/session-launch";
import { makeTrpcProxy } from "#/lib/trpc";
import { worktreeMenu } from "#/lib/workbench-menus";

const session: SessionDto = {
  id: SessionId.make("session-created"),
  projectId: ProjectId.make("project-selected"),
  worktreeId: WorktreeId.make("worktree-selected"),
  harness: "codex",
  providerSessionId: null,
  label: null,
  worktree: "/store/worktrees/selected",
  branch: "mend/selected",
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
  baseRef: "main",
  contextSnapshotId: null,
  referenceMounts: [],
  extraMounts: [],
  sealantRunId: null,
  sealantWorkspaceId: null,
  sealantSessionId: null,
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  workspaceImage: null,
  dotfiles: null,
  ownerUserId: null,
  sharedControlEnabledByUserId: null,
  sharedControlEnabledAt: null,
  hasTranscript: null,
  status: "idle",
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: true,
  startedAt: null,
  settledAt: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const clients: QueryClient[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients) client.clear();
  clients.length = 0;
});

// Exercise the real API wrappers and tRPC serialization against an inert HTTP endpoint.
const fixture = (failures: { readonly create?: boolean; readonly launch?: boolean } = {}) => {
  const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
  const navigations: unknown[] = [];
  const queryClient = new QueryClient();
  clients.push(queryClient);
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.split("/trpc/")[1];
    if (path === undefined) throw new Error("Unexpected request outside the fixture");
    const body: unknown = await request.json();
    requests.push({ path, body });
    if (
      path !== "worktrees.createSession" &&
      path !== "sessions.create" &&
      path !== "sessions.launch"
    ) {
      throw new Error(`Unexpected procedure: ${path}`);
    }
    if (
      (path === "worktrees.createSession" && failures.create) ||
      (path === "sessions.launch" && failures.launch)
    ) {
      return Response.json([
        {
          error: serialize({
            message: "Fixture refusal",
            code: -32603,
            data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
          }),
        },
      ]);
    }
    return Response.json([{ result: { data: serialize(session) } }]);
  });
  return {
    requests,
    navigations,
    navigate: async (options: unknown): Promise<void> => {
      navigations.push(options);
    },
    context: { queryClient, trpc: makeTrpcProxy(queryClient) },
  };
};

const selectedWorktreeId = WorktreeId.make("worktree-selected");

describe("Composed session launch", () => {
  it("joins the chosen worktree and forwards the prompt and harness settings", async () => {
    const f = fixture();
    await startComposedSessionInWorktree(f.navigate, f.context, selectedWorktreeId, {
      harness: "codex",
      prompt: "  Review the change  ",
      model: "gpt-5.4",
      effort: "high",
      permissionMode: "ask",
      speed: "fast",
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests).toEqual([
      {
        path: "worktrees.createSession",
        body: {
          0: { json: { id: selectedWorktreeId, session: { harness: "codex", label: null } } },
        },
      },
      {
        path: "sessions.launch",
        body: {
          0: {
            json: {
              id: session.id,
              request: {
                prompt: "Review the change",
                model: "gpt-5.4",
                effort: "high",
                permissionMode: "ask",
                speed: "fast",
              },
            },
          },
        },
      },
    ]);
    expect(f.navigations).toEqual([
      { to: "/sessions/$sessionId", params: { sessionId: session.id } },
    ]);
  });

  it("omits an empty prompt and unspecified settings", async () => {
    const f = fixture();
    await startComposedSessionInWorktree(f.navigate, f.context, selectedWorktreeId, {
      harness: "claude",
      prompt: "  ",
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests[1]?.body).toEqual({ 0: { json: { id: session.id, request: {} } } });
  });

  it("does not launch, navigate, or provision another worktree when session creation fails", async () => {
    const f = fixture({ create: true });
    await expect(
      startComposedSessionInWorktree(f.navigate, f.context, selectedWorktreeId, {
        harness: "codex",
        prompt: "Keep this draft",
      }),
    ).rejects.toThrow("Fixture refusal");
    expect(f.requests.map((request) => request.path)).toEqual(["worktrees.createSession"]);
    expect(f.navigations).toEqual([]);
  });

  it("opens the created session even when its launch fails, without retrying creation", async () => {
    const f = fixture({ launch: true });
    await startComposedSessionInWorktree(f.navigate, f.context, selectedWorktreeId, {
      harness: "codex",
      prompt: "Review",
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests.map((request) => request.path)).toEqual([
      "worktrees.createSession",
      "sessions.launch",
    ]);
    expect(f.navigations).toEqual([
      { to: "/sessions/$sessionId", params: { sessionId: session.id } },
    ]);
  });

  it("preserves the separate project quick-start operation", async () => {
    const f = fixture();
    await startComposedSession(f.navigate, f.context, session.projectId, {
      harness: "shell",
      prompt: "",
    });
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests[0]).toEqual({
      path: "sessions.create",
      body: {
        0: {
          json: {
            projectId: session.projectId,
            session: { harness: "shell", label: null, name: null, base: null },
          },
        },
      },
    });
  });

  it("launches the agent when the worktree context menu starts a session", async () => {
    const f = fixture();
    const worktree: WorktreeDto = {
      id: selectedWorktreeId,
      projectId: session.projectId,
      name: "selected",
      directory: session.worktree,
      branch: session.branch,
      baseRef: session.baseRef,
      baseSha: session.baseSha,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
    const menu = worktreeMenu(worktree, [], undefined, f.navigate, f.context);
    const action = menu.entries.find(
      (entry) => entry !== "separator" && entry.label === "Start codex session here",
    );
    if (action === undefined || action === "separator") throw new Error("Start action missing");
    action.onSelect();
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.requests.map((request) => request.path)).toEqual([
      "worktrees.createSession",
      "sessions.launch",
    ]);
    expect(f.requests[0]?.body).toEqual({
      0: { json: { id: selectedWorktreeId, session: { harness: "codex", label: null } } },
    });
    expect(f.requests[1]?.body).toEqual({ 0: { json: { id: session.id, request: {} } } });
    expect(f.navigations).toEqual([
      { to: "/sessions/$sessionId", params: { sessionId: session.id } },
    ]);
  });

  it("requires a worktree identity and excludes worktree creation settings", () => {
    expectTypeOf<Parameters<typeof startComposedSessionInWorktree>[2]>().toEqualTypeOf<
      WorktreeDto["id"]
    >();
    expectTypeOf<SessionStartSpec>().not.toHaveProperty("base");
    expectTypeOf<SessionStartSpec>().not.toHaveProperty("name");
  });
});
