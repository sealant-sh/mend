import type { ExecutorCall } from "@mend/domain/workbench";
import {
  Approval,
  ApprovalArguments,
  ApprovalCommand,
  ApprovalDiff,
} from "@mend/ui/components/approval";
import { Banner } from "@mend/ui/components/banner";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { PromptInput } from "@mend/ui/components/prompt-input";
import { Question, QuestionEarlier } from "@mend/ui/components/question";
import { TraceRow } from "@mend/ui/components/trace-row";
import { Button } from "@mend/ui/components/ui/button";
import { UserMessage } from "@mend/ui/components/user-message";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageCircleQuestionIcon,
  PlugIcon,
  ShieldCheckIcon,
  ShieldXIcon,
  SmartphoneIcon,
  UsersIcon,
} from "lucide-react";
import { type ComponentProps, useState } from "react";

import {
  answered,
  answererOf,
  approvalShape,
  approvalTitle,
  askOf,
  isPending,
  NOTHING_PICKED,
  OTHER,
  type Picked,
  pick,
  questionHint,
  questionPlaceholder,
  requestAnswers,
  settledLine,
  waitingLine,
} from "#/lib/agent-requests";
import { answeredElsewhere, markAnsweredHere, markShownWaiting } from "#/lib/answered-here";
import {
  type ConversationView,
  conversationKey,
  type RequestView,
  requestView,
} from "#/lib/conversation";
import { withChanges } from "#/lib/conversation-live";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { messageTime } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./session-facts";

type Size = "default" | "touch";

/** What the composer passes every card's prompt input: the field, the bar and the draft. */
export type PromptBase = Pick<
  ComponentProps<typeof PromptInput>,
  "id" | "size" | "harness" | "model" | "onAttach" | "value" | "onValueChange" | "label"
> & { readonly blocked: boolean };

/** Whose answer a request waits for, when it isn't the viewer's: the session's owner. */
const ownerName = (facts: SessionFacts): string =>
  (facts.session.ownerUserId === null ? null : facts.nameOf(facts.session.ownerUserId)) ??
  "the session's owner";

// --- In the conversation -------------------------------------------------------------------------

/**
 * A request in the conversation where the agent asked it. While it waits, a muted marker says what
 * it asks and whose answer it waits for; the card itself is in the composer. Once settled, one line
 * says who answered and how, with any words written shown as that person's message.
 */
export function RequestLine({
  request,
  facts,
  canAnswer,
}: {
  readonly request: RequestView;
  readonly facts: SessionFacts;
  readonly canAnswer: boolean;
}) {
  if (isPending(request))
    return (
      <ConversationMarker
        kind="status"
        label={waitingLine(request, canAnswer ? null : ownerName(facts))}
      />
    );
  const answerer = answererOf(request, facts.viewerId, facts.nameOf);
  const line = settledLine(request, answerer);
  const ask = askOf(request);
  const elsewhere = answerer.kind === "you" && answeredElsewhere(request.id);
  const icon =
    answerer.kind === "someone" && request.decidedBy !== null ? (
      <UsersIcon />
    ) : elsewhere ? (
      <SmartphoneIcon />
    ) : ask.kind === "question" ? (
      <MessageCircleQuestionIcon />
    ) : request.decision === "decline" || request.decision === "cancel" ? (
      <ShieldXIcon />
    ) : (
      <ShieldCheckIcon />
    );
  const at =
    request.decidedAt === null ? null : messageTime(new Date(request.decidedAt), new Date());
  const description = elsewhere
    ? ["On another device", at].filter((part) => part !== null).join(" · ")
    : line.description;
  const byline = [answerer.kind === "you" ? facts.nameOf(facts.viewerId) : answerer.name, at]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <div className="flex flex-col gap-3">
      <TraceRow
        icon={icon}
        title={line.title}
        {...(line.code === null ? {} : { code: line.code })}
        {...(description === null ? {} : { description })}
      />
      {line.words === null ? null : (
        <>
          <UserMessage byline={byline} className="max-lg:hidden">
            <p className="whitespace-pre-wrap">{line.words}</p>
          </UserMessage>
          <UserMessage size="touch" byline={byline} className="lg:hidden">
            <p className="whitespace-pre-wrap">{line.words}</p>
          </UserMessage>
        </>
      )}
    </div>
  );
}

// --- Sending an answer ---------------------------------------------------------------------------

/**
 * Send an answer to a request: the server's copy replaces the waiting one in the cached
 * conversation at once, so the card goes and the line says who answered. A request someone else
 * answered first reads the conversation again, so the card goes and says who did.
 */
const useRespond = (sessionId: string) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.sessions.respondRequest.mutationOptions({
      onMutate: ({ requestId }) => markAnsweredHere(requestId),
      onSuccess: (settled) => {
        queryClient.setQueriesData(
          { queryKey: conversationKey(trpc, sessionId) },
          (data: Parameters<typeof withChanges>[0] | undefined) =>
            data === undefined
              ? data
              : withChanges(data, { items: [], turns: [], requests: [requestView(settled)] }),
        );
      },
      onError: (cause) => {
        if (refusalTagOf(cause) === "AgentRequestResolved")
          void queryClient.invalidateQueries({ queryKey: conversationKey(trpc, sessionId) });
      },
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: trpc.sessions.inbox.queryKey(), exact: true }),
    }),
  );
};

/** Why an answer didn't go, in a band at the top of the card, with Try again. */
function NotSent({
  error,
  kept,
  size,
  onRetry,
}: {
  readonly error: unknown;
  readonly kept: string;
  readonly size: Size;
  readonly onRetry: () => void;
}) {
  const resolved = refusalTagOf(error) === "AgentRequestResolved";
  return (
    <Banner
      tone="error"
      layout={size === "touch" ? "stacked" : "inline"}
      title={resolved ? "Someone answered first." : "Your answer wasn't sent."}
      actions={
        resolved ? undefined : (
          <Button
            type="button"
            size={size === "touch" ? "touch" : "sm"}
            variant="outline"
            onClick={onRetry}
          >
            Try again
          </Button>
        )
      }
    >
      {resolved
        ? "This was answered on another device or by someone else, so yours wasn't sent."
        : `${failureWords(error, "Mend couldn't reach the server.")} ${kept}`}
    </Banner>
  );
}

// --- A question ----------------------------------------------------------------------------------

/**
 * A question the agent asked, answered in the composer card (Doop "Question · nothing picked" to
 * "Question with two parts · 2 of 2"): the choices above, the field under them. A picked choice is
 * an answer on its own and the field's words go with it as a note; Something else, or nothing
 * picked, makes the field's words the answer. The composer's send button sends it; with several
 * questions it goes on to the next one, and the last sends them all.
 */
export function QuestionComposer({
  request,
  facts,
  base,
  size,
}: {
  readonly request: RequestView;
  readonly facts: SessionFacts;
  readonly base: PromptBase;
  readonly size: Size;
}) {
  markShownWaiting(request.id);
  const questions = request.questions ?? [];
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<Readonly<Record<string, Picked>>>({});
  const [written, setWritten] = useState<Readonly<Record<string, string>>>({});
  const respond = useRespond(facts.session.id);
  const question = questions[step];
  if (question === undefined) return null;
  const own = picked[question.id] ?? NOTHING_PICKED;
  const words = base.value ?? "";
  const last = step === questions.length - 1;
  const setWords = (next: string) => base.onValueChange?.(next);

  /** Answer this question with the field's words: go on to the next, or send them all. */
  const submit = (field: string): boolean => {
    if (base.blocked || respond.isPending || !answered(own, field)) return false;
    if (!last) {
      setWritten({ ...written, [question.id]: field });
      setStep(step + 1);
      setWords(written[questions[step + 1]?.id ?? ""] ?? "");
      return true;
    }
    respond.mutate(
      {
        requestId: request.id,
        response: { answers: requestAnswers(questions, picked, written, field) },
      },
      // Not sent: the words go back into the field, so nothing is lost.
      { onError: () => setWords(field) },
    );
    return true;
  };

  const back = (index: number) => {
    setWritten({ ...written, [question.id]: words });
    setStep(index);
    setWords(written[questions[index]?.id ?? ""] ?? "");
  };

  const choiceValue = own.other ? OTHER : (own.choices[0] ?? null);
  return (
    <>
      {respond.isError ? (
        <NotSent
          error={respond.error}
          size={size}
          kept={
            own.choices.length > 0
              ? `Your choice${words.trim() === "" ? " is" : " and your note are"} kept, so nothing is lost.`
              : "Your answer is kept, so nothing is lost."
          }
          onRetry={() => {
            if (submit(words.trim())) setWords("");
          }}
        />
      ) : null}
      {questions.slice(0, step).map((earlier, index) => {
        const earlierPicked = picked[earlier.id] ?? NOTHING_PICKED;
        const answer =
          earlierPicked.choices.length > 0
            ? earlierPicked.choices.join(", ")
            : (written[earlier.id] ?? "").trim();
        return (
          <QuestionEarlier
            key={earlier.id}
            size={size}
            label={`Question ${index + 1}`}
            answer={answer}
            onChange={() => back(index)}
          />
        );
      })}
      <Question
        key={question.id}
        size={size}
        name={`answer-${question.id}`}
        title={question.question}
        {...(question.header === null || question.header === question.question
          ? {}
          : { description: question.header })}
        {...(questions.length > 1 ? { step: `${step + 1} of ${questions.length}` } : {})}
        choices={question.options.map((option) => ({
          value: option.label,
          label: option.label,
          ...(option.description === null ? {} : { description: option.description }),
        }))}
        other={{ value: OTHER, label: "Something else" }}
        multiple={question.multiSelect}
        values={[...own.choices, ...(own.other ? [OTHER] : [])]}
        value={choiceValue}
        onValueChange={(value) => {
          setPicked({ ...picked, [question.id]: pick(own, value, question.multiSelect) });
          if (value === OTHER) document.getElementById(base.id ?? "")?.focus();
        }}
        onSubmit={() => {
          // Enter on a picked choice: the field empties once the last answer goes.
          if (submit(words.trim()) && last) setWords("");
        }}
        hint={
          respond.isError
            ? `Your choice is kept. Try again to send it${words.trim() === "" ? "" : " with the note"}.`
            : questionHint({ question, picked: own, words, step, steps: questions.length })
        }
      />
      <PromptInput
        {...base}
        placeholder={questionPlaceholder({ picked: own, last, steps: questions.length })}
        allowEmpty={own.choices.length > 0}
        blocked={base.blocked || respond.isPending}
        onSubmit={(field) => void submit(field)}
      />
      {respond.isPending ? (
        <p role="status" className="sr-only">
          Sending your answer…
        </p>
      ) : null}
    </>
  );
}

// --- An approval ---------------------------------------------------------------------------------

/** What the agent would do, exactly: the command, the edit's diff, or the tool and its arguments. */
function ApprovalDetail({
  request,
  conversation,
}: {
  readonly request: RequestView;
  readonly conversation: ConversationView | undefined;
}) {
  const shape = approvalShape(request, conversation?.items ?? []);
  switch (shape.kind) {
    case "command":
      return (
        <>
          <ApprovalCommand
            command={shape.command}
            {...(shape.cwd === null
              ? {}
              : {
                  where: (
                    <>
                      Runs in <code>{shape.cwd}</code>
                    </>
                  ),
                })}
          />
          {shape.reason === null ? null : <p className="text-muted-foreground">{shape.reason}</p>}
        </>
      );
    case "edit":
      return (
        <>
          {shape.reason === null ? null : <p className="text-muted-foreground">{shape.reason}</p>}
          {shape.files.length === 0 ? (
            <p className="text-muted-foreground">
              The edit isn't in the conversation yet. Its diff shows here once the agent records it.
            </p>
          ) : (
            shape.files.map((file) => (
              <ApprovalDiff key={file.path} path={file.path} diff={file.diff} />
            ))
          )}
        </>
      );
    case "tool":
      return (
        <>
          {shape.server === null ? null : (
            <p className="-mt-1.5 text-muted-foreground">
              The tool comes from the MCP server {shape.server}.
            </p>
          )}
          <ApprovalArguments icon={<PlugIcon />} name={shape.name} entries={shape.entries} />
        </>
      );
  }
}

/** "Always allow …" for this kind of request, and what it means. */
const alwaysChoice = (
  agent: string,
  request: RequestView,
  conversation: ConversationView | undefined,
) => {
  const shape = approvalShape(request, conversation?.items ?? []);
  switch (shape.kind) {
    case "command":
      return {
        once: `${agent} asks again before its next command.`,
        label:
          shape.rule === null ? (
            "Always allow this command in this session"
          ) : (
            <>
              Always allow <code>{shape.rule}</code> in this session
            </>
          ),
        description: `${agent} won't ask again for it until the session ends.`,
      };
    case "edit":
      return {
        once: `${agent} asks again before its next file edit.`,
        label: "Always allow file edits in this session",
        description: `${agent} still asks before it runs commands.`,
      };
    case "tool":
      return {
        once: `${agent} asks again the next time it wants this tool.`,
        label: (
          <>
            Always allow <code>{shape.name}</code> in this session
          </>
        ),
        description: "Other tools still ask first.",
      };
  }
};

/**
 * The agent asking to run a command, edit a file or use a tool, answered in the composer card
 * (Doop "Approve a command", "a file edit", "a tool"): exactly what it would do, Approve once or
 * Always allow for the session, Deny and Approve. Words in the field and send deny it and tell the
 * agent what to do instead.
 */
export function ApprovalComposer({
  request,
  facts,
  conversation,
  base,
  size,
  sendWords,
}: {
  readonly request: RequestView;
  readonly facts: SessionFacts;
  readonly conversation: ConversationView | undefined;
  readonly base: PromptBase;
  readonly size: Size;
  /** Sends the field's words to the agent as a message, after the denial. */
  readonly sendWords: (words: string) => void;
}) {
  markShownWaiting(request.id);
  const [choice, setChoice] = useState("once");
  const respond = useRespond(facts.session.id);
  const always = alwaysChoice(facts.agent, request, conversation);
  const decide = (decision: "accept" | "accept-for-session" | "decline", words: string | null) =>
    respond.mutate(
      { requestId: request.id, response: { decision } },
      {
        onSuccess: () => {
          if (words !== null) sendWords(words);
        },
        onError: () => {
          if (words !== null) base.onValueChange?.(words);
        },
      },
    );
  const pendingDecision =
    respond.isPending && "decision" in respond.variables.response
      ? respond.variables.response.decision
      : null;
  const busy = base.blocked || respond.isPending;
  const touch = size === "touch";
  return (
    <>
      {respond.isError ? (
        <NotSent
          error={respond.error}
          size={size}
          kept="Nothing ran. Try again, or Deny."
          onRetry={() => respond.mutate(respond.variables)}
        />
      ) : null}
      <Approval
        size={size}
        title={approvalTitle(facts.agent, approvalShape(request, conversation?.items ?? []))}
        choices={[
          { value: "once", label: "Approve once", description: always.once },
          { value: "always", label: always.label, description: always.description },
        ]}
        value={choice}
        onValueChange={setChoice}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size={touch ? "touch" : "sm"}
              disabled={busy}
              onClick={() => decide("decline", null)}
            >
              {pendingDecision === "decline" ? "Denying…" : "Deny"}
            </Button>
            <Button
              type="button"
              size={touch ? "touch" : "sm"}
              disabled={busy}
              onClick={() => decide(choice === "always" ? "accept-for-session" : "accept", null)}
            >
              {pendingDecision === "accept" || pendingDecision === "accept-for-session"
                ? "Approving…"
                : "Approve"}
            </Button>
          </>
        }
      >
        <ApprovalDetail request={request} conversation={conversation} />
      </Approval>
      <PromptInput
        {...base}
        placeholder={`Or tell ${facts.agent} what to do instead`}
        blocked={busy}
        onSubmit={(words) => decide("decline", words)}
      />
    </>
  );
}

// --- An Executor approval ------------------------------------------------------------------------

/**
 * A call the agent made through Executor that waits for the viewer's approval, in the same card
 * (Doop "Approve a tool"): the service's tool, its arguments and what Executor said; Deny and
 * Approve. Executor offers no "always" here. The field's words, sent, deny it and tell the agent
 * what to do instead.
 */
export function ExecutorApprovalComposer({
  call,
  facts,
  base,
  size,
  sendWords,
}: {
  readonly call: ExecutorCall;
  readonly facts: SessionFacts;
  readonly base: PromptBase;
  readonly size: Size;
  readonly sendWords: (words: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = { sessionId: call.sessionId, callId: call.id };
  const approval = useQuery(trpc.executor.approval.queryOptions(params, { retry: false }));
  const answer = useMutation(
    trpc.executor.approve.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.executor.calls.pathFilter()),
    }),
  );
  const decide = (action: "accept" | "decline", words: string | null) =>
    answer.mutate(
      { ...params, action, content: {} },
      {
        onSuccess: () => {
          if (words !== null) sendWords(words);
        },
        onError: () => {
          if (words !== null) base.onValueChange?.(words);
        },
      },
    );
  const busy = base.blocked || answer.isPending;
  const touch = size === "touch";
  const args = approval.data?.arguments;
  const entries =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? Object.entries(args).map(
          ([key, value]) =>
            [key, typeof value === "string" ? value : JSON.stringify(value)] as const,
        )
      : [];
  return (
    <>
      {answer.isError ? (
        <NotSent
          error={answer.error}
          size={size}
          kept="Nothing ran. Try again, or Deny."
          onRetry={() => answer.mutate(answer.variables)}
        />
      ) : null}
      <Approval
        size={size}
        title={`${facts.agent} wants to use a tool`}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size={touch ? "touch" : "sm"}
              disabled={busy}
              onClick={() => decide("decline", null)}
            >
              {answer.isPending && answer.variables.action === "decline" ? "Denying…" : "Deny"}
            </Button>
            <Button
              type="button"
              size={touch ? "touch" : "sm"}
              disabled={busy}
              onClick={() => decide("accept", null)}
            >
              {answer.isPending && answer.variables.action === "accept" ? "Approving…" : "Approve"}
            </Button>
          </>
        }
      >
        <p className="-mt-1.5 text-muted-foreground">
          {approval.isSuccess ? approval.data.message : call.message}
        </p>
        {approval.isPending ? (
          <p role="status" className="text-muted-foreground">
            Reading what it wants to do…
          </p>
        ) : approval.isError ? (
          <p role="alert" className="text-destructive">
            What it wants to do didn't load. {failureWords(approval.error, "")}
          </p>
        ) : (
          <ApprovalArguments
            icon={<PlugIcon />}
            name={`${call.service} · ${call.tool}`}
            entries={entries}
          />
        )}
      </Approval>
      <PromptInput
        {...base}
        placeholder={`Or tell ${facts.agent} what to do instead`}
        blocked={busy}
        onSubmit={(words) => decide("decline", words)}
      />
    </>
  );
}

// --- Answered somewhere else ---------------------------------------------------------------------

/**
 * A request this tab showed that was answered elsewhere (Doop "Question · answered on your phone",
 * "answered by Grace Hopper", "Approval · already approved on another device"): who answered and
 * what, at the top of the composer card, until dismissed. The words in the field stay, unsent.
 */
export function AnsweredElsewhere({
  request,
  facts,
  hasWords,
  size,
  onDismiss,
}: {
  readonly request: RequestView;
  readonly facts: SessionFacts;
  readonly hasWords: boolean;
  readonly size: Size;
  readonly onDismiss: () => void;
}) {
  const answerer = answererOf(request, facts.viewerId, facts.nameOf);
  const line = settledLine(request, answerer);
  const at =
    request.decidedAt === null ? null : messageTime(new Date(request.decidedAt), new Date());
  const ask = askOf(request);
  const what = `${line.title}${line.code === null ? "" : ` ${line.code}`}`;
  const unsent = hasWords ? " Your words below haven't been sent." : "";
  const withdrawn = request.answers === null && request.decision === null;
  const title = withdrawn
    ? ask.kind === "question"
      ? "The question was withdrawn."
      : "The request was withdrawn."
    : answerer.kind === "you"
      ? ask.kind === "question"
        ? "You answered on another device."
        : "Already answered on another device."
      : `${answerer.name ?? "Someone"} answered first.`;
  const body = withdrawn
    ? `${facts.agent} stopped waiting before anyone answered.${unsent}`
    : `${what}${at === null ? "" : ` at ${at}`}.${unsent}`;
  return (
    <Banner
      tone="info"
      layout={size === "touch" ? "stacked" : "inline"}
      icon={
        answerer.kind === "you" ? (
          <SmartphoneIcon className="text-primary" />
        ) : (
          <UsersIcon className="text-primary" />
        )
      }
      title={title}
      actions={
        <Button
          type="button"
          variant="link"
          size={size === "touch" ? "touch" : "sm"}
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      }
    >
      {body}
    </Banner>
  );
}

// --- Someone who can't answer ---------------------------------------------------------------------

/**
 * A waiting request as someone who may not answer it sees it, above the locked composer: what was
 * asked, with no controls. The marker in the conversation says whose answer it waits for.
 */
export function RequestPreview({
  request,
  facts,
  conversation,
  size,
}: {
  readonly request: RequestView;
  readonly facts: SessionFacts;
  readonly conversation: ConversationView | undefined;
  readonly size: Size;
}) {
  if (askOf(request).kind === "question") {
    const questions = request.questions ?? [];
    return (
      <div className="grid gap-3 pt-4 pr-4 pb-3 pl-4.5 text-row">
        {questions.map((question) => (
          <div key={question.id} className="grid gap-1">
            <p className="text-lead font-semibold">{question.question}</p>
            <ul className="grid gap-0.5 text-muted-foreground">
              {question.options.map((option) => (
                <li key={option.label}>
                  <span className="text-foreground">{option.label}</span>
                  {option.description === null ? null : ` · ${option.description}`}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  return (
    <Approval
      size={size}
      title={approvalTitle(facts.agent, approvalShape(request, conversation?.items ?? []))}
    >
      <ApprovalDetail request={request} conversation={conversation} />
    </Approval>
  );
}
