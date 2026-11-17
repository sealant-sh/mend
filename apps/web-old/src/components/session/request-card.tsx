import {
  type AgentApprovalDecision,
  type AgentRequestDto,
  type AnswerChoices,
  answersComplete,
  composeAnswers,
  recordedAnswers,
  requestAsk,
  requestDetailText,
  requestName,
  requestOutcome,
  toggleChoice,
  type WrittenAnswers,
} from "@mend/agent-conversation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { CheckBox } from "#/components/kit/menu";
import { Dot } from "#/components/kit/status";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import type { SessionFacts } from "./facts";

const DECISIONS: ReadonlyArray<{
  readonly decision: AgentApprovalDecision;
  readonly label: string;
  readonly primary: boolean;
}> = [
  { decision: "accept", label: "Allow once", primary: true },
  { decision: "accept-for-session", label: "Allow for this session", primary: false },
  { decision: "decline", label: "Decline", primary: false },
];

/**
 * What the agent asked a person, in the conversation where it asked: a command or a file change to
 * allow, or questions to answer. Anyone who steers the session answers; everyone else reads it.
 * A settled request keeps one line saying how it was settled.
 */
export function RequestCard({
  facts,
  request,
}: {
  readonly facts: SessionFacts;
  readonly request: AgentRequestDto;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const respond = useMutation({
    ...trpc.sessions.respondRequest.mutationOptions(),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  const [selected, setSelected] = useState<AnswerChoices>({});
  const [written, setWritten] = useState<WrittenAnswers>({});
  const headingId = useId();
  const detail = requestDetailText(request.detail);
  const pending = request.status === "pending";
  if (!pending)
    return (
      <div className="grid gap-1 font-mono text-[12px] text-muted-foreground">
        <p>
          {requestName(request)} · {requestOutcome(request)}
        </p>
        {recordedAnswers(request).map((answer) => (
          <p key={answer.question} className="text-faint">
            {answer.question}: {answer.answers.join(", ")}
          </p>
        ))}
      </div>
    );
  const ask = requestAsk(request);
  const questions = request.questions ?? [];
  const canAnswer = facts.control.steer && facts.agentLive && ask !== "unanswerable";
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 rounded-[14px] border border-rule bg-panel px-4 py-3.5 shadow-xs"
    >
      <h3 id={headingId} className="flex items-center gap-2 font-sans text-[13.5px] font-semibold">
        <Dot tone="wait" />
        {requestName(request)}
      </h3>
      {detail === null ? null : (
        <pre className="max-h-48 overflow-auto rounded-xl bg-secondary px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">
          {detail}
        </pre>
      )}
      {ask === "answers"
        ? questions.map((question) => (
            <fieldset key={question.id} className="grid gap-1.5" disabled={!canAnswer}>
              <legend className="mb-1 text-[13px] text-foreground">
                {question.header === null ? null : (
                  <span className="mr-2 font-mono text-[11px] text-label">{question.header}</span>
                )}
                {question.question}
              </legend>
              {question.options.map((option) => {
                const checked = (selected[question.id] ?? []).includes(option.label);
                return (
                  <label
                    key={option.label}
                    className="flex cursor-pointer items-start gap-2 text-[13px] text-ink-2"
                  >
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`${request.id}:${question.id}`}
                      checked={checked}
                      onChange={() =>
                        setSelected(
                          toggleChoice(selected, question.id, option.label, question.multiSelect),
                        )
                      }
                      className="peer sr-only"
                    />
                    <span className="mt-0.5 rounded-[4px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--sw-accent)]">
                      <CheckBox checked={checked} />
                    </span>
                    <span>
                      {option.label}
                      {option.description === null ? null : (
                        <span className="block text-[12px] text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              <input
                aria-label={`Your own answer: ${question.question}`}
                placeholder="Or write an answer"
                value={written[question.id] ?? ""}
                onChange={(event) => setWritten({ ...written, [question.id]: event.target.value })}
                className="mt-1 rounded-[10px] border border-input bg-panel px-3 py-1.5 text-[13px] outline-none focus-visible:border-primary"
              />
            </fieldset>
          ))
        : null}
      {canAnswer ? (
        <div className="flex flex-wrap items-center gap-2">
          {ask === "decision" ? (
            DECISIONS.map((choice) => (
              <Button
                key={choice.decision}
                size="sm"
                variant={choice.primary ? "primary" : "default"}
                disabled={respond.isPending}
                onClick={() =>
                  respond.mutate({ requestId: request.id, response: { decision: choice.decision } })
                }
              >
                {choice.label}
              </Button>
            ))
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={respond.isPending || !answersComplete(questions, selected, written)}
              onClick={() =>
                respond.mutate({
                  requestId: request.id,
                  response: { answers: composeAnswers(questions, selected, written) },
                })
              }
            >
              Send the answers
            </Button>
          )}
          {respond.isPending ? (
            <span role="status" className="font-mono text-[11.5px] text-muted-foreground">
              Sending…
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-[12.5px] text-muted-foreground">
          {ask === "unanswerable"
            ? "The agent asked without a question Mend can show. Answer it in the Terminal tab."
            : !facts.agentLive
              ? "The agent is not running, so this can no longer be answered."
              : `Only ${facts.ownerName ?? "its owner"} answers this, unless they share control.`}
        </p>
      )}
      {respond.isError ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {failureWords(respond.error, "The answer did not reach the agent. Try again.")}
        </p>
      ) : null}
    </section>
  );
}
