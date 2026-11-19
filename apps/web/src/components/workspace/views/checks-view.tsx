import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { cn } from "@mend/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ListChecksIcon } from "lucide-react";
import type { ReactNode } from "react";

import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import {
  checkpointBefore,
  checksFact,
  checkTitle,
  editsSinceChecks,
  type ObservedCheck,
  observedChecks,
  tookWords,
} from "#/lib/checks";
import { conversationQuery, heldConversation } from "#/lib/conversation";
import { clockTime } from "#/lib/session-view";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";

/**
 * The session's conversation as far as it is read, the same cached read its conversation tile
 * makes, so the Checks tab costs no request of its own.
 */
const useHeldConversation = (sessionId: string) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  return useInfiniteQuery({
    ...conversationQuery(trpc, client, sessionId),
    select: (data) => heldConversation(data.pages),
  });
};

/** The Checks tab's and its "+" item's fact: "2 passed", "1 failed". Nothing while it is read. */
const useChecksFacts = (place: ViewPlace): ViewFacts => {
  const conversation = useHeldConversation(place.sessionId);
  if (conversation.isPending || conversation.isError) return {};
  const fact = checksFact(observedChecks(conversation.data.items));
  return fact === undefined ? {} : { fact };
};

/** "the last edit", "the last 2 edits". */
const editsWord = (count: number): string =>
  count === 1 ? "the last edit" : `the last ${count} edits`;

/**
 * The Checks view (Doop T10 "Terminal and checks in one tile"): the tests, typechecks, lints and
 * builds the agent ran in this session, the latest run of each, newest first, with how each ended
 * and the checkpoint it ran after. Then whether edits came after the last of them. What ran, never
 * a verdict: a run whose outcome the record does not hold says so.
 */
function ChecksBody({ place }: { readonly place: ViewPlace }) {
  const facts = useSessionFacts(place.sessionId);
  const conversation = useHeldConversation(place.sessionId);

  if (conversation.isPending)
    return (
      <Shell>
        <Note busy>Reading the record…</Note>
      </Shell>
    );
  if (conversation.isError)
    return (
      <Shell>
        <div className="px-5 py-5 max-lg:px-4">
          <QueryError
            error={conversation.error}
            retry={() => void conversation.refetch()}
            retrying={conversation.isRefetching}
          />
        </div>
      </Shell>
    );

  const { items } = conversation.data;
  const checks = observedChecks(items);
  const untested = editsSinceChecks(items, checks);
  // Older windows of the record aren't read until someone asks: a check may be in one.
  const earlier = conversation.hasNextPage ? (
    <EarlierHistory
      reading={conversation.isFetchingNextPage}
      failed={conversation.isFetchNextPageError}
      onRead={() => void conversation.fetchNextPage()}
    />
  ) : null;

  if (checks.length === 0)
    return (
      <Shell>
        <Note>
          No test, typecheck, lint or build in this session's record yet. When the agent runs one,
          it shows here with how it ended.
        </Note>
        {earlier}
      </Shell>
    );

  return (
    <Shell>
      <ul aria-label="Checks" className="px-5 max-lg:px-4">
        {checks.map((check) => (
          <CheckRow
            key={check.command}
            check={check}
            checkpoint={checkpointBefore(facts.detail.checkpoints, check.at)}
          />
        ))}
      </ul>
      {untested > 0 ? (
        <p className="px-5 py-4 text-row text-foreground max-lg:px-4">
          No check ran after {editsWord(untested)}.
        </p>
      ) : null}
      {earlier}
    </Shell>
  );
}

/** The view's scrolling column, as tall as its tile. */
function Shell({ children }: { readonly children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>;
}

const RESULT_TONE: Readonly<Record<ObservedCheck["result"], string>> = {
  passed: "text-foreground",
  failed: "text-destructive",
  running: "text-foreground",
  unknown: "text-foreground",
};

function CheckRow({
  check,
  checkpoint,
}: {
  readonly check: ObservedCheck;
  readonly checkpoint: number | null;
}) {
  const when = clockTime(new Date(check.at));
  const detail =
    check.result === "running"
      ? `Started ${when}.`
      : check.result === "unknown"
        ? `Ran ${when}. The record doesn't hold how it ended.`
        : [
            check.exitCode === null ? null : `Exit ${check.exitCode}.`,
            check.durationMs === null ? null : tookWords(check.durationMs),
            `Ran ${when}.`,
          ]
            .filter((part) => part !== null)
            .join(" ");
  return (
    <li className="flex flex-col gap-0.5 border-b border-border py-3 last:border-b-0">
      <span className={cn("flex items-center gap-2 text-row", RESULT_TONE[check.result])}>
        {check.result === "running" ? <Spinner aria-hidden className="size-3.5 shrink-0" /> : null}
        {checkTitle(check, checkpoint)}
      </span>
      <span className="truncate font-mono text-meta text-muted-foreground" title={check.command}>
        {check.command}
      </span>
      <span className="text-meta text-muted-foreground">{detail}</span>
    </li>
  );
}

function EarlierHistory({
  reading,
  failed,
  onRead,
}: {
  readonly reading: boolean;
  readonly failed: boolean;
  readonly onRead: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-5 py-4 max-lg:px-4">
      <p className="text-meta text-muted-foreground">
        {failed
          ? "Mend couldn't read the earlier record. Try again."
          : "Checks from earlier in the session are in the record not read yet."}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="max-lg:h-11 max-lg:px-4"
        disabled={reading}
        onClick={onRead}
      >
        {reading ? "Reading…" : failed ? "Try again" : "Read earlier history"}
      </Button>
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
    <div role="status" className="px-5 py-5 max-lg:px-4">
      <p className="flex items-start gap-2 text-row text-muted-foreground">
        {busy ? <Spinner aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
        <span>{children}</span>
      </p>
    </div>
  );
}

/** The Checks view: the checks the agent ran and how each ended (route PR 21). */
export const CHECKS_VIEW: WorkspaceView = {
  id: "checks",
  name: "Checks",
  icon: <ListChecksIcon />,
  useFacts: useChecksFacts,
  Body: ChecksBody,
};
