import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import { cn } from "@mend/ui/lib/utils";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  GitCommitHorizontalIcon,
  ScrollTextIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import {
  checkpointAt,
  checkpointOfHash,
  commandEndWords,
  filteredRows,
  isRecordFilter,
  KIND_WORDS,
  RECORD_FILTERS,
  type RecordFilter,
  type RecordRow,
  recordRows,
  TRIGGER_WORDS,
} from "#/lib/record-rows";
import { failureWords } from "#/lib/refusal";
import { screenLogActor } from "#/lib/screen-log";
import { noRunWords } from "#/lib/session-record";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import type { ViewFacts, WorkspaceView, ViewPlace } from "../views.tsx";

/** What "nothing of this kind" says, per filter. */
const EMPTY_WORDS: Readonly<Record<RecordFilter, string>> = {
  all: "Nothing in the record yet. What the agent says and does shows here as it happens.",
  message: "No messages in the record yet.",
  command: "No commands in the record yet.",
  edit: "No edits in the record yet.",
  screen: "Nothing on a screen yet. When the agent looks at or acts on its screen, it shows here.",
  checkpoint:
    "No checkpoints yet. Mend takes one each time the agent finishes changing files, so the first shows here once this session edits something.",
};

const useRecordFacts = (_place: ViewPlace): ViewFacts => ({});

/**
 * The Record view (Doop "Record" and its states): everything the session did, newest first,
 * filtered by kind, each row with its time, kind, what happened and the checkpoint it falls in; a
 * row opens to as much as the record holds of it. A pull request's link to `#checkpoint-N` lands
 * here with that checkpoint's row in view and marked.
 */
function RecordBody({ place }: { readonly place: ViewPlace }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const facts = useSessionFacts(place.sessionId);
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const marked = checkpointOfHash(hash);

  const conversation = useInfiniteQuery({
    ...conversationQuery(trpc, client, place.sessionId),
    select: (data) => heldConversation(data.pages),
  });
  // A terminal session has no turns: its record is the transcript, as its conversation reads it.
  const terminalOnly = conversation.isSuccess && conversation.data.turns.length === 0;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: place.sessionId }),
    enabled: terminalOnly && facts.session.sealantRunId !== null,
  });
  const screenLog = useQuery(trpc.screens.log.queryOptions({ id: place.sessionId }));

  // A filter picked holds for the address it was picked on: a checkpoint's link shows every kind.
  const [picked, setPicked] = useState<{ readonly hash: string; readonly filter: RecordFilter }>({
    hash,
    filter: "all",
  });
  const filter = picked.hash === hash ? picked.filter : "all";
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const mark = useMutation({
    mutationFn: () =>
      client.sessions.checkpoint.mutate({
        id: place.sessionId,
        request: { trigger: "user-mark" },
      }),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });

  const checkpoints = facts.detail.checkpoints;
  const rows =
    conversation.data === undefined
      ? []
      : recordRows({
          conversation: conversation.data,
          transcript:
            !terminalOnly || transcript.isPending || transcript.isError
              ? []
              : transcript.data.events,
          checkpoints,
          // Until the screen log is read, or if it can't be, the rest of the record stands.
          screenLog: screenLog.isPending || screenLog.isError ? [] : screenLog.data,
          agent: facts.agent,
          nameOf: (userId, fallback = "Mend") =>
            userId === null
              ? fallback
              : userId === facts.viewerId
                ? "You"
                : (facts.nameOf(userId) ?? "Someone"),
          actorOf: (entry) =>
            screenLogActor(entry, facts.agent, (userId) =>
              userId === facts.viewerId ? "You" : (facts.nameOf(userId) ?? "Someone"),
            ),
        });
  const shown = filteredRows(rows, filter);
  const markedRow =
    marked === null ? null : (shown.find((row) => row.checkpoint === marked) ?? null);

  // The marked checkpoint scrolls into view once its row is drawn; scrolling is the browser's.
  const list = useRef<HTMLUListElement | null>(null);
  const markedKey = markedRow?.key ?? null;
  useEffect(() => {
    if (markedKey === null) return;
    list.current
      ?.querySelector(`[data-row="${CSS.escape(markedKey)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [markedKey]);

  const held = conversation.data !== undefined;
  const partial = held && conversation.hasNextPage;
  const readAll = async () => {
    for (;;) {
      const result = await conversation.fetchNextPage();
      if (result.isError || !result.hasNextPage) return;
    }
  };
  const clearMark = () =>
    void navigate({ to: ".", search: (search) => search, hash: "", replace: true });
  const live = facts.agentLive;

  return (
    <div className="@container/record flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-2.5 max-lg:px-4">
        <Tabs
          value={filter}
          onValueChange={(value: string) => {
            if (isRecordFilter(value)) setPicked({ hash, filter: value });
          }}
        >
          <TabsList
            aria-label="Show"
            className="h-8 max-w-full overflow-x-auto max-lg:h-11 data-horizontal:h-8 max-lg:data-horizontal:h-11"
          >
            {RECORD_FILTERS.map((option) => (
              <TabsTrigger
                key={option.value}
                value={option.value}
                disabled={!held}
                className="px-2.5 max-lg:px-3.5"
              >
                {option.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="min-w-0 truncate text-meta text-muted-foreground @3xl/record:ml-auto">
          {facts.title} · newest first
        </p>
        {live ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-lg:h-11 max-lg:px-4"
              disabled={mark.isPending}
              onClick={() => mark.mutate()}
            >
              {mark.isPending ? "Marking…" : "Mark a checkpoint"}
            </Button>
            {mark.isError ? (
              <p role="alert" className="text-meta text-destructive">
                {failureWords(mark.error, "Mend couldn't take the checkpoint. Try again.")}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {marked !== null && held ? (
        <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-row max-lg:px-4">
          <GitCommitHorizontalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            {checkpoints.some((checkpoint) => checkpoint.ordinal === marked) ? (
              <>
                You opened <span className="font-medium text-foreground">checkpoint {marked}</span>{" "}
                from a link.
              </>
            ) : (
              `This session has no checkpoint ${marked}.`
            )}
          </p>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-0 max-lg:h-11"
            onClick={clearMark}
          >
            Clear the mark
          </Button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          aria-hidden
          className="mx-5 hidden grid-cols-[84px_100px_minmax(0,1fr)_72px_16px] gap-x-3 border-b border-border py-2.5 text-meta text-muted-foreground @3xl/record:grid"
        >
          <span>Time</span>
          <span>Kind</span>
          <span>What happened</span>
          <span className="text-right">Checkpoint</span>
        </div>
        {conversation.isPending ? (
          <Note busy>Reading the record…</Note>
        ) : conversation.isError && !held ? (
          <div className="px-5 py-4 max-lg:px-4">
            <QueryError
              error={conversation.error}
              retry={() => void conversation.refetch()}
              retrying={conversation.isRefetching}
            />
          </div>
        ) : shown.length === 0 ? (
          <Note>
            {partial ? "Nothing of this kind in the history read so far." : EMPTY_WORDS[filter]}
          </Note>
        ) : (
          <ul
            ref={list}
            aria-label="The session's record, newest first"
            className="px-5 max-lg:px-4"
          >
            {shown.map((row) => (
              <RecordLine
                key={row.key}
                row={row}
                ordinal={row.checkpoint ?? checkpointAt(checkpoints, row.at)}
                agent={facts.agent}
                open={open.has(row.key)}
                marked={markedRow?.key === row.key}
                onToggle={() => toggle(row.key)}
              />
            ))}
          </ul>
        )}
        {held && (screenLog.isError || (terminalOnly && transcript.isError)) ? (
          <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-meta text-muted-foreground max-lg:px-4">
            <span role="alert">
              {screenLog.isError
                ? "The screen log didn't load, so the screen's rows are missing."
                : "The terminal's record didn't load, so what it said and ran is missing."}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-lg:h-11 max-lg:px-4"
              disabled={screenLog.isFetching || transcript.isFetching}
              onClick={() => {
                if (screenLog.isError) void screenLog.refetch();
                if (transcript.isError) void transcript.refetch();
              }}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {partial ? (
          <div className="flex flex-wrap items-center gap-2 px-5 py-3 text-meta text-muted-foreground max-lg:px-4">
            {conversation.isFetchingNextPage ? (
              <span role="status" className="flex items-center gap-2">
                <Spinner aria-hidden className="size-3.5" /> Reading earlier history…
              </span>
            ) : (
              <>
                {conversation.isFetchNextPageError ? (
                  <span role="alert" className="text-destructive">
                    {failureWords(conversation.error, "Mend couldn't read earlier history.")}
                  </span>
                ) : (
                  <span>This is the record so far. Earlier history isn't read yet.</span>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-lg:h-11 max-lg:px-4"
                  onClick={() => void conversation.fetchNextPage()}
                >
                  Read earlier history
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-lg:h-11 max-lg:px-4"
                  onClick={() => void readAll()}
                >
                  Read all of it
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>

      <p className="border-t border-border px-5 py-2.5 text-meta text-muted-foreground max-lg:px-4">
        {checkpoints.length === 0
          ? "No checkpoints."
          : `${checkpoints.length} checkpoint${checkpoints.length === 1 ? "" : "s"}.`}{" "}
        {facts.session.sealantRunId === null ? (
          noRunWords(facts.session.status).header
        ) : (
          <>
            Mend recorded this session as run{" "}
            <span className="font-mono">{facts.session.sealantRunId.slice(0, 12)}</span>.
          </>
        )}
        {terminalOnly ? " It ran in a terminal, so its record keeps no times." : ""}
      </p>
    </div>
  );
}

function RecordLine({
  row,
  ordinal,
  agent,
  open,
  marked,
  onToggle,
}: {
  readonly row: RecordRow;
  readonly ordinal: number | null;
  readonly agent: string;
  readonly open: boolean;
  readonly marked: boolean;
  readonly onToggle: () => void;
}) {
  const opens = row.detail !== null;
  const mono = row.kind === "command" || row.kind === "edit";
  const time =
    row.at === null ? (
      <span className="text-muted-foreground">
        <span aria-hidden>—</span>
        <span className="sr-only">time not recorded</span>
      </span>
    ) : (
      <time dateTime={row.at.toISOString()}>{clockSeconds(row.at)}</time>
    );
  const what = (
    <span
      className={cn(
        "min-w-0 truncate text-row text-foreground",
        row.kind === "checkpoint" && "font-medium",
        open && "whitespace-normal",
      )}
    >
      {row.who === null ? null : <span>{row.who}: </span>}
      <span className={cn(mono && "font-mono")}>{row.text}</span>
      {row.outcome === null ? null : (
        <span
          className={cn(
            "text-muted-foreground",
            (row.outcome === "failed" || /^exit [1-9]/.test(row.outcome)) && "text-destructive",
          )}
        >
          {" "}
          · {row.outcome}
        </span>
      )}
    </span>
  );
  const line = (
    <>
      <span className="font-mono text-meta text-muted-foreground @3xl/record:text-row">
        {time}
        <span className="@3xl/record:hidden">
          {" "}
          · {KIND_WORDS[row.kind]}
          {ordinal === null ? "" : ` · #${ordinal}`}
        </span>
      </span>
      <span className="hidden text-row text-muted-foreground @3xl/record:block">
        {KIND_WORDS[row.kind]}
      </span>
      {what}
      <span className="hidden text-right font-mono text-meta text-muted-foreground @3xl/record:block">
        {ordinal === null ? "" : `#${ordinal}`}
      </span>
      <span
        aria-hidden
        className="text-muted-foreground @max-3xl/record:row-span-2 @max-3xl/record:row-start-1 @max-3xl/record:col-start-2 @max-3xl/record:self-center"
      >
        {opens ? (
          open ? (
            <ChevronDownIcon className="size-4" />
          ) : (
            <ChevronRightIcon className="size-4" />
          )
        ) : null}
      </span>
    </>
  );
  const grid = cn(
    "grid w-full items-baseline gap-x-3 py-2.5 text-left",
    "grid-cols-[minmax(0,1fr)_16px] gap-y-0.5 max-lg:min-h-11",
    "@3xl/record:grid-cols-[84px_100px_minmax(0,1fr)_72px_16px] @3xl/record:gap-y-0",
  );
  return (
    <li
      data-row={row.key}
      {...(row.checkpoint === null ? {} : { "data-checkpoint": row.checkpoint })}
      aria-current={marked ? "location" : undefined}
      className={cn(
        "scroll-mt-4 border-b border-border",
        marked && "-mx-2 rounded-md border-l-2 border-l-primary bg-muted px-2",
      )}
    >
      {opens ? (
        <button
          type="button"
          aria-expanded={open}
          className={cn(
            grid,
            "cursor-pointer rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          )}
          onClick={onToggle}
        >
          {line}
        </button>
      ) : (
        <div className={grid}>{line}</div>
      )}
      {open && row.detail !== null ? <Detail row={row} agent={agent} /> : null}
    </li>
  );
}

function Detail({ row, agent }: { readonly row: RecordRow; readonly agent: string }) {
  const detail = row.detail;
  if (detail === null) return null;
  return (
    <div className="grid gap-2 pb-3 @3xl/record:ml-[208px]">
      {detail.kind === "text" ? (
        <p className="text-row whitespace-pre-wrap text-foreground">{detail.text}</p>
      ) : detail.kind === "edit" ? (
        <pre className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-meta whitespace-pre-wrap text-foreground">
          {detail.diff}
        </pre>
      ) : detail.kind === "checkpoint" ? (
        <p className="text-meta text-muted-foreground">
          Mend took this checkpoint when the {TRIGGER_WORDS[detail.trigger] ?? detail.trigger}. Its
          commit is <span className="font-mono text-foreground">{detail.sha}</span>.
        </p>
      ) : (
        <>
          {detail.output === null ? null : (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-meta whitespace-pre-wrap text-foreground">
              {detail.output}
            </pre>
          )}
          <p className="text-meta text-muted-foreground">
            {detail.cwd === null ? null : (
              <>
                {agent} ran this in <span className="font-mono">{detail.cwd}</span>.{" "}
              </>
            )}
            {commandEndWords(detail)}
            {detail.output === null &&
            detail.exitCode === null &&
            detail.durationMs === null &&
            !detail.running
              ? "The record holds only the command for this step."
              : null}
          </p>
        </>
      )}
    </div>
  );
}

function Note({
  children,
  busy = false,
}: {
  readonly children: ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <div role="status" className="px-5 py-4 max-lg:px-4">
      <p className="flex items-start gap-2 text-row text-muted-foreground">
        {busy ? <Spinner aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
        <span>{children}</span>
      </p>
    </div>
  );
}

/** The Record view: everything the session did, newest first (route PR 20). */
export const RECORD_VIEW: WorkspaceView = {
  id: "record",
  name: "Record",
  icon: <ScrollTextIcon />,
  useFacts: useRecordFacts,
  Body: RecordBody,
};
