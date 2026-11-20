import type { TileLayout } from "@mend/domain/workbench";
import { Status } from "@mend/ui/components/status";
import { buttonVariants } from "@mend/ui/components/ui/button";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useState, useSyncExternalStore } from "react";

import type { InboxRow } from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import { type ApplyContext, applyLayout, oneTileOf } from "#/lib/layouts";
import { rowActions } from "#/lib/row-actions";
import { lumpStatusOf, STATUS_WORDS } from "#/lib/session-sheet";
import {
  activate,
  addToTile,
  type Arrangement,
  closeTab,
  focusTile,
  forgetEnded,
  isNewSessionTab,
  keepArrangement,
  maximise,
  moveTab,
  openedWith,
  resizeSplit,
  type Side,
  sessionTab,
  splitTile,
  sessionOfTab,
  tabsOf,
  tileById,
  tileOfTab,
  tilesOf,
  viewOfTab,
  viewTab,
  withWorkspace,
  type WorkspaceSession,
  focusedTab,
  replaceTab,
} from "#/lib/tiles";
import { useTRPC } from "#/lib/trpc";
import { tileArrangements } from "#/lib/ui-prefs";
import { useInbox } from "#/lib/use-inbox";

import { Kept, KeptSlot, useKeptNodes } from "../workspace/kept.tsx";
import { LayoutMenu } from "../workspace/layout-menu.tsx";
import { OpenMenu, PhoneOpenSheet, type ClosedSession } from "../workspace/open-menu.tsx";
import { PhoneHeader } from "../workspace/phone-header.tsx";
import { PhoneTabStrip } from "../workspace/phone-tab-strip.tsx";
import { DraggedTab } from "../workspace/tile-tab.tsx";
import { TileTree } from "../workspace/tile-tree.tsx";
import { Tile } from "../workspace/tile.tsx";
import { chipAt, type DropTarget, useTabDrag } from "../workspace/use-tab-drag.ts";
import { workspaceView, type ViewPlace } from "../workspace/views.tsx";
import { WorkspaceHeader } from "../workspace/workspace-header.tsx";
import { NewSessionTab } from "./new-session-tab.tsx";
import {
  PhoneSessionActions,
  type RenameDialogState,
  RenameSessionDialog,
  SessionTabMenu,
  type SessionMenuContext,
  type StopDialogState,
  StopSessionDialog,
  type DeleteDialogState,
  DeleteSessionDialog,
  type TabLayout,
  TileMenuButton,
  type WorkspaceFacts,
  WorkspaceMenuButton,
} from "./session-actions.tsx";
import { type SessionFacts, useSessionFacts } from "./session-facts.ts";
import { faceOf, type TabLook, WorkspaceTab, WorkspaceTabBody } from "./workspace-tabs.tsx";

/** Under 1024px Back goes to the inbox, which is home there. */
const BACK_TO_INBOX = { link: { to: "/" }, label: "Back to the inbox" } as const;

/** The VS Code extension's own address: it opens this session's workspace (apps/vscode). */
const vscodeOpenUri = (sessionId: string) =>
  `vscode://sealant-sh.mend/open?session=${encodeURIComponent(sessionId)}`;

/** A session that ended: its tab doesn't open by itself, and closing it needn't be remembered. */
const ENDED: ReadonlySet<string> = new Set(["completed", "stopped", "failed"]);

/** The keyboard's moves of a tab: Alt+Shift with an arrow. */
const ARROW_SIDES: Readonly<Record<string, Side>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "top",
  ArrowDown: "bottom",
};

const SIDE_WORDS: Readonly<Record<Side, string>> = {
  left: "on the left",
  right: "on the right",
  top: "above",
  bottom: "below",
};

const TAB_KEYS =
  "Delete F2 Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown";

const subscribeToNothing = () => () => undefined;

/** False while the server's page is hydrated, true from then on. */
const useHydrated = () =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

/** A New session tab's key, one past the highest the arrangement holds. */
const newSessionTab = (arrangement: Arrangement): string => {
  const numbers = tabsOf(arrangement)
    .filter(isNewSessionTab)
    .map((tab) => Number(tab.slice("new:".length)) || 0);
  return `new:${Math.max(0, ...numbers) + 1}`;
};

/** A view this version of Mend doesn't have (kept by a newer one, or removed) leaves the sheet. */
const withKnownViews = (arrangement: Arrangement): Arrangement =>
  tabsOf(arrangement)
    .filter((tab) => {
      const view = viewOfTab(tab);
      return view !== null && workspaceView(view) === undefined;
    })
    .reduce((next, tab) => closeTab(next, tab, () => false), arrangement);

/**
 * The arrangement after `tab` is dropped on `target`. A strip's index counts the dragged tab where
 * it was; moving it right along its own strip lands one place sooner once it has left.
 */
const dropped = (arrangement: Arrangement, tab: string, target: DropTarget): Arrangement => {
  if (target.drop !== "centre") return splitTile(arrangement, target.tileId, tab, target.drop);
  const home = tileOfTab(arrangement, tab);
  const from = home?.id === target.tileId ? home.tabs.indexOf(tab) : -1;
  const index =
    target.index === null
      ? undefined
      : from !== -1 && from < target.index
        ? target.index - 1
        : target.index;
  return addToTile(arrangement, target.tileId, tab, index);
};

const sameLayout = (a: Arrangement, b: Arrangement): boolean =>
  JSON.stringify(a.root) === JSON.stringify(b.root);

/**
 * The session's workspace, as its sheet (ADR 0026): the Workspace header naming the project, the
 * worktree and the branch, then the tiles. Every tab is a session's conversation (this session's,
 * and every other session's in the workspace), a view, or a New session; a person splits the
 * sheet by dragging a tab onto a tile's edge or with Alt+Shift and an arrow, adds one to a tile by
 * dropping it in the middle, resizes tiles by their dividers and maximises one. The arrangement is
 * kept for the workspace in this browser (`tileArrangements`).
 *
 * Every tab's body is drawn once, into a node of its own that moves into whichever tile shows it
 * (`Kept`): a conversation keeps its place and a terminal its socket as tabs move. Under 1024px it
 * is the phone's layout (T19, T23): the Phone header, every tab in one strip, and the focused
 * tile's body.
 *
 * A session's own actions are on its tab: its right-click menu, the "…" of the tile that shows it,
 * and on a phone the header's "…" (`session-actions.tsx`); the workspace's are in the header's "…".
 *
 * The header's layout button (`LayoutMenu`) picks a built-in or saved layout for this sheet,
 * saves the sheet as a layout, or puts every tab in one tile. What attaches here later: the views
 * (PRs 17 to 23, `WORKSPACE_VIEWS`).
 */
function SessionSheet({
  facts,
  view,
  full,
  onLeaveFull,
}: {
  readonly facts: SessionFacts;
  readonly view: string | undefined;
  readonly full: boolean;
  readonly onLeaveFull: () => void;
}) {
  const { session } = facts;
  const worktreeId = session.worktreeId;
  const own = sessionTab(session.id);
  // The tab the address names: the session's own, or a view's (`/sessions/<id>/terminal`).
  const opened = view === undefined ? own : viewTab(view);
  const place: ViewPlace = { sessionId: session.id, worktreeId, projectId: session.projectId };
  const trpc = useTRPC();
  const inbox = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.filter((row) => row.session.worktreeId === worktreeId),
  });
  const rows = inbox.isPending || inbox.isError ? [] : inbox.data;
  const sessions: ReadonlyArray<WorkspaceSession> | null =
    inbox.isPending || inbox.isError
      ? null
      : inbox.data.map((row) => ({ id: row.session.id, running: !ENDED.has(row.session.status) }));

  const [kept, setKept] = useState(() =>
    openedWith(tileArrangements.read().find(([id]) => id === worktreeId)?.[1] ?? null, opened),
  );
  // The address moved between the session and one of its views: that tab shows, focused.
  const [openedLast, setOpenedLast] = useState(opened);
  if (openedLast !== opened) {
    setOpenedLast(opened);
    setKept((current) => openedWith(current, opened));
  }
  const arrange = (arrangement: Arrangement) =>
    withWorkspace(withKnownViews(arrangement), sessions ?? []);
  const shown = arrange(kept);
  /** A person's change to the arrangement, kept for the workspace in this browser. */
  const change = (step: (current: Arrangement) => Arrangement) =>
    setKept((current) => {
      const next = step(arrange(current));
      tileArrangements.set(
        keepArrangement(tileArrangements.read(), worktreeId, forgetEnded(next, sessions)),
      );
      return next;
    });

  // `?full=1` (the old app's full screen) maximises the tile showing this session.
  const maximised = full ? (tileOfTab(shown, own)?.id ?? null) : shown.maximised;
  const focus = full && maximised !== null ? maximised : shown.focus;
  const tiles = tilesOf(shown.root);
  const allTabs = tabsOf(shown);

  // A tab's body mounts the first time it shows, and stays mounted from then on.
  const showing = tiles.map((tile) => tile.active);
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set(showing));
  if (showing.some((tab) => !mounted.has(tab))) setMounted(new Set([...mounted, ...showing]));
  const hydrated = useHydrated();
  const nodeOf = useKeptNodes("flex min-h-0 flex-1 flex-col");

  const [said, setSaid] = useState("");

  // The inbox's rows, for what a session's menu offers and its writers act on.
  const inboxState = useInbox();
  const inboxAll = inboxState.status === "success" ? inboxState.view.all : [];
  const rowOf = (sessionId: string): InboxRow | null =>
    inboxAll.find((row) => row.session.id === sessionId) ?? null;
  const [stopDialog, setStopDialog] = useState<StopDialogState>({ open: false, target: null });
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>({ open: false, row: null });
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState>({
    open: false,
    target: null,
  });
  const navigate = useNavigate();
  const menus: SessionMenuContext = {
    rowOf,
    viewerId: facts.viewerId,
    onRename: (row) => setRenameDialog({ open: true, row }),
    onStop: (target) => setStopDialog({ open: true, target }),
    onDelete: (target) => setDeleteDialog({ open: true, target }),
  };

  const drag = useTabDrag({
    lands: (tab, target) => !sameLayout(dropped(shown, tab, target), shown),
    onDrop: (tab, target) => change((current) => dropped(current, tab, target)),
  });

  const closed: ReadonlyArray<ClosedSession> = rows
    .filter((row) => !allTabs.includes(sessionTab(row.session.id)))
    .map((row) => ({
      id: row.session.id,
      title: row.title,
      status: lumpStatusOf(row.session.status),
      pr: "none" as const,
    }));

  /** Opens `tab` in tile `tileId` (a tab already open shows where it is), after its active tab. */
  const open = (tileId: string, tab: string) =>
    change((current) => {
      if (tileOfTab(current, tab) !== undefined) return activate(current, tab);
      const tile = tileById(current, tileId);
      const at = tile === undefined ? undefined : tile.tabs.indexOf(tile.active) + 1;
      return addToTile(current, tileId, tab, isNewSessionTab(tab) ? at : undefined);
    });
  const openNewSession = (tileId: string) =>
    change((current) => {
      const tab = newSessionTab(current);
      const tile = tileById(current, tileId);
      return addToTile(
        current,
        tileId,
        tab,
        tile === undefined ? undefined : tile.tabs.indexOf(tile.active) + 1,
      );
    });

  /** A press or focus inside a tile focuses it. */
  const focusOn = (tileId: string | undefined) => {
    if (tileId !== undefined && tileId !== shown.focus)
      change((current) => focusTile(current, tileId));
  };

  const closeOne = (tab: string) =>
    change((current) =>
      closeTab(
        current,
        tab,
        (id) => sessions?.some((each) => each.id === id && each.running) ?? false,
      ),
    );

  const keys = (tab: string, label: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabSession = sessionOfTab(tab);
    const row = tabSession === null ? null : rowOf(tabSession);
    if (event.key === "F2" && row !== null && rowActions(row, facts.viewerId).rename) {
      event.preventDefault();
      menus.onRename(row);
      return;
    }
    if (event.key === "Delete" && allTabs.length > 1) {
      event.preventDefault();
      closeOne(tab);
      setSaid(`Closed ${label}.`);
      return;
    }
    const side = ARROW_SIDES[event.key];
    if (side === undefined || !event.altKey || !event.shiftKey) return;
    event.preventDefault();
    const next = moveTab(shown, tab, side);
    if (sameLayout(next, shown)) {
      setSaid(`${label} can't move ${SIDE_WORDS[side]}.`);
      return;
    }
    const split = tilesOf(next.root).length > tiles.length;
    change(() => next);
    setSaid(
      split
        ? `Moved ${label} to a new tile ${SIDE_WORDS[side]}.`
        : `Moved ${label} to the tile ${SIDE_WORDS[side]}.`,
    );
    // The tab is drawn again in its new tile: the keyboard stays on it.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-tab="${CSS.escape(tab)}"] [role="tab"]`)?.focus(),
    );
  };

  /** What a tab's menus can do to the tiles, from the tile that holds it. */
  const layoutOf = (tab: string): TabLayout => {
    const tile = tileOfTab(shown, tab);
    return {
      ...(tile !== undefined && tiles.length > 1 && maximised !== tile.id
        ? { onMaximise: () => change((current) => maximise(current, tile.id)) }
        : {}),
      // A tab alone in its tile has nothing to split from.
      ...(tile !== undefined && tile.tabs.length > 1
        ? {
            onSplit: (side: Side) => change((current) => splitTile(current, tile.id, tab, side)),
          }
        : {}),
      ...(allTabs.length > 1 ? { onClose: () => closeOne(tab) } : {}),
    };
  };

  const lookOf = (tab: string, size: "default" | "touch"): TabLook => {
    const label = faceOf(tab, facts, rows).label;
    const tabSession = sessionOfTab(tab);
    return {
      size,
      ghost: drag.drag?.tab === tab,
      ...(allTabs.length > 1 ? { onClose: () => closeOne(tab) } : {}),
      ...(size === "default"
        ? {
            onPointerDown: drag.begin(tab),
            onKeyDown: keys(tab, label),
            keyShortcuts: TAB_KEYS,
            ...(tabSession === null
              ? {}
              : {
                  contextMenu: (
                    <SessionTabMenu sessionId={tabSession} layout={layoutOf(tab)} context={menus} />
                  ),
                }),
          }
        : {}),
    };
  };

  const workspace: WorkspaceFacts = {
    worktreeName: facts.worktreeName,
    branch: session.branch,
    worktreePath: session.worktree,
    onNewSession: () => openNewSession(shown.focus),
    onLand: () =>
      void navigate({
        to: "/sessions/$sessionId/$view",
        params: { sessionId: session.id, view: "change" },
        hash: "land",
      }),
  };
  const focusedSession = sessionOfTab(focusedTab(shown));

  const newSessionBody = (tab: string) => (
    <NewSessionTab
      tabId={tab}
      worktreeName={facts.worktreeName}
      others={sessions?.length ?? 1}
      place={{
        projectId: session.projectId,
        worktree: { id: worktreeId, branch: session.branch },
        onStarted: (sessionId) =>
          change((current) => replaceTab(current, tab, sessionTab(sessionId))),
      }}
    />
  );
  const bodyOf = (tab: string) => (
    <WorkspaceTabBody
      tab={tab}
      facts={facts}
      place={place}
      newSession={newSessionBody}
      onStartOwn={() => openNewSession(tileOfTab(shown, tab)?.id ?? shown.focus)}
    />
  );

  const maximisedTile = maximised === null ? undefined : tileById(shown, maximised);
  const waiting =
    rows.find(
      (row) =>
        row.session.status === "waiting" && maximisedTile?.active !== sessionTab(row.session.id),
    )?.title ?? null;

  const restore = () => {
    if (full) onLeaveFull();
    change((current) => maximise(current, null));
  };

  // Layouts (PR 16): picking one rearranges this workspace's sheet, kept as any change is.
  const layoutContext: ApplyContext = {
    own,
    knownView: (id) => workspaceView(id) !== undefined,
  };
  const pickLayout = (layout: TileLayout, name: string) => {
    if (full) onLeaveFull();
    change((current) => applyLayout(current, layout, layoutContext));
    setSaid(`Arranged the tiles as ${name}.`);
  };
  const resetToOneTile = () => {
    if (full) onLeaveFull();
    change((current) => oneTileOf(current));
    setSaid("Put every tab in one tile.");
  };

  const dragged = drag.drag === null ? null : faceOf(drag.drag.tab, facts, rows);

  return (
    // Exactly the sheet's height, never the content's: the thread scrolls inside its tile.
    <div className="flex h-dvh min-w-0 flex-none flex-col lg:h-auto lg:min-h-0 lg:flex-1">
      <WorkspaceHeaderRow
        facts={facts}
        workspace={workspace}
        layouts={
          <LayoutMenu
            arrangement={shown}
            context={layoutContext}
            onApply={pickLayout}
            onReset={resetToOneTile}
          />
        }
      />
      <PhoneHeader
        title={facts.worktreeName}
        sub={facts.projectName}
        back={BACK_TO_INBOX}
        className="lg:hidden"
        actions={
          focusedSession === null ? undefined : (
            <PhoneSessionActions
              sessionId={focusedSession}
              layout={layoutOf(focusedTab(shown))}
              context={menus}
              workspace={workspace}
            />
          )
        }
      />
      <PhoneTabStrip
        className="lg:hidden"
        tabs={allTabs.map((tab) => ({
          value: tab,
          tab: (
            <WorkspaceTab
              tab={tab}
              facts={facts}
              rows={rows}
              place={place}
              look={lookOf(tab, "touch")}
            />
          ),
        }))}
        active={focusedTab(shown)}
        onActiveChange={(tab) => change((current) => activate(current, tab))}
        add={
          <PhoneOpenSheet
            worktree={facts.worktreeName}
            place={place}
            closed={closed}
            onOpen={(tab) => open(shown.focus, tab)}
            onNewSession={() => openNewSession(shown.focus)}
          />
        }
      />
      <div className="flex min-h-0 flex-1 max-lg:**:data-tile-strip:hidden">
        <TileTree
          node={shown.root}
          focus={focus}
          maximised={maximised}
          onResize={(splitId, sizes) => change((current) => resizeSplit(current, splitId, sizes))}
          renderTile={(tile) => (
            <div
              className="flex size-full min-h-0 min-w-0"
              onPointerDownCapture={() => focusOn(tile.id)}
              onFocusCapture={() => focusOn(tile.id)}
            >
              <Tile
                id={tile.id}
                label={`Tile ${tiles.indexOf(tile) + 1}`}
                focused={tile.id === focus}
                active={tile.active}
                onActiveChange={(tab) => change((current) => activate(current, tab))}
                tabs={tile.tabs.map((tab) => ({
                  value: tab,
                  tab: (
                    <WorkspaceTab
                      tab={tab}
                      facts={facts}
                      rows={rows}
                      place={place}
                      look={lookOf(tab, "default")}
                    />
                  ),
                  body: hydrated ? (
                    <KeptSlot node={nodeOf(tab)} className="flex min-h-0 flex-1 flex-col" />
                  ) : tab === tile.active ? (
                    bodyOf(tab)
                  ) : null,
                }))}
                add={
                  <OpenMenu
                    place={place}
                    closed={closed}
                    onOpen={(tab) => open(tile.id, tab)}
                    onNewSession={() => openNewSession(tile.id)}
                  />
                }
                actions={
                  <TileMenuButton
                    sessionId={sessionOfTab(tile.active)}
                    label={faceOf(tile.active, facts, rows).label}
                    layout={layoutOf(tile.active)}
                    context={menus}
                  />
                }
                maximised={maximised === tile.id}
                {...(tiles.length > 1
                  ? { onMaximise: () => change((current) => maximise(current, tile.id)) }
                  : {})}
                onRestore={restore}
                waiting={waiting}
                drop={drag.drag?.target?.tileId === tile.id ? drag.drag.target.drop : null}
              />
            </div>
          )}
        />
      </div>
      {hydrated
        ? allTabs
            .filter((tab) => mounted.has(tab))
            .map((tab) => (
              <Kept key={tab} node={nodeOf(tab)}>
                {/* A press or focus in a body focuses its tile: the body's events reach here, not the tile. */}
                <div
                  data-tab-body={tab}
                  className="flex min-h-0 flex-1 flex-col"
                  onPointerDownCapture={() => focusOn(tileOfTab(shown, tab)?.id)}
                  onFocusCapture={() => focusOn(tileOfTab(shown, tab)?.id)}
                >
                  {bodyOf(tab)}
                </div>
              </Kept>
            ))
        : null}
      {drag.drag === null || dragged === null ? null : (
        <DraggedTab ref={drag.chip} at={chipAt(drag.drag.x, drag.drag.y)} {...dragged} />
      )}
      <p role="status" className="sr-only">
        {said}
      </p>
      <StopSessionDialog
        state={stopDialog}
        viewerId={facts.viewerId}
        onOpenChange={(next) => setStopDialog((current) => ({ ...current, open: next }))}
      />
      <DeleteSessionDialog
        state={deleteDialog}
        onOpenChange={(next) => setDeleteDialog((current) => ({ ...current, open: next }))}
        onDeleted={(id) => {
          // The page's own session is gone: home. Another session's tab just closes.
          if (id === session.id) void navigate({ to: "/" });
          else closeOne(sessionTab(id));
        }}
      />
      <RenameSessionDialog
        state={renameDialog}
        onOpenChange={(next) => setRenameDialog((current) => ({ ...current, open: next }))}
      />
    </div>
  );
}

/** The Workspace header with the layout button, Open in VS Code and the workspace's "…", from 1024px. */
function WorkspaceHeaderRow({
  facts,
  workspace,
  layouts,
}: {
  readonly facts: SessionFacts;
  readonly workspace: WorkspaceFacts;
  readonly layouts: ReactNode;
}) {
  return (
    <WorkspaceHeader
      project={facts.projectName}
      projectId={facts.session.projectId}
      worktree={facts.worktreeName}
      branch={facts.session.branch}
      className="max-lg:hidden"
      actions={
        <>
          {layouts}
          <a
            href={vscodeOpenUri(facts.session.id)}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Open in VS Code
          </a>
          <WorkspaceMenuButton workspace={workspace} />
        </>
      }
    />
  );
}

/** The session's page, read from the cache its route filled. */
export function SessionPage({
  sessionId,
  view,
  full,
  onLeaveFull,
}: {
  readonly sessionId: string;
  /** The view the address names (`/sessions/<id>/<view>`), whose tab shows and is focused. */
  readonly view?: string;
  /** The address asks for the session's tile maximised (`?full=1`). */
  readonly full: boolean;
  readonly onLeaveFull: () => void;
}) {
  return (
    <SessionSheet
      facts={useSessionFacts(sessionId)}
      view={view}
      full={full}
      onLeaveFull={onLeaveFull}
    />
  );
}

/**
 * A session nothing has read yet, while its detail loads: the sheet's frame with what the inbox's
 * row already says (its title and status), and the conversation's place saying it is being read.
 * Never a blank page.
 */
export function SessionPending({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const row = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.find((each) => each.session.id === sessionId) ?? null,
  });
  const listed = row.isPending || row.isError ? null : row.data;
  return (
    <div aria-busy className="flex h-dvh min-w-0 flex-none flex-col lg:h-auto">
      <div className="flex h-header shrink-0 items-center gap-3 border-b px-5 max-lg:h-14">
        {listed === null ? (
          <Skeleton className="h-4 w-56" />
        ) : (
          <p className="min-w-0 truncate text-prose">
            <Link
              to="/projects/$projectId"
              params={{ projectId: listed.session.projectId }}
              className="text-muted-foreground outline-none hover:text-foreground focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {listed.projectName}
            </Link>
            <span aria-hidden className="text-faint">
              {" / "}
            </span>
            <span className="font-semibold">{listed.worktreeName ?? listed.title}</span>
          </p>
        )}
      </div>
      <div className="flex h-tab-strip shrink-0 items-center gap-2 border-b px-5">
        {listed === null ? (
          <Skeleton className="h-3.5 w-40" />
        ) : (
          <>
            <span className="truncate text-control font-medium">{listed.title}</span>
            <Status tone="idle">{STATUS_WORDS[listed.session.status]}</Status>
          </>
        )}
      </div>
      <p
        role="status"
        className="mx-auto w-full max-w-conversation px-4 py-6 text-row text-muted-foreground"
      >
        Reading the conversation…
      </p>
    </div>
  );
}
