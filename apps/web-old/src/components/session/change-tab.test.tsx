// @vitest-environment jsdom
import { SessionControlView, SessionDetail } from "@mend/api-contracts";
import {
  ChangeId,
  ProjectId,
  ReviewCommentId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Change, ReviewComment, Session, SessionProcess } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserTrpcClient, makeTrpcProxy, TRPCProvider } from "#/lib/trpc";
import { bodyText, urlText } from "#/test-fixtures/fake-fetch";

import { ChangeTab } from "./change-tab";
import { useSessionFacts } from "./facts";

vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});

const now = new Date("2026-11-18T12:00:00Z");
const session = new Session({
  id: SessionId.make("session-1"),
  projectId: ProjectId.make("project-1"),
  worktreeId: WorktreeId.make("worktree-1"),
  harness: "codex",
  providerSessionId: null,
  label: null,
  worktree: "review",
  branch: "mend/review",
  baseSha: Sha.make("0123456789abcdef"),
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
  ownerUserId: "owner-1",
  hasTranscript: false,
  status: "completed",
  summary: null,
  lastSeenSequence: 0n,
  recordHistoryComplete: true,
  startedAt: now,
  settledAt: now,
  createdAt: now,
  updatedAt: now,
});
const change = new Change({
  id: ChangeId.make("change-1"),
  projectId: session.projectId,
  worktreeId: session.worktreeId,
  sessionId: session.id,
  branch: session.branch,
  baseSha: session.baseSha,
  headSha: null,
  createdAt: now,
  updatedAt: now,
});
const agent = new SessionProcess({
  id: SessionProcessId.make("agent"),
  sessionId: session.id,
  sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
  sealantSessionId: null,
  sealantRunId: null,
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "agent-protocol",
  harness: "codex",
  providerSessionId: null,
  protocolOptions: null,
  label: "codex",
  argv: ["codex"],
  status: "stopped",
  exitCode: 0,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: now,
  exitedAt: now,
  updatedAt: now,
});
const detail = new SessionDetail({
  session,
  control: new SessionControlView({
    own: true,
    steer: true,
    stop: true,
    toggleSharedControl: true,
    terminalInput: true,
    turnsOnSendersLogin: false,
  }),
  checkpoints: [],
  change,
  repositories: [],
  landings: [],
  processes: [agent],
  currentAgent: agent,
  liveServices: 0,
  preReleaseMemory: null,
  launchAdmission: "agentRan",
});
const comment = (id: string, file: string | null, body: string) =>
  new ReviewComment({
    id: ReviewCommentId.make(id),
    changeId: change.id,
    file,
    line: file === null ? null : 1,
    endLine: null,
    anchor: null,
    authorKind: "reviewer",
    authorName: "Ana",
    body,
    kind: "note",
    suggestion: null,
    state: "open",
    evidence: [],
    sentToSessionId: null,
    createdAt: now,
    updatedAt: now,
  });

/**
 * The Change tab's side panel, over a server that keeps each comment's state: the comment list
 * reads what `setCommentState` last wrote, as the API does.
 */
const openPanel = async (comments: ReadonlyArray<ReviewComment>) => {
  const states = new Map(comments.map((row) => [row.id as string, row.state]));
  const stateChanges: unknown[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(urlText(input), "http://localhost");
    const paths = url.pathname.split("/trpc/")[1]?.split(",") ?? [];
    const replies = paths.map((path) => {
      if (path === "changes.setCommentState") {
        const sent = JSON.parse(bodyText(init)) as {
          0: { json: { commentId: string; request: { state: ReviewComment["state"] } } };
        };
        stateChanges.push(sent[0].json);
        states.set(sent[0].json.commentId, sent[0].json.request.state);
        return { result: { data: serialize(null) } };
      }
      if (path === "changes.comments")
        return {
          result: {
            data: serialize(
              comments.map((row) => ({ ...row, state: states.get(row.id) ?? row.state })),
            ),
          },
        };
      if (path === "sessions.detail") return { result: { data: serialize(detail) } };
      // Everything else the panel reads (the slice, passes, the record) stays out of this test.
      return {
        error: {
          json: {
            message: "Not in this test",
            code: -32004,
            data: { code: "NOT_FOUND", httpStatus: 404 },
          },
        },
      };
    });
    return Response.json(replies);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = browserTrpcClient();
  const trpc = makeTrpcProxy(client, trpcClient);
  client.setQueryData(trpc.sessions.detail.queryKey({ id: session.id }), detail);
  function Panel() {
    const facts = useSessionFacts(session.id);
    return <ChangeTab facts={facts} place="panel" />;
  }
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => (
        <Suspense>
          <Panel />
        </Suspense>
      ),
    }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TRPCProvider queryClient={client} trpcClient={trpcClient}>
          <RouterProvider router={router} />
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  });
  return { host, stateChanges };
};

/** The rows of `Comments <n> not sent`, by their text. */
const notSentRows = (host: HTMLElement) =>
  [...host.querySelectorAll("ul > li")].map((row) => row.textContent ?? "");

const press = async (host: HTMLElement, label: string, within?: string) => {
  const scope =
    within === undefined
      ? host
      : [...host.querySelectorAll("li, div")].findLast((element) =>
          element.textContent?.includes(within),
        );
  const button = [...(scope?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === undefined) throw new Error(`No ${label} button${within ? ` on ${within}` : ""}`);
  await act(async () => button.click());
};

describe("the comments not sent", () => {
  it("dismisses one before it is sent, out of the list and the next send, and reopens it", async () => {
    const page = await openPanel([
      comment("comment-1", null, "Say why VERIFY.md exists."),
      comment("comment-2", "VERIFY.md", "Add a trailing newline check."),
    ]);
    await vi.waitFor(() => expect(notSentRows(page.host)).toHaveLength(2));
    expect(page.host.textContent).toContain("2 not sent");
    expect(notSentRows(page.host)).toEqual([
      "whole changeSay why VERIFY.md exists.Mark addressedDismiss",
      "VERIFY.md:1Add a trailing newline check.Mark addressedDismiss",
    ]);
    expect(page.host.textContent).toContain("Send 2 to Codex");

    await press(page.host, "Dismiss", "Say why VERIFY.md exists.");
    await vi.waitFor(() => expect(page.host.textContent).toContain("1 not sent"));
    expect(page.stateChanges).toEqual([
      { id: "change-1", commentId: "comment-1", request: { state: "dismissed" } },
    ]);
    expect(notSentRows(page.host)).toEqual([
      "VERIFY.md:1Add a trailing newline check.Mark addressedDismiss",
    ]);
    expect(page.host.textContent).toContain("Send 1 to Codex");
    expect(page.host.textContent).toContain("Ana · dismissed");

    await press(page.host, "Reopen", "Ana · dismissed");
    await vi.waitFor(() => expect(page.host.textContent).toContain("2 not sent"));
    expect(page.stateChanges.at(-1)).toEqual({
      id: "change-1",
      commentId: "comment-1",
      request: { state: "open" },
    });
    expect(page.host.textContent).not.toContain("Ana · dismissed");
    expect(page.host.textContent).toContain("Send 2 to Codex");
  });

  it("marks one addressed before it is sent, which takes it out of the next send", async () => {
    const page = await openPanel([comment("comment-1", null, "Say why VERIFY.md exists.")]);
    await vi.waitFor(() => expect(notSentRows(page.host)).toHaveLength(1));

    await press(page.host, "Mark addressed", "Say why VERIFY.md exists.");
    await vi.waitFor(() => expect(page.host.textContent).toContain("0 not sent"));
    expect(page.stateChanges).toEqual([
      { id: "change-1", commentId: "comment-1", request: { state: "addressed" } },
    ]);
    expect(page.host.textContent).toContain("Ana · addressed");
    expect(page.host.textContent).toContain("Send 0 to Codex");
  });
});
