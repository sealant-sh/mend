import type { AgentInputQuestionDto, AgentItemDto, AgentRequestDto } from "./feed.ts";

/** A human decision for an approval request, as the respond endpoint takes it. */
export type AgentApprovalDecision = "accept" | "accept-for-session" | "decline" | "cancel";

/** Approval and structured-input responses are disjoint on the wire. */
export type AgentRequestResponse =
  | { readonly decision: AgentApprovalDecision }
  | { readonly answers: Readonly<Record<string, ReadonlyArray<string>>> };

/** Choices and written answers per question id, while a person fills a user-input request. */
export type AnswerChoices = Readonly<Record<string, ReadonlyArray<string>>>;
export type WrittenAnswers = Readonly<Record<string, string>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the request carries for a person to read: its input when it has one, else all of it. */
export const requestDetailText = (detail: unknown): string | null => {
  if (typeof detail === "string") {
    return detail === "" ? null : detail;
  }
  if (detail === null || detail === undefined) {
    return null;
  }
  const visible = isRecord(detail) && detail.input !== undefined ? detail.input : detail;
  const text = JSON.stringify(visible, null, 2);
  return text === undefined || text === "{}" ? null : text;
};

/** How a request was settled, in words; the status itself when nothing more was recorded. */
export const requestOutcome = (request: AgentRequestDto): string => {
  if (request.answers !== null) {
    return "answered";
  }
  switch (request.decision) {
    case "accept":
      return "allowed once";
    case "accept-for-session":
      return "allowed for session";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
    default:
      return request.status;
  }
};

/** The question a request puts to a person. */
export const requestName = (request: AgentRequestDto): string => {
  if (request.title !== null && request.title !== "") {
    return request.title;
  }
  switch (request.kind) {
    case "command-approval":
      return "Run this command?";
    case "file-change-approval":
      return "Apply this file change?";
    case "tool-permission":
      return "Allow this tool?";
    case "user-input":
      return "The agent needs an answer";
    default:
      return "The agent needs a decision";
  }
};

/** A tool-like item's heading when the provider gave it none. */
export const itemName = (item: AgentItemDto): string => {
  if (item.title !== null) {
    return item.title;
  }
  switch (item.kind) {
    case "file-change":
      return "File change";
    case "web-search":
      return "Web search";
    case "command-execution":
      return "Command";
    default:
      return "Tool";
  }
};

/** Whether the item is an observed failure (the only reason to mark it red). */
export const itemFailed = (item: AgentItemDto): boolean =>
  item.kind === "error" || item.status === "failed";

/** Toggle one option: a multi-select question keeps the others, a single-select replaces them. */
export const toggleChoice = (
  current: AnswerChoices,
  questionId: string,
  label: string,
  multiSelect: boolean,
): AnswerChoices => {
  const values = current[questionId] ?? [];
  let next: ReadonlyArray<string>;
  if (values.includes(label)) {
    next = values.filter((value) => value !== label);
  } else {
    next = multiSelect ? [...values, label] : [label];
  }
  return { ...current, [questionId]: next };
};

/**
 * The answers a user-input request is sent: a written answer replaces the choice on a
 * single-select question and joins the choices on a multi-select one.
 */
export const composeAnswers = (
  questions: ReadonlyArray<AgentInputQuestionDto>,
  selected: AnswerChoices,
  written: WrittenAnswers,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const answers: Record<string, ReadonlyArray<string>> = {};
  for (const question of questions) {
    const custom = written[question.id]?.trim() ?? "";
    const choices = selected[question.id] ?? [];
    if (custom === "") {
      answers[question.id] = choices;
    } else {
      answers[question.id] = question.multiSelect ? [...choices, custom] : [custom];
    }
  }
  return answers;
};

/** Every question has a choice or a written answer. */
export const answersComplete = (
  questions: ReadonlyArray<AgentInputQuestionDto>,
  selected: AnswerChoices,
  written: WrittenAnswers,
): boolean =>
  questions.every((question) => {
    const custom = written[question.id]?.trim() ?? "";
    return (selected[question.id]?.length ?? 0) > 0 || custom !== "";
  });

/** The answers a request recorded, labelled with the question each one answered. */
export const recordedAnswers = (
  request: AgentRequestDto,
): ReadonlyArray<{ readonly question: string; readonly answers: ReadonlyArray<string> }> => {
  const questions = request.questions ?? [];
  return Object.entries(request.answers ?? {}).map(([questionId, answers]) => {
    const question = questions.find((candidate) => candidate.id === questionId);
    return { question: question?.header ?? question?.question ?? questionId, answers };
  });
};

/**
 * What a pending request asks of a person: a decision, answers to its questions, or nothing it
 * can be answered with (a user-input request that arrived without a question).
 */
export const requestAsk = (request: AgentRequestDto): "decision" | "answers" | "unanswerable" => {
  if (request.kind !== "user-input") return "decision";
  return (request.questions ?? []).length > 0 ? "answers" : "unanswerable";
};
