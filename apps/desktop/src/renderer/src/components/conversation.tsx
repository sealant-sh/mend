import {
  answersComplete,
  buildAgentConversation,
  composeAnswers,
  conversationActivity,
  EMPTY_CONVERSATION,
  itemFailed,
  itemName,
  openTurnOf,
  recordedAnswers,
  requestAsk,
  requestDetailText,
  requestName,
  requestOutcome,
  toggleChoice,
  type AgentRequestResponse,
  type AnswerChoices,
  type WrittenAnswers,
} from "@mend/agent-conversation";
import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AgentItemDto, AgentRequestDto, AgentTurnDto } from "#/lib/api";
import {
  controlEventsQuery,
  conversationQuery,
  interruptersByTurn,
  turnAuthorLine,
  turnEndWord,
  useConversationActions,
  type ConversationEntry,
} from "#/lib/conversation";
import { sessionDetailQuery } from "#/lib/queries";
import { membersQuery } from "#/lib/viewer";

/**
 * A protocol-mode session (codex app-server, claude stream-json) in the main pane where a PTY
 * would be: the authored turns, what the agent said and did, and what it asks a person, with a
 * turn composer beneath while the agent is live and the caller steers. The phone shows the same
 * feed (`@mend/agent-conversation`); this is its desktop face, on the app's own sheet rather than
 * the terminal ground, because nothing here is a terminal.
 */

/** Within this many pixels of the end, new entries keep the view pinned to the end. */
const STICK_PX = 48;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function TurnRow({
  turn,
  author,
  ending,
}: {
  readonly turn: AgentTurnDto;
  readonly author: string | null;
  readonly ending: string | null;
}) {
  return (
    <div className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
      <div className="rounded-2xl rounded-br-md bg-wash px-3.5 py-2.5">
        <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {turn.input}
        </p>
      </div>
      {(author !== null || ending !== null) && (
        <p className="font-mono text-[11px] text-faint">
          {[author, ending].filter((part) => part !== null).join(" · ")}
        </p>
      )}
      {turn.error !== null && (
        <p className="font-mono text-[11px] whitespace-pre-wrap text-danger">{turn.error}</p>
      )}
    </div>
  );
}

function ItemRow({ item }: { readonly item: AgentItemDto }) {
  const growing = item.status === "in-progress" ? " ▍" : "";
  if (item.kind === "assistant-message" && item.text !== null) {
    return (
      <p className="max-w-[720px] text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground">
        {item.text}
        {growing}
      </p>
    );
  }
  if (item.kind === "reasoning") {
    return (
      <p className="line-clamp-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-faint">
        {item.text ?? item.title ?? "reasoning"}
        {growing}
      </p>
    );
  }
  if (item.kind === "plan" && item.text !== null) {
    return (
      <p className="max-w-[720px] border-l-2 border-rule pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-2">
        {item.text}
      </p>
    );
  }
  const failed = itemFailed(item);
  return (
    <div
      className={cn(
        "max-w-[720px] rounded-lg bg-secondary px-3 py-2",
        failed && "border-l-2 border-l-[var(--sw-red)]",
      )}
    >
      <p className={cn("font-mono text-[12px]", failed ? "text-danger" : "text-ink-2")}>
        {itemName(item)}
        {growing}
      </p>
      {item.text !== null && item.text !== "" && (
        <p className="mt-1 line-clamp-4 font-mono text-[11.5px] whitespace-pre-wrap text-faint">
          {item.text}
        </p>
      )}
    </div>
  );
}

function RequestRow({
  request,
  steer,
  responding,
  onRespond,
}: {
  readonly request: AgentRequestDto;
  /** Whether this caller may answer (docs/adr/0003); anyone else reads the request. */
  readonly steer: boolean;
  readonly responding: boolean;
  readonly onRespond: (requestId: string, response: AgentRequestResponse) => void;
}) {
  const [selected, setSelected] = useState<AnswerChoices>({});
  const [written, setWritten] = useState<WrittenAnswers>({});
  const pending = request.status === "pending";
  const questions = request.questions ?? [];
  const ask = requestAsk(request);
  const detail = requestDetailText(request.detail);
  const answerable = pending && steer;

  let actions: React.ReactNode = null;
  if (pending && !steer) {
    actions = <p className="font-mono text-[11.5px] text-faint">waiting for an answer</p>;
  } else if (answerable && ask === "unanswerable") {
    actions = (
      <p className="font-mono text-[11.5px] text-danger">
        The provider did not include a question. Stop and resume the session.
      </p>
    );
  } else if (answerable && ask === "answers") {
    actions = (
      <Button
        size="sm"
        disabled={responding || !answersComplete(questions, selected, written)}
        onClick={() =>
          onRespond(request.id, { answers: composeAnswers(questions, selected, written) })
        }
      >
        {responding ? "Sending…" : "Send answer"}
      </Button>
    );
  } else if (answerable) {
    actions = (
      <>
        <Button
          size="sm"
          disabled={responding}
          onClick={() => onRespond(request.id, { decision: "accept" })}
        >
          Allow once
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={responding}
          onClick={() => onRespond(request.id, { decision: "accept-for-session" })}
        >
          Allow for session
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={responding}
          onClick={() => onRespond(request.id, { decision: "decline" })}
        >
          Decline
        </Button>
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex max-w-[720px] flex-col gap-3 rounded-xl border border-rule bg-panel p-3.5 shadow-xs",
        pending && "border-l-2 border-l-[var(--sw-amber)]",
      )}
    >
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-foreground">{requestName(request)}</p>
        {!pending && <p className="font-mono text-[11px] text-faint">{requestOutcome(request)}</p>}
        {detail !== null && (
          <pre className="max-h-48 overflow-auto font-mono text-[11.5px] whitespace-pre-wrap text-muted-foreground">
            {detail}
          </pre>
        )}
        {recordedAnswers(request).map((recorded) => (
          <div key={recorded.question} className="pt-1">
            <p className="text-[12px] text-muted-foreground">{recorded.question}</p>
            <p className="font-mono text-[11.5px] text-ink-2">{recorded.answers.join(", ")}</p>
          </div>
        ))}
      </div>

      {answerable &&
        ask === "answers" &&
        questions.map((question) => (
          <div key={question.id} className="flex flex-col gap-2">
            <p className="text-[12.5px] font-medium text-foreground">
              {question.header ?? question.question}
            </p>
            {question.header !== null && (
              <p className="text-[12.5px] text-muted-foreground">{question.question}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const chosen = selected[question.id]?.includes(option.label) ?? false;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={chosen}
                    onClick={() =>
                      setSelected((current) =>
                        toggleChoice(current, question.id, option.label, question.multiSelect),
                      )
                    }
                    className={cn(
                      "max-w-full rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                      chosen
                        ? "border-[var(--sw-accent)] bg-wash text-info"
                        : "border-rule bg-panel text-ink-2 hover:bg-secondary",
                    )}
                  >
                    <span className="block text-[12.5px]">{option.label}</span>
                    {option.description !== null && (
                      <span className="block text-[11.5px] text-faint">{option.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <input
              value={written[question.id] ?? ""}
              placeholder="Write an answer"
              onChange={(event) => {
                const value = event.target.value;
                setWritten((current) => ({ ...current, [question.id]: value }));
              }}
              className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-[13px] text-foreground outline-none placeholder:text-faint focus:border-[var(--sw-accent)]"
            />
          </div>
        ))}

      {actions !== null && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function ProtocolConversation({
  sessionId,
  live,
  starting,
  steer,
  summary,
  endFact,
  viewerId,
}: {
  readonly sessionId: string;
  /** The agent process runs: the conversation grows and, for a steering caller, takes turns. */
  readonly live: boolean;
  /** Still provisioning: nothing can be delivered yet. */
  readonly starting: boolean;
  /** Whether this caller sends turns, answers and interrupts (docs/adr/0003). */
  readonly steer: boolean;
  /** What the harness reported at settle, shown when nothing else was recorded. */
  readonly summary: string | null;
  /** How the agent ended, once it has ("exited · observed"). */
  readonly endFact: string | null;
  readonly viewerId: string | null;
}) {
  const conversation = useQuery(conversationQuery(sessionId, live));
  const control = useQuery(controlEventsQuery(sessionId));
  const members = useQuery(membersQuery);
  const detail = useQuery(sessionDetailQuery(sessionId));
  const { submit, respond, interrupt } = useConversationActions(sessionId);
  const [draft, setDraft] = useState("");
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);

  const data = conversation.data ?? EMPTY_CONVERSATION;
  const entries = useMemo(() => buildAgentConversation(data), [data]);
  const names = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.userId, member.name])),
    [members.data],
  );
  const processKinds = useMemo(
    () => new Map((detail.data?.processes ?? []).map((process) => [process.id, process.kind])),
    [detail.data],
  );
  const interrupters = useMemo(() => interruptersByTurn(control.data ?? []), [control.data]);
  const openTurn = openTurnOf(data.turns);
  const activity = live ? conversationActivity(data) : null;
  let activityLine: string | null = null;
  if (activity === "working") activityLine = "working…";
  // Someone who cannot answer reads "waiting for an answer" on the request itself.
  else if (activity === "waiting" && steer) activityLine = "waiting for your answer";
  const composing = live && steer;

  // Follow the end while the reader is at it; leave them alone once they scroll back.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller !== null && stuck.current) scroller.scrollTop = scroller.scrollHeight;
  }, [entries, activity]);

  const send = () => {
    const text = draft.trim();
    if (text === "" || starting || submit.isPending) return;
    submit.mutate(text, {
      onSuccess: () => setDraft((current) => (current.trim() === text ? "" : current)),
    });
  };

  const actionError = submit.error ?? respond.error ?? interrupt.error;
  let empty: string | null = null;
  if (conversation.isPending) empty = "reading the conversation…";
  else if (conversation.isError)
    empty = `the conversation could not be read — ${errorText(conversation.error)}`;
  else if (entries.length === 0 && !composing) empty = summary ?? "no conversation recorded";
  let hint: string | null = null;
  if (composing && starting) hint = "starting up — the conversation opens when the agent is ready…";
  else if (composing && entries.length === 0 && !conversation.isPending)
    hint = "ready for your first message";

  const row = (entry: ConversationEntry) => {
    switch (entry.kind) {
      case "turn":
        return (
          <TurnRow
            key={entry.key}
            turn={entry.turn}
            author={turnAuthorLine(entry.turn, viewerId, names, processKinds)}
            ending={turnEndWord(
              entry.turn,
              interrupters.get(entry.turn.id) ?? null,
              viewerId,
              names,
            )}
          />
        );
      case "item":
        return <ItemRow key={entry.key} item={entry.item} />;
      case "request":
        return (
          <RequestRow
            key={entry.key}
            request={entry.request}
            steer={steer && live}
            responding={respond.isPending}
            onRespond={(requestId, response) => respond.mutate({ requestId, response })}
          />
        );
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-y-auto select-text"
      >
        <div className="mx-auto flex max-w-[820px] flex-col gap-3.5 px-6 py-5">
          {empty !== null && <p className="font-mono text-[12px] text-faint">{empty}</p>}
          {entries.map(row)}
          {activityLine !== null && (
            <p className="font-mono text-[11.5px] text-faint">{activityLine}</p>
          )}
        </div>
      </div>

      {!live && endFact !== null && (
        <div className="shrink-0 border-t border-rule">
          <p className="mx-auto max-w-[820px] px-6 py-2 font-mono text-[11.5px] text-muted-foreground">
            {endFact}
          </p>
        </div>
      )}

      {composing && (
        <div className="shrink-0 border-t border-rule bg-panel">
          <div className="mx-auto flex max-w-[820px] flex-col gap-1.5 px-6 py-3">
            {actionError !== null && (
              <p className="font-mono text-[11.5px] text-danger">{errorText(actionError)}</p>
            )}
            {hint !== null && <p className="font-mono text-[11.5px] text-faint">{hint}</p>}
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <textarea
                value={draft}
                rows={1}
                autoFocus
                placeholder="Message the session…"
                onChange={(event) => setDraft(event.target.value)}
                onInput={(event) => {
                  const el = event.currentTarget;
                  el.style.height = "auto";
                  el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
                    return;
                  event.preventDefault();
                  send();
                }}
                className="max-h-[200px] min-h-9 flex-1 resize-none rounded-xl border border-input bg-background px-3 py-2 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-faint focus:border-[var(--sw-accent)]"
              />
              {openTurn !== undefined && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={interrupt.isPending}
                  onClick={() => interrupt.mutate(openTurn.id)}
                >
                  {interrupt.isPending ? "Interrupting…" : "Interrupt"}
                </Button>
              )}
              <Button type="submit" disabled={starting || submit.isPending || draft.trim() === ""}>
                {submit.isPending ? "Sending…" : "Send"}
              </Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
