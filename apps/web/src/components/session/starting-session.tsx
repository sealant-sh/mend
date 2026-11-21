import { Conversation, ConversationItem } from "@mend/ui/components/conversation";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { Navigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { PhoneHeader } from "#/components/workspace/phone-header";
import { PhoneTabStrip } from "#/components/workspace/phone-tab-strip";
import { Tile } from "#/components/workspace/tile";
import { TileTab } from "#/components/workspace/tile-tab";
import { WorkspaceHeader } from "#/components/workspace/workspace-header";
import { type OutboxMessage, UNCONFIRMED, useOutbox } from "#/lib/outbox";
import {
  type PendingStart,
  startTitle,
  usePendingStart,
  useStoredStart,
} from "#/lib/pending-starts";
import { lumpStatusOf, messageTime, STATUS_WORDS } from "#/lib/session-sheet";
import { harnessName } from "#/lib/session-view";
import { STARTING_LINE } from "#/lib/starting-line";

import { useRecoverStart } from "../new-session/instant-start";
import { StartingComposer } from "./composer";
import { YouMessage } from "./conversation-tile";

const BACK_TO_INBOX = { link: { to: "/" }, label: "Back to the inbox" } as const;

/** What the page calls a session Mend hasn't made yet. */
const NEW_SESSION = "New session";

/**
 * A session this tab is starting, before Mend has made it (SLNT-1196): laid out as the session's
 * own page is, with the person's message, anything sent since, and the start's line, so nothing
 * moves when that page takes its place. After a reload the tab's kept copy of the start shows, and
 * Mend is asked which session it made (SLNT-1239). A start the tab doesn't hold at all goes home.
 */
export function StartingSessionPage({ draftId }: { readonly draftId: string }) {
  const start = usePendingStart(draftId);
  const stored = useStoredStart(draftId);
  if (start !== undefined) return <StartingSheet start={start} />;
  // Drawn on the server, which can't see the tab's starts: the browser decides.
  if (stored === undefined) return null;
  if (stored === null) return <Navigate to="/" replace />;
  return <RecoveredStart start={stored} />;
}

/** A start kept from before a reload: its page again, while Mend is asked what it made. */
function RecoveredStart({ start }: { readonly start: PendingStart }) {
  const recover = useRecoverStart();
  // Once, as the page opens: the recovery reads Mend until it knows, then moves the page on.
  useEffect(() => recover(start), [recover, start]);
  return <StartingSheet start={start} />;
}

function StartingSheet({ start }: { readonly start: PendingStart }) {
  const title = startTitle(start.prompt);
  const value = `session:${start.draftId}`;
  const tab = (size: "default" | "touch") => (
    <TileTab
      value={value}
      label={title}
      size={size}
      kind="session"
      status={lumpStatusOf("starting")}
      pr="none"
      statusWords={STATUS_WORDS.starting}
    />
  );
  return (
    <div aria-busy className="flex h-dvh min-w-0 flex-none flex-col lg:h-auto lg:min-h-0 lg:flex-1">
      <WorkspaceHeader
        project={start.project.name}
        projectId={start.project.id}
        worktree={NEW_SESSION}
        branch=""
        className="max-lg:hidden"
      />
      <PhoneHeader
        title={NEW_SESSION}
        sub={start.project.name}
        back={BACK_TO_INBOX}
        className="lg:hidden"
      />
      <PhoneTabStrip
        className="lg:hidden"
        tabs={[{ value, tab: tab("touch") }]}
        active={value}
        onActiveChange={() => undefined}
        add={null}
      />
      <div className="flex min-h-0 flex-1 max-lg:**:data-tile-strip:hidden">
        <Tile
          id={`tile:${start.draftId}`}
          label="Tile 1"
          focused
          active={value}
          tabs={[{ value, tab: tab("default"), body: <StartingThread start={start} /> }]}
        />
      </div>
    </div>
  );
}

/**
 * Where a message written on a start's page stands: on its way until Mend has it, then kept by Mend
 * for the agent (SLNT-1237), which only then outlives this tab.
 */
const startingNote = (message: OutboxMessage, agent: string): string => {
  switch (message.state._tag) {
    case "Sending":
      return "Sending…";
    case "Sent":
      return `Waits for ${agent} to start.`;
    case "Unconfirmed":
      return UNCONFIRMED;
    case "NotSent":
      return message.state.words;
  }
};

/** A start in a workspace's New session tab: the thread, until the session takes the tab. */
export function StartingTab({ draftId }: { readonly draftId: string }) {
  const start = usePendingStart(draftId);
  return start === undefined ? null : <StartingThread start={start} />;
}

/** The thread: the first message, what was sent since, and where the start has got to. */
function StartingThread({ start }: { readonly start: PendingStart }) {
  const agent = harnessName(start.harness);
  // Under the session's own address once Mend has made it, where the composer writes from then on.
  const outbox = useOutbox(start.sessionId ?? start.draftId);
  const now = new Date();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation
        label={`Conversation: ${startTitle(start.prompt)}`}
        className="min-h-0 flex-1"
        footer={<StartingComposer start={start} />}
      >
        <ConversationItem messageId="opening">
          <YouMessage text={start.prompt} byline={`You · ${messageTime(start.sentAt, now)}`} />
        </ConversationItem>
        {outbox.messages.map((message) => (
          <ConversationItem key={message.clientMessageId} messageId={message.clientMessageId}>
            <YouMessage
              text={message.text}
              byline={`You · ${messageTime(new Date(message.sentAt), now)}`}
              note={startingNote(message, agent)}
              pending
            />
          </ConversationItem>
        ))}
        <ConversationItem messageId="starting">
          <div role="status">
            <ConversationMarker kind="status" label={STARTING_LINE} />
          </div>
        </ConversationItem>
      </Conversation>
    </div>
  );
}
