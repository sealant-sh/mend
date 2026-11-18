import {
  type AgentItemDto,
  type AgentRequestDto,
  type AgentTaskView,
  durationWords,
  itemFailed,
  itemName,
  mendPageCallOf,
  requestOutcome,
  taskFacts,
} from "@mend/agent-conversation";
import { AgentRequestKind, type PageRef, sessionAsk } from "@mend/domain/workbench";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { TraceRow, type TraceTone } from "@mend/ui/components/trace-row";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Message, MessageContent, MessageHeader } from "@mend/ui/components/ui/message";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Schema } from "effect";
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
import {
  addedUnreachableLogin,
  type ConversationRow,
  defaultEndpointHost,
  type Segment,
  turnEnd,
  turnLasted,
} from "#/lib/conversation-rows";
import { askWords } from "#/lib/inbox";
import { laterPage } from "#/lib/later-pages";
import { useTRPC } from "#/lib/trpc";

import { PageEvent } from "./page-view";
import { RichText } from "./rich-text";
import type { SessionFacts } from "./session-facts";

/** A request kind this app knows; a newer server's kind reads as a plain ask. */
const isRequestKind = Schema.is(AgentRequestKind);

type AgentRow = Extract<ConversationRow, { readonly kind: "agent" }>;

/** Where a person connects or changes the logins their agents run on. */
const AGENT_LOGINS = laterPage("settings/agent-logins");

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

/** "Worked for 2m 4s", the steps it took, and how many failed: a finished turn's steps, folded. */
function Worked({ row }: { readonly row: AgentRow }) {
  if (row.folded.length === 0) return null;
  const lasted = row.turn === null ? null : turnLasted(row.turn);
  const stopped = row.turn?.status === "interrupted" || row.turn?.status === "cancelled";
  const title = [
    lasted === null ? "Worked" : `Worked for ${durationWords(lasted)}`,
    ...(stopped ? ["before it stopped"] : []),
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
}: {
  readonly segment: Extract<Segment, { readonly kind: "sub-agent" }>;
  readonly renderRequest: (request: AgentRequestDto) => ReactNode;
  readonly pages: PagesById;
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
          <AgentSegments segments={segment.segments} renderRequest={renderRequest} pages={pages} />
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
 * A question or an approval the agent asked for, as one line: what it wants, and whether it waits
 * for an answer. Answering is PR 14's card, which takes this line's place.
 */
export function RequestLine({ request }: { readonly request: AgentRequestDto }) {
  const { kind } = request;
  const asked = isRequestKind(kind) ? askWords(sessionAsk({ ...request, kind })) : "Asked you";
  return (
    <ConversationMarker
      kind="status"
      label={`${asked} · ${request.status === "pending" ? "Waiting for your answer" : requestOutcome(request)}`}
    />
  );
}

/** What the agent wrote and did, run by run, in the order it happened. */
export function AgentSegments({
  segments,
  renderRequest,
  pages,
}: {
  readonly segments: ReadonlyArray<Segment>;
  readonly renderRequest: (request: AgentRequestDto) => ReactNode;
  readonly pages: PagesById;
}) {
  return segments.map((segment) => {
    switch (segment.kind) {
      case "text":
        return <RichText key={segment.key} text={segment.item.text ?? ""} />;
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

/** Why a turn didn't finish as asked, in the agent's own words, and what to do next. */
function TurnEnd({ row, facts }: { readonly row: AgentRow; readonly facts: SessionFacts }) {
  const end = turnEnd(row, useUnreachableHost(row, facts));
  const turn = row.turn;
  if (end === null || turn === null) return null;
  const { agent } = facts;
  const unreachable = (turn.unreachable ?? null) !== null;
  const title =
    end.next === "add-credit"
      ? `${agent} ran out of credit`
      : end.next === "connect-login"
        ? `${agent} couldn't use your login`
        : turn.status === "interrupted"
          ? "The turn was interrupted"
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
  readonly renderRequest: (request: AgentRequestDto) => ReactNode;
  readonly pages: PagesById;
}) {
  // A session's turns are numbered from 0; people count them from 1.
  const header = row.turn === null ? facts.agent : `${facts.agent} · turn ${row.turn.ordinal + 1}`;
  return (
    <Message>
      <MessageContent className="gap-3">
        <MessageHeader className="px-0 text-meta font-normal">{header}</MessageHeader>
        <Worked row={row} />
        {/* A finished turn's steps fold away; the pages they made stay in view. */}
        <Pages items={row.folded} pages={pages} />
        <AgentSegments segments={row.segments} renderRequest={renderRequest} pages={pages} />
        <TurnEnd row={row} facts={facts} />
      </MessageContent>
    </Message>
  );
}
