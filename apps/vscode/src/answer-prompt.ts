import * as vscode from "vscode";

import { showErrorToast } from "./error-toast.js";
import {
  DECISIONS,
  type AgentResponse,
  type Answers,
  type RequestView,
  type ToastChoice,
} from "./request-answer.js";
import type { SessionView } from "./session-model.js";
import type { SessionStore } from "./session-store.js";

/** The last item of a question's quick pick: an input box for an answer of her own. */
export const WRITE_AN_ANSWER = "Write an answer…";

/** What the input box says while it is empty: Enter would send nothing. */
export const EMPTY_ANSWER = "Write an answer, or press Escape to send nothing";

const STATUS_MS = 5_000;

interface ChoicePick extends vscode.QuickPickItem {
  /** The option this item picks; null for `Write an answer…`. */
  readonly choice: string | null;
}

/**
 * The quick pick a conversation's request opens (More…, Answer…, the row's Answer): the three
 * decisions, or one pick per question with its options and a typed answer. Escape anywhere sends
 * nothing.
 */
const pickResponse = async (
  name: string,
  request: RequestView,
): Promise<AgentResponse | undefined> => {
  const title = `${name} asks: ${request.question}`;
  switch (request.ask.kind) {
    case "decision": {
      const picked = await vscode.window.showQuickPick(
        DECISIONS.map(({ label, response }) => ({ label, response })),
        { title, ignoreFocusOut: true },
      );
      return picked?.response;
    }
    case "answers": {
      const { questions } = request.ask;
      const answers: Record<string, ReadonlyArray<string>> = {};
      for (const [index, question] of questions.entries()) {
        const stepTitle =
          questions.length > 1 ? `${title} (${index + 1}/${questions.length})` : title;
        const items: ReadonlyArray<ChoicePick> = [
          ...question.options.map(
            (option): ChoicePick => ({
              label: option.label,
              ...(option.description === null ? {} : { description: option.description }),
              choice: option.label,
            }),
          ),
          { label: WRITE_AN_ANSWER, choice: null },
        ];
        const options = { title: stepTitle, placeHolder: question.question, ignoreFocusOut: true };
        const picked = question.multiSelect
          ? await vscode.window.showQuickPick(items, { ...options, canPickMany: true })
          : await vscode.window
              .showQuickPick(items, options)
              .then((one) => (one === undefined ? undefined : [one]));
        if (picked === undefined) return undefined;
        const choices = picked.flatMap((item) => (item.choice === null ? [] : [item.choice]));
        let typed: string | undefined;
        if (picked.some((item) => item.choice === null)) {
          typed = await vscode.window.showInputBox({
            title: stepTitle,
            prompt: question.question,
            ignoreFocusOut: true,
            validateInput: (value) => (value.trim() === "" ? EMPTY_ANSWER : null),
          });
          if (typed === undefined) return undefined;
        }
        // Trimmed only to tell a blank answer: what she typed is sent as typed.
        if (typed === undefined || typed.trim() === "") {
          if (choices.length === 0) return undefined;
          answers[question.id] = choices;
        } else answers[question.id] = question.multiSelect ? [...choices, typed] : [typed];
      }
      return { answers };
    }
    case "unanswerable":
      vscode.window.setStatusBarMessage(
        `${name} · the agent did not include a question · stop and resume the session`,
        STATUS_MS,
      );
      return undefined;
  }
};

/**
 * The request a row's Answer answers in the quick pick (rule 8); null for a terminal agent, whose
 * Answer attaches its terminal.
 */
export const requestToAnswer = (
  view: Pick<SessionView, "needsYou" | "wait"> | undefined,
): RequestView | null =>
  view?.needsYou === true && view.wait?.via === "conversation" ? view.wait.request : null;

/**
 * What her gestures at a conversation's request do: a toast button sends its answer or opens the
 * quick pick, and every answer goes through `Answers`. Whatever the answer found, she is told once:
 * nothing more for an answer taken, the session's current line for a request already answered,
 * `Mend is offline` when Mend was not reached, and an error toast for a refusal or a failed send.
 */
export class RequestPrompts {
  /** One quick pick per request: a second gesture while it shows joins it. */
  readonly #asking = new Map<string, Promise<void>>();

  constructor(
    private readonly answers: Pick<Answers, "send">,
    private readonly store: Pick<SessionStore, "reread"> & {
      model(): {
        readonly sessions: ReadonlyMap<string, Pick<SessionView, "name" | "line">>;
      } | null;
    },
  ) {}

  /** A toast button she clicked. */
  async chose(request: RequestView, name: string, choice: ToastChoice): Promise<void> {
    if (choice.kind === "send") await this.send(request, name, choice.response);
    else await this.answer(request, name);
  }

  /** The quick pick for the request, then the answer it gives. */
  answer(request: RequestView, name: string): Promise<void> {
    const running = this.#asking.get(request.id);
    if (running !== undefined) return running;
    const run = (async () => {
      const response = await pickResponse(name, request);
      if (response !== undefined) await this.send(request, name, response);
    })().finally(() => this.#asking.delete(request.id));
    this.#asking.set(request.id, run);
    return run;
  }

  async send(request: RequestView, name: string, response: AgentResponse): Promise<void> {
    const outcome = await this.answers.send(request, response);
    switch (outcome.kind) {
      case "answered":
        void this.store.reread(request.sessionId);
        return;
      case "gone": {
        await this.store.reread(request.sessionId);
        const now = this.store.model()?.sessions.get(request.sessionId);
        if (now !== undefined)
          vscode.window.setStatusBarMessage(`${now.name} · ${now.line}`, STATUS_MS);
        return;
      }
      case "unreachable":
        vscode.window.setStatusBarMessage("Mend is offline", STATUS_MS);
        return;
      case "failed": {
        const retry = await showErrorToast(
          outcome.cause,
          `Mend did not send your answer to ${name} · ${outcome.words}`,
          outcome.retryable ? "Retry" : undefined,
        );
        if (retry) await this.send(request, name, outcome.response);
        return;
      }
    }
  }
}
