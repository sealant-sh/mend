import { Collapsible } from "@base-ui/react/collapsible";
import {
  type AgentItemDto,
  type AgentRequestDto,
  conversationActivity,
  durationWords,
  itemFailed,
  itemName,
  mendPageCallOf,
} from "@mend/agent-conversation";
import type { PageRef } from "@mend/domain/workbench";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@mend/ui/components/ui/message-scroller";
import { cn } from "@mend/ui/lib/utils";
import { fitPageHeight } from "@mend/ui/page-frame";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, lazy, type ReactNode, Suspense, useLayoutEffect, useRef, useState } from "react";

import { Button, focusRing, touchArea } from "#/components/kit/button";
import { Clock } from "#/components/kit/clock";
import { Icon } from "#/components/kit/icons";
import { Dot } from "#/components/kit/status";
import { messageInputId } from "#/components/session-message-input";
import type { TranscriptEventDto } from "#/lib/api";
import { stepCommand } from "#/lib/checks";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { sentSince, useStickToEnd } from "#/lib/conversation-follow";
import {
  conversationBody,
  type ConversationRow,
  type Segment,
  turnEnd,
  turnLasted,
  workingOn,
} from "#/lib/conversation-rows";
import {
  editMessage,
  type OutboxMessage,
  pruneArrived,
  retryMessage,
  useOutbox,
} from "#/lib/outbox";
import { finishPendingLaunch, launchForSession, usePendingLaunches } from "#/lib/pending-launches";
import { useReducedMotion } from "#/lib/reduced-motion";
import { noRunWords } from "#/lib/session-record";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { ExecutorCalls } from "./executor";
import type { SessionFacts } from "./facts";
import { SessionNotices } from "./notices";
import { RequestCard } from "./request-card";
import { RichText } from "./rich-text";
import { StartLine } from "./starting-session";
import { SubAgentCard, TaskCard } from "./sub-agent-card";
import { YouMessage } from "./you-message";

// A page the agent made renders in a sandboxed frame whose code (and t3code's frame protocol)
// loads with the first page a conversation shows.
const PageFrame = lazy(() =>
  import("#/components/page-frame").then((module) => ({ default: module.PageFrame })),
);
const PageDialog = lazy(() =>
  import("#/components/page-frame").then((module) => ({ default: module.PageDialog })),
);

/**
 * The conversation's pages held in the cache, as one conversation: the tab, the latest strip, the
 * record and the checks all read the same infinite query, the newest window first, and read older
 * windows (`fetchNextPage`) only when the reader asks for them by scrolling up.
 */
export const useConversation = (sessionId: string) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  // What the session now holds leaves this tab's outboxes as each page lands.
  return useInfiniteQuery({
    ...conversationQuery(trpc, client, sessionId, (page) => pruneArrived(sessionId, page)),
    select: (data) => heldConversation(data.pages),
  });
};

/** How near the top, in pixels, the reader is when the window before the held ones is read. */
const READ_OLDER_WITHIN = 600;

/**
 * The conversation (screens P1, C1, X6): what was asked, what the agent wrote and did, and what
 * it asks now. A protocol session reads its turns and items; a terminal session reads its record.
 * New messages arrive through the tab's event stream, the list follows them while it is at its
 * end, and a screen reader hears each one as it is added (the content is a `log`).
 */
export function Conversation({
  facts,
  narrow = false,
}: {
  readonly facts: SessionFacts;
  readonly narrow?: boolean;
}) {
  const conversation = useConversation(facts.session.id);
  const outbox = useOutbox(facts.session.id);
  const reduced = useReducedMotion();
  // The person's own messages show whatever the history's read is doing.
  const body = conversationBody(
    { status: conversation.status, data: conversation.data },
    outbox.messages,
    outbox.scope?.userId ?? "",
  );
  const retry = (message: OutboxMessage) => {
    if (outbox.scope !== null)
      void retryMessage(outbox.courier, outbox.scope, message, {
        resuming: facts.conversationResumes,
      });
  };
  const edit = (message: OutboxMessage) => {
    if (outbox.scope === null) return;
    editMessage(outbox.scope, message);
    document.getElementById(messageInputId(facts.session.id))?.focus();
  };
  const protocol = (conversation.data?.turns.length ?? 0) > 0;
  const launch = launchForSession(usePendingLaunches(), facts.session.id);
  const launchPrompt = protocol ? undefined : launch;
  // Retire external state after the recorded bubble is on screen, never before its query settles.
  useLayoutEffect(() => {
    if (protocol && launch !== undefined) finishPendingLaunch(facts.session.id);
  }, [protocol, launch, facts.session.id]);
  const stick = useStickToEnd();
  const readOlder = () => {
    if (conversation.hasNextPage && !conversation.isFetchingNextPage)
      void conversation.fetchNextPage();
  };
  return (
    // Follows the newest message while the reader is at the end, as the person's own message and
    // the agent's reply arrive; scrolling up stops it, and the button below brings them back.
    // Nearing the top reads the page before (the scroll stays where the reader is). No message is
    // a scroll anchor: an anchor would lift the person's message to the top of the list. The list
    // follows a frame after a change; `stick` keeps the end in place in the frame itself.
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <FollowOwnSend sentAt={outbox.messages.at(-1)?.sentAt ?? null} />
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          ref={stick}
          aria-label="Conversation"
          className="pr-1"
          preserveScrollOnPrepend
          onScroll={(event) => {
            if (event.currentTarget.scrollTop < READ_OLDER_WITHIN) readOlder();
          }}
        >
          <MessageScrollerContent
            className="mx-auto w-full max-w-[768px] gap-[18px]"
            style={{ paddingBottom: "calc(var(--composer-height, 0px) + 16px)" }}
          >
            <MessageScrollerItem messageId="notices">
              <SessionNotices facts={facts} />
              <ExecutorCalls sessionId={facts.session.id} nameOf={facts.nameOf} />
            </MessageScrollerItem>
            {protocol && conversation.hasNextPage ? (
              <MessageScrollerItem messageId="older">
                <OlderMessages
                  pending={conversation.isFetchingNextPage}
                  failure={
                    conversation.isFetchNextPageError ? (conversation.error?.message ?? "") : null
                  }
                  onRead={readOlder}
                />
              </MessageScrollerItem>
            ) : null}
            {body.notice === "reading" ? (
              <MessageScrollerItem messageId="reading">
                <p role="status" className="font-mono text-[12px] text-muted-foreground">
                  Reading the conversation…
                </p>
              </MessageScrollerItem>
            ) : body.notice === "failed" ? (
              <MessageScrollerItem messageId="failed">
                <p role="alert" className="font-mono text-[12px] text-danger">
                  The conversation did not load: {conversation.error?.message}{" "}
                  <button
                    type="button"
                    className={cn("text-info underline-offset-2 hover:underline", focusRing)}
                    onClick={() => void conversation.refetch()}
                  >
                    Try again
                  </button>
                </p>
              </MessageScrollerItem>
            ) : null}
            {launchPrompt !== undefined &&
            body.list !== "transcript" &&
            launchPrompt.prompt !== "" ? (
              <MessageScrollerItem messageId="launch">
                <div className="grid gap-[18px]">
                  <YouMessage text={launchPrompt.prompt} from={null} note={null} narrow={narrow} />
                  <StartLine words={startWords(facts)} />
                </div>
              </MessageScrollerItem>
            ) : null}
            {body.list === "protocol" && !(launchPrompt !== undefined && body.rows.length === 0) ? (
              <ProtocolMessages
                facts={facts}
                rows={body.rows}
                narrow={narrow}
                onRetry={retry}
                onEdit={edit}
              />
            ) : body.list === "transcript" ? (
              <TranscriptMessages facts={facts} narrow={narrow} />
            ) : null}
            {body.list === "protocol" && conversation.data !== undefined ? (
              <LiveLine
                facts={facts}
                working={conversationActivity(conversation.data) === "working"}
                item={workingOn(conversation.data)}
              />
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton
          behavior={reduced ? "auto" : "smooth"}
          style={{ bottom: "calc(var(--composer-height, 0px) + 8px)" }}
          className={cn(
            "size-8 rounded-full border border-rule bg-panel text-ink-2 shadow-sm hover:bg-secondary motion-reduce:transition-none",
            touchArea,
          )}
        >
          <Icon name="arrowDown" size={15} />
          <span className="sr-only">Scroll to the newest message</span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/**
 * Brings the end into view when the person sends a message, wherever they had scrolled to: they
 * are at the composer, and their message is what they look for. Everything else that arrives
 * follows only a reader already at the end.
 */
function FollowOwnSend({ sentAt }: { readonly sentAt: string | null }) {
  const scroller = useMessageScroller();
  // The newest message on screen when the list opened is not a send to follow.
  const followed = useRef(sentAt);
  // Scrolling is the list's own imperative call, made as the person's message is laid out.
  useLayoutEffect(() => {
    if (!sentSince(followed.current, sentAt)) return;
    followed.current = sentAt;
    scroller.scrollToEnd();
  }, [sentAt, scroller]);
  return null;
}

/** The agent's reply: its name and time, then what it wrote and did. */
function AgentMessage({
  name,
  at,
  children,
}: {
  readonly name: string;
  readonly at: string | null;
  readonly children: ReactNode;
}) {
  return (
    <Message>
      <MessageContent className="gap-1.5">
        <MessageHeader className="gap-2.5 px-0 text-foreground">
          <span className="font-sans text-[13px] font-semibold">{name}</span>
          {at === null ? null : (
            <Clock at={at} className="font-mono text-[11px] font-normal text-faint" />
          )}
        </MessageHeader>
        {children}
      </MessageContent>
    </Message>
  );
}

const STEP_KEY: Readonly<Record<string, string>> = {
  "command-execution": "run",
  "file-change": "edit",
  "tool-call": "tool",
  "web-search": "search",
  screen: "screen",
  plan: "plan",
  task: "task",
  proof: "proof",
  page: "page",
  error: "error",
};

const stepResult = (item: AgentItemDto): { readonly word: string; readonly className: string } =>
  itemFailed(item)
    ? { word: item.kind === "error" ? "error" : "failed", className: "text-danger" }
    : item.status === "completed"
      ? { word: "ok", className: "text-[#3f7d54]" }
      : item.status === "declined"
        ? { word: "declined", className: "text-warning" }
        : { word: "…", className: "text-muted-foreground" };

/** `.rec`: what the agent did, one mono row per step, with how it ended. */
function StepTable({
  items,
  pages,
}: {
  readonly items: ReadonlyArray<AgentItemDto>;
  readonly pages: ReadonlyMap<string, PageRef>;
}) {
  return (
    <div className="grid gap-3">
      <ul className="my-1 overflow-hidden rounded-[10px] border border-rule bg-panel">
        {items.map((item) => {
          const result = stepResult(item);
          return (
            <li
              key={item.id}
              className="grid grid-cols-[46px_minmax(0,1fr)_auto] gap-3 px-3 py-[7px] font-mono text-[12px] leading-normal [&+&]:border-t [&+&]:border-rule-faint"
            >
              <span className="text-muted-foreground">{STEP_KEY[item.kind] ?? "step"}</span>
              <span className="truncate text-ink-2" title={stepName(item)}>
                {stepName(item)}
              </span>
              <span className={result.className}>{result.word}</span>
            </li>
          );
        })}
      </ul>
      {items.map((item) => {
        const page = pageOf(item, pages);
        return page === null ? null : <PageEvent key={item.id} page={page} />;
      })}
    </div>
  );
}

/** What a step did: a command step's own command, else the item's name. */
const stepName = (item: AgentItemDto): string =>
  (item.kind === "command-execution" ? stepCommand(item) : null) ?? itemName(item);

const pageOf = (item: AgentItemDto, pages: ReadonlyMap<string, PageRef>): PageRef | null => {
  const attachment = mendPageCallOf(item)?.attachmentId ?? null;
  return attachment === null ? null : (pages.get(attachment) ?? null);
};

/** "Worked for 6 min · 14 steps": a finished turn's steps, folded. */
function Worked({
  row,
  pages,
}: {
  readonly row: Extract<ConversationRow, { readonly kind: "agent" }>;
  readonly pages: ReadonlyMap<string, PageRef>;
}) {
  const { turn, folded } = row;
  if (folded.length === 0) return null;
  const lasted = turn === null ? null : turnLasted(turn);
  const took = lasted === null ? null : durationWords(lasted);
  const failed = folded.filter(itemFailed).length;
  const words = [
    took === null ? "Worked" : `Worked for ${took}`,
    `${folded.length} step${folded.length === 1 ? "" : "s"}`,
    ...(failed === 0 ? [] : [`${failed} failed`]),
  ].join(" · ");
  return (
    <Collapsible.Root>
      <Collapsible.Trigger
        className={cn(
          "group/worked mt-1 flex items-center gap-1.5 rounded-md font-mono text-[12px] text-muted-foreground hover:text-foreground",
          focusRing,
        )}
      >
        <Icon
          name="chevronRight"
          size={12}
          className="transition-transform group-data-[panel-open]/worked:rotate-90 motion-reduce:transition-none"
        />
        {words}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <StepTable items={folded} pages={pages} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Why a turn did not finish as asked, and what to do next: under its reply, or alone. */
function TurnEnd({
  row,
  agent,
}: {
  readonly row: Extract<ConversationRow, { readonly kind: "agent" }>;
  readonly agent: string;
}) {
  const end = turnEnd(row);
  if (end === null) return null;
  return (
    <div className="grid gap-1">
      <p className="font-mono text-[12px] text-danger">{end.words}</p>
      {end.next === "connect-login" ? (
        <p className="text-[13px] text-ink-2">
          Connect your {agent} login in{" "}
          <Link
            to="/settings/account"
            className={cn("text-info underline-offset-2 hover:underline", focusRing)}
          >
            Settings → Account
          </Link>
          , then send the message again.
        </p>
      ) : end.next === "send-again" ? (
        <p className="text-[13px] text-ink-2">Send a message below to try again.</p>
      ) : null}
    </div>
  );
}

export function AgentSegments({
  segments,
  renderRequest,
  pages,
}: {
  readonly segments: ReadonlyArray<Segment>;
  readonly renderRequest: (request: AgentRequestDto) => ReactNode;
  readonly pages: ReadonlyMap<string, PageRef>;
}) {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "text":
        return <RichText key={segment.key} text={segment.item.text ?? ""} />;
      case "steps":
        return <StepTable key={segment.key} items={segment.items} pages={pages} />;
      case "task":
        return <TaskCard key={segment.key} task={segment.task} />;
      case "sub-agent":
        return (
          <SubAgentCard
            key={segment.key}
            agent={segment.agent}
            task={segment.task}
            stepCount={segment.stepCount}
          >
            {segment.segments.length === 0 ? null : (
              <AgentSegments
                segments={segment.segments}
                renderRequest={renderRequest}
                pages={pages}
              />
            )}
          </SubAgentCard>
        );
      case "request":
        return <Fragment key={segment.key}>{renderRequest(segment.request)}</Fragment>;
    }
  });
}

function ProtocolMessages({
  facts,
  rows,
  narrow,
  onRetry,
  onEdit,
}: {
  readonly facts: SessionFacts;
  readonly rows: ReadonlyArray<ConversationRow>;
  readonly narrow: boolean;
  readonly onRetry: (message: OutboxMessage) => void;
  readonly onEdit: (message: OutboxMessage) => void;
}) {
  const pages = usePages(facts.session.id);
  const me = facts.viewer?.userId ?? null;
  if (rows.length === 0)
    return (
      <MessageScrollerItem messageId="empty">
        <p className="font-mono text-[12px] text-muted-foreground">
          Nothing said yet. A message below starts the agent.
        </p>
      </MessageScrollerItem>
    );
  return (
    <>
      {rows.map((row) =>
        row.kind === "you" ? (
          <MessageScrollerItem key={row.key} messageId={row.key}>
            <YouMessage
              text={row.text}
              narrow={narrow}
              from={row.author === null || row.author === me ? null : facts.nameOf(row.author)}
              note={row.steer === null ? null : steerNote(row.steer.delivery._tag)}
              outbox={row.outbox}
              onRetry={onRetry}
              onEdit={onEdit}
            />
          </MessageScrollerItem>
        ) : (
          <MessageScrollerItem key={row.key} messageId={row.key}>
            <AgentMessage name={facts.agent} at={row.turn?.startedAt ?? row.at}>
              <AgentSegments
                segments={row.segments}
                pages={pages}
                renderRequest={(request) => <RequestCard facts={facts} request={request} />}
              />
              <Worked row={row} pages={pages} />
              <TurnEnd row={row} agent={facts.agent} />
            </AgentMessage>
          </MessageScrollerItem>
        ),
      )}
    </>
  );
}

const steerNote = (delivery: string): string => {
  switch (delivery) {
    case "Accepted":
      return "into the running turn";
    case "Queued":
      return "queued for the next turn";
    case "NotSent":
      return "not sent";
    case "Unknown":
      return "delivery not confirmed";
    default:
      return "sending";
  }
};

/** The pages the session made, by id, for the page calls in its steps. */
const usePages = (sessionId: string): ReadonlyMap<string, PageRef> => {
  const trpc = useTRPC();
  const pages = useQuery(trpc.sessions.pages.queryOptions({ id: sessionId }));
  return new Map((pages.data ?? []).map((page) => [page.id, page]));
};

/** `.live`: what the agent is doing right now, after its latest message. */
function LiveLine({
  facts,
  working,
  item,
}: {
  readonly facts: SessionFacts;
  /** A turn or a background task is under way (`conversationActivity`). */
  readonly working: boolean;
  readonly item: AgentItemDto | null;
}) {
  if (!working || !facts.agentLive) return null;
  return (
    <MessageScrollerItem messageId="live">
      <p className="flex items-center gap-2 font-mono text-[12px] text-ink-2">
        <Dot tone="run" />
        {item === null
          ? `${facts.agent} is working`
          : `${STEP_KEY[item.kind] ?? "working"} · ${stepName(item)}`}
        <span
          aria-hidden="true"
          className="inline-block h-3.5 w-[7px] rounded-[2px] bg-primary motion-safe:animate-pulse"
        />
      </p>
    </MessageScrollerItem>
  );
}

/** Where a created session's start has got to, until its agent's first words arrive. */
const startWords = (facts: SessionFacts): string =>
  facts.detail.currentAgent === null && facts.session.status === "starting"
    ? "Starting the workspace"
    : `Starting ${facts.agent}`;

/** A page the agent made, shown where it was made; Open shows it large. */
function PageEvent({ page }: { readonly page: PageRef }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-[13px] font-medium break-words text-foreground">
          {page.title}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Open<span className="sr-only"> {page.title}</span>
        </Button>
      </figcaption>
      <Suspense fallback={<div style={{ height: fitPageHeight(page.height) }} />}>
        <PageFrame page={page} />
        {open ? <PageDialog page={page} onClose={() => setOpen(false)} /> : null}
      </Suspense>
    </figure>
  );
}

/**
 * A terminal session's conversation, read from its durable record: what the agent and the person
 * said, and the commands it ran. The record carries no clock times.
 */
function TranscriptMessages({
  facts,
  narrow,
}: {
  readonly facts: SessionFacts;
  readonly narrow: boolean;
}) {
  const trpc = useTRPC();
  const launch = launchForSession(usePendingLaunches(), facts.session.id);
  const recorded = facts.session.sealantRunId !== null;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: facts.session.id }),
    enabled: recorded,
    // Terminal record entries emit progress pointers, which do not invalidate query reads.
    refetchInterval: facts.agentLive && !facts.conversationLive ? 1_000 : false,
  });
  const waitingPrompt =
    launch !== undefined &&
    launch.prompt !== "" &&
    !(
      transcript.data?.events.some((event) => event.kind === "user" && event.text !== null) ?? false
    );
  useLayoutEffect(() => {
    if (
      launch !== undefined &&
      transcript.data?.events.some((event) => event.kind === "user" && event.text !== null)
    )
      finishPendingLaunch(facts.session.id);
  }, [launch, transcript.data, facts.session.id]);
  const opening = waitingPrompt ? (
    <MessageScrollerItem messageId="launch">
      <div className="grid gap-[18px]">
        <YouMessage text={launch.prompt} from={null} note={null} narrow={narrow} />
        <StartLine words={startWords(facts)} />
      </div>
    </MessageScrollerItem>
  ) : null;
  if (waitingPrompt && (!recorded || transcript.isPending || transcript.data?.events.length === 0))
    return opening;
  if (!recorded)
    return (
      <MessageScrollerItem messageId="no-record">
        <p className="font-mono text-[12px] text-muted-foreground">
          {facts.agentLive
            ? "The workspace is starting. The conversation shows here once the agent runs."
            : noRunWords(facts.session.status).note}
        </p>
      </MessageScrollerItem>
    );
  if (transcript.isPending)
    return (
      <MessageScrollerItem messageId="reading-record">
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading the record…
        </p>
      </MessageScrollerItem>
    );
  if (transcript.isError)
    return (
      <>
        {opening}
        <MessageScrollerItem messageId="record-failed">
          <p role="alert" className="font-mono text-[12px] text-danger">
            The record could not be read; it stays on the platform.{" "}
            <button
              type="button"
              className={cn("text-info underline-offset-2 hover:underline", focusRing)}
              onClick={() => void transcript.refetch()}
            >
              Try again
            </button>
          </p>
        </MessageScrollerItem>
      </>
    );
  const groups = transcriptGroups(transcript.data.events);
  if (groups.length === 0 && waitingPrompt) return opening;
  if (groups.length === 0)
    return (
      <MessageScrollerItem messageId="record-empty">
        <p className="font-mono text-[12px] text-muted-foreground">
          {facts.conversationLive
            ? "Nothing said yet. A message below starts the agent."
            : "No conversation recorded. The Terminal and Change tabs show what the session did."}
        </p>
      </MessageScrollerItem>
    );
  return (
    <>
      {opening}
      {groups.map((group, index) =>
        group.kind === "you" ? (
          <MessageScrollerItem key={index} messageId={`record:${index}`}>
            <YouMessage text={group.text} from={null} note={null} narrow={narrow} />
          </MessageScrollerItem>
        ) : (
          <MessageScrollerItem key={index} messageId={`record:${index}`}>
            <AgentMessage name={facts.agent} at={null}>
              {group.events.map((event, at) =>
                event.kind === "assistant" && event.text !== null ? (
                  <RichText key={at} text={event.text} />
                ) : event.kind === "page" && event.page !== undefined ? (
                  <PageEvent key={at} page={event.page} />
                ) : event.kind === "tool" ? (
                  <p
                    key={at}
                    className="truncate rounded-[10px] border border-rule bg-panel px-3 py-[7px] font-mono text-[12px] text-ink-2"
                  >
                    <span className="mr-3 text-muted-foreground">
                      {event.command === null ? "tool" : "run"}
                    </span>
                    {event.command ?? event.name ?? "tool"}
                  </p>
                ) : null,
              )}
            </AgentMessage>
          </MessageScrollerItem>
        ),
      )}
    </>
  );
}

type TranscriptGroup =
  | { readonly kind: "you"; readonly text: string }
  | { readonly kind: "agent"; readonly events: ReadonlyArray<TranscriptEventDto> };

/** The record's events as messages: each person's line, then everything the agent did after it. */
const transcriptGroups = (
  events: ReadonlyArray<TranscriptEventDto>,
): ReadonlyArray<TranscriptGroup> => {
  const groups: Array<TranscriptGroup> = [];
  let agent: Array<TranscriptEventDto> = [];
  const flush = () => {
    if (agent.length > 0) groups.push({ kind: "agent", events: agent });
    agent = [];
  };
  for (const event of events) {
    if (event.kind === "user" && event.text !== null) {
      flush();
      groups.push({ kind: "you", text: event.text });
    } else if (event.kind !== "reasoning") agent.push(event);
  }
  flush();
  return groups;
};

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
    <p className="flex items-center justify-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      {pending ? (
        <span role="status">Reading earlier messages…</span>
      ) : failure !== null ? (
        <>
          <span role="alert" className="text-danger">
            Earlier messages did not load: {failure}
          </span>
          <Button size="sm" variant="ghost" onClick={onRead}>
            Try again
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={onRead}>
          Show earlier messages
        </Button>
      )}
    </p>
  );
}
