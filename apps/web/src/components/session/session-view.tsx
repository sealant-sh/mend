import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";

import { SessionInbox } from "#/components/inbox/session-inbox";
import { Kept, KeptSlot, useKeptNode } from "#/components/kit/kept";
import { SplitView } from "#/components/kit/split";
import { AppShell } from "#/components/shell";
import { keyIsTaken, sessionLayout, type SessionTab } from "#/lib/session-view";
import { useWorkbenchEvents } from "#/lib/workbench-events";

import { ChangeTab } from "./change-tab";
import { Composer, LatestMessage } from "./composer";
import { Conversation } from "./conversation";
import { type SessionFacts, useSessionFacts } from "./facts";
import { FullScreenBar, SessionHeader, SplitHeader, WorkTabs } from "./header";
import { PreviewTab } from "./preview-tab";
import { RecordTab } from "./record-tab";
import { ScreenTab } from "./screen-tab";
import { OverviewPanel } from "./side-panel";
import { TerminalTab } from "./terminal-tab";

/** The tabs whose live connection outlives a switch away: once opened, they stay mounted. */
const KEPT: ReadonlySet<SessionTab> = new Set(["screen", "terminal"]);

/**
 * One session (screens P, C and X): the inbox, the session, and its side panel; the conversation
 * alone; the conversation split beside the work; or full screen. The layout is the person's choice
 * per browser, full screen is in the URL (`?full`), and the tab is the route.
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
  const layout = sessionLayout.use();
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
  const place: Place = full ? "full" : layout === "split" ? "work" : "main";
  const keptWork = (
    <Kept node={node}>
      <WorkBodies facts={facts} tab={tab} kept={kept} place={place} />
    </Kept>
  );
  const onConversation = tab === "conversation";
  const slot = <KeptSlot node={node} className="flex min-h-0 flex-1 flex-col" />;

  if (full)
    return (
      <>
        {keptWork}
        <div className="flex h-screen flex-col bg-background">
          <FullScreenBar facts={facts} />
          <main
            className={`mx-auto flex min-h-0 w-full flex-1 flex-col px-6 pt-4 ${onConversation ? "max-w-[768px]" : "max-w-[848px]"}`}
          >
            <div hidden={!onConversation} className="flex min-h-0 flex-1 flex-col">
              <Conversation facts={facts} />
            </div>
            {onConversation ? null : slot}
            <div className={onConversation ? "pt-4 pb-6" : "pt-4 pb-[18px]"}>
              {onConversation ? null : <LatestMessage facts={facts} />}
              <Composer facts={facts} />
            </div>
          </main>
        </div>
      </>
    );

  if (layout === "split")
    return (
      <>
        {keptWork}
        <AppShell layout="bare" projectId={facts.session.projectId}>
          <div className="flex h-screen min-w-0 flex-1">
            <SplitView
              storageKey="session-split"
              label="Resize the conversation"
              defaultStart={39}
              minStart={26}
              minEnd={34}
              start={
                <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
                  <SplitHeader facts={facts} tab={tab} />
                  <div className="flex min-h-0 flex-1 flex-col px-6 pt-4">
                    <Conversation facts={facts} narrow />
                  </div>
                  <div className="px-6 pt-3 pb-[18px]">
                    <Composer facts={facts} />
                  </div>
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
        </AppShell>
      </>
    );

  // The conversation stays mounted under the other tabs, so its place in the list survives them.
  const main = (
    <main className="flex h-screen min-w-0 flex-1 flex-col">
      <SessionHeader facts={facts} tab={tab} layout={layout} />
      <div hidden={!onConversation} className="flex min-h-0 flex-1 flex-col px-6 pt-5">
        <Conversation facts={facts} />
      </div>
      {onConversation ? null : <div className="flex min-h-0 flex-1 flex-col px-6 pt-4">{slot}</div>}
      <div className="px-6 pt-3 pb-[18px]">
        {onConversation ? null : <LatestMessage facts={facts} />}
        <Composer facts={facts} />
      </div>
    </main>
  );
  return (
    <>
      {keptWork}
      <AppShell layout="bare" projectId={facts.session.projectId}>
        <SessionInbox selectedId={facts.session.id} />
        {layout === "panel" ? (
          <div className="flex h-screen min-w-0 flex-1">
            <SplitView
              storageKey="session-side-panel"
              label="Resize the side panel"
              minStart={45}
              endSize={{ initial: "212px", min: "200px", max: "420px" }}
              start={main}
              end={
                <aside
                  aria-label={tab === "change" ? "Review" : "Session overview"}
                  className="h-full overflow-y-auto border-l border-rule px-4 py-5"
                >
                  {tab === "change" ? (
                    <ChangeTab facts={facts} place="panel" />
                  ) : (
                    <OverviewPanel facts={facts} tab={tab} />
                  )}
                </aside>
              }
            />
          </div>
        ) : (
          main
        )}
      </AppShell>
    </>
  );
}

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
  const layout = sessionLayout.use();
  const bodies: ReadonlyArray<{ readonly tab: SessionTab; readonly node: ReactNode }> = [
    {
      tab: "change",
      node: (
        <ChangeTab
          facts={facts}
          place={place}
          withActions={!(place === "main" && layout === "panel")}
        />
      ),
    },
    { tab: "preview", node: <PreviewTab facts={facts} /> },
    { tab: "screen", node: <ScreenTab facts={facts} wide={place !== "work"} /> },
    { tab: "terminal", node: <TerminalTab facts={facts} /> },
    { tab: "record", node: <RecordTab facts={facts} /> },
  ];
  // The split view has no Conversation tab on its work side: it opens on the change.
  const shown = tab === "conversation" ? "change" : tab;
  return (
    <>
      {bodies.map((body) =>
        body.tab === shown || (KEPT.has(body.tab) && kept.has(body.tab)) ? (
          <div
            key={body.tab}
            hidden={body.tab !== shown}
            className="flex min-h-0 flex-1 flex-col overflow-y-auto"
          >
            {body.node}
          </div>
        ) : null,
      )}
    </>
  );
}

/** `f` opens full screen and Esc leaves it, from anywhere on the page but a text field. */
function useFullScreenKeys(full: boolean) {
  const navigate = useNavigate();
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
