import type { ExecutorCall } from "@mend/domain/workbench";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { ErrorNote } from "#/components/kit/status";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";

export function ExecutorFact({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const calls = useQuery(
    trpc.executor.calls.queryOptions({ sessionId }, { retry: false, refetchInterval: 5000 }),
  );
  const latest = calls.data?.calls[0];
  return (
    <>
      {latest === undefined
        ? "No Executor call observed"
        : `${latest.message} ${latest.observedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
    </>
  );
}
/** Persisted service calls are independent of a harness's record sequence. */
export function ExecutorCalls({
  sessionId,
  nameOf,
}: {
  readonly sessionId: string;
  readonly nameOf: (id: string) => string;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const viewer = useViewer();
  const calls = useInfiniteQuery({
    queryKey: [...trpc.executor.calls.queryKey({ sessionId }), "history"],
    initialPageParam: ((): string | undefined => undefined)(),
    queryFn: ({ pageParam }) =>
      client.executor.calls.query({
        sessionId,
        ...(pageParam === undefined ? {} : { before: pageParam }),
      }),
    getNextPageParam: (last) => last.olderCursor ?? undefined,
    refetchInterval: 5000,
    retry: false,
  });
  if (calls.isPending) return null;
  if (calls.isError)
    return <ErrorNote>Executor calls could not be read: {calls.error.message}</ErrorNote>;
  const rows = calls.data.pages.flatMap((page) => page.calls);
  if (rows.length === 0) return null;
  return (
    <section aria-label="Executor calls" className="grid gap-3 rounded-2xl bg-panel p-4 shadow-sm">
      <h3 className="font-display text-[15px]">Executor calls</h3>
      {rows.map((call) => (
        <div key={call.id} className="grid gap-2 border-t border-rule-faint pt-3">
          <p className="font-mono text-[12px]">
            {call.service} · {call.tool} · as{" "}
            {call.asMember
              ? "Mend's member"
              : call.asUserId === viewer?.userId
                ? "you"
                : call.asUserId === null
                  ? "unknown"
                  : nameOf(call.asUserId)}
          </p>
          <p role="status" className="text-[13px]">
            {call.message} · {call.observedAt.toLocaleTimeString()}
          </p>
          {call.observations.length === 0 ? null : (
            <ul className="font-mono text-[11px]">
              {call.observations.map((observation, index) => (
                <li key={index}>
                  {observation.service} · {observation.tool} · {observation.outcome}
                </li>
              ))}
            </ul>
          )}
          {call.outcome === "held" && call.approverId === viewer?.userId ? (
            <Approval call={call} />
          ) : call.outcome === "held" ? (
            <p>
              Waiting for {call.approverId === null ? "the turn's sender" : nameOf(call.approverId)}{" "}
              to answer in Mend.
            </p>
          ) : null}
        </div>
      ))}
      {calls.hasNextPage ? (
        <Button
          variant="ghost"
          disabled={calls.isFetchingNextPage}
          onClick={() => void calls.fetchNextPage()}
        >
          Read older Executor calls
        </Button>
      ) : null}
    </section>
  );
}
function Approval({ call }: { readonly call: ExecutorCall }) {
  const trpc = useTRPC();
  const [content, setContent] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const params = { sessionId: call.sessionId, callId: call.id };
  const request = useQuery(trpc.executor.approval.queryOptions(params, { retry: false }));
  const answer = useMutation(
    trpc.executor.approve.mutationOptions({
      onSuccess: (_a, _b, _c, { client }) => client.invalidateQueries(trpc.executor.pathFilter()),
    }),
  );
  const submit = (action: "accept" | "decline") => {
    let parsed: unknown = {};
    try {
      parsed = action === "decline" ? {} : JSON.parse(content);
    } catch {
      setError("Enter the requested information as a JSON object.");
      return;
    }
    if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(parsed)) {
      setError("The requested information must be an object.");
      return;
    }
    setError(null);
    answer.mutate({ ...params, action, content: parsed });
  };
  if (request.isPending) return <p>Reading the approval…</p>;
  if (request.isError) return <ErrorNote>{request.error.message}</ErrorNote>;
  return (
    <div className="grid gap-3">
      <p>{request.data.message}</p>
      {request.data.arguments === null ? null : (
        <details>
          <summary>Call arguments</summary>
          <pre className="overflow-auto whitespace-pre-wrap text-[12px]">
            {JSON.stringify(request.data.arguments, null, 2)}
          </pre>
        </details>
      )}
      <details>
        <summary>Requested information</summary>
        <pre className="overflow-auto whitespace-pre-wrap text-[12px]">
          {JSON.stringify(request.data.inputSchema, null, 2)}
        </pre>
        <label className="grid gap-2">
          Your response
          <textarea
            className="rounded-xl border border-rule bg-canvas p-3 font-mono text-[12px]"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
          />
        </label>
      </details>
      <p className="text-[12px] text-muted-foreground">
        Expires {call.expiresAt?.toLocaleTimeString()}. Answer as{" "}
        {call.asMember ? "Mend's member" : "your Executor member"}.
      </p>
      <div className="flex gap-2">
        <Button disabled={answer.isPending} onClick={() => submit("accept")}>
          Approve
        </Button>
        <Button variant="ghost" disabled={answer.isPending} onClick={() => submit("decline")}>
          Deny
        </Button>
      </div>
      {error === null && answer.error === null ? null : (
        <ErrorNote>{error ?? answer.error?.message}</ErrorNote>
      )}
    </div>
  );
}
