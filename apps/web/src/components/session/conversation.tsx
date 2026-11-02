import { Collapsible } from "@base-ui/react/collapsible";
import {
  type AgentItemDto,
  conversationActivity,
  durationWords,
  itemFailed,
  itemName,
  mendPageCallOf,
} from "@mend/agent-conversation";
import type { PageRef } from "@mend/domain/workbench";
import { Bubble, BubbleContent } from "@mend/ui/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@mend/ui/components/ui/message-scroller";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { Button, focusRing } from "#/components/kit/button";
import { Icon } from "#/components/kit/icons";
import { Dot } from "#/components/kit/status";
import { PageDialog, PageFrame } from "#/components/page-frame";
import { messageInputId } from "#/components/session-message-input";
import type { TranscriptEventDto } from "#/lib/api";
import { stepCommand } from "#/lib/checks";
import { conversationQuery } from "#/lib/conversation";
import {
  conversationBody,
  type ConversationRow,
  turnEnd,
  workingOn,
} from "#/lib/conversation-rows";
import {
  editMessage,
  type OutboxMessage,
  pruneArrived,
  retryMessage,
  useOutbox,
} from "#/lib/outbox";
import { useReducedMotion } from "#/lib/reduced-motion";
import { noRunWords } from "#/lib/session-record";
import { clockTime } from "#/lib/session-view";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import type { SessionFacts } from "./facts";
import { SessionNotices } from "./notices";
import { RequestCard } from "./request-card";
import { RichText } from "./rich-text";

/** The conversation's reading of the cache, shared by the tab, the latest strip and the record. */
export const useConversation = (sessionId: string) => {
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  // What the session now holds leaves this tab's outboxes as each read lands.
  return useQuery(
    conversationQuery(client, queryClient, sessionId, (read) => pruneArrived(sessionId, read)),
  );
};

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
  return (
    // Follows the newest message while the reader is at the end; scrolling up stops it.
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Conversation" className="pr-1">
          <MessageScrollerContent className="gap-[18px] pb-4">
            <MessageScrollerItem messageId="notices">
              <SessionNotices facts={facts} />
            </MessageScrollerItem>
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
            {body.list === "protocol" ? (
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
          className="size-8 rounded-full border border-rule bg-panel text-ink-2 shadow-sm hover:bg-secondary motion-reduce:transition-none"
        >
          <Icon name="arrowDown" size={15} />
          <span className="sr-only">Scroll to the newest message</span>
        </MessageScrollerButton>
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

/** What a bubble of the person's own says of a message still in their outbox. */
const outboxNote = (
  message: OutboxMessage,
): { readonly words: string; readonly className: string } | null => {
  switch (message.state._tag) {
    case "Sending":
      // A stopped session takes the words once Mend has resumed it.
      return {
        words: message.resuming === true ? "resuming…" : "sending",
        className: "text-faint",
      };
    case "Sent":
      return null;
    case "Unconfirmed":
      return { words: "delivery not confirmed", className: "text-warning" };
    case "NotSent":
      return { words: "not sent", className: "text-danger" };
  }
};

/**
 * A message the person (or someone sharing control) sent: the right-hand `.msg-you` bubble. One
 * of their own still in their outbox says how far it got; one that did not arrive says why, under
 * the bubble, with Retry and Edit. The composer's footer announces the outcome, on every tab.
 */
function YouMessage({
  text,
  from,
  note,
  narrow,
  outbox = null,
  onRetry,
  onEdit,
}: {
  readonly text: string;
  readonly from: string | null;
  readonly note: string | null;
  readonly narrow: boolean;
  readonly outbox?: OutboxMessage | null;
  readonly onRetry?: (message: OutboxMessage) => void;
  readonly onEdit?: (message: OutboxMessage) => void;
}) {
  const pending = outbox === null ? null : outboxNote(outbox);
  const stuck =
    outbox !== null && (outbox.state._tag === "NotSent" || outbox.state._tag === "Unconfirmed")
      ? outbox
      : null;
  return (
    <Message align="end">
      <MessageContent>
        {from === null && note === null && pending === null ? null : (
          <MessageHeader className="justify-end gap-2 px-1 font-mono text-[11px] text-faint">
            {from === null ? null : (
              <span className="font-sans font-semibold text-ink-2">{from}</span>
            )}
            {pending === null ? note : <span className={pending.className}>{pending.words}</span>}
          </MessageHeader>
        )}
        <Bubble variant="secondary" align="end" className={narrow ? "max-w-[92%]" : "max-w-[78%]"}>
          <BubbleContent
            className={cn(
              "rounded-[18px_18px_6px_18px] px-4 py-3 text-[14.5px] leading-[1.55] whitespace-pre-wrap text-foreground",
              stuck !== null && "border border-dashed border-input bg-transparent",
            )}
          >
            {text}
          </BubbleContent>
        </Bubble>
        {stuck === null ? null : (
          <div className="flex flex-wrap items-center justify-end gap-1.5 px-1">
            {stuck.state._tag === "NotSent" ? (
              <p className="min-w-0 flex-1 text-right font-mono text-[11.5px] text-danger">
                {stuck.state.words}
              </p>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => onRetry?.(stuck)}>
              Retry
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onEdit?.(stuck)}>
              Edit
            </Button>
          </div>
        )}
      </MessageContent>
    </Message>
  );
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
            <time dateTime={at} className="font-mono text-[11px] font-normal text-faint">
              {clockTime(new Date(at))}
            </time>
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
      <ul className="my-1 overflow-hidden rounded-[14px] border border-rule bg-panel">
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
  const started = turn?.startedAt ?? null;
  const ended = turn?.endedAt ?? null;
  const took =
    started === null || ended === null
      ? null
      : durationWords(new Date(ended).getTime() - new Date(started).getTime());
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
          <MessageScrollerItem key={row.key} messageId={row.key} scrollAnchor>
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
              {row.segments.map((segment) =>
                segment.kind === "text" ? (
                  <RichText key={segment.key} text={segment.item.text ?? ""} />
                ) : segment.kind === "steps" ? (
                  <StepTable key={segment.key} items={segment.items} pages={pages} />
                ) : (
                  <RequestCard key={segment.key} facts={facts} request={segment.request} />
                ),
              )}
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
      <PageFrame page={page} />
      {open ? <PageDialog page={page} onClose={() => setOpen(false)} /> : null}
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
  const recorded = facts.session.sealantRunId !== null;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: facts.session.id }),
    enabled: recorded,
  });
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
    );
  const groups = transcriptGroups(transcript.data.events);
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
      {groups.map((group, index) =>
        group.kind === "you" ? (
          <MessageScrollerItem key={index} messageId={`record:${index}`} scrollAnchor>
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
                    className="truncate rounded-xl border border-rule bg-panel px-3 py-[7px] font-mono text-[12px] text-ink-2"
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
