import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, Pick } from "#/components/kit/button";
import { GroupField } from "#/components/kit/field";
import { FuzzyFinder } from "#/components/kit/finder";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { worktreeGroups, type WorktreeGroup } from "#/components/project-detail/model";
import type { ProjectDetailDto } from "#/lib/api";
import { startShellSession } from "#/lib/session-launch";
import { useTRPC } from "#/lib/trpc";
import { copyText, LIVE_STATES, worktreeDisplayName } from "#/lib/workbench-menus";

/** The extension's own URI: `/open?session=` opens that session's workspace (apps/vscode). */
const vscodeOpenUri = (sessionId: string) =>
  `vscode://sealant-sh.mend/open?session=${encodeURIComponent(sessionId)}`;

const NEW = "new";
/** How many worktrees the segment shows before the rest move into a finder. */
const SEGMENT_WORKTREES = 2;

/**
 * Open in VS Code (screen K11): pick a worktree and VS Code opens its workspace through the Mend
 * extension, or copy the SSH line for Remote-SSH. A worktree with no session yet, or a new one,
 * gets a shell session first, since VS Code opens a session's workspace.
 */
export function OpenInVsCode({ detail }: { readonly detail: ProjectDetailDto }) {
  const [open, setOpen] = useState(false);
  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>Open in VS Code</Button>}
      title={`Open ${detail.project.name} in VS Code`}
      description="VS Code opens the worktree in its workspace through the Mend extension. Your files stay on the Mend server."
      width={520}
    >
      {open ? <OpenInVsCodeForm detail={detail} onDone={() => setOpen(false)} /> : null}
    </ModalDialog>
  );
}

function OpenInVsCodeForm({
  detail,
  onDone,
}: {
  readonly detail: ProjectDetailDto;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { project } = detail;
  const groups = worktreeGroups(detail.worktrees, detail.sessions, detail.worktreeAnnotations);
  const [choice, setChoice] = useState<string>(groups[0]?.worktree.id ?? NEW);
  const chosen = groups.find((group) => group.worktree.id === choice);
  const gateway = useQuery(trpc.platform.workspaceSsh.queryOptions()).data?.gateway ?? null;
  const live = chosen?.members.find((session) => LIVE_STATES.has(session.status));
  const workspaceId = live?.sealantWorkspaceId ?? null;
  const sshLine =
    gateway === null || workspaceId === null
      ? null
      : `ssh -p ${gateway.port} ${gateway.usernamePrefix}-${workspaceId}@${gateway.host}`;

  const openIt = useMutation({
    mutationFn: async (group: WorktreeGroup | undefined) => {
      const existing = group?.newest ?? null;
      if (existing !== null) return existing.id;
      const started = await startShellSession(
        { queryClient, trpc },
        group === undefined
          ? { projectId: project.id, base: null }
          : { worktreeId: group.worktree.id },
      );
      return started.id;
    },
    onSuccess: (sessionId) => {
      window.location.href = vscodeOpenUri(sessionId);
      onDone();
    },
  });

  const shown = groups.slice(0, SEGMENT_WORKTREES);
  const rest = groups.slice(SEGMENT_WORKTREES);
  const options = [
    ...shown.map((group) => ({
      value: group.worktree.id,
      label: (
        <span className="font-mono text-[12.5px]">
          {worktreeDisplayName(group.worktree, group.members)}
        </span>
      ),
    })),
    ...(rest.some((group) => group.worktree.id === choice) && chosen !== undefined
      ? [
          {
            value: chosen.worktree.id,
            label: (
              <span className="font-mono text-[12.5px]">
                {worktreeDisplayName(chosen.worktree, chosen.members)}
              </span>
            ),
          },
        ]
      : []),
    { value: NEW, label: `A new one from ${project.defaultBranch}` },
  ];

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        openIt.mutate(chosen);
      }}
    >
      <GroupField label="Worktree">
        <div className="flex flex-wrap items-center gap-2">
          <Segment
            label="Worktree"
            value={choice}
            options={options}
            onChange={setChoice}
            disabled={openIt.isPending}
          />
          {rest.length === 0 ? null : (
            <FuzzyFinder
              label="Another worktree"
              items={rest}
              itemKey={(group) => group.worktree.id}
              itemText={(group) => worktreeDisplayName(group.worktree, group.members)}
              meta={(group) => group.worktree.branch}
              onPick={(group) => setChoice(group.worktree.id)}
              placeholder="Find a worktree"
              trigger={<Pick size="sm">Another worktree</Pick>}
            />
          )}
        </div>
      </GroupField>
      {chosen === undefined || chosen.newest === null ? (
        <p className="text-[12.5px] text-muted-foreground">
          VS Code opens a session&apos;s workspace, so Mend starts a shell session there first.
        </p>
      ) : null}
      <p className="text-[12.5px] text-muted-foreground">
        It opens through the Mend extension in VS Code. Mend cannot see which extensions this
        computer has, so it does not say whether it is installed.
      </p>
      {sshLine === null ? null : (
        <GroupField label="Or over Remote-SSH">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 rounded-[10px] bg-secondary px-3 py-2 font-mono text-[12px] break-all text-ink-2">
              {sshLine}
            </code>
            <Button size="sm" variant="ghost" onClick={() => copyText(sshLine)}>
              Copy
            </Button>
          </div>
        </GroupField>
      )}
      <p role="alert" className="font-mono text-[11.5px] text-danger empty:hidden">
        {openIt.isError ? `VS Code did not open: ${openIt.error.message}` : ""}
      </p>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onDone} disabled={openIt.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={openIt.isPending}>
          {openIt.isPending ? "Starting the workspace…" : "Open in VS Code"}
        </Button>
      </div>
    </form>
  );
}
