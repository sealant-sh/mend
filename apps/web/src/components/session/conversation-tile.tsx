import { conversationActivity, isOpenTurn } from "@mend/agent-conversation";
import {
  TERMINAL_HOOK_HARNESSES,
  AgentItemKind,
  agentActivity,
  launchPhaseOf,
  preReleaseMemoryLine,
  withoutLaunchPhase,
} from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { Conversation, ConversationItem } from "@mend/ui/components/conversation";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { Avatar, AvatarFallback } from "@mend/ui/components/ui/avatar";
import { Button } from "@mend/ui/components/ui/button";
import { UserMessage } from "@mend/ui/components/user-message";
import { cn } from "@mend/ui/lib/utils";
import { useInfiniteQuery, useQueries, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { CircleAlertIcon, ClockIcon } from "lucide-react";
import type { ReactNode } from "react";

import { restoreMarks } from "#/lib/checkpoint-restores";
import { type ConversationView, conversationQuery, heldConversation } from "#/lib/conversation";
import { conversationBody, type ConversationRow, workingOn } from "#/lib/conversation-rows";
import { activityDetail } from "#/lib/inbox";
import { landingMarks } from "#/lib/landing";
import {
  editMessage,
  type OutboxMessage,
  retryMessage,
  UNCONFIRMED,
  useOutbox,
} from "#/lib/outbox";
import { steerNote } from "#/lib/session-composer";
import { withoutLayoutWords } from "#/lib/session-details";
import { sessionDotfilesLines } from "#/lib/session-dotfiles";
import { SESSION_STALE_MS } from "#/lib/session-queries";
import { messageTime, withCheckpoints, withLandings, withRestores } from "#/lib/session-sheet";
import { controlMarkers, withMarkers } from "#/lib/shared-control";
import { startingLine } from "#/lib/starting-line";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { checkpointMarks, sharedWorktree, turnCheckpoints } from "#/lib/turn-checkpoints";

import { initialsOf } from "../app-sidebar.tsx";
import { AgentTurn, type PagesById } from "./agent-turn";
import { CheckpointLine } from "./checkpoint-line";
import { messageInputId, SessionComposer } from "./composer";
import { ExecutorCalls } from "./executor-calls";
import { RequestLine } from "./request-card";
import { RestoreLine } from "./restore-line";
import type { SessionFacts } from "./session-facts";
import { SessionNotices } from "./session-notices";
import { ControlMarkerLabel, LoginBand, SharedControlBands, WaitingLine } from "./shared-control";
import { StoppedBanner, StoppedLine } from "./stopped-banner";

/** An item kind this app knows; a newer server's kind says nothing about the work under way. */
const isItemKind = Schema.is(AgentItemKind);

/** How near the top, in pixels, the reader is when the window before the held ones is read. */
const READ_OLDER_WITHIN = 600;

/** A started session that never got as far as its agent: its failure is about the start. */
const startFailed = (facts: SessionFacts): boolean =>
  facts.session.status === "failed" && facts.detail.currentAgent === null;

/**
 * What Mend says about the session before its conversation, each line only when there is
 * something to say: the session's own summary (a secret file it didn't write, a source left out),
 * what the launch sent of its owner's dotfiles, and the memory from before 0.36 nobody was
 * credited with. A starting session's launch phase is said on its starting line instead, and a
 * failed one's reason where it failed.
 */
function MendLines({ facts }: { readonly facts: SessionFacts }) {
  const { session, detail } = facts;
  const summary =
    session.status === "failed" || session.status === "starting"
      ? null
      : withoutLayoutWords(withoutLaunchPhase(session.summary));
  const memory = preReleaseMemoryLine(detail.preReleaseMemory);
  const dotfiles = sessionDotfilesLines(session.dotfiles);
  if (summary === null && memory === null && dotfiles.length === 0) return null;
  return (
    <ConversationItem messageId="mend-lines">
      <div className="flex flex-col gap-1 text-meta text-muted-foreground">
        {summary === null ? null : <p className="wrap-anywhere">{summary}</p>}
        {dotfiles.map((line) => (
          <p
            key={line.text}
            className={line.notApplied ? "wrap-anywhere text-warning" : "wrap-anywhere"}
          >
            {line.text}
          </p>
        ))}
        {memory === null || detail.preReleaseMemory === null ? null : (
          <p className="wrap-anywhere" title={detail.preReleaseMemory.notCredited.join("\n")}>
            {memory}
          </p>
        )}
      </div>
    </ConversationItem>
  );
}

/** What a message of the person's own still in their outbox says of where it stands. */
const outboxNote = (message: OutboxMessage): string | null => {
  switch (message.state._tag) {
    case "Sending":
      // A stopped session takes the words once Mend has resumed it.
      return message.resuming === true ? "Resuming the session…" : "Sending…";
    case "Sent":
      return null;
    case "Unconfirmed":
      return UNCONFIRMED;
    case "NotSent":
      return message.state.words;
  }
};

/**
 * Who sent a message and when (Doop "Shared control · Grace sees Ada's message"): "You · 10:24"
 * for the viewer's own, the sender's initials and name for anyone else's.
 */
const bylineOf = (facts: SessionFacts, author: string | null, time: string): ReactNode => {
  if (author === null || author === facts.viewerId) return author === null ? time : `You · ${time}`;
  const name = facts.nameOf(author);
  if (name === null) return time;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Avatar size="sm" className="size-5" aria-hidden>
        <AvatarFallback className="text-2xs font-semibold text-foreground">
          {initialsOf(name)}
        </AvatarFallback>
      </Avatar>
      {name} · {time}
    </span>
  );
};

/** What the line under a person's message says: who sent it, when, and how far it got. */
const noteOf = (
  facts: SessionFacts,
  row: Extract<ConversationRow, { readonly kind: "you" }>,
  conversation: ConversationView | undefined,
  now: Date,
): { readonly byline: ReactNode; readonly note: string | null; readonly pending: boolean } => {
  const byline = bylineOf(facts, row.author, messageTime(new Date(row.at), now));
  if (row.outbox !== null) {
    const note = outboxNote(row.outbox);
    return { byline, note, pending: row.outbox.state._tag !== "Sent" };
  }
  if (row.steer === null) {
    // Mend keeps what was sent while the session starts for its agent (SLNT-1237): it says so
    // until the agent takes it. One the start never got to says why in its turn, below it.
    const turn = conversation?.turns.find((each) => each.id === row.turnId);
    if (turn?.status === "queued" && facts.session.status === "starting")
      return { byline, note: `Waits for ${facts.agent} to start.`, pending: true };
    return { byline, note: null, pending: false };
  }
  const turn = conversation?.turns.find((each) => each.id === row.steer?.turnId);
  const steer = steerNote(row.steer, facts.agent, turn !== undefined && isOpenTurn(turn));
  return { byline, note: steer.words, pending: steer.pending };
};

/** Send again, or take back into the composer, a message of the person's own that didn't arrive. */
function StuckActions({
  sessionId,
  message,
}: {
  readonly sessionId: string;
  readonly message: OutboxMessage;
}) {
  const outbox = useOutbox(sessionId);
  const { scope } = outbox;
  if (scope === null) return null;
  return (
    <span className="flex gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-primary max-lg:h-11"
        onClick={() => void retryMessage(outbox.courier, scope, message)}
      >
        Try again
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="text-primary max-lg:h-11"
        onClick={() => {
          editMessage(scope, message);
          document.getElementById(messageInputId(sessionId))?.focus();
        }}
      >
        Edit
      </Button>
    </span>
  );
}

/**
 * A person's message on the right of the thread, sized for the phone under 1024px. One the agent
 * hasn't read yet is dashed, with where it stands under it; one that couldn't send offers Try
 * again and Edit.
 */
export function YouMessage({
  text,
  byline,
  note = null,
  pending = false,
  stuck = null,
  sessionId = "",
}: {
  readonly text: string;
  readonly byline: ReactNode;
  readonly note?: string | null;
  readonly pending?: boolean;
  /** The person's own message that didn't arrive, which they can send again or take back. */
  readonly stuck?: OutboxMessage | null;
  readonly sessionId?: string;
}) {
  const line =
    note === null && stuck === null ? (
      byline
    ) : (
      <span className="flex flex-col items-end gap-1">
        {byline === "" ? null : <span>{byline}</span>}
        {note === null ? null : (
          <span className={cn("text-right", stuck?.state._tag === "NotSent" && "text-destructive")}>
            {pending && stuck === null ? (
              <ClockIcon aria-hidden className="mr-1.5 inline size-3.5 align-middle" />
            ) : null}
            {note}
          </span>
        )}
        {stuck === null ? null : <StuckActions sessionId={sessionId} message={stuck} />}
      </span>
    );
  return (
    <>
      <UserMessage byline={line} pending={pending} className="max-lg:hidden">
        <p className="whitespace-pre-wrap">{text}</p>
      </UserMessage>
      <UserMessage size="touch" byline={line} pending={pending} className="lg:hidden">
        <p className="whitespace-pre-wrap">{text}</p>
      </UserMessage>
    </>
  );
}

/**
 * Where a session's start has got to, under what was sent to it (Doop "Starting failed"): its first
 * message and anything sent since are the server's own turns from the moment Mend took the start
 * (SLNT-1237). A start that failed says so in the banner above as well.
 */
function StartingLine({ facts }: { readonly facts: SessionFacts }) {
  const failed = startFailed(facts);
  const starting = facts.session.status === "starting";
  if (!starting && !failed) return null;
  const phase = launchPhaseOf(facts.session.summary);
  return (
    <>
      <ConversationItem messageId="starting">
        <div role={failed ? undefined : "status"}>
          <ConversationMarker
            kind="status"
            label={failed ? `${facts.agent} didn't start` : startingLine(phase)}
          />
        </div>
      </ConversationItem>
    </>
  );
}

/**
 * A session that failed once its agent had run, for a reason no turn of its own says (Doop "A
 * failed session"): the reason Mend recorded, the one its inbox row shows.
 */
function SessionFailure({
  facts,
  rows,
}: {
  readonly facts: SessionFacts;
  readonly rows: ReadonlyArray<ConversationRow>;
}) {
  const { session } = facts;
  if (session.status !== "failed" || startFailed(facts) || session.summary === null) return null;
  const last = rows.at(-1);
  // The last turn already says why it ended.
  if (
    last?.kind === "agent" &&
    last.turn !== null &&
    (last.turn.status === "failed" || (last.turn.memoryLimit ?? null) !== null)
  ) {
    return null;
  }
  return (
    <ConversationItem messageId="failed">
      <div className="flex flex-col gap-2 border-t pt-4">
        <p className="flex items-center gap-2 font-semibold text-foreground">
          <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
          The session failed
        </p>
        <p className="text-prose wrap-anywhere text-foreground">{session.summary}</p>
      </div>
    </ConversationItem>
  );
}

/** The top of a conversation held in part: earlier messages, read as the reader nears them. */
function OlderMessages({
  pending,
  failure,
  onRead,
}: {
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onRead: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2 text-meta text-muted-foreground">
      {pending ? (
        <span role="status">Reading earlier messages…</span>
      ) : failure === null ? (
        <Button type="button" size="sm" variant="ghost" className="max-lg:h-11" onClick={onRead}>
          Show earlier messages
        </Button>
      ) : (
        <>
          <span role="alert" className="text-destructive">
            Earlier messages didn't load. {failure}
          </span>
          <Button type="button" size="sm" variant="ghost" className="max-lg:h-11" onClick={onRead}>
            Try again
          </Button>
        </>
      )}
    </div>
  );
}

/** What the agent is doing right now, after its latest words, while its turn runs. */
function LiveLine({
  facts,
  item,
}: {
  readonly facts: SessionFacts;
  readonly item: ReturnType<typeof workingOn>;
}) {
  const kind = item?.kind ?? null;
  const doing =
    item === null || !isItemKind(kind)
      ? null
      : agentActivity({ kind, title: item.title, data: item.data });
  return (
    <ConversationItem messageId="live">
      <div role="status">
        <ConversationMarker
          kind="status"
          label={doing === null ? `${facts.agent} is working…` : `${activityDetail(doing)}…`}
        />
      </div>
    </ConversationItem>
  );
}

/** A line of Mend's in the thread, muted: a notice, a read on its way, nothing to show. */
function Note({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <ConversationItem messageId={id}>
      <p className="text-row text-muted-foreground">{children}</p>
    </ConversationItem>
  );
}

/**
 * The pages the session's agent made, by id. Until they are read, or if they can't be, a page
 * call shows as its step alone.
 */
const usePages = (sessionId: string): PagesById => {
  const trpc = useTRPC();
  const pages = useQuery(trpc.sessions.pages.queryOptions({ id: sessionId }));
  if (pages.isPending || pages.isError) return new Map();
  return new Map(pages.data.map((page) => [page.id, page]));
};

/**
 * What a session whose agent runs in a terminal says while its conversation holds nothing yet
 * (SLNT-1235): each of its turns lands here, as turn rows, once it ends.
 */
function TerminalNote({ facts }: { readonly facts: SessionFacts }) {
  if (facts.session.mode !== "terminal" || facts.session.status === "starting") return null;
  return (
    <Note id="terminal-note">
      {facts.agentLive
        ? `${facts.agent} runs in a terminal. Each turn shows here once it ends.`
        : "No conversation recorded. The session's terminal and change show what it did."}
    </Note>
  );
}

/**
 * The session's conversation, the body of its tab (Doop "The turn completes"): what was asked,
 * what the agent wrote and did, the checkpoints between, and what it is doing now. A protocol
 * session reads its turns and items, a window at a time, newest first, and reads the window before
 * as the reader nears the top; a terminal's turns land there too, once each ends. New messages arrive through
 * the tab's event stream, and the thread follows them while the reader is at its end.
 *
 * Its footer is the composer (`SessionComposer`): the person's messages show in the thread the
 * moment they are sent (`lib/outbox`), and say where they stand until the agent reads them.
 * A question or approval the agent asks waits in the composer card; the conversation keeps a line
 * where it was asked (`RequestLine`), saying whose answer it waits for and, once settled, who
 * answered and how.
 */
export function ConversationTile({
  facts,
  onStartOwn,
}: {
  readonly facts: SessionFacts;
  /** Opens a New session tab in this workspace, for someone who can't message this session. */
  readonly onStartOwn?: () => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const conversation = useInfiniteQuery({
    ...conversationQuery(trpc, client, facts.session.id),
    select: (data) => heldConversation(data.pages),
  });
  const pages = usePages(facts.session.id);
  const outbox = useOutbox(facts.session.id);
  // One source in both modes (SLNT-1235): a terminal's turns land as turn rows once each ends.
  const body = conversationBody(
    { status: conversation.status, data: conversation.data },
    outbox.messages,
    facts.viewerId,
  );
  // The conversation holds a message of its own (one still in the outbox isn't the server's).
  const held = body.rows.some((row) => row.kind !== "you" || row.outbox === null);
  const readOlder = () => {
    if (conversation.hasNextPage && !conversation.isFetchingNextPage)
      void conversation.fetchNextPage();
  };
  const now = new Date();
  const control = useQuery({
    ...trpc.sessions.controlEvents.queryOptions({ id: facts.session.id }),
    staleTime: SESSION_STALE_MS,
    enabled: body.list === "protocol",
  });
  // Shared control's asks, grants and take-backs, as lines between the messages by time.
  const markers =
    control.isPending || control.isError
      ? []
      : controlMarkers(control.data, {
          viewerId: facts.viewerId,
          nameOf: facts.nameOf,
          ownerUserId: facts.session.ownerUserId,
        });
  // A turn's checkpoint shows after it only when a file changed during the turn: ask which files
  // changed for each ended turn. Both ends of a turn are fixed commits, so the answer never
  // changes and is read once.
  const turns = turnCheckpoints(
    conversation.data?.turns ?? [],
    facts.detail.checkpoints,
    facts.session.id,
  );
  const turnFiles = useQueries({
    queries: turns.map((turn) => ({
      ...trpc.worktrees.sliceFiles.queryOptions({
        id: facts.session.worktreeId,
        ...(turn.from === null ? {} : { from: turn.from.id }),
        to: turn.to.id,
      }),
      staleTime: Number.POSITIVE_INFINITY,
      enabled: body.list === "protocol",
    })),
  });
  const shared = sharedWorktree(facts.session.id, facts.detail.checkpoints);
  // Going back to a checkpoint (SLNT-1259) is the change's owner's; the server checks it again.
  const canGoBack = facts.detail.control.own;
  const entries = withMarkers(
    withRestores(
      withLandings(
        withCheckpoints(body.rows, checkpointMarks(turns, turnFiles)),
        landingMarks(facts.detail.landings, facts.detail.checkpoints, facts.session.id),
        !conversation.hasNextPage,
      ),
      restoreMarks(facts.detail.restores, facts.viewerId, facts.nameOf),
      !conversation.hasNextPage,
    ),
    (entry) => (entry.kind === "row" ? entry.row.at : entry.mark.at),
    markers,
    !conversation.hasNextPage,
  );
  // While the session starts, what Mend keeps for the agent (SLNT-1237) is not work it does yet:
  // the starting line says where the start is. A terminal agent works while its hooks report no
  // wait (SLNT-1235): a message waiting for its terminal is no turn of its own, and one with no
  // hooks says nothing either way.
  const working =
    conversation.data !== undefined &&
    facts.agentLive &&
    facts.session.status !== "starting" &&
    (facts.session.mode === "terminal"
      ? TERMINAL_HOOK_HARNESSES.has(facts.session.harness) &&
        facts.detail.currentAgent?.waiting == null
      : conversationActivity(conversation.data) === "working");
  const failedStart = startFailed(facts);
  // Anyone who steers the session answers what its agent asks (shared control included).
  const canAnswer = facts.detail.control.steer;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {failedStart ? (
        <Banner tone="error" title="The session couldn't start." className="max-lg:hidden">
          {facts.session.summary ?? `${facts.agent} didn't start.`}
        </Banner>
      ) : null}
      {failedStart ? (
        <Banner
          tone="error"
          layout="stacked"
          title="The session couldn't start."
          className="lg:hidden"
        >
          {facts.session.summary ?? `${facts.agent} didn't start.`}
        </Banner>
      ) : null}
      <LoginBand facts={facts} />
      <SharedControlBands facts={facts} />
      <StoppedBanner facts={facts} />
      <SessionNotices facts={facts} />
      <Conversation
        label={`Conversation: ${facts.title}`}
        keepPlaceOnPrepend
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < READ_OLDER_WITHIN) readOlder();
        }}
        className="min-h-0 flex-1"
        footer={
          <SessionComposer facts={facts} conversation={conversation.data} onStartOwn={onStartOwn} />
        }
      >
        <MendLines facts={facts} />
        <ExecutorCalls facts={facts} />
        {body.list === "protocol" && conversation.hasNextPage ? (
          <ConversationItem messageId="older">
            <OlderMessages
              pending={conversation.isFetchingNextPage}
              failure={
                conversation.isFetchNextPageError ? (conversation.error?.message ?? "") : null
              }
              onRead={readOlder}
            />
          </ConversationItem>
        ) : null}
        {body.notice === "reading" ? (
          <ConversationItem messageId="reading">
            <p role="status" className="text-row text-muted-foreground">
              Reading the conversation…
            </p>
          </ConversationItem>
        ) : body.notice === "failed" && !conversation.isFetchNextPageError ? (
          <ConversationItem messageId="failed-read">
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 text-row text-destructive"
            >
              The conversation didn't load. {conversation.error?.message}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="max-lg:h-11"
                onClick={() => void conversation.refetch()}
              >
                Try again
              </Button>
            </div>
          </ConversationItem>
        ) : null}
        {body.list === "protocol" && body.rows.length === 0 ? <TerminalNote facts={facts} /> : null}
        {body.list === "protocol"
          ? entries.map((placed) => {
              if (placed.kind === "marker")
                return (
                  <ConversationItem key={placed.marker.key} messageId={placed.marker.key}>
                    <ConversationMarker
                      kind="status"
                      label={<ControlMarkerLabel marker={placed.marker} />}
                    />
                  </ConversationItem>
                );
              const entry = placed.entry;
              return entry.kind === "checkpoint" ? (
                <ConversationItem key={entry.key} messageId={entry.key}>
                  <CheckpointLine
                    mark={entry.mark}
                    sessionId={facts.session.id}
                    changeId={facts.detail.change?.id ?? null}
                    shared={shared}
                    canGoBack={canGoBack}
                  />
                </ConversationItem>
              ) : entry.kind === "restore" ? (
                <ConversationItem key={entry.key} messageId={entry.key}>
                  <RestoreLine
                    mark={entry.mark}
                    sessionId={facts.session.id}
                    canGoBack={canGoBack}
                  />
                </ConversationItem>
              ) : entry.kind === "landing" ? (
                <ConversationItem key={entry.key} messageId={entry.key}>
                  <ConversationMarker
                    label={entry.mark.label}
                    sha={entry.mark.sha}
                    {...(entry.mark.pullRequest === null
                      ? {}
                      : {
                          link: (
                            <a href={entry.mark.pullRequest.url} target="_blank" rel="noreferrer">
                              View pull request
                            </a>
                          ),
                        })}
                  />
                </ConversationItem>
              ) : entry.row.kind === "you" ? (
                <ConversationItem key={entry.row.key} messageId={entry.row.key}>
                  <YouMessage
                    text={entry.row.text}
                    sessionId={facts.session.id}
                    {...noteOf(facts, entry.row, conversation.data, now)}
                    stuck={
                      entry.row.outbox !== null &&
                      (entry.row.outbox.state._tag === "NotSent" ||
                        entry.row.outbox.state._tag === "Unconfirmed")
                        ? entry.row.outbox
                        : null
                    }
                  />
                </ConversationItem>
              ) : (
                <ConversationItem key={entry.row.key} messageId={entry.row.key}>
                  <AgentTurn
                    row={entry.row}
                    facts={facts}
                    renderRequest={(request) => (
                      <RequestLine request={request} facts={facts} canAnswer={canAnswer} />
                    )}
                    pages={pages}
                  />
                </ConversationItem>
              );
            })
          : null}
        <StartingLine facts={facts} />
        {body.list === "protocol" ? <WaitingLine facts={facts} /> : null}
        {body.list === "protocol" && working && conversation.data !== undefined ? (
          <LiveLine facts={facts} item={workingOn(conversation.data)} />
        ) : null}
        {body.list === "protocol" &&
        !held &&
        !failedStart &&
        facts.session.status !== "starting" ? (
          <Note id="empty">Nothing said yet.</Note>
        ) : null}
        <SessionFailure facts={facts} rows={body.rows} />
        <StoppedLine facts={facts} />
      </Conversation>
    </div>
  );
}
