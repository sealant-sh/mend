import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuGroup, MenuItem, MenuMeta, MenuSeparator } from "#/components/kit/menu";
import { worktreeGroups } from "#/components/project-detail/model";
import type { ProjectDetailDto, SessionDto, WorktreeDto } from "#/lib/api";
import { startShellSession } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";
import { worktreeDisplayName } from "#/lib/workbench-menus";

type ShellTarget =
  | { readonly worktreeId: WorktreeDto["id"] }
  | { readonly projectId: string; readonly base: string | null };

/** "2 sessions" while any run there, "stopped" when none does. */
export const worktreeLiveWords = (live: number): string =>
  live === 0 ? "stopped" : `${live} session${live === 1 ? "" : "s"}`;

/**
 * Open a shell (screen K9): pick a worktree and the shell runs in that worktree's workspace, beside
 * its sessions; or start a new worktree from the default branch. The shell opens on the project's
 * Shell page (K10). Starting is a real request: the button says so while it runs, and a refusal
 * is announced beside it.
 */
export function OpenShellMenu({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { project } = detail;
  const groups = worktreeGroups(detail.worktrees, detail.sessions, detail.worktreeAnnotations);
  const start = useMutation({
    mutationFn: (target: ShellTarget) => startShellSession({ queryClient, trpc }, target),
    onSuccess: (session: SessionDto) =>
      navigate({
        to: "/projects/$projectId/shell/$sessionId",
        params: { projectId: project.id, sessionId: session.id },
      }),
  });

  return (
    <div className="relative">
      <Menu
        align="end"
        width={300}
        trigger={
          <Button disabled={start.isPending} aria-describedby="open-shell-error">
            {start.isPending ? "Starting a shell…" : "Open a shell"}
          </Button>
        }
      >
        <MenuGroup label="Open a shell in">
          {groups.map((group) => (
            <MenuItem
              key={group.worktree.id}
              onClick={() => start.mutate({ worktreeId: group.worktree.id })}
            >
              <span className="min-w-0 truncate font-mono text-[12.5px]">
                {worktreeDisplayName(group.worktree, group.members)}
              </span>
              <MenuMeta>{worktreeLiveWords(group.live)}</MenuMeta>
            </MenuItem>
          ))}
        </MenuGroup>
        {groups.length === 0 ? null : <MenuSeparator />}
        <MenuItem onClick={() => start.mutate({ projectId: project.id, base: null })}>
          <Icon name="plus" size={13} />A new worktree from {project.defaultBranch}
        </MenuItem>
      </Menu>
      <p
        id="open-shell-error"
        role="alert"
        className="absolute top-full right-0 mt-1.5 w-max max-w-[320px] font-mono text-[11px] text-danger empty:hidden"
      >
        {start.isError ? `The shell did not start: ${start.error.message}` : ""}
      </p>
    </div>
  );
}
