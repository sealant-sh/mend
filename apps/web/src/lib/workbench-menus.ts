import type { Viewer } from "@mend/domain/workbench";
import type { ContextMenuEntry, ContextMenuSpec } from "@mend/ui/context-menu";
import type { UseNavigateResult } from "@tanstack/react-router";

import {
  checkpointSession,
  removeProject,
  removeSession,
  removeWorktree,
  resumeSession,
  stopSession,
  type ProjectDto,
  type SessionAnnotationDto,
  type SessionDto,
  type WorktreeAnnotationDto,
  type WorktreeDto,
} from "#/lib/api";
import {
  HARNESSES,
  startComposedSession,
  startComposedSessionInWorktree,
  type Harness,
  type LaunchContext,
} from "#/lib/session-launch";
import { canRemove, sessionActions } from "#/lib/viewer";

/** Session states with a live process behind them. */
export const LIVE_STATES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

type Navigate = UseNavigateResult<string>;

/** Quick-start a bare session — the composer's path with no prompt or knobs. */
export const startSession = (
  navigate: Navigate,
  context: LaunchContext,
  projectId: string,
  harness: Harness,
) => startComposedSession(navigate, context, projectId, { harness, prompt: "" });

/** Clipboard write with a fallback for non-secure origins (LAN over http). */
export const copyText = (text: string) => {
  if (typeof navigator.clipboard?.writeText === "function") {
    void navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
};

const fallbackCopy = (text: string) => {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
};

/** The right-click menu for a project row/card in a list. */
export const projectMenu = (
  project: ProjectDto,
  navigate: Navigate,
  context: LaunchContext,
  viewer: Viewer | null,
): ContextMenuSpec => {
  const { queryClient, trpc } = context;
  const entries: ContextMenuEntry[] = [
    {
      label: "Open project",
      onSelect: () =>
        void navigate({ to: "/projects/$projectId", params: { projectId: project.id } }),
    },
    "separator",
    ...HARNESSES.map(
      (harness): ContextMenuEntry => ({
        label: `Start ${harness} session`,
        onSelect: () => void startSession(navigate, context, project.id, harness),
      }),
    ),
    "separator",
    { label: "Copy store path", flash: "Copied", onSelect: () => copyText(project.storePath) },
  ];
  const originUrl = project.originUrl;
  if (originUrl !== null) {
    entries.push({
      label: "Copy origin URL",
      flash: "Copied",
      onSelect: () => copyText(originUrl),
    });
  }
  if (!canRemove(project, viewer)) return { title: project.name, entries };
  entries.push("separator", {
    label: "Remove project…",
    confirm: "Really remove project and store copy?",
    danger: true,
    onSelect: () => {
      // The list refetches before the detail cache is dropped, so the
      // removed project's detail query unmounts instead of refetching a 404.
      void removeProject(project.id)
        .then(() => queryClient.invalidateQueries(trpc.projects.list.queryFilter()))
        .then(() => {
          queryClient.removeQueries(trpc.projects.detail.queryFilter({ id: project.id }));
          return null;
        });
    },
  });
  return { title: project.name, entries };
};

/** The right-click menu for a session row/card in a list. */
export const sessionMenu = (
  session: SessionDto,
  annotation: SessionAnnotationDto | undefined,
  navigate: Navigate,
  context: LaunchContext,
  viewer: Viewer | null,
): ContextMenuSpec => {
  const { queryClient, trpc } = context;
  const invalidateSession = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.sessions.pathFilter()),
      queryClient.invalidateQueries(trpc.projects.pathFilter()),
    ]);
  const live = LIVE_STATES.has(session.status);
  // Only what this viewer may do (docs/adr/0003): steering is the owner's unless shared.
  const { own, steer, stop } = sessionActions(session, viewer);
  const entries: ContextMenuEntry[] = [
    {
      label: "Open session",
      onSelect: () =>
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } }),
    },
  ];
  const changeId = annotation?.changeId ?? null;
  if (changeId !== null) {
    entries.push({
      label: "Open review",
      onSelect: () => void navigate({ to: "/changes/$changeId", params: { changeId } }),
    });
  }
  entries.push("separator");
  if (live) {
    entries.push({
      label: "Mark checkpoint",
      onSelect: () =>
        void checkpointSession(session.id, "user-mark").then(() => invalidateSession()),
    });
    if (stop) {
      entries.push({
        label: "Stop session",
        onSelect: () =>
          void stopSession(session.id)
            .catch(() => undefined)
            .finally(() => invalidateSession()),
      });
    }
  } else if (steer) {
    entries.push({
      // Same worktree, restored state, fresh workspace; harness null = last used.
      label: "Resume session",
      onSelect: () => {
        void resumeSession(session.id, null)
          .catch(() => undefined)
          .finally(() => invalidateSession());
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
      },
    });
  }
  if (!live && own) {
    entries.push("separator", {
      label: "Delete session…",
      confirm: "Really delete this session? The worktree, its change, and checkpoints remain.",
      danger: true,
      onSelect: () => {
        void removeSession(session.id).then(() => {
          queryClient.removeQueries(trpc.sessions.detail.queryFilter({ id: session.id }));
          return queryClient.invalidateQueries(trpc.projects.pathFilter());
        });
      },
    });
  }
  return {
    title: `${session.harness}${session.label === null ? "" : ` — ${session.label}`}`,
    entries,
  };
};

/** What to call a worktree: its name, unless anonymous — then a member's label. */
export const worktreeDisplayName = (
  worktree: WorktreeDto,
  members: ReadonlyArray<SessionDto>,
): string =>
  worktree.name.startsWith("wt-")
    ? (members.find((session) => session.label !== null)?.label ??
      (members[0] === undefined ? worktree.name : `session ${members[0].id.slice(0, 8)}`))
    : worktree.name;

/** The right-click menu for a worktree group — the container's own verbs. */
export const worktreeMenu = (
  worktree: WorktreeDto,
  members: ReadonlyArray<SessionDto>,
  annotation: WorktreeAnnotationDto | undefined,
  navigate: Navigate,
  context: LaunchContext,
): ContextMenuSpec => {
  const { queryClient, trpc } = context;
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.projects.pathFilter()),
      queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
      queryClient.invalidateQueries(trpc.sessions.pathFilter()),
    ]);
  const live = members.filter((session) => LIVE_STATES.has(session.status));
  const newest = live[0] ?? members[0];
  const entries: ContextMenuEntry[] = [];
  if (newest !== undefined) {
    entries.push({
      label: live.length > 0 ? "Open newest live session" : "Open newest session",
      onSelect: () =>
        void navigate({ to: "/sessions/$sessionId", params: { sessionId: newest.id } }),
    });
  }
  const changeId = annotation?.changeId ?? null;
  if (changeId !== null) {
    entries.push({
      label: "Open review",
      onSelect: () => void navigate({ to: "/changes/$changeId", params: { changeId } }),
    });
  }
  entries.push(
    "separator",
    ...HARNESSES.filter((harness) => harness !== "shell").map(
      (harness): ContextMenuEntry => ({
        label: `Start ${harness} session here`,
        onSelect: () => {
          void startComposedSessionInWorktree(navigate, context, worktree.id, {
            harness,
            prompt: "",
          }).finally(() => invalidate());
        },
      }),
    ),
    "separator",
    { label: "Copy worktree path", flash: "Copied", onSelect: () => copyText(worktree.directory) },
    { label: "Copy branch name", flash: "Copied", onSelect: () => copyText(worktree.branch) },
  );
  if (worktree.baseRef !== null) {
    const baseRef = worktree.baseRef;
    entries.push({ label: "Copy base ref", flash: "Copied", onSelect: () => copyText(baseRef) });
  }
  if (live.length === 0) {
    const facts =
      members.length === 0
        ? "The change and checkpoints go with it."
        : `${members.length} session${members.length === 1 ? "" : "s"}, the change, and its review go with it.`;
    entries.push("separator", {
      label: "Remove worktree…",
      confirm: `Really remove worktree ${worktreeDisplayName(worktree, members)}? ${facts}`,
      danger: true,
      onSelect: () => {
        void removeWorktree(worktree.id)
          .catch(() => undefined)
          .finally(() => invalidate());
      },
    });
  }
  return { title: worktreeDisplayName(worktree, members), entries };
};
