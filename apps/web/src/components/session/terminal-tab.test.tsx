// @vitest-environment jsdom
import { SessionControlView, SessionDetail } from "@mend/api-contracts";
import {
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Session, SessionProcess, noResumeLine } from "@mend/domain/workbench";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { serialize } from "superjson";
import { afterEach, describe, expect, it, vi } from "vitest";

import { browserTrpcClient, makeTrpcProxy, TRPCProvider } from "#/lib/trpc";

import { useSessionFacts } from "./facts";
import { TerminalTab } from "./terminal-tab";

vi.hoisted(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  vi.unstubAllGlobals();
});

const stopped = (harness: string) => {
  const now = new Date("2026-11-06T19:00:00Z");
  return new Session({
    id: SessionId.make(`session-${harness}`),
    projectId: ProjectId.make("project-1"),
    worktreeId: WorktreeId.make("worktree-1"),
    harness,
    providerSessionId: null,
    label: null,
    worktree: "resume",
    branch: "mend/resume",
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
    status: "stopped",
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: now,
    settledAt: now,
    createdAt: now,
    updatedAt: now,
  });
};

const openTab = async (
  harness: string,
  agentKind: "agent-pty" | "agent-protocol" = "agent-pty",
  existingShells: ReadonlyArray<string> = [],
) => {
  const session = stopped(harness);
  const process = (id: string, kind: SessionProcess["kind"], live: boolean) =>
    structuredClone(
      new SessionProcess({
        id: SessionProcessId.make(id),
        sessionId: session.id,
        sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
        sealantSessionId: `${id}-pty`,
        sealantRunId: null,
        launchCorrelationId: null,
        serviceId: null,
        attemptOrdinal: null,
        kind,
        harness:
          kind === "shell" ? null : id === "resumed-agent" && harness === "run" ? "shell" : harness,
        providerSessionId: null,
        protocolOptions: null,
        label: kind === "shell" ? (id === "opened-shell" ? "new shell" : id) : harness,
        argv: ["bash"],
        status: live ? "running" : "stopped",
        exitCode: null,
        workspacePort: null,
        protocol: "tcp",
        hostPort: null,
        createdAt: session.createdAt,
        exitedAt: live ? null : session.settledAt,
        updatedAt: session.updatedAt,
      }),
    );
  const currentAgent = process("agent", agentKind, false);
  const resumedAgent = process("resumed-agent", agentKind, true);
  const shell = process("opened-shell", "shell", true);
  const previousShells = existingShells.map((id) => process(id, "shell", true));
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
    change: null,
    repositories: [],
    landings: [],
    processes: [currentAgent, ...previousShells],
    currentAgent,
    liveServices: 0,
    preReleaseMemory: null,
    launchAdmission: "agentRan",
  });
  const resumes: unknown[] = [];
  const shells: unknown[] = [];
  let resumed = false;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    // Terminal rendering is exercised below; its Wasm renderer has no canvas in jsdom.
    if (url.pathname.endsWith(".wasm")) return new Promise<Response>(() => {});
    const body: unknown = JSON.parse(String(init?.body));
    const replies = (url.pathname.split("/trpc/")[1]?.split(",") ?? []).map((path) => {
      if (path === "sessions.resume") {
        resumes.push(body);
        if (harness === "run" && !JSON.stringify(body).includes('"harness":"shell"')) {
          return {
            error: {
              json: {
                message: noResumeLine(harness),
                code: -32600,
                data: { code: "BAD_REQUEST", httpStatus: 400 },
              },
            },
          };
        }
        resumed = true;
      }
      if (path === "sessions.openShell") shells.push(body);
      const data =
        path === "sessions.detail"
          ? {
              ...detail,
              // A shell resume keeps the session's original harness identity.
              session: resumed
                ? { ...session, status: "running", settledAt: null, sealantSessionId: "shell-pty" }
                : { ...session },
              currentAgent: resumed ? resumedAgent : currentAgent,
            }
          : path === "sessions.processes"
            ? shells.length > 0
              ? [resumedAgent, ...previousShells, shell]
              : resumed
                ? [resumedAgent, ...previousShells]
                : [currentAgent, ...previousShells]
            : path === "sessions.openShell"
              ? shell
              : path === "organization.current"
                ? { userId: "owner-1", organization: { id: "org-1" }, role: "owner" }
                : path === "projects.detail"
                  ? null
                  : path === "screens.read"
                    ? { _tag: "NoScreen", reason: "not-started" }
                    : path === "sessions.resume"
                      ? { ...session }
                      : [];
      return { result: { data: serialize(data) } };
    });
    return Response.json(replies);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = browserTrpcClient();
  const trpc = makeTrpcProxy(client, trpcClient);
  client.setQueryData(trpc.sessions.detail.queryKey({ id: session.id }), detail);
  const host = document.createElement("div");
  const root = createRoot(host);
  function Tab() {
    const facts = useSessionFacts(session.id);
    return <TerminalTab facts={facts} shown />;
  }
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <TRPCProvider queryClient={client} trpcClient={trpcClient}>
          <Suspense>
            <Tab />
          </Suspense>
        </TRPCProvider>
      </QueryClientProvider>,
    ),
  );
  cleanups.push(async () => {
    await act(async () => root.unmount());
    client.clear();
  });
  if (existingShells.length > 0) {
    const selected = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === existingShells.at(-1),
    );
    if (selected === undefined) throw new Error("No existing shell to select");
    await act(async () => selected.click());
  }
  const resume = host.querySelector<HTMLButtonElement>(
    'button[aria-label="Resume the session and open a shell"]',
  );
  if (resume === null) throw new Error("No resume/open-shell button");
  await act(async () => resume.click());
  await act(async () => {
    await vi.waitFor(() => expect(resumes).toHaveLength(1));
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
  });
  return { host, resumes, shells, session };
};

describe("opening a stopped session's terminal", () => {
  it("resumes a run session as a shell and shows that terminal without opening another shell", async () => {
    const page = await openTab("run");
    expect(page.host.querySelector('[role="alert"]')).toBeNull();
    expect(page.resumes).toEqual([
      { 0: { json: { id: page.session.id, request: { harness: "shell" } } } },
    ]);
    expect(page.shells).toEqual([]);
    expect(page.host.textContent).toContain("connecting");
    expect(page.host.textContent).not.toContain("The workspace is not running");
    expect(page.host.textContent).not.toContain("Opening a shell");
  });

  it.each(["shell", "claude"])(
    "keeps a stopped %s terminal on its own harness",
    async (harness) => {
      const page = await openTab(harness);
      expect(page.resumes).toEqual([
        { 0: { json: { id: page.session.id, request: { harness: null } } } },
      ]);
      expect(page.shells).toEqual([]);
      expect(page.host.textContent).toContain("connecting");
    },
  );

  it("shows the resumed shell when another workspace shell was selected", async () => {
    const page = await openTab("run", "agent-pty", ["earlier shell", "selected shell"]);
    expect(page.host.querySelector('[aria-pressed="true"]')?.textContent).toBe("run");
    expect(page.shells).toEqual([]);
  });

  it("resumes a conversation and selects the shell opened beside it", async () => {
    const page = await openTab("claude", "agent-protocol");
    expect(page.resumes).toEqual([
      { 0: { json: { id: page.session.id, request: { harness: null } } } },
    ]);
    expect(page.shells).toEqual([{ 0: { json: { id: page.session.id } } }]);
    expect(page.host.querySelector('[aria-pressed="true"]')?.textContent).toBe("new shell");
    expect(page.host.textContent).toContain("Close this shell");
    expect(page.host.textContent).toContain("connecting");
  });
});
