import { conversationActivity } from "@mend/agent-conversation";
import {
  AgentItemKind,
  agentActivity,
  launchPhaseOf,
  preReleaseMemoryLine,
  withoutLaunchPhase,
} from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { Conversation, ConversationItem } from "@mend/ui/components/conversation";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { TraceRow } from "@mend/ui/components/trace-row";
import { Button } from "@mend/ui/components/ui/button";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import { UserMessage } from "@mend/ui/components/user-message";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { CircleAlertIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react";
import { useLayoutEffect, type ReactNode } from "react";

import type { TranscriptEventDto } from "#/lib/api";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { conversationBody, type ConversationRow, workingOn } from "#/lib/conversation-rows";
import { activityDetail } from "#/lib/inbox";
import { releaseOpeningMessage, useOpeningMessage } from "#/lib/opening-messages";
import { sessionDotfilesLines } from "#/lib/session-dotfiles";
import { noRunWords } from "#/lib/session-record";
import { messageTime, withCheckpoints } from "#/lib/session-sheet";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { AgentTurn, RequestLine } from "./agent-turn";
import { RichText } from "./rich-text";
import type { SessionFacts } from "./session-facts";

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
      : withoutLaunchPhase(session.summary);
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

/** The byline under a person's message: who sent it, when, and how far a steer got. */
const bylineOf = (
  facts: SessionFacts,
  row: Extract<ConversationRow, { readonly kind: "you" }>,
  now: Date,
): string => {
  const name = row.author === null ? null : facts.nameOf(row.author);
  const steer =
    row.steer === null
      ? null
      : row.steer.delivery._tag === "Accepted"
        ? `${facts.agent} read this during its turn`
        : row.steer.delivery._tag === "Queued"
          ? "Waits for the next turn"
          : row.steer.delivery._tag === "NotSent"
            ? "Not sent"
            : "Not confirmed";
  return [name, messageTime(new Date(row.at), now), steer]
    .filter((part) => part !== null)
    .join(" · ");
};

/** A person's message on the right of the thread, sized for the phone under 1024px. */
function YouMessage({ text, byline }: { readonly text: string; readonly byline: string }) {
  return (
    <>
      <UserMessage byline={byline} className="max-lg:hidden">
        <p className="whitespace-pre-wrap">{text}</p>
      </UserMessage>
      <UserMessage size="touch" byline={byline} className="lg:hidden">
        <p className="whitespace-pre-wrap">{text}</p>
      </UserMessage>
    </>
  );
}

/**
 * The start of a session, until its agent's first words arrive (Doop "Starting failed"): the
 * message it was started with, then where the start has got to. A start that failed says so in
 * the banner above instead.
 */
function StartingLines({
  facts,
  opening,
}: {
  readonly facts: SessionFacts;
  readonly opening: ReturnType<typeof useOpeningMessage>;
}) {
  const failed = startFailed(facts);
  const starting = facts.session.status === "starting";
  if (!starting && !failed) return null;
  const phase = launchPhaseOf(facts.session.summary);
  return (
    <>
      {opening === null ? null : (
        <ConversationItem messageId="opening">
          <YouMessage
            text={opening.text}
            byline={[
              facts.nameOf(facts.viewerId),
              messageTime(new Date(opening.sentAt), new Date()),
            ]
              .filter((part) => part !== null)
              .join(" · ")}
          />
        </ConversationItem>
      )}
      <ConversationItem messageId="starting">
        <div role={failed ? undefined : "status"}>
          <ConversationMarker
            kind="status"
            label={
              failed
                ? `${facts.agent} didn't start`
                : `Getting the session ready${phase === null ? "" : ` · ${phase.words}`}`
            }
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
  if (last?.kind === "agent" && last.turn !== null && last.turn.status === "failed") return null;
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

type TranscriptEvent = { readonly key: string; readonly event: TranscriptEventDto };

type TranscriptGroup =
  | { readonly kind: "you"; readonly key: string; readonly text: string }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly events: ReadonlyArray<TranscriptEvent>;
    };

/**
 * The record's events as messages: each person's line, then everything the agent did after it.
 * The record holds no ids; each message and event is keyed by its place in the record, which only
 * grows at its end.
 */
const transcriptGroups = (
  events: ReadonlyArray<TranscriptEventDto>,
): ReadonlyArray<TranscriptGroup> => {
  const groups: Array<TranscriptGroup> = [];
  let agent: Array<TranscriptEvent> = [];
  const flush = () => {
    if (agent.length > 0)
      groups.push({ kind: "agent", key: `record:${groups.length}`, events: agent });
    agent = [];
  };
  events.forEach((event, at) => {
    if (event.kind === "user" && event.text !== null) {
      flush();
      groups.push({ kind: "you", key: `record:${groups.length}`, text: event.text });
    } else if (event.kind !== "reasoning") agent.push({ key: `event:${at}`, event });
  });
  flush();
  return groups;
};

/** A line of Mend's in the thread, muted: a notice, a read on its way, nothing to show. */
function Note({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <ConversationItem messageId={id}>
      <p className="text-row text-muted-foreground">{children}</p>
    </ConversationItem>
  );
}

/**
 * A terminal session's conversation, read from its durable record: what the agent and the person
 * said, and the commands it ran. The record carries no clock times.
 */
function TranscriptMessages({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const recorded = facts.session.sealantRunId !== null;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: facts.session.id }),
    enabled: recorded,
    // A terminal session's record moves without an event that marks it stale: read it while it runs.
    refetchInterval: facts.agentLive ? 2_000 : false,
  });
  if (!recorded)
    return facts.session.status === "starting" || startFailed(facts) ? null : (
      <Note id="no-record">
        {facts.agentLive
          ? "The workspace is starting. The conversation shows here once the agent runs."
          : noRunWords(facts.session.status).note}
      </Note>
    );
  if (transcript.isPending)
    return (
      <ConversationItem messageId="reading-record">
        <p role="status" className="text-row text-muted-foreground">
          Reading the record…
        </p>
      </ConversationItem>
    );
  if (transcript.isError)
    return (
      <ConversationItem messageId="record-failed">
        <div role="alert" className="flex flex-wrap items-center gap-2 text-row text-destructive">
          The record didn't load. It stays on the platform.
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="max-lg:h-11"
            onClick={() => void transcript.refetch()}
          >
            Try again
          </Button>
        </div>
      </ConversationItem>
    );
  const groups = transcriptGroups(transcript.data.events);
  if (groups.length === 0)
    return (
      <Note id="record-empty">
        {facts.agentLive
          ? "Nothing said yet."
          : "No conversation recorded. The session's terminal and change show what it did."}
      </Note>
    );
  return groups.map((group) =>
    group.kind === "you" ? (
      <ConversationItem key={group.key} messageId={group.key}>
        <YouMessage text={group.text} byline="" />
      </ConversationItem>
    ) : (
      <ConversationItem key={group.key} messageId={group.key}>
        <Message>
          <MessageContent className="gap-3">
            <MessageHeader className="px-0 text-meta font-normal">{facts.agent}</MessageHeader>
            {group.events.map(({ key, event }) =>
              event.kind === "assistant" && event.text !== null ? (
                <RichText key={key} text={event.text} />
              ) : event.kind === "tool" ? (
                <TraceRow
                  key={key}
                  icon={event.command === null ? <WrenchIcon /> : <SquareTerminalIcon />}
                  title={event.command === null ? (event.name ?? "Tool") : "Ran"}
                  {...(event.command === null ? {} : { code: event.command })}
                />
              ) : null,
            )}
          </MessageContent>
        </Message>
      </ConversationItem>
    ),
  );
}

/**
 * The session's conversation, the body of its tab (Doop "The turn completes"): what was asked,
 * what the agent wrote and did, the checkpoints between, and what it is doing now. A protocol
 * session reads its turns and items, a window at a time, newest first, and reads the window before
 * as the reader nears the top; a terminal session reads its record. New messages arrive through
 * the tab's event stream, and the thread follows them while the reader is at its end.
 *
 * It ends without an input: writing to the agent is PR 12's composer, in the Conversation's
 * `footer`, and answering a question PR 14's card, where `RequestLine` stands now.
 */
export function ConversationTile({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const conversation = useInfiniteQuery({
    ...conversationQuery(trpc, client, facts.session.id),
    select: (data) => heldConversation(data.pages),
  });
  const opening = useOpeningMessage(facts.session.id);
  const body = conversationBody({ status: conversation.status, data: conversation.data });
  const held = body.rows.length > 0;
  // Once the conversation holds a message, the one this tab held for the start is in it.
  useLayoutEffect(() => {
    if (held && opening !== null) releaseOpeningMessage(facts.session.id);
  }, [held, opening, facts.session.id]);
  const readOlder = () => {
    if (conversation.hasNextPage && !conversation.isFetchingNextPage)
      void conversation.fetchNextPage();
  };
  const now = new Date();
  const entries = withCheckpoints(
    body.rows,
    facts.detail.checkpoints,
    facts.session.id,
    !conversation.hasNextPage,
  );
  const working =
    conversation.data !== undefined &&
    facts.agentLive &&
    conversationActivity(conversation.data) === "working";
  const failedStart = startFailed(facts);
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
      <Conversation
        label={`Conversation: ${facts.title}`}
        keepPlaceOnPrepend
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < READ_OLDER_WITHIN) readOlder();
        }}
        className="min-h-0 flex-1"
      >
        <MendLines facts={facts} />
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
        {held ? null : <StartingLines facts={facts} opening={opening} />}
        {body.list === "transcript" ? <TranscriptMessages facts={facts} /> : null}
        {body.list === "protocol"
          ? entries.map((entry) =>
              entry.kind === "checkpoint" ? (
                <ConversationItem key={entry.key} messageId={entry.key}>
                  <ConversationMarker
                    id={`checkpoint-${entry.mark.ordinal}`}
                    label={`Checkpoint ${entry.mark.ordinal}`}
                    sha={entry.mark.sha}
                    className="scroll-mt-6"
                  />
                </ConversationItem>
              ) : entry.row.kind === "you" ? (
                <ConversationItem key={entry.row.key} messageId={entry.row.key}>
                  <YouMessage text={entry.row.text} byline={bylineOf(facts, entry.row, now)} />
                </ConversationItem>
              ) : (
                <ConversationItem key={entry.row.key} messageId={entry.row.key}>
                  <AgentTurn
                    row={entry.row}
                    facts={facts}
                    renderRequest={(request) => <RequestLine request={request} />}
                  />
                </ConversationItem>
              ),
            )
          : null}
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
      </Conversation>
    </div>
  );
}
