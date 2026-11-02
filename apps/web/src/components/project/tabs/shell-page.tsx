import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";

import { Button, focusRing } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { StatusWord } from "#/components/kit/status";
import { SessionTerminal } from "#/components/terminal";
import { stopSession, type ProjectDetailDto, type SessionDetailDto } from "#/lib/api";
import { startShellSession } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";
import { LIVE_STATES, worktreeDisplayName } from "#/lib/workbench-menus";

type WorkspaceImageDto = SessionDetailDto["session"]["workspaceImage"];

/** The login shell a family image switches to; a custom base promises only a POSIX shell. */
const loginShell = (...images: ReadonlyArray<WorkspaceImageDto>): string | null => {
  for (const image of images) {
    if (image === null) continue;
    return image.mode === "family" ? image.shell : null;
  }
  return null;
};

/**
 * A shell in a worktree's workspace (screen K10): it sees the same files as the worktree's
 * sessions. Another shell opens a second one beside it; Close ends this one and goes back to the
 * project. A shell is a session, so its terminal is the session's own, written to by its owner.
 */
export function ShellPage({
  detail,
  project,
}: {
  readonly detail: SessionDetailDto;
  readonly project: ProjectDetailDto;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { session, control } = detail;
  const worktree = project.worktrees.find((row) => row.id === session.worktreeId);
  const worktreeName =
    worktree === undefined
      ? session.branch
      : worktreeDisplayName(
          worktree,
          project.sessions.filter((row) => row.worktreeId === worktree.id),
        );
  const shell = loginShell(session.workspaceImage, project.project.workspaceImage);
  const facts = [
    worktreeName,
    session.sealantWorkspaceId === null
      ? null
      : `workspace ${session.sealantWorkspaceId.slice(0, 7)}`,
    shell,
  ].filter((part) => part !== null);
  const live = LIVE_STATES.has(session.status);

  const another = useMutation({
    mutationFn: () => startShellSession({ queryClient, trpc }, { worktreeId: session.worktreeId }),
    onSuccess: (started) =>
      navigate({
        to: "/projects/$projectId/shell/$sessionId",
        params: { projectId: project.project.id, sessionId: started.id },
      }),
  });
  const close = useMutation({
    mutationFn: () => (live ? stopSession(session.id) : Promise.resolve(null)),
    onSuccess: async () => {
      await queryClient.invalidateQueries(
        trpc.projects.detail.queryFilter({ id: project.project.id }),
      );
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      return navigate({ to: "/projects/$projectId", params: { projectId: project.project.id } });
    },
  });
  const failure = another.isError
    ? `Another shell did not start: ${another.error.message}`
    : close.isError
      ? `The shell did not stop: ${close.error.message}`
      : "";

  return (
    <main className="flex min-h-screen min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2.5 border-b border-rule-faint px-6 py-3.5">
        <nav
          aria-label="Breadcrumb"
          className="font-sans text-[13px] font-medium text-muted-foreground"
        >
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.project.id }}
            className={cn(
              "rounded-md text-muted-foreground no-underline hover:text-foreground",
              focusRing,
            )}
          >
            {project.project.name}
          </Link>
          {" / "}
          <h1 aria-current="page" className="inline font-medium text-foreground">
            Shell
          </h1>
        </nav>
        <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
          {facts.join(" · ")}
        </span>
        <span className="flex-1" />
        <p role="alert" className="font-mono text-[11px] text-danger empty:hidden">
          {failure}
        </p>
        {live ? null : <StatusWord tone="off">{session.status}</StatusWord>}
        <Button size="sm" disabled={another.isPending} onClick={() => another.mutate()}>
          <Icon name="plus" size={13} />
          {another.isPending ? "Starting…" : "Another shell"}
        </Button>
        <Button size="sm" disabled={close.isPending} onClick={() => close.mutate()}>
          {close.isPending ? "Closing…" : "Close"}
        </Button>
      </header>
      {/* Dark, as the session's Terminal tab and screen K10 draw a terminal. */}
      <div className="mx-6 mt-4 mb-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] bg-[#1e1f22] px-4 py-3.5 shadow-sm">
        {control.terminalInput ? null : (
          <p className="pb-2 font-mono text-[11.5px] text-[#9da0a8]">
            Read only: this shell is someone else&apos;s.
          </p>
        )}
        <div className="flex min-h-[420px] flex-1 flex-col">
          <SessionTerminal
            sessionId={session.id}
            startingLabel="the shell"
            readOnly={!control.terminalInput}
            palette="dark"
          />
        </div>
      </div>
    </main>
  );
}
