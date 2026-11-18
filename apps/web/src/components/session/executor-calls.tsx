import type { ExecutorCall } from "@mend/domain/workbench";
import { ConversationItem } from "@mend/ui/components/conversation";
import { TraceRow } from "@mend/ui/components/trace-row";
import { Button } from "@mend/ui/components/ui/button";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { PlugIcon } from "lucide-react";

import { messageTime } from "#/lib/session-sheet";
import { type TrpcClient, type TrpcProxy, useTRPC, useTRPCClient } from "#/lib/trpc";

import type { SessionFacts } from "./session-facts";

/** Executor calls change without an event: a session's are read again this often. */
const CALLS_READ_MS = 5_000;

/** Whom a call ran as, from where the viewer stands. */
const callerOf = (call: ExecutorCall, facts: SessionFacts): string => {
  if (call.asMember) return "Mend's member";
  if (call.asUserId === null) return "an unknown account";
  if (call.asUserId === facts.viewerId) return "you";
  return facts.nameOf(call.asUserId) ?? "a member";
};

/** One call: the service and tool, whom it ran as, what Executor said, and who must answer. */
function Call({ call, facts }: { readonly call: ExecutorCall; readonly facts: SessionFacts }) {
  const held = call.outcome === "held";
  const at = messageTime(call.observedAt, new Date());
  const approver =
    call.approverId === null
      ? "the turn's sender"
      : call.approverId === facts.viewerId
        ? "you"
        : (facts.nameOf(call.approverId) ?? "a member");
  return (
    <TraceRow
      tone={held ? "pending" : "none"}
      icon={<PlugIcon />}
      title={`${call.service} · ${call.tool}`}
      description={`as ${callerOf(call, facts)} · ${at}`}
    >
      <div className="flex flex-col gap-1 py-1 text-row text-foreground">
        <p className="wrap-anywhere">{call.message}</p>
        {call.observations.map((observation) => (
          <p
            key={`${observation.service}:${observation.tool}:${observation.outcome}`}
            className="font-mono text-2xs text-muted-foreground"
          >
            {observation.service} · {observation.tool} · {observation.outcome}
          </p>
        ))}
        {held ? (
          <p className="text-muted-foreground">Waiting for {approver} to answer in Mend.</p>
        ) : null}
      </div>
    </TraceRow>
  );
}

/**
 * The calls the session's agent made through Executor, newest first, at the top of its
 * conversation: they are recorded beside the conversation, not in its turns. Nothing while there
 * are none. A call waiting on someone's approval says whose; its approver answers it in the
 * composer card (`ExecutorApprovalComposer`).
 */
export function ExecutorCalls({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const sessionId = facts.session.id;
  const calls = useInfiniteQuery(executorCallsQuery(trpc, client, sessionId));
  if (calls.isPending) return null;
  if (calls.isError)
    return (
      <ConversationItem messageId="executor-calls">
        <p role="alert" className="text-row text-destructive">
          Executor calls didn't load. {calls.error.message}
        </p>
      </ConversationItem>
    );
  const rows = calls.data.pages.flatMap((page) => page.calls);
  if (rows.length === 0) return null;
  return (
    <ConversationItem messageId="executor-calls">
      <section aria-label="Executor calls" className="flex flex-col gap-0.5">
        <h2 className="text-meta text-muted-foreground">Executor calls</h2>
        {rows.map((call) => (
          <Call key={call.id} call={call} facts={facts} />
        ))}
        {calls.hasNextPage ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start max-lg:h-11"
            disabled={calls.isFetchingNextPage}
            onClick={() => void calls.fetchNextPage()}
          >
            {calls.isFetchingNextPage ? "Reading older calls…" : "Show older calls"}
          </Button>
        ) : null}
      </section>
    </ConversationItem>
  );
}

/** A session's Executor calls, newest first, a page at a time, read again every few seconds. */
export const executorCallsQuery = (trpc: TrpcProxy, client: TrpcClient, sessionId: string) =>
  infiniteQueryOptions({
    queryKey: [...trpc.executor.calls.queryKey({ sessionId }), "history"],
    queryFn: readCalls(client, sessionId),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Awaited<ReturnType<ReturnType<typeof readCalls>>>) =>
      last.olderCursor ?? undefined,
    refetchInterval: CALLS_READ_MS,
    retry: false,
  });

/** One page of calls, before the cursor the page is read with. */
const readCalls =
  (client: TrpcClient, sessionId: string) =>
  ({ pageParam }: { readonly pageParam: string | null }) =>
    client.executor.calls.query({
      sessionId,
      ...(pageParam === null ? {} : { before: pageParam }),
    });
