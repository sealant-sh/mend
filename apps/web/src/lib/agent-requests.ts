import type { AgentInputQuestionDto, AgentItemDto } from "@mend/agent-conversation";
import { AgentRequestKind, type SessionAsk, sessionAsk } from "@mend/domain/workbench";
import { Schema } from "effect";

import type { RequestView } from "./conversation.ts";

// What the agent asks a person, as the session's composer card shows it (Doop page 3, "Answer the
// agent"): a question's choices and the answer they make, an approval's command, edit or tool, and
// the one line a settled request leaves in the conversation. Plain rules, free of React.

/** A request kind this app knows; a newer server's kind reads as a plain ask. */
const isRequestKind = Schema.is(AgentRequestKind);

/** The value of a question's last row, "Something else": the answer is the person's own words. */
export const OTHER = "mend:something-else";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (record: Readonly<Record<string, unknown>>, ...names: ReadonlyArray<string>) => {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string"))
      return value.join(" ");
  }
  return null;
};

/** What a request asks, by kind and the thing it names: a question, a command, an edit, a tool. */
export const askOf = (request: RequestView): SessionAsk => {
  const { kind } = request;
  return isRequestKind(kind)
    ? sessionAsk({ ...request, kind })
    : { kind: "decision", subject: request.title };
};

/** A request that waits for an answer. */
export const isPending = (request: RequestView): boolean => request.status === "pending";

/** The request the composer card answers: the oldest still waiting. Undefined when none waits. */
export const waitingRequest = (requests: ReadonlyArray<RequestView>): RequestView | undefined =>
  requests
    .filter(isPending)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];

// --- Questions -----------------------------------------------------------------------------------

/** What a person has picked for one question: its choices, or Something else. */
export type Picked = { readonly choices: ReadonlyArray<string>; readonly other: boolean };

export const NOTHING_PICKED: Picked = { choices: [], other: false };

/** Picking `value` (a choice's label, or `OTHER`) on a question: one at a time unless it allows several. */
export const pick = (picked: Picked, value: string, multiSelect: boolean): Picked => {
  if (value === OTHER)
    return multiSelect
      ? { ...picked, other: !picked.other }
      : { choices: [], other: !picked.other || picked.choices.length > 0 };
  if (!multiSelect) return { choices: [value], other: false };
  return picked.choices.includes(value)
    ? { ...picked, choices: picked.choices.filter((choice) => choice !== value) }
    : { ...picked, choices: [...picked.choices, value] };
};

/**
 * The answer one question is sent: the choices picked, then the person's words. With a choice
 * picked the words are a note that goes with it; with Something else or nothing picked they are
 * the answer.
 */
export const answerOf = (picked: Picked, words: string): ReadonlyArray<string> => {
  const written = words.trim();
  return written === "" ? picked.choices : [...picked.choices, written];
};

/** Whether one question has an answer to send: a choice picked, or words of the person's own. */
export const answered = (picked: Picked, words: string): boolean =>
  picked.choices.length > 0 || words.trim() !== "";

/**
 * The answers to every question of a request, keyed by question id as the server takes them.
 * `written` holds the words each earlier question was answered with; `note` is the field's words
 * as the last question is sent: its own answer, or, beside a choice, a note that goes with every
 * answer.
 */
export const requestAnswers = (
  questions: ReadonlyArray<AgentInputQuestionDto>,
  picked: Readonly<Record<string, Picked>>,
  written: Readonly<Record<string, string>>,
  note: string,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const last = questions.at(-1);
  const lastPicked = last === undefined ? NOTHING_PICKED : (picked[last.id] ?? NOTHING_PICKED);
  // A note beside the last question's choice goes with every answer; its own words only with it.
  const noteForAll = lastPicked.choices.length > 0 && !lastPicked.other;
  return Object.fromEntries(
    questions.map((question) => {
      const isLast = question === last;
      const own = picked[question.id] ?? NOTHING_PICKED;
      const words = isLast ? note : (written[question.id] ?? "");
      const answer = answerOf(own, words);
      const extra = !isLast && noteForAll && note.trim() !== "" ? [note.trim()] : [];
      return [question.id, [...answer, ...extra]];
    }),
  );
};

const numbersWords = (count: number): string => {
  const numbers = Array.from({ length: count }, (_, index) => String(index + 1));
  if (numbers.length <= 1) return numbers.join("");
  return `${numbers.slice(0, -1).join(", ")} or ${numbers.at(-1)}`;
};

const countWords = (count: number): string =>
  count === 2 ? "both answers" : `all ${count} answers`;

/**
 * The hint under a question's choices, for where the person is: what Enter does, and what the
 * field below takes (Doop "Question · nothing picked", "a choice picked", "writing your own answer",
 * "Question with two parts").
 */
export const questionHint = ({
  question,
  picked,
  words,
  step,
  steps,
}: {
  readonly question: AgentInputQuestionDto;
  readonly picked: Picked;
  readonly words: string;
  /** Which question this is, from 0. */
  readonly step: number;
  readonly steps: number;
}): string => {
  const last = step === steps - 1;
  if (!last)
    return `Pick one, or write your own answer and press Enter, to go on to question ${step + 2}.`;
  if (picked.other) return "Write your answer below, then press Enter.";
  if (picked.choices.length === 0)
    return question.multiSelect
      ? "Pick any, or write your own answer below."
      : `Press ${numbersWords(question.options.length + 1)}, or write your own answer below.`;
  if (steps > 1)
    return `Press Enter to send ${countWords(steps)}. A note goes with ${steps === 2 ? "both" : "all of them"}.`;
  return words.trim() === ""
    ? "Press Enter to send your answer, or add a note below."
    : "Press Enter to send your answer with the note.";
};

/** What the composer's field says while a question waits. */
export const questionPlaceholder = ({
  picked,
  last,
  steps,
}: {
  readonly picked: Picked;
  readonly last: boolean;
  readonly steps: number;
}): string => {
  if (picked.other) return "Write your own answer";
  if (picked.choices.length === 0) return "Or write your own answer";
  if (last && steps > 1) return `Add a note to ${countWords(steps)} (optional)`;
  return "Add a note (optional)";
};

// --- Approvals -----------------------------------------------------------------------------------

/** One file an edit approval would change, with its unified diff. */
export type EditedFile = { readonly path: string; readonly diff: string };

/** What an approval would do, for the card to show exactly. */
export type ApprovalShape =
  | {
      readonly kind: "command";
      readonly command: string;
      /** Where it runs, when the agent said. */
      readonly cwd: string | null;
      /** The part of the command "Always allow" covers, when the agent offered a rule. */
      readonly rule: string | null;
      readonly reason: string | null;
    }
  | {
      readonly kind: "edit";
      readonly files: ReadonlyArray<EditedFile>;
      readonly reason: string | null;
    }
  | {
      readonly kind: "tool";
      /** The tool's name as people read it: `linear · create_issue` for an MCP server's tool. */
      readonly name: string;
      /** The MCP server the tool comes from, when it comes from one. */
      readonly server: string | null;
      readonly entries: ReadonlyArray<readonly [string, string]>;
    };

/** Every line of `content` as added: a new file. */
const addedLines = (content: string): string =>
  content
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");

const removedLines = (content: string): string =>
  content
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `-${line}`)
    .join("\n");

/** Claude's edit tool input as a diff: what the edit replaces, then what it writes. */
const claudeEdit = (
  input: Readonly<Record<string, unknown>>,
  tool: string,
): ReadonlyArray<EditedFile> => {
  const path = text(input, "file_path", "notebook_path", "path") ?? "";
  if (tool === "Write") return [{ path, diff: addedLines(text(input, "content") ?? "") }];
  const edits = Array.isArray(input["edits"]) ? input["edits"].filter(isRecord) : [input];
  const diff = edits
    .map((edit) =>
      [
        removedLines(text(edit, "old_string") ?? ""),
        addedLines(text(edit, "new_string", "new_source") ?? ""),
      ]
        .filter((part) => part !== "-" && part !== "+")
        .join("\n"),
    )
    .join("\n@@ @@\n");
  return [{ path, diff }];
};

/** Codex's file changes, from the turn's file-change item: each path and its diff. */
const codexChanges = (item: AgentItemDto | undefined): ReadonlyArray<EditedFile> => {
  const data = isRecord(item?.data) ? item.data : {};
  const changes = Array.isArray(data["changes"]) ? data["changes"].filter(isRecord) : [];
  return changes.flatMap((change) => {
    const path = text(change, "path");
    if (path === null) return [];
    return [{ path, diff: text(change, "diff", "unified_diff") ?? "" }];
  });
};

/** A tool argument's value as one string: text as it is, anything else as JSON. */
const valueWords = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

/** The rule Claude offers for "Always allow" a command (`terraform apply:*`), as people read it. */
const claudeRule = (detail: Readonly<Record<string, unknown>>): string | null => {
  const suggestions = Array.isArray(detail["suggestions"])
    ? detail["suggestions"].filter(isRecord)
    : [];
  for (const suggestion of suggestions) {
    const rules = Array.isArray(suggestion["rules"]) ? suggestion["rules"].filter(isRecord) : [];
    for (const rule of rules) {
      const content = text(rule, "ruleContent");
      if (content !== null) return content.replace(/:\*$/, "").replace(/\s\*$/, "");
    }
  }
  return null;
};

/** Claude's own keys on a tool permission's detail, which aren't the tool's arguments. */
const DETAIL_KEYS: ReadonlySet<string> = new Set(["toolName", "suggestions"]);

/**
 * What an approval would do, from what the adapters record: Codex's command approval (`detail` is
 * its params: the command, where it runs, why) and file-change approval (the turn's newest
 * file-change item holds the diff), and Claude's tool permission (`detail` carries `toolName` and
 * the tool's input: Bash is a command, an edit tool an edit, anything else a tool).
 */
export const approvalShape = (
  request: RequestView,
  items: ReadonlyArray<AgentItemDto>,
): ApprovalShape => {
  const detail = isRecord(request.detail) ? request.detail : {};
  const input = isRecord(detail["input"]) ? detail["input"] : detail;
  const ask = askOf(request);
  const reason = text(detail, "reason");
  if (ask.kind === "command")
    return {
      kind: "command",
      command: text(input, "command") ?? request.title ?? "",
      cwd: text(input, "cwd"),
      rule: claudeRule(detail),
      reason: text(input, "description") ?? reason,
    };
  if (ask.kind === "edit") {
    const tool = text(detail, "toolName");
    if (tool !== null) return { kind: "edit", files: claudeEdit(input, tool), reason };
    const item = items.findLast(
      (each) => each.turnId === request.turnId && each.kind === "file-change",
    );
    return { kind: "edit", files: codexChanges(item), reason };
  }
  const tool = text(detail, "toolName") ?? request.title ?? "a tool";
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  return {
    kind: "tool",
    name: mcp === null ? tool : `${mcp[1]} · ${mcp[2]}`,
    server: mcp?.[1] ?? null,
    entries: Object.entries(input)
      .filter(([key]) => !DETAIL_KEYS.has(key))
      .map(([key, value]) => [key, valueWords(value)] as const),
  };
};

/** "Claude Code wants to run a command" (Doop "Approve a command", "a file edit", "a tool"). */
export const approvalTitle = (agent: string, shape: ApprovalShape): string => {
  switch (shape.kind) {
    case "command":
      return `${agent} wants to run a command`;
    case "edit":
      return shape.files.length > 1
        ? `${agent} wants to edit ${shape.files.length} files`
        : `${agent} wants to edit a file`;
    case "tool":
      return `${agent} wants to use a tool`;
  }
};

// --- Settled requests ----------------------------------------------------------------------------

/** Who answered, as the viewer reads it. */
export type Answerer =
  | { readonly kind: "you" }
  /** Someone else; `name` is null when the roster doesn't name them, or nobody was recorded. */
  | { readonly kind: "someone"; readonly name: string | null };

export const answererOf = (
  request: RequestView,
  viewerId: string,
  nameOf: (userId: string) => string | null,
): Answerer => {
  if (request.decidedBy === null) return { kind: "someone", name: null };
  return request.decidedBy === viewerId
    ? { kind: "you" }
    : { kind: "someone", name: nameOf(request.decidedBy) };
};

const whoWords = (answerer: Answerer): string =>
  answerer.kind === "someone" ? (answerer.name ?? "Someone") : "You";

/** The words a single question was answered with: the choice it named, and anything written. */
export const answerParts = (
  question: AgentInputQuestionDto | undefined,
  values: ReadonlyArray<string>,
): { readonly choices: ReadonlyArray<string>; readonly words: string | null } => {
  const labels = new Set(question?.options.map((option) => option.label) ?? []);
  const choices = values.filter((value) => labels.has(value));
  const rest = values.filter((value) => !labels.has(value)).join("\n");
  return { choices, words: rest === "" ? null : rest };
};

/**
 * What a settled request says in the conversation, in one line: who answered and what (Doop
 * "Question · sent", "your own answer sent", "answered by Grace Hopper", "Approval · denied"),
 * the question it answered, and the words written with it, shown as that person's message.
 */
export const settledLine = (
  request: RequestView,
  answerer: Answerer,
): {
  readonly title: string;
  readonly code: string | null;
  readonly description: string | null;
  readonly words: string | null;
} => {
  const who = whoWords(answerer);
  const ask = askOf(request);
  if (request.answers !== null) {
    const questions = request.questions ?? [];
    const [first] = questions;
    if (questions.length <= 1) {
      const parts = answerParts(
        first,
        request.answers[first?.id ?? ""] ?? Object.values(request.answers)[0] ?? [],
      );
      const theirOwn = answerer.kind === "you" ? "your own words" : "their own words";
      return parts.choices.length === 0
        ? {
            title: `${who} answered in ${theirOwn}`,
            code: null,
            description: first?.question ?? null,
            words: parts.words,
          }
        : {
            title: `${who} chose ${parts.choices.join(", ")}`,
            code: null,
            description: first?.question ?? null,
            words: parts.words,
          };
    }
    const summary = questions
      .map((question) => {
        const parts = answerParts(question, request.answers?.[question.id] ?? []);
        return parts.choices.length > 0 ? parts.choices.join(", ") : "their own words";
      })
      .join(" · ");
    return {
      title: `${who} answered ${questions.length} questions`,
      code: null,
      description: summary,
      words: null,
    };
  }
  const subject = ask.subject;
  const thing =
    ask.kind === "command"
      ? "the command"
      : ask.kind === "edit"
        ? "the edit"
        : ask.kind === "tool"
          ? "the tool"
          : "it";
  switch (request.decision) {
    case "accept":
      return {
        title: `${who} approved ${thing} once`,
        code: subject,
        description: null,
        words: null,
      };
    case "accept-for-session":
      return {
        title: `${who} allowed ${thing} for this session`,
        code: subject,
        description: null,
        words: null,
      };
    case "decline":
      return {
        title: subject === null ? `${who} denied ${thing}` : `${who} denied`,
        code: subject,
        description: null,
        words: null,
      };
    case "cancel":
      return { title: `${who} cancelled ${thing}`, code: subject, description: null, words: null };
    default:
      // Withdrawn: the turn ended, or the agent stopped waiting, before anyone answered.
      return {
        title: ask.kind === "question" ? "The question was withdrawn" : "The request was withdrawn",
        code: ask.kind === "question" ? null : subject,
        description: "No answer was needed in the end",
        words: null,
      };
  }
};

/**
 * The marker in the conversation while a request waits: what the agent asked and whose answer it
 * waits for (Doop "Asked you a question · Waiting for your answer").
 */
export const waitingLine = (request: RequestView, waitsOn: string | null): string => {
  const ask = askOf(request);
  const count = request.questions?.length ?? 0;
  const asked =
    ask.kind === "question"
      ? count > 1
        ? `Asked ${count} questions`
        : "Asked a question"
      : ask.kind === "command"
        ? "Wants to run a command"
        : ask.kind === "edit"
          ? "Wants to edit a file"
          : ask.kind === "tool"
            ? "Wants to use a tool"
            : "Asked for a decision";
  const yours = waitsOn === null;
  const what = ask.kind === "question" ? (count > 1 ? "answers" : "answer") : "approval";
  const asks = yours ? asked.replace(/^Asked /, "Asked you ") : asked;
  return `${asks} · ${yours ? `Waiting for your ${what}` : `Waiting for ${waitsOn}'s ${what}`}`;
};
