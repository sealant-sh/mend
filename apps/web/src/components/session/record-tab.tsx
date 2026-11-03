import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { Segment } from "#/components/kit/segment";
import { checkpointAt, RECORD_FILTERS, type RecordFilter, recordRows } from "#/lib/record-rows";
import { screenLogActor } from "#/lib/screen-log";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

import { useConversation } from "./conversation";
import type { SessionFacts } from "./facts";

/** What the Record reads of a session's facts. */
export type RecordFacts = Pick<SessionFacts, "agent" | "viewer" | "nameOf"> & {
  readonly session: Pick<SessionFacts["session"], "id" | "sealantRunId">;
  readonly detail: Pick<SessionFacts["detail"], "checkpoints">;
};

/**
 * The Record tab (screens P6, C6, X5): everything the session did, newest first, filterable by
 * kind. Each row carries the checkpoint it falls in; a checkpoint's own row is the place a landed
 * pull request's `#checkpoint-N` link lands.
 */
export function RecordTab({ facts }: { readonly facts: RecordFacts }) {
  const trpc = useTRPC();
  const [filter, setFilter] = useState<RecordFilter>("all");
  const conversation = useConversation(facts.session.id);
  // A terminal session has no turns: its record is the transcript, as the Conversation tab reads it.
  const terminalOnly = conversation.isSuccess && conversation.data.turns.length === 0;
  const transcript = useQuery({
    ...trpc.sessions.transcript.queryOptions({ id: facts.session.id }),
    enabled: terminalOnly && facts.session.sealantRunId !== null,
  });
  const screenLog = useQuery(trpc.screens.log.queryOptions({ id: facts.session.id }));
  const checkpoints = facts.detail.checkpoints;
  const rows = recordRows({
    conversation: conversation.data,
    transcript: terminalOnly ? (transcript.data?.events ?? []) : [],
    checkpoints,
    screenLog: screenLog.data ?? [],
    agent: facts.agent,
    nameOf: (userId, fallback = "Mend") =>
      userId === null ? fallback : userId === facts.viewer?.userId ? "You" : facts.nameOf(userId),
    actorOf: (entry) => screenLogActor(entry, facts.agent, facts.nameOf),
  });
  const shown = filter === "all" ? rows : rows.filter((row) => row.kind === filter);
  // The conversation is read a window at a time from its newest end: what is shown may be part.
  // An older window that failed sets the query's error, over the windows still held.
  const held = conversation.data !== undefined;
  const partial = held && conversation.hasNextPage;
  const olderFailure = conversation.isFetchNextPageError
    ? (conversation.error?.message ?? "")
    : null;
  const readAll = async () => {
    for (;;) {
      const result = await conversation.fetchNextPage();
      if (result.isError || !result.hasNextPage) return;
    }
  };
  return (
    <div className="grid content-start gap-3 pb-2">
      <Segment label="Show" value={filter} onChange={setFilter} options={RECORD_FILTERS} />
      {conversation.isPending ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading the record…
        </p>
      ) : conversation.isError && !held ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          The record did not load: {conversation.error.message}
        </p>
      ) : shown.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">
          {partial
            ? "Nothing of this kind in the history read so far."
            : "Nothing of this kind yet."}
        </p>
      ) : (
        <div className="rounded-[22px] bg-panel px-4 py-1.5 shadow-sm">
          <table className="w-full table-fixed font-mono text-[11.5px] leading-normal">
            <caption className="sr-only">The session's record, newest first</caption>
            <colgroup>
              <col className="w-[70px]" />
              <col className="w-[86px]" />
              <col />
              <col className="w-[44px]" />
            </colgroup>
            <thead className="sr-only">
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Kind</th>
                <th scope="col">What</th>
                <th scope="col">Checkpoint</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const ordinal = row.checkpoint ?? checkpointAt(checkpoints, row.at);
                return (
                  <tr
                    key={row.key}
                    id={row.checkpoint === null ? undefined : `checkpoint-${row.checkpoint}`}
                    className="scroll-mt-4 border-t border-rule-faint align-top text-ink-2 first:border-t-0 target:bg-wash"
                  >
                    <td className="py-1.5">
                      {row.at === null ? (
                        <span className="text-faint">
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">time not recorded</span>
                        </span>
                      ) : (
                        <time dateTime={row.at.toISOString()}>{clockSeconds(row.at)}</time>
                      )}
                    </td>
                    <td className="py-1.5 text-muted-foreground">{row.kind}</td>
                    <td className="truncate py-1.5 pr-3" title={row.text}>
                      {row.text}
                    </td>
                    <td className="py-1.5 text-right text-faint">
                      {ordinal === null ? "" : `#${ordinal}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {partial ? (
        <EarlierHistory
          pending={conversation.isFetchingNextPage}
          failure={olderFailure}
          onReadEarlier={() => void conversation.fetchNextPage()}
          onReadAll={() => void readAll()}
        />
      ) : null}
      <p className="font-mono text-[11.5px] text-faint">
        {checkpoints.length} checkpoint{checkpoints.length === 1 ? "" : "s"}
        {facts.session.sealantRunId === null
          ? " · no run recorded"
          : ` · recorded by run ${facts.session.sealantRunId.slice(0, 12)}`}
        {terminalOnly
          ? " · it ran in a terminal; its record keeps no times for what it said and ran"
          : ""}
      </p>
    </div>
  );
}

/** The end of a record read in part: it says so, and reads the next window, or all of them. */
function EarlierHistory({
  pending,
  failure,
  onReadEarlier,
  onReadAll,
}: {
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onReadEarlier: () => void;
  readonly onReadAll: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      {pending ? (
        <span role="status">Reading earlier history…</span>
      ) : (
        <>
          {failure === null ? (
            <span>The record so far: earlier history is not read yet.</span>
          ) : (
            <span role="alert" className="text-danger">
              Earlier history did not load: {failure}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={onReadEarlier}>
            Read earlier history
          </Button>
          <Button size="sm" variant="ghost" onClick={onReadAll}>
            Read all of it
          </Button>
        </>
      )}
    </div>
  );
}
