import {
  type AgentItemDto,
  type AgentTaskView,
  durationWords,
  itemFailed,
  itemName,
  mendPageCallOf,
  taskFacts,
} from "@mend/agent-conversation";
import type { PageRef } from "@mend/domain/workbench";
import { TraceRow, type TraceTone } from "@mend/ui/components/trace-row";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BotIcon,
  CircleAlertIcon,
  FilePenIcon,
  GlobeIcon,
  ListChecksIcon,
  ListTodoIcon,
  type LucideIcon,
  SquareTerminalIcon,
  WrenchIcon,
  CircleDotIcon,
} from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";

import { stepCommand } from "#/lib/checks";
import type { RequestView } from "#/lib/conversation";
import {
  addedUnreachableLogin,
  type ConversationRow,
  defaultEndpointHost,
  type Segment,
  turnEnd,
  type TurnNext,
  turnLasted,
} from "#/lib/conversation-rows";
import { messageTime } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";

import { PageEvent } from "./page-view";
import { RichText } from "./rich-text";
import type { SessionFacts } from "./session-facts";

type AgentRow = Extract<ConversationRow, { readonly kind: "agent" }>;

/** Where a person connects or changes the logins their agents run on. */
const AGENT_LOGINS = { to: "/settings/agent-logins" } as const;

const STEP_ICONS: Readonly<Record<string, LucideIcon>> = {
  "command-execution": SquareTerminalIcon,
  "file-change": FilePenIcon,
  "tool-call": WrenchIcon,
  "web-search": GlobeIcon,
  plan: ListTodoIcon,
  task: ListTodoIcon,
  error: CircleAlertIcon,
};

/** What a step did, as the trace says it: the verb, and the command or file in mono. */
const stepLine = (item: AgentItemDto): { readonly title: string; readonly code?: string } => {
  switch (item.kind) {
    case "command-execution":
      return { title: "Ran", code: stepCommand(item) ?? itemName(item) };
    case "file-change":
      return { title: "Edited", code: itemName(item) };
    case "web-search":
      return { title: "Searched", code: itemName(item) };
    default:
      return { title: itemName(item) };
  }
};

/** How a step ended, or that it still runs; how long it took when it finished. */
const stepEnd = (item: AgentItemDto): { readonly tone: TraceTone; readonly words: string } => {
  if (itemFailed(item)) return { tone: "error", words: "failed" };
  if (item.status === "declined") return { tone: "none", words: "declined" };
  if (item.status === "in-progress") return { tone: "running", words: "running" };
  const took = new Date(item.updatedAt).getTime() - new Date(item.createdAt).getTime();
  return { tone: "none", words: took >= 1000 ? durationWords(took) : "" };
};

/** One thing the agent did, as a row of its turn's trace. */
function Step({ item }: { readonly item: AgentItemDto }) {
  const Icon = STEP_ICONS[item.kind] ?? CircleDotIcon;
  const line = stepLine(item);
  const end = stepEnd(item);
  return (
    <TraceRow
      tone={end.tone}
      icon={<Icon />}
      title={line.title}
      {...(line.code === undefined ? {} : { code: line.code })}
      {...(end.words === "" ? {} : { description: end.words })}
    />
  );
}

/** The pages a session's agent made, by id, for the page calls among its steps. */
export type PagesById = ReadonlyMap<string, PageRef>;

const NO_PAGES: PagesById = new Map();

/** The pages any of `items` made, each with the step that made it. */
const pagesMadeBy = (
  items: ReadonlyArray<AgentItemDto>,
  pages: PagesById,
): ReadonlyArray<{ readonly key: string; readonly page: PageRef }> =>
  items.flatMap((item) => {
    const attachment = mendPageCallOf(item)?.attachmentId ?? null;
    const page = attachment === null ? undefined : pages.get(attachment);
    return page === undefined ? [] : [{ key: item.id, page }];
  });

/** Pages the agent made, each shown where it was made. */
function Pages({
  items,
  pages,
}: {
  readonly items: ReadonlyArray<AgentItemDto>;
  readonly pages: PagesById;
}) {
  return pagesMadeBy(items, pages).map(({ key, page }) => (
    <div key={key} className="mt-2">
      <PageEvent page={page} />
    </div>
  ));
}

/** Steps in a row, then the pages any of them made. */
function Steps({
  items,
  pages,
}: {
  readonly items: ReadonlyArray<AgentItemDto>;
  readonly pages: PagesById;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((item) => (
        <Step key={item.id} item={item} />
      ))}
      <Pages items={items} pages={pages} />
    </div>
  );
}

/**
 * "Worked for 2m 4s", the steps it took, and how many failed: a finished turn's steps, folded. A
 * turn someone stopped reads "Stopped after 1m 14s" (Doop "Stop the turn").
 */
function Worked({ row }: { readonly row: AgentRow }) {
  if (row.folded.length === 0) return null;
  const lasted = row.turn === null ? null : turnLasted(row.turn);
  const interrupted = row.turn?.status === "interrupted";
  const withdrawn = row.turn?.status === "cancelled";
  const title = interrupted
    ? lasted === null
      ? "Stopped"
      : `Stopped after ${durationWords(lasted)}`
    : [
        lasted === null ? "Worked" : `Worked for ${durationWords(lasted)}`,
        ...(withdrawn ? ["before it stopped"] : []),
      ].join(" ");
  const failed = row.folded.filter(itemFailed).length;
  const steps = `${row.folded.length} step${row.folded.length === 1 ? "" : "s"}`;
  return (
    <TraceRow
      icon={<ListChecksIcon />}
      title={title}
      description={failed === 0 ? steps : `${steps} · ${failed} failed`}
    >
      <Steps items={row.folded} pages={NO_PAGES} />
    </TraceRow>
  );
}

/** A delegated agent: what it was asked, its own steps and words, and how it ended. */
function SubAgent({
  segment,
  renderRequest,
  pages,
  live,
}: {
  readonly segment: Extract<Segment, { readonly kind: "sub-agent" }>;
  readonly renderRequest: (request: RequestView) => ReactNode;
  readonly pages: PagesById;
  readonly live: boolean;
}) {
  const { agent, task } = segment;
  const status =
    task?.status ?? (agent.background && agent.status === "completed" ? "started" : agent.status);
  const result = agent.background ? (task?.summary ?? null) : agent.result;
  const kind = agent.background ? "Background sub-agent" : "Sub-agent";
  return (
    <TraceRow
      tone={status === "running" ? "running" : status === "failed" ? "error" : "none"}
      icon={<BotIcon />}
      title={agent.description}
      code={agent.type}
      description={`${kind} · ${status}`}
    >
      <div className="flex flex-col gap-2 py-1">
        {segment.segments.length === 0 ? null : (
          <AgentSegments
            segments={segment.segments}
            renderRequest={renderRequest}
            pages={pages}
            live={live}
          />
        )}
        {task?.error == null ? null : <p className="text-row text-destructive">{task.error}</p>}
        {result === null ? null : <RichText text={result} />}
      </div>
    </TraceRow>
  );
}

/** A background task the agent started: what it is, and its progress as the harness reports it. */
function Task({ task }: { readonly task: AgentTaskView }) {
  const facts = taskFacts(task);
  return (
    <TraceRow
      tone={task.status === "running" ? "running" : task.status === "failed" ? "error" : "none"}
      icon={<ListTodoIcon />}
      title={task.workflow ?? task.description}
      description={facts === "" ? task.status : `${task.status} · ${facts}`}
    >
      {task.error === null && task.summary === null ? null : (
        <div className="flex flex-col gap-2 py-1">
          {task.error === null ? null : <p className="text-row text-destructive">{task.error}</p>}
          {task.summary === null ? null : <RichText text={task.summary} />}
        </div>
      )}
    </TraceRow>
  );
}

/**
 * What the agent wrote and did, run by run, in the order it happened. While `live` (its turn
 * runs), what it writes shows at a steady pace as it streams in.
 */
export function AgentSegments({
  segments,
  renderRequest,
  pages,
  live,
}: {
  readonly segments: ReadonlyArray<Segment>;
  readonly renderRequest: (request: RequestView) => ReactNode;
  readonly pages: PagesById;
  readonly live: boolean;
}) {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "text":
        return <RichText key={segment.key} text={segment.item.text ?? ""} live={live} />;
      case "steps":
        return <Steps key={segment.key} items={segment.items} pages={pages} />;
      case "task":
        return <Task key={segment.key} task={segment.task} />;
      case "sub-agent":
        return (
          <SubAgent
            key={segment.key}
            segment={segment}
            renderRequest={renderRequest}
            pages={pages}
            live={live}
          />
        );
      case "request":
        return <Fragment key={segment.key}>{renderRequest(segment.request)}</Fragment>;
    }
  });
}

/**
 * The host of the endpoint a turn couldn't reach, for the person who added the login it ran on:
 * read from their own login, so nobody else's screen ever holds it. Null for anyone else.
 */
function useUnreachableHost(row: AgentRow, facts: SessionFacts): string | null {
  const trpc = useTRPC();
  const theirs = addedUnreachableLogin(row.turn, facts.viewerId);
  const identity = useQuery({ ...trpc.platform.sealantIdentity.queryOptions(), enabled: theirs });
  if (!theirs || identity.isPending || identity.isError) return null;
  return defaultEndpointHost(identity.data.accounts, facts.session.harness);
}

/** Copy the turn's error, saying so on the button for a moment. */
function CopyError({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button
      type="button"
      variant="ghost"
      className="max-lg:h-11"
      // A browser that refuses the clipboard leaves the button as it was.
      onClick={() => void copy().catch(() => undefined)}
    >
      {copied ? "Copied" : "Copy error"}
    </Button>
  );
}

/**
 * A turn someone stopped with Stop turn: when, and that what it did stays (Doop "Stop the turn").
 * Not a failure, so no alert: the conversation carries on from the composer.
 */
function TurnStopped({ row, facts }: { readonly row: AgentRow; readonly facts: SessionFacts }) {
  const at = row.turn?.endedAt ?? row.at;
  const kept = `What ${facts.agent} changed before then is kept${facts.agentLive ? ", and the workspace is still running" : ""}.`;
  return (
    <p className="text-prose text-muted-foreground">
      This turn was stopped at {messageTime(new Date(at), new Date())}. {kept}
    </p>
  );
}

/**
 * The workspace reached its memory limit during the turn (SLNT-1233): what the kernel stopped,
 * and, when that was the agent, how to go on.
 */
function TurnMemoryLimit({
  words,
  next,
}: {
  readonly words: string;
  readonly next: TurnNext | null;
}) {
  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-4">
      <p className="flex items-center gap-2 font-semibold text-foreground">
        <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        The workspace hit its memory limit
      </p>
      <p className="text-prose text-foreground">
        {next === "send-again" ? `${words} Send a message to start it again.` : words}
      </p>
    </div>
  );
}

/** Why a turn didn't finish as asked, in the agent's own words, and what to do next. */
function TurnEnd({ row, facts }: { readonly row: AgentRow; readonly facts: SessionFacts }) {
  const end = turnEnd(row, useUnreachableHost(row, facts));
  const turn = row.turn;
  if (end === null || turn === null) return null;
  if (turn.status === "interrupted" && (turn.memoryLimit ?? null) === null) {
    return <TurnStopped row={row} facts={facts} />;
  }
  if ((turn.memoryLimit ?? null) !== null)
    return <TurnMemoryLimit words={end.words} next={end.next} />;
  const { agent } = facts;
  const unreachable = (turn.unreachable ?? null) !== null;
  const title =
    end.next === "add-credit"
      ? `${agent} ran out of credit`
      : end.next === "connect-login"
        ? `${agent} couldn't use your login`
        : turn.status === "cancelled"
          ? "The turn was withdrawn"
          : "The turn failed";
  const account = turn.billedAccountName;
  const explanation = unreachable
    ? end.words
    : end.next === "add-credit"
      ? `${account === null ? "The account this turn ran on" : `The account ${account}`} has no credit left, so ${agent} stopped partway through this turn. Add credit to that account, or pick another login in your agent logins, then send the message again.`
      : end.next === "connect-login"
        ? `Connect your ${agent} login in your agent logins, then send the message again.`
        : "Send a message to try again.";
  const error = unreachable ? null : turn.error;
  return (
    <div className="mt-2 flex flex-col gap-3 border-t pt-4">
      <p className="flex items-center gap-2 font-semibold text-foreground">
        <CircleAlertIcon aria-hidden className="size-4 shrink-0 text-destructive" />
        {title}
      </p>
      {error === null || error === "" ? null : (
        <pre className="overflow-x-auto rounded-lg bg-muted px-3.5 py-2.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-foreground">
          {error}
        </pre>
      )}
      <p className="text-prose text-foreground">{explanation}</p>
      {end.next === "add-credit" || end.next === "connect-login" || error !== null ? (
        <div className="flex flex-wrap gap-2">
          {end.next === "send-again" ? null : (
            <Link
              {...AGENT_LOGINS}
              className={cn(buttonVariants({ variant: "outline" }), "max-lg:h-11")}
            >
              Open agent logins
            </Link>
          )}
          {error === null || error === "" ? null : <CopyError text={error} />}
        </div>
      ) : null}
    </div>
  );
}

/** Whose login another person's turn ran on, by name; null for the viewer's own or unknown. */
const turnLogin = (facts: SessionFacts, author: string | null): string | null => {
  if (author === null || author === facts.viewerId) return null;
  const owner = facts.session.ownerUserId;
  const spent = facts.detail.control.turnsOnSendersLogin || owner === null ? author : owner;
  return spent === facts.viewerId ? null : facts.nameOf(spent);
};

/**
 * The agent's reply to one message (Doop "The turn completes"): a muted header naming the agent
 * and the turn, then what it did, folded, and what it wrote; or, while the turn runs, its steps as
 * they happen. A turn that ended badly says why under it.
 */
export function AgentTurn({
  row,
  facts,
  renderRequest,
  pages,
}: {
  readonly row: AgentRow;
  readonly facts: SessionFacts;
  readonly renderRequest: (request: RequestView) => ReactNode;
  readonly pages: PagesById;
}) {
  // A session's turns are numbered from 0; people count them from 1. Another person's turn says
  // whose login it ran on (Doop "Shared control · Grace sees Ada's message"): its sender's, where
  // each person runs as themselves, else the owner's.
  const login = turnLogin(facts, row.turn?.author ?? null);
  const header = [
    facts.agent,
    row.turn === null ? null : `turn ${row.turn.ordinal + 1}`,
    login === null ? null : `${login}'s login`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <Message>
      <MessageContent className="gap-3">
        <MessageHeader className="px-0 text-meta font-normal">{header}</MessageHeader>
        <Worked row={row} />
        {/* A finished turn's steps fold away; the pages they made stay in view. */}
        <Pages items={row.folded} pages={pages} />
        <AgentSegments
          segments={row.segments}
          renderRequest={renderRequest}
          pages={pages}
          live={row.open}
        />
        <TurnEnd row={row} facts={facts} />
      </MessageContent>
    </Message>
  );
}
