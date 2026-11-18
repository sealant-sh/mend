import { Status } from "@mend/ui/components/status";
import { buttonVariants } from "@mend/ui/components/ui/button";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { inboxQuery } from "#/lib/inbox-live";
import { lumpPrOf, lumpStatusOf, STATUS_WORDS } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";

import { PhoneHeader } from "../workspace/phone-header";
import { Tile, type TileTabEntry } from "../workspace/tile";
import { TileTab } from "../workspace/tile-tab";
import { WorkspaceHeader } from "../workspace/workspace-header";
import { ConversationTile } from "./conversation-tile";
import { type SessionFacts, useSessionFacts } from "./session-facts";

/** Under 1024px Back goes to the inbox, which is home there. */
const BACK_TO_INBOX = { link: { to: "/" }, label: "Back to the inbox" } as const;

/** The VS Code extension's own address: it opens this session's workspace (apps/vscode). */
const vscodeOpenUri = (sessionId: string) =>
  `vscode://sealant-sh.mend/open?session=${encodeURIComponent(sessionId)}`;

/**
 * The session's workspace, as its sheet (ADR 0026): the Workspace header naming the project, the
 * worktree and the branch, then one tile whose one tab is this session's conversation (Doop T01
 * "One tile"). Under 1024px it is the phone's layout instead (T19): the Phone header with Back to
 * the inbox, and the tabs in one strip under it.
 *
 * What attaches here later: the session's other tabs, other sessions of the workspace and the
 * views (PRs 15 and 17 to 23), each a `TileTabEntry` in `tabs`; the workspace "…" and the layout
 * button in the header (PRs 13 and 16); the tile's "+", "…" and maximise (PRs 13 and 15).
 */
function SessionSheet({ facts }: { readonly facts: SessionFacts }) {
  const { session, detail } = facts;
  const conversation = `session:${session.id}`;
  const [active, setActive] = useState(conversation);
  const tab: TileTabEntry = {
    value: conversation,
    tab: (
      <TileTab
        value={conversation}
        kind="session"
        status={lumpStatusOf(session.status)}
        pr={lumpPrOf(detail.landings)}
        statusWords={STATUS_WORDS[session.status]}
        label={facts.title}
        size="auto"
      />
    ),
    body: <ConversationTile facts={facts} />,
  };
  return (
    <div className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col lg:h-[calc(100dvh-2*var(--spacing-sheet-inset))]">
      <WorkspaceHeader
        project={facts.projectName}
        worktree={facts.worktreeName}
        branch={session.branch}
        className="max-lg:hidden"
        actions={
          <a
            href={vscodeOpenUri(session.id)}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Open in VS Code
          </a>
        }
      />
      <PhoneHeader
        title={facts.worktreeName}
        sub={facts.projectName}
        back={BACK_TO_INBOX}
        className="lg:hidden"
      />
      <div className="flex min-h-0 flex-1">
        <Tile label="Tabs" size="auto" tabs={[tab]} active={active} onActiveChange={setActive} />
      </div>
    </div>
  );
}

/** The session's page, read from the cache its route filled. */
export function SessionPage({ sessionId }: { readonly sessionId: string }) {
  return <SessionSheet facts={useSessionFacts(sessionId)} />;
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
    <div aria-busy className="flex h-dvh min-w-0 flex-1 flex-col lg:h-auto">
      <div className="flex h-header shrink-0 items-center gap-3 border-b px-5 max-lg:h-14">
        {listed === null ? (
          <Skeleton className="h-4 w-56" />
        ) : (
          <p className="min-w-0 truncate text-prose">
            <span className="text-muted-foreground">{listed.projectName}</span>
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
