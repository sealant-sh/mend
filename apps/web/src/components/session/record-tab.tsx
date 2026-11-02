import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Segment } from "#/components/kit/segment";
import { checkpointAt, RECORD_FILTERS, type RecordFilter, recordRows } from "#/lib/record-rows";
import { screenLogActor } from "#/lib/screen-log";
import { clockSeconds } from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";

import { useConversation } from "./conversation";
import type { SessionFacts } from "./facts";

/**
 * The Record tab (screens P6, C6, X5): everything the session did, newest first, filterable by
 * kind. Each row carries the checkpoint it falls in; a checkpoint's own row is the place a landed
 * pull request's `#checkpoint-N` link lands.
 */
export function RecordTab({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const [filter, setFilter] = useState<RecordFilter>("all");
  const conversation = useConversation(facts.session.id);
  const screenLog = useQuery(trpc.screens.log.queryOptions({ id: facts.session.id }));
  const checkpoints = facts.detail.checkpoints;
  const rows = recordRows({
    conversation: conversation.data,
    checkpoints,
    screenLog: screenLog.data ?? [],
    agent: facts.agent,
    nameOf: (userId) =>
      userId === null ? "Mend" : userId === facts.viewer?.userId ? "You" : facts.nameOf(userId),
    actorOf: (entry) => screenLogActor(entry, facts.agent, facts.nameOf),
  });
  const shown = filter === "all" ? rows : rows.filter((row) => row.kind === filter);
  const terminalOnly = conversation.isSuccess && conversation.data.turns.length === 0;
  return (
    <div className="grid content-start gap-3 pb-2">
      <Segment label="Show" value={filter} onChange={setFilter} options={RECORD_FILTERS} />
      {conversation.isPending ? (
        <p role="status" className="font-mono text-[12px] text-muted-foreground">
          Reading the record…
        </p>
      ) : conversation.isError ? (
        <p role="alert" className="font-mono text-[12px] text-danger">
          The record did not load: {conversation.error.message}
        </p>
      ) : shown.length === 0 ? (
        <p className="font-mono text-[12px] text-muted-foreground">Nothing of this kind yet.</p>
      ) : (
        <div className="rounded-[22px] bg-panel px-4 py-1.5 shadow-sm">
          <table className="w-full table-fixed font-mono text-[11.5px] leading-normal">
            <caption className="sr-only">The session's record, newest first</caption>
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
                    <td className="w-[70px] py-1.5">
                      <time dateTime={row.at.toISOString()}>{clockSeconds(row.at)}</time>
                    </td>
                    <td className="w-[86px] py-1.5 text-muted-foreground">{row.kind}</td>
                    <td className="truncate py-1.5 pr-3" title={row.text}>
                      {row.text}
                    </td>
                    <td className="w-[44px] py-1.5 text-right text-faint">
                      {ordinal === null ? "" : `#${ordinal}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="font-mono text-[11.5px] text-faint">
        {checkpoints.length} checkpoint{checkpoints.length === 1 ? "" : "s"}
        {facts.session.sealantRunId === null
          ? " · no run recorded"
          : ` · recorded by run ${facts.session.sealantRunId.slice(0, 12)}`}
        {terminalOnly
          ? " · this session ran in a terminal; what it said is in the Conversation tab"
          : ""}
      </p>
    </div>
  );
}
