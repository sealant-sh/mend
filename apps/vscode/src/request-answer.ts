import { requestAsk, requestName, type AgentInputQuestionDto } from "@mend/agent-conversation";

import type { PendingRequest } from "./client.js";
import { MendApiError } from "./mend-http.js";

/**
 * Answering a conversation's request (story b, rule 8): what it asks, what the toast and the quick
 * pick offer for it, and the one state machine every answer goes through, whichever gesture sent
 * it. Pure but for the effects `Answers` is given.
 */

/** What a pending request asks, and so what the toast and quick pick offer. */
export type RequestAsk =
  | { readonly kind: "decision" }
  | { readonly kind: "answers"; readonly questions: ReadonlyArray<AgentInputQuestionDto> }
  /** A user-input request that arrived without a question. */
  | { readonly kind: "unanswerable" };

export interface RequestView {
  readonly id: string;
  readonly sessionId: string;
  readonly processId: string;
  readonly createdAt: string;
  /** `run pnpm db:migrate?`, `use Edit?`, `Which database?` */
  readonly question: string;
  readonly ask: RequestAsk;
}

/** What an answer sends: a decision, or answers by question id. Nothing here offers `cancel`. */
export type AgentResponse =
  | { readonly decision: "accept" | "accept-for-session" | "decline" }
  | { readonly answers: Readonly<Record<string, ReadonlyArray<string>>> };

/** One request's answer, in this window. `answered` and `gone` are final. */
export type AnswerState =
  | { readonly kind: "pending" }
  | { readonly kind: "sending"; readonly response: AgentResponse }
  | { readonly kind: "answered"; readonly response: AgentResponse }
  /** A re-read found it no longer pending, or Mend said it already has an answer or is gone. */
  | { readonly kind: "gone" }
  | {
      readonly kind: "failed";
      readonly response: AgentResponse;
      /** Mend's words, or why it was not reached. */
      readonly words: string;
      readonly retryable: boolean;
      /** What failed, for the error toast: a refused sign-in reads as one wherever it is met. */
      readonly cause: unknown;
    };

const firstLine = (text: string): string => text.split("\n")[0]?.trim() ?? "";

const stringAt = (value: unknown, ...path: ReadonlyArray<string>): string | null => {
  let found = value;
  for (const key of path) {
    if (typeof found !== "object" || found === null) return null;
    found = Reflect.get(found, key);
  }
  return typeof found === "string" && found.trim() !== "" ? found : null;
};

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** The question a request puts, as the toast says it after `<name> asks:`. */
const questionOf = (request: PendingRequest): string => {
  const [first, ...rest] = request.questions ?? [];
  if (request.kind === "user-input" && first !== undefined)
    return rest.length === 0
      ? first.question
      : `${first.question} · ${rest.length} more ${rest.length === 1 ? "question" : "questions"}`;
  // Claude's permission is titled by its tool; a Bash one carries the command it would run.
  const tool = request.kind === "tool-permission" ? stringAt(request.detail, "toolName") : null;
  const command = stringAt(request.detail, "input", "command");
  if (tool === "Bash" && command !== null) return `run ${firstLine(command)}?`;
  if (request.kind === "tool-permission" && request.title !== null && request.title !== "")
    return `use ${request.title}?`;
  // Codex titles its command approval by the command.
  if (request.kind === "command-approval" && request.title !== null && request.title !== "")
    return `run ${firstLine(request.title)}?`;
  // Codex titles a file change by its reason, which reads as no question.
  return lowerFirst(
    requestName(request.kind === "file-change-approval" ? { ...request, title: null } : request),
  );
};

export const requestView = (request: PendingRequest): RequestView => {
  const ask = requestAsk(request);
  return {
    id: request.id,
    sessionId: request.sessionId,
    processId: request.processId,
    createdAt: request.createdAt,
    question: questionOf(request),
    ask:
      ask === "answers"
        ? { kind: "answers", questions: request.questions ?? [] }
        : ask === "decision"
          ? { kind: "decision" }
          : { kind: "unanswerable" },
  };
};

/** A toast button: it sends its answer, or opens the quick pick (`More…`, `Answer…`). */
export type ToastChoice =
  | { readonly label: string; readonly kind: "send"; readonly response: AgentResponse }
  | { readonly label: string; readonly kind: "pick" };

export const MORE = "More…";

/** A single-select question with at most this many options puts them on the toast itself. */
const TOAST_OPTIONS = 3;

export const toastChoices = (ask: RequestAsk): ReadonlyArray<ToastChoice> => {
  switch (ask.kind) {
    case "decision":
      return [
        { label: "Allow", kind: "send", response: { decision: "accept" } },
        { label: "Deny", kind: "send", response: { decision: "decline" } },
        { label: MORE, kind: "pick" },
      ];
    case "answers": {
      const [only, ...others] = ask.questions;
      if (
        only === undefined ||
        others.length > 0 ||
        only.multiSelect ||
        only.options.length === 0 ||
        only.options.length > TOAST_OPTIONS
      )
        return [{ label: "Answer…", kind: "pick" }];
      return [
        ...only.options.map(
          (option): ToastChoice => ({
            label: option.label,
            kind: "send",
            response: { answers: { [only.id]: [option.label] } },
          }),
        ),
        { label: MORE, kind: "pick" },
      ];
    }
    case "unanswerable":
      return [];
  }
};

/** The quick pick's decisions, in the web's order. */
export const DECISIONS: ReadonlyArray<{
  readonly label: string;
  readonly response: AgentResponse;
}> = [
  { label: "Allow once", response: { decision: "accept" } },
  { label: "Allow for this session", response: { decision: "accept-for-session" } },
  { label: "Deny", response: { decision: "decline" } },
];

/** How a send ended: the request's state after it, or Mend not reached, so nothing was sent. */
export type SendOutcome = Settled | { readonly kind: "unreachable" };

type Settled = Extract<AnswerState, { readonly kind: "answered" | "gone" | "failed" }>;

/** What the machine does to the world. */
export interface AnswerEffects {
  /** The session's requests still pending, read now. */
  readonly pending: (sessionId: string) => Promise<ReadonlyArray<{ readonly id: string }>>;
  /** `POST /requests/:id/respond`. */
  readonly respond: (requestId: string, response: AgentResponse) => Promise<void>;
}

type Failure =
  | { readonly kind: "gone" }
  | { readonly kind: "unreachable"; readonly words: string }
  | { readonly kind: "refused" | "transient"; readonly words: string };

const failureOf = (cause: unknown): Failure => {
  if (!(cause instanceof MendApiError))
    return {
      kind: "transient",
      words: cause instanceof Error ? cause.message : "Mend could not take the answer",
    };
  if (cause.status === null) return { kind: "unreachable", words: cause.message };
  // A second answer, from here or anywhere, finds it resolved; one removed meanwhile is a 404.
  if (cause.status === 404 || (cause.status === 409 && cause.tag === "AgentRequestResolved"))
    return { kind: "gone" };
  // Just after Mend restarts, a conversation reads live before Mend has it back.
  if (cause.status === 409 && cause.tag === "ProtocolSessionNotLive")
    return { kind: "transient", words: cause.message };
  return { kind: cause.status >= 500 ? "transient" : "refused", words: cause.message };
};

/**
 * Every answer this window sends, one request at a time. A send first re-reads the session's
 * pending requests: one no longer listed is gone and nothing is sent, so a toast still on screen
 * after it was answered elsewhere does no harm. Mend has no idempotency key, so a second send while
 * one runs joins it instead of posting again.
 */
export class Answers {
  readonly #states = new Map<string, AnswerState>();
  readonly #running = new Map<string, Promise<SendOutcome>>();

  constructor(private readonly effects: AnswerEffects) {}

  state(requestId: string): AnswerState {
    return this.#states.get(requestId) ?? { kind: "pending" };
  }

  send(
    request: Pick<RequestView, "id" | "sessionId">,
    response: AgentResponse,
  ): Promise<SendOutcome> {
    const running = this.#running.get(request.id);
    if (running !== undefined) return running;
    const state = this.state(request.id);
    if (state.kind === "answered" || state.kind === "gone") return Promise.resolve(state);
    const run = this.#send(request, response).finally(() => this.#running.delete(request.id));
    this.#running.set(request.id, run);
    return run;
  }

  async #send(
    request: Pick<RequestView, "id" | "sessionId">,
    response: AgentResponse,
  ): Promise<SendOutcome> {
    let listed: boolean;
    try {
      listed = (await this.effects.pending(request.sessionId)).some(
        (pending) => pending.id === request.id,
      );
    } catch (cause) {
      const failure = failureOf(cause);
      // Offline: nothing was sent and nothing is known, so the request stays as it was.
      if (failure.kind === "unreachable") return { kind: "unreachable" };
      return this.#settle(request.id, response, failure, cause);
    }
    if (!listed) return this.#set(request.id, { kind: "gone" });
    this.#states.set(request.id, { kind: "sending", response });
    try {
      await this.effects.respond(request.id, response);
    } catch (cause) {
      return this.#settle(request.id, response, failureOf(cause), cause);
    }
    return this.#set(request.id, { kind: "answered", response });
  }

  #settle(
    requestId: string,
    response: AgentResponse,
    failure: Failure,
    cause: unknown,
  ): SendOutcome {
    if (failure.kind === "gone") return this.#set(requestId, { kind: "gone" });
    return this.#set(requestId, {
      kind: "failed",
      response,
      words: failure.words,
      retryable: failure.kind !== "refused",
      cause,
    });
  }

  #set(requestId: string, state: Settled): Settled {
    this.#states.set(requestId, state);
    return state;
  }
}
