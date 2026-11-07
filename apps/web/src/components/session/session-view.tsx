import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ErrorComponentProps,
  useHydrated,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";

import { Button } from "#/components/kit/button";
import { Kept, KeptSlot, useKeptNode } from "#/components/kit/kept";
import { SplitView } from "#/components/kit/split";
import { StatusWord } from "#/components/kit/status";
import { inboxQuery } from "#/lib/inbox-live";
import { launchForSession, usePendingLaunches } from "#/lib/pending-launches";
import {
  harnessName,
  keyIsTaken,
  SESSION_TABS,
  type SessionTab,
  useNarrow,
  useSessionLayout,
} from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { useOwnerName } from "#/lib/viewer";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { Composer, LatestMessage } from "./composer";
import { Conversation } from "./conversation";
import { ConversationPane } from "./conversation-pane";
import { type SessionFacts, sessionStatusWord, useSessionFacts } from "./facts";
import { BackToSessions, FullScreenBar, SessionHeader, SplitHeader, WorkTabs } from "./header";
import { StartedSession } from "./starting-session";

// Each tab's body is its own chunk, read when the tab is first shown: the diff viewer and its
// highlighter, the terminal, the screen's viewer. Opening a session reads the conversation's code
// alone, and a tab's own loading line shows in its pane while its code arrives.
const ChangeTab = lazy(() =>
  import("./change-tab").then((module) => ({ default: module.ChangeTab })),
);
const PreviewTab = lazy(() =>
  import("./preview-tab").then((module) => ({ default: module.PreviewTab })),
);
const RecordTab = lazy(() =>
  import("./record-tab").then((module) => ({ default: module.RecordTab })),
);
const ScreenTab = lazy(() =>
  import("./screen-tab").then((module) => ({ default: module.ScreenTab })),
);
const TerminalTab = lazy(() =>
  import("./terminal-tab").then((module) => ({ default: module.TerminalTab })),
);
const OverviewPanel = lazy(() =>
  import("./side-panel").then((module) => ({ default: module.OverviewPanel })),
);

/** A pane whose code or reads are on the way: a line in the pane, never the page. */
function PaneLoading() {
  return (
    <p role="status" className="font-mono text-[12px] text-muted-foreground">
      Loading…
    </p>
  );
}

/** The tabs whose live connection outlives a switch away: once opened, they stay mounted. */
const KEPT: ReadonlySet<SessionTab> = new Set(["screen", "terminal"]);

/**
 * One session (screens P, C and X), beside the layout's rail and inbox: the session and its side
 * panel; the conversation alone; the conversation split beside the work; or full screen. The
 * layout is the person's choice per browser, full screen is in the URL (`?full`), and the tab is
 * the route.
 */
export function SessionView({
  sessionId,
  tab,
  full,
}: {
  readonly sessionId: string;
  readonly tab: SessionTab;
  readonly full: boolean;
}) {
  const facts = useSessionFacts(sessionId);
  const layout = useSessionLayout();
  const narrow = useNarrow();
  useWorkbenchEvents();
  useFullScreenKeys(full);
  // A screen or terminal opened once stays connected while another tab shows: its socket and
  // the input it holds are not dropped by a glance at the conversation.
  const [kept, setKept] = useState<ReadonlySet<SessionTab>>(() => new Set([tab]));
  if (KEPT.has(tab) && !kept.has(tab)) setKept(new Set([...kept, tab]));
  // The work side (the tab bodies, the kept screen and terminal among them) renders once, into a
  // node of its own that each layout shows in its slot: tab, layout and full-screen changes move
  // that node, and never unmount what it holds.
  const node = useKeptNode("flex min-h-0 flex-1 flex-col");
  // The work side (the diff, the terminal, the screen) mounts in the browser: a page rendered on
  // the server arrives with the conversation, and a placeholder where the work goes until then.
  const hydrated = useHydrated();
  const place: Place = full ? "full" : layout === "split" ? "work" : "main";
  const keptWork =
    hydrated && node !== null ? (
      <Kept node={node}>
        <WorkBodies facts={facts} tab={tab} kept={kept} place={place} />
      </Kept>
    ) : null;
  const onConversation = tab === "conversation";
  const slot =
    hydrated && node !== null ? (
      <KeptSlot node={node} className="flex min-h-0 flex-1 flex-col" />
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Opening the {workTabLabel(tab).toLowerCase()}…
        </p>
      </div>
    );

  if (full)
    return (
      <>
        {keptWork}
        <div className="flex h-dvh min-w-0 flex-1 flex-col bg-background">
          <FullScreenBar facts={facts} />
          <main
            className={`mx-auto flex min-h-0 w-full flex-1 flex-col ${onConversation ? "max-w-[816px]" : "max-w-[848px] px-6 pt-4 max-md:px-3"}`}
          >
            <div hidden={!onConversation} className="flex min-h-0 flex-1 flex-col">
              <ConversationPane composer={<Composer facts={facts} />}>
                <Conversation facts={facts} />
              </ConversationPane>
            </div>
            {onConversation ? null : (
              <>
                {slot}
                <div className="pt-4 pb-[18px] max-md:pt-2 max-md:pb-3">
                  <div className="mx-auto w-full max-w-[768px]">
                    <LatestMessage facts={facts} />
                    <Composer facts={facts} />
                  </div>
                </div>
              </>
            )}
          </main>
        </div>
      </>
    );

  if (layout === "split")
    return (
      <>
        {keptWork}
        <div className="flex h-dvh min-w-0 flex-1">
          <SplitView
            storageKey="session-split"
            label="Resize the conversation"
            defaultStart={39}
            minStart={26}
            minEnd={34}
            start={
              <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
                <SplitHeader facts={facts} tab={tab} />
                <ConversationPane narrow composer={<Composer facts={facts} />}>
                  <Conversation facts={facts} narrow />
                </ConversationPane>
              </section>
            }
            end={
              <section
                aria-label="Work"
                className="flex h-full min-h-0 flex-col gap-3 px-5 pt-4 pb-[18px]"
              >
                <div className="flex items-center gap-2.5">
                  <WorkTabs facts={facts} />
                </div>
                {slot}
              </section>
            }
          />
        </div>
      </>
    );

  // The conversation stays mounted under the other tabs, so its place in the list survives them.
  const main = (
    <main className="flex h-dvh min-w-0 flex-1 flex-col">
      <SessionHeader facts={facts} tab={tab} layout={layout} />
      <div hidden={!onConversation} className="flex min-h-0 flex-1 flex-col">
        <ConversationPane composer={<Composer facts={facts} />}>
          <Conversation facts={facts} />
        </ConversationPane>
      </div>
      {onConversation ? null : (
        <>
          <div className="flex min-h-0 flex-1 flex-col px-6 pt-4 max-md:px-3 max-md:pt-3">
            {slot}
          </div>
          <div className="px-6 pt-3 pb-[18px] max-md:px-3 max-md:pt-2 max-md:pb-[max(12px,env(safe-area-inset-bottom))]">
            <div className="mx-auto w-full max-w-[768px]">
              <LatestMessage facts={facts} />
              <Composer facts={facts} />
            </div>
          </div>
        </>
      )}
    </main>
  );
  return (
    <>
      {keptWork}
      {layout === "panel" ? (
        <div className="flex h-dvh min-w-0 flex-1">
          {/* A phone shows the session alone: the side panel and its divider are hidden below
              `md`, and what the panel holds is in the tabs. */}
          <SplitView
            storageKey="session-side-panel"
            label="Resize the side panel"
            minStart={45}
            endSize={{ initial: "212px", min: "200px", max: "420px" }}
            startOnlyWhenNarrow
            start={main}
            end={
              <aside
                aria-label={tab === "change" ? "Review" : "Session overview"}
                className="h-full overflow-y-auto border-l border-rule px-4 py-5"
              >
                {narrow ? null : (
                  <Suspense fallback={<PaneLoading />}>
                    {tab === "change" ? (
                      <ChangeTab facts={facts} place="panel" />
                    ) : (
                      <OverviewPanel facts={facts} tab={tab} />
                    )}
                  </Suspense>
                )}
              </aside>
            }
          />
        </div>
      ) : (
        main
      )}
    </>
  );
}

/**
 * A session nothing has read yet, while its first page loads: its row's own facts from the inbox
 * read (title, status, project, agent, who started it), and the conversation's place saying it is
 * being read. Never a blank page; the inbox beside it stays as it was.
 */
export function SessionPending({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const row = useQuery({
    ...inboxQuery(trpc),
    select: (rows) => rows.find((each) => each.session.id === sessionId),
  }).data;
  const launch = launchForSession(usePendingLaunches(), sessionId);
  const owner = useOwnerName(row?.session.ownerUserId ?? null);
  const status = row === undefined ? null : sessionStatusWord(row.session.status);
  if (launch !== undefined) return <StartedSession launch={launch} />;
  return (
    <main
      aria-busy
      className="flex h-dvh min-w-0 flex-1 flex-col px-6 pt-5 max-md:px-3 max-md:pt-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <BackToSessions />
        <h1 className="truncate font-sans text-[15px] font-medium text-foreground">
          {row?.title ?? "Opening the session…"}
        </h1>
      </div>
      {row === undefined || status === null ? null : (
        <p className="mt-1 flex min-w-0 gap-2 font-mono text-[11px] text-muted-foreground">
          <StatusWord tone={status.tone}>{status.word}</StatusWord>
          <span className="truncate">
            {[row.projectName, harnessName(row.session.harness), owner]
              .filter((part) => part !== null && part !== "")
              .join(" · ")}
          </span>
        </p>
      )}
      <p role="status" className="mt-6 font-mono text-[12px] text-muted-foreground">
        Reading the conversation…
      </p>
    </main>
  );
}

/** The tab the work side shows: the split view has no Conversation tab there, it opens on the change. */
const workTabLabel = (tab: SessionTab): string =>
  SESSION_TABS.find((entry) => entry.tab === (tab === "conversation" ? "change" : tab))?.label ??
  "tab";

/** Where a tab's body is laid out: the main column, the split's work panel, or full screen. */
export type Place = "main" | "work" | "full" | "panel";

/**
 * The current tab's body, and the screen and terminal kept mounted (hidden) once opened. In the
 * side-panel layout the Change tab's review actions sit in the panel; elsewhere above the diff.
 */
function WorkBodies({
  facts,
  tab,
  kept,
  place,
}: {
  readonly facts: SessionFacts;
  readonly tab: SessionTab;
  readonly kept: ReadonlySet<SessionTab>;
  readonly place: Place;
}) {
  const layout = useSessionLayout();
  // A phone hides the side panel, so the Change tab keeps its review actions there too.
  const narrow = useNarrow();
  // The split view has no Conversation tab on its work side: it opens on the change. Elsewhere the
  // Conversation tab shows no work side at all, so nothing renders there (the diff's code and its
  // reads wait for the Change tab).
  const shown: SessionTab | null =
    tab === "conversation" ? (place === "work" ? "change" : null) : tab;
  const bodies: ReadonlyArray<{ readonly tab: SessionTab; readonly node: ReactNode }> = [
    {
      tab: "change",
      node: (
        <ChangeTab
          facts={facts}
          place={place}
          withActions={!(place === "main" && layout === "panel" && !narrow)}
        />
      ),
    },
    { tab: "preview", node: <PreviewTab facts={facts} /> },
    { tab: "screen", node: <ScreenTab facts={facts} wide={place !== "work"} /> },
    { tab: "terminal", node: <TerminalTab facts={facts} shown={shown === "terminal"} /> },
    { tab: "record", node: <RecordTab facts={facts} /> },
  ];
  return (
    <>
      {bodies.map((body) =>
        body.tab === shown || (KEPT.has(body.tab) && kept.has(body.tab)) ? (
          <div
            key={body.tab}
            hidden={body.tab !== shown}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            <Suspense fallback={<PaneLoading />}>{body.node}</Suspense>
          </div>
        ) : null,
      )}
    </>
  );
}

/** `f` opens full screen and Esc leaves it, from anywhere on the page but a text field. */
function useFullScreenKeys(full: boolean) {
  const navigate = useNavigate({ from: "/sessions/$sessionId" });
  // A page-wide shortcut has to listen on the document for as long as the session is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      // Keys typed in a text field, in the diff's shadow root too, or on a held screen are theirs.
      if (keyIsTaken(event)) return;
      // A dialog, menu or popover takes Escape first, and a screen holding input keeps its keys.
      if (document.querySelector("[role=dialog],[role=menu]") !== null) return;
      if (document.fullscreenElement !== null) return;
      const open = event.key === "f" && !full;
      const close = event.key === "Escape" && full;
      if (!open && !close) return;
      event.preventDefault();
      void navigate({
        to: ".",
        search: ({ full: _open, ...rest }) => (close ? rest : { ...rest, full: true }),
      });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [full, navigate]);
}

/** The session's panes when its detail did not load; the inbox beside them stays usable. */
export function SessionFailed({ error }: ErrorComponentProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const router = useRouter();
  return (
    <main className="flex h-dvh min-w-0 flex-1 flex-col px-6 pt-5 max-md:px-3 max-md:pt-1.5">
      <BackToSessions />
      <p className="font-mono text-[11px] tracking-wider text-faint uppercase">
        this session did not load
      </p>
      <p role="alert" className="mt-3 font-mono text-[12.5px] break-words text-muted-foreground">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        size="sm"
        className="mt-5 self-start"
        onClick={() => {
          // Forget the failed read, so the panes read it again instead of showing the error.
          queryClient.removeQueries(trpc.sessions.detail.pathFilter());
          void router.invalidate();
        }}
      >
        Try again
      </Button>
    </main>
  );
}
