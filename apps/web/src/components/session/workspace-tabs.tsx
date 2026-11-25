import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { type ReactNode, Suspense } from "react";

import type { SessionInboxRowDto, SessionStatusDto } from "#/lib/api";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { sessionFace } from "#/lib/inbox";
import { shownStatus } from "#/lib/session-composer";
import { sessionDetailQuery } from "#/lib/session-queries";
import { lumpPrOf, lumpStatusOf, STATUS_WORDS } from "#/lib/session-sheet";
import { sessionTitleOf } from "#/lib/session-title";
import { reportCaught } from "#/lib/telemetry";
import { isNewSessionTab, sessionOfTab, viewOfTab } from "#/lib/tiles";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { QueryError } from "../route-screens.tsx";
import { ViewLoadError } from "../workspace/lazy-body.tsx";
import {
  TileTab,
  type TileTabHandlers,
  type TileTabKind,
  type TileSize,
} from "../workspace/tile-tab.tsx";
import { type ViewPlace, workspaceView, type WorkspaceView } from "../workspace/views.tsx";
import { ConversationTile } from "./conversation-tile.tsx";
import { type SessionFacts, useSessionFacts } from "./session-facts.ts";

/** How every tab of the sheet draws: its size, its handlers, and whether it can close. */
export interface TabLook extends TileTabHandlers {
  readonly size: TileSize;
  readonly onClose?: () => void;
  readonly ghost?: boolean;
}

/** What a tab looks like before anything about it is read: its words, its lump or icon. */
export type TabFace = TileTabKind & { readonly label: string };

/** The New session tab's face: a session that hasn't started. */
const NEW_SESSION: TabFace = {
  kind: "session",
  status: "idle",
  pr: "none",
  statusWords: "Not started",
  label: "New session",
};

/**
 * A tab's face from what the sheet holds already (the page's session, the workspace's inbox rows,
 * the views): for the chip that follows a dragged tab, which reads nothing of its own.
 */
export const faceOf = (
  tab: string,
  facts: SessionFacts,
  rows: ReadonlyArray<SessionInboxRowDto>,
): TabFace => {
  const session = sessionOfTab(tab);
  if (session !== null) {
    const row = rows.find((each) => each.session.id === session);
    const status = session === facts.session.id ? facts.session.status : row?.session.status;
    const face = row === undefined ? null : sessionFace(row, new Date());
    return {
      kind: "session",
      status: face?.lump ?? (status === undefined ? "idle" : lumpStatusOf(status)),
      pr: session === facts.session.id ? lumpPrOf(facts.detail.landings) : (face?.pr ?? "none"),
      statusWords: face?.word ?? (status === undefined ? "" : STATUS_WORDS[status]),
      label: session === facts.session.id ? facts.title : sessionTitleOf(row, null),
    };
  }
  const view = workspaceView(viewOfTab(tab) ?? "");
  if (view !== undefined) return { kind: "view", icon: view.icon, label: view.name };
  return NEW_SESSION;
};

/**
 * The status a session's tab shows: the server's word, but Idle once the person stopped its newest
 * turn and nothing else runs (the server still says running). It shares the read of the turns its
 * conversation tile makes.
 */
const useShownStatus = (sessionId: string, status: SessionStatusDto): SessionStatusDto => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const turns = useInfiniteQuery({
    ...conversationQuery(trpc, client, sessionId),
    select: (data) => heldConversation(data.pages).turns,
  });
  // While the turns are read, or if they can't be, the server's word stands.
  return shownStatus(status, turns.isPending || turns.isError ? undefined : turns.data);
};

/**
 * A session's tab: its lump and title. The glyph and word are its inbox row's, as the sidebar
 * draws them (`sessionFace`); without a row, from its detail once read. The page's own session's
 * tab is drawn the same way, so the tab stays the same element when another session's tab takes
 * the page (the address follows the focused session's tab).
 */
function SessionTab({
  tab,
  sessionId,
  row,
  look,
}: {
  readonly tab: string;
  readonly sessionId: string;
  readonly row: SessionInboxRowDto | undefined;
  readonly look: TabLook;
}) {
  const trpc = useTRPC();
  const read = useQuery(sessionDetailQuery(trpc, sessionId));
  const detail = read.isPending || read.isError ? null : read.data;
  const status = useShownStatus(sessionId, detail?.session.status ?? row?.session.status ?? "idle");
  const face = row === undefined ? null : sessionFace(row, new Date());
  return (
    <TileTab
      value={tab}
      kind="session"
      status={face?.lump ?? lumpStatusOf(status)}
      pr={detail === null ? (face?.pr ?? "none") : lumpPrOf(detail.landings)}
      statusWords={face?.word ?? STATUS_WORDS[status]}
      label={sessionTitleOf(row, detail?.session.label)}
      {...look}
    />
  );
}

/** A view's tab, with the facts its view reads. */
function ViewTab({
  tab,
  view,
  place,
  look,
}: {
  readonly tab: string;
  readonly view: WorkspaceView;
  readonly place: ViewPlace;
  readonly look: TabLook;
}) {
  const facts = view.useFacts(place);
  return (
    <TileTab
      value={tab}
      kind="view"
      icon={view.icon}
      label={view.name}
      onIntent={view.preload}
      {...facts}
      {...look}
    />
  );
}

/** The tab for `tab` in a strip: a session, a view, or New session. */
export function WorkspaceTab({
  tab,
  rows,
  place,
  look,
}: {
  readonly tab: string;
  readonly rows: ReadonlyArray<SessionInboxRowDto>;
  readonly place: ViewPlace;
  readonly look: TabLook;
}) {
  const session = sessionOfTab(tab);
  if (session !== null)
    return (
      <SessionTab
        tab={tab}
        sessionId={session}
        row={rows.find((each) => each.session.id === session)}
        look={look}
      />
    );
  const view = workspaceView(viewOfTab(tab) ?? "");
  if (view !== undefined) return <ViewTab tab={tab} view={view} place={place} look={look} />;
  return <TileTab value={tab} {...NEW_SESSION} {...look} />;
}

/**
 * A session's conversation, read as its tab first shows. The page's own session's is drawn the same
 * way, so its body stays mounted when another session's tab takes the page.
 */
function SessionConversation({
  sessionId,
  onStartOwn,
}: {
  readonly sessionId: string;
  readonly onStartOwn: () => void;
}) {
  return <ConversationTile facts={useSessionFacts(sessionId)} onStartOwn={onStartOwn} />;
}

/** A tab whose body couldn't be read: what went wrong, and Try again, which reads it again. */
function TabFailed({ error, reset }: ErrorComponentProps) {
  const queryClient = useQueryClient();
  return (
    <div className="mx-auto w-full max-w-conversation px-4 py-6">
      <QueryError
        error={error}
        retrying={false}
        retry={() => {
          // A view whose code didn't arrive fetches it again; a read that failed is read again.
          if (error instanceof ViewLoadError) error.retry();
          void queryClient.resetQueries({ predicate: (query) => query.state.status === "error" });
          reset();
        }}
      />
    </div>
  );
}

/** What a tab's body shows while it is read, and when reading it failed. */
function Guarded({
  tab,
  reading,
  children,
}: {
  readonly tab: string;
  /** What the body reads, for its loading line: "Reading the conversation…". */
  readonly reading: string;
  readonly children: ReactNode;
}) {
  return (
    <CatchBoundary getResetKey={() => tab} errorComponent={TabFailed} onCatch={reportCaught}>
      <Suspense
        fallback={
          <p
            role="status"
            className="mx-auto w-full max-w-conversation px-4 py-6 text-row text-muted-foreground"
          >
            {reading}
          </p>
        }
      >
        {children}
      </Suspense>
    </CatchBoundary>
  );
}

/**
 * What the body of `tab` shows: a session's conversation (with its own composer), a view, or a
 * New session's composer (`newSession`).
 */
export function WorkspaceTabBody({
  tab,
  place,
  newSession,
  onStartOwn,
}: {
  readonly tab: string;
  readonly place: ViewPlace;
  readonly newSession: (tab: string) => ReactNode;
  /** Opens a New session tab beside this tab: a session of the viewer's own in this workspace. */
  readonly onStartOwn: () => void;
}) {
  const session = sessionOfTab(tab);
  if (session !== null)
    return (
      <Guarded tab={tab} reading="Reading the conversation…">
        <SessionConversation sessionId={session} onStartOwn={onStartOwn} />
      </Guarded>
    );
  const view = workspaceView(viewOfTab(tab) ?? "");
  if (view !== undefined)
    return (
      <Guarded tab={tab} reading={`Opening ${view.name}…`}>
        <view.Body place={place} />
      </Guarded>
    );
  if (isNewSessionTab(tab))
    return (
      <Guarded tab={tab} reading="Opening a new session…">
        {newSession(tab)}
      </Guarded>
    );
  return null;
}
