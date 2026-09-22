import type { AgentInputAnswers } from "@mend/domain/workbench";

/**
 * The owner's mention as the answer to the agent's question (docs/adr/0006-slack.md, "Follow-ups
 * in a thread"). One question takes the whole request. Several take one line each, in order, and
 * a mention with another number of lines is refused rather than guessed at. An answer that names
 * one of the question's options, by its label or its number, is that option; anything else is the
 * owner's own words.
 */

export interface AnswerableQuestion {
  readonly id: string;
  readonly options: ReadonlyArray<{ readonly label: string }>;
  readonly multiSelect: boolean;
}

export type MentionAnswer =
  | { readonly kind: "answers"; readonly answers: AgentInputAnswers }
  /** Why the mention cannot answer, worded for a reply only the owner sees. */
  | { readonly kind: "refused"; readonly reason: string };

const normalised = (text: string): string =>
  text
    .trim()
    .replace(/[.!]+$/, "")
    .trim()
    .toLowerCase();

/** The option a part names, by label (any case) or by its 1-based number; null otherwise. */
const optionNamed = (question: AnswerableQuestion, part: string): string | null => {
  const wanted = normalised(part);
  const byLabel = question.options.find((option) => normalised(option.label) === wanted);
  if (byLabel !== undefined) return byLabel.label;
  if (!/^\d{1,2}$/.test(wanted)) return null;
  return question.options[Number(wanted) - 1]?.label ?? null;
};

/** One question's answer: its options when every part names one, the words themselves otherwise. */
const answerOne = (question: AnswerableQuestion, text: string): ReadonlyArray<string> => {
  const parts = question.multiSelect ? text.split(/\s*,\s*/).filter((part) => part !== "") : [text];
  const named = parts.map((part) => optionNamed(question, part));
  return named.every((label) => label !== null) && named.length > 0
    ? named.filter((label) => label !== null)
    : [text];
};

export const answersFromMention = (
  questions: ReadonlyArray<AnswerableQuestion> | null,
  text: string,
): MentionAnswer => {
  const body = text.trim();
  if (body === "") return { kind: "refused", reason: "the mention has no answer" };
  if (questions === null || questions.length === 0) {
    return {
      kind: "refused",
      reason: "the question has nothing Slack can answer · answer it in Mend",
    };
  }
  const [only] = questions;
  if (questions.length === 1 && only !== undefined) {
    return { kind: "answers", answers: { [only.id]: answerOne(only, body) } };
  }
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length !== questions.length) {
    return {
      kind: "refused",
      reason: `the agent asked ${questions.length} questions · answer one per line, in order`,
    };
  }
  return {
    kind: "answers",
    answers: Object.fromEntries(
      questions.map((question, index) => [question.id, answerOne(question, lines[index] ?? "")]),
    ),
  };
};
