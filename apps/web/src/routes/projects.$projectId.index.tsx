import { useContextMenu } from "@mend/ui/context-menu";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, ListTree, Plus } from "lucide-react";
import { useState } from "react";

import { settledGroups, worktreeGroups } from "#/components/project-detail/model";
import { NewWorktreeDialog } from "#/components/project-detail/new-worktree-dialog";
import {
  ClearSettledButton,
  type ClearSettled,
  type DetailHandlers,
} from "#/components/project-detail/parts";
import {
  type RefusedRemoval,
  RemoveWorktreeAnywayDialog,
} from "#/components/project-detail/remove-worktree-anyway";
import { setWorktreeView, useWorktreeView } from "#/components/project-detail/view-choice";
import { ProjectWorktreeContent, WorktreeTree } from "#/components/project-detail/worktree-tree";
import { removeWorktree } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";
import { sessionMenu, worktreeDisplayName, worktreeMenu } from "#/lib/workbench-menus";
import { removalRefusalOf } from "#/lib/worktree-removal";

/** The Worktrees tab; the project layout (`projects.$projectId.tsx`) loads the project. */
export const Route = createFileRoute("/projects/$projectId/")({
  component: ProjectWorktreesPage,
});

const VIEWS = [
  { value: "list", label: "List", icon: ListTree },
  { value: "cards", label: "Cards", icon: LayoutGrid },
] as const;

function ProjectWorktreesPage() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const launchContext = { queryClient, trpc };
  const viewer = useViewer();
  const { project, sessions, hiddenEndedSessions, annotations, worktrees, worktreeAnnotations } =
    useSuspenseQuery(trpc.projects.detail.queryOptions({ id: projectId })).data;
  const navigate = useNavigate();
  const view = useWorktreeView();
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [clearing, setClearing] = useState<"idle" | "armed" | "working">("idle");
  // What a sweep left standing, said once beside its button; the next sweep replaces it.
  const [kept, setKept] = useState<string | null>(null);
  // A removal the store refused in words: the dialog shows them and offers the second step.
  const [refused, setRefused] = useState<RefusedRemoval | null>(null);
  const { openMenu, menuElement } = useContextMenu();

  const groups = worktreeGroups(worktrees, sessions, worktreeAnnotations, annotations);
  const settled = settledGroups(groups);
  const handlers: DetailHandlers = {
    onWorktreeMenu: (event, group) =>
      openMenu(
        event,
        worktreeMenu(
          group.worktree,
          group.members,
          group.annotation,
          navigate,
          launchContext,
          (refusal) =>
            setRefused({
              worktree: group.worktree,
              name: worktreeDisplayName(group.worktree, group.members),
              sessions: group.members.length,
              refusal,
            }),
        ),
      ),
    onSessionMenu: (event, session) =>
      openMenu(
        event,
        sessionMenu(
          session,
          annotations.find((row) => row.sessionId === session.id),
          navigate,
          launchContext,
          viewer,
        ),
      ),
  };

  // Removal stays explicit and sequential; changing the presentation cannot execute it.
  const clearSettled = () => {
    if (clearing === "idle") {
      setClearing("armed");
      return;
    }
    if (clearing !== "armed") return;
    setClearing("working");
    setKept(null);
    // The sweep never forces: a worktree the store refuses for a change not on origin stays, and
    // the count of those is said once. Its own menu shows the words and offers the second step.
    void settled
      .reduce(
        (chain, group) =>
          chain.then(async (unlanded) => {
            const refusal = await removeWorktree(group.worktree.id).then(
              () => null,
              (cause: unknown) => removalRefusalOf(cause),
            );
            return refusal?.forceable === true ? unlanded + 1 : unlanded;
          }),
        Promise.resolve(0),
      )
      .then((unlanded) => {
        if (unlanded > 0) {
          setKept(
            unlanded === 1
              ? "1 kept · its change is not on origin · remove it from its menu to see what it holds"
              : `${unlanded} kept · their changes are not on origin · remove one from its menu to see what it holds`,
          );
        }
        return null;
      })
      .finally(() => {
        setClearing("idle");
        void queryClient.invalidateQueries(trpc.projects.pathFilter());
        void queryClient.invalidateQueries(trpc.worktrees.pathFilter());
        void queryClient.invalidateQueries(trpc.environment.pathFilter());
      });
  };
  const clear: ClearSettled = {
    count: settled.length,
    state: clearing,
    note: kept,
    onClear: clearSettled,
    onBlur: () => setClearing((current) => (current === "armed" ? "idle" : current)),
  };

  return (
    <>
      <section aria-labelledby="project-worktrees-heading" className="mt-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <h2 id="project-worktrees-heading" className="text-sm font-medium">
              Worktrees
            </h2>
            <span className="font-mono text-xs text-faint">{groups.length}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Worktree view"
              className="flex gap-1 rounded-lg border border-rule bg-panel p-1 shadow-xs"
            >
              {VIEWS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={view === value}
                  onClick={() => setWorktreeView(value)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${view === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Icon className="size-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setNewWorktreeOpen(true)}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)]"
            >
              <Plus className="size-4" aria-hidden="true" />
              New worktree
            </button>
          </div>
        </div>

        <ProjectWorktreeContent
          hiddenEndedSessions={hiddenEndedSessions}
          worktreeCount={groups.length}
          onCreate={() => setNewWorktreeOpen(true)}
        >
          <WorktreeTree groups={groups} view={view} handlers={handlers} />
        </ProjectWorktreeContent>
        <ClearSettledButton clear={clear} />
      </section>
      <NewWorktreeDialog
        project={project}
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
      />
      <RemoveWorktreeAnywayDialog
        refused={refused}
        onKeep={() => setRefused(null)}
        onRemoved={() => {
          setRefused(null);
          void queryClient.invalidateQueries(trpc.environment.pathFilter());
        }}
      />
      {menuElement}
    </>
  );
}
