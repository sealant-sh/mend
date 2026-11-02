// @vitest-environment jsdom
import {
  ProjectCapabilities,
  ProjectDetail,
  SessionControlView,
  SessionDetail,
} from "@mend/api-contracts";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Project, Session, Worktree } from "@mend/domain/workbench";
import { RouterProvider } from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getRouter } from "#/router";

// Before the app's modules load: better-auth's createAuthClient keeps the fetch it finds then.
// Nothing here is answered over the network: every read the switch needs is already cached, as
// a hover or touch on the row leaves it.
vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  // A session's detail that was never cached stays in flight, as on a slow phone network.
  vi.stubGlobal("fetch", (input: unknown) =>
    String(input instanceof Request ? input.url : input).includes("sessions.detail")
      ? new Promise(() => {})
      : Promise.resolve(Response.json({ message: "not answered" }, { status: 500 })),
  );
  vi.stubGlobal(
    "EventSource",
    class {
      readyState = 0;
      addEventListener() {}
      close() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const NOW = new Date("2026-11-02T10:00:00Z");
const PROJECT = ProjectId.make("proj-1");

const project = new Project({
  id: PROJECT,
  organizationId: OrganizationId.make("org-1"),
  visibility: "shared",
  createdByUserId: "dana",
  storePath: "/store/proj-1/repo.git",
  name: "billing",
  originUrl: null,
  defaultBranch: "main",
  adoptedSha: Sha.make("0123456789abcdef"),
  autoTour: "off",
  autoSuggest: "off",
  autoName: "off",
  autoLand: "inherit",
  backgroundSessions: "off",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: false,
  defaultShellProfile: true,
  inheritUserSkills: false,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const worktree = (name: string) =>
  new Worktree({
    id: WorktreeId.make(`wt-${name}`),
    projectId: PROJECT,
    name,
    directory: name,
    branch: `mend/${name}`,
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    handoff: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const session = (name: string, label: string) =>
  new Session({
    id: SessionId.make(`sess-${name}`),
    projectId: PROJECT,
    worktreeId: WorktreeId.make(`wt-${name}`),
    harness: "claude",
    providerSessionId: null,
    label,
    worktree: name,
    branch: `mend/${name}`,
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
    ownerUserId: "dana",
    hasTranscript: true,
    status: "waiting",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const first = session("rate-limit", "Add a rate limit");
const second = session("retry-queue", "Retry the webhook queue");
/** Listed in the inbox, its detail never read yet. */
const uncached = session("flaky-tests", "Quarantine the flaky tests");

const detailOf = (row: Session) =>
  new SessionDetail({
    session: row,
    control: new SessionControlView({
      own: true,
      steer: true,
      stop: true,
      toggleSharedControl: true,
      terminalInput: true,
      turnsOnSendersLogin: false,
    }),
    checkpoints: [],
    change: null,
    repositories: [],
    landings: [],
    processes: [],
    currentAgent: null,
    liveServices: 0,
    preReleaseMemory: null,
    launchAdmission: "agentRan",
  });

/** The client hands out plain data (server/api/run.ts), never Schema instances. */
const plain = <A,>(value: A): A => structuredClone(value);

let root: Root;
let host: HTMLDivElement;

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

/** The app at `href`, its cache holding what the tRPC client would decode for each read. */
const open = async (href: string) => {
  window.history.replaceState(null, "", href);
  const router = getRouter();
  const { queryClient, trpc } = router.options.context;
  queryClient.setQueryData(trpc.projects.list.queryKey(), plain([project]));
  queryClient.setQueryData(trpc.sessions.inboxMarks.queryKey(), []);
  queryClient.setQueryData(
    trpc.projects.detail.queryKey({ id: PROJECT }),
    plain(
      new ProjectDetail({
        project,
        sessions: [first, second, uncached],
        hiddenEndedSessions: 0,
        annotations: [],
        worktrees: [worktree("rate-limit"), worktree("retry-queue"), worktree("flaky-tests")],
        worktreeAnnotations: [],
        capabilities: new ProjectCapabilities({
          manage: true,
          changeVisibility: true,
          remove: true,
          hostMounts: false,
        }),
        mountDelivery: "sources",
      }),
    ),
  );
  for (const row of [first, second]) {
    queryClient.setQueryData(trpc.sessions.detail.queryKey({ id: row.id }), plain(detailOf(row)));
    queryClient.setQueryData(trpc.sessions.pendingFollowUp.queryKey({ id: row.id }), null);
  }
  await act(async () => root.render(<RouterProvider router={router} />));
  await settle();
  return router;
};

const inbox = () => host.querySelector('aside[aria-label="Sessions"]');
const rail = () => host.querySelector('aside[aria-label="Mend"]');
const rowLink = (title: string) => {
  const link = [...host.querySelectorAll('aside[aria-label="Sessions"] a')].find((element) =>
    element.textContent?.includes(title),
  );
  if (!(link instanceof HTMLAnchorElement)) throw new Error(`no inbox row "${title}"`);
  return link;
};
const heading = () => host.querySelector("main h1")?.textContent ?? "";

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("switching sessions from the inbox", () => {
  it("keeps the same inbox and rail on the page and shows the next session from the cache", async () => {
    const router = await open(`/sessions/${first.id}`);
    const before = { inbox: inbox(), rail: rail() };
    expect(before.inbox).not.toBeNull();
    expect(heading()).toContain("Add a rate limit");

    await act(async () => rowLink("Retry the webhook queue").click());
    await settle();

    expect(router.state.location.pathname).toBe(`/sessions/${second.id}`);
    expect(heading()).toContain("Retry the webhook queue");
    expect(inbox()).toBe(before.inbox);
    expect(rail()).toBe(before.rail);
    expect(rowLink("Retry the webhook queue").getAttribute("aria-current")).toBe("page");
  });

  it("keeps the same inbox from Sessions into a session and back", async () => {
    const router = await open("/");
    const before = inbox();
    expect(before).not.toBeNull();

    await act(async () => rowLink("Add a rate limit").click());
    await settle();
    expect(router.state.location.pathname).toBe(`/sessions/${first.id}`);
    expect(heading()).toContain("Add a rate limit");
    expect(inbox()).toBe(before);

    await act(async () => router.navigate({ to: "/" }));
    await settle();
    expect(heading()).toContain("What should an agent work on?");
    expect(inbox()).toBe(before);
  });

  it("keeps the previous session on screen, marked busy, while an uncached one is read", async () => {
    const router = await open(`/sessions/${first.id}`);
    const before = inbox();

    await act(async () => rowLink("Quarantine the flaky tests").click());
    await settle();

    expect(router.state.location.pathname).toBe(`/sessions/${uncached.id}`);
    expect(rowLink("Quarantine the flaky tests").getAttribute("aria-current")).toBe("page");
    expect(heading()).toContain("Add a rate limit");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(host.textContent).toContain("Opening the session…");
    expect(inbox()).toBe(before);
  });
});
