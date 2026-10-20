import type { PendingRequest } from "./client.js";
import { requestView } from "./request-answer.js";
import type { WaitFact } from "./session-model.js";

/**
 * Pending requests as Mend lists them, for unit tests. The default is Claude asking to run a
 * command with Bash, which the toast says as `run pnpm db:migrate?`.
 */
export const pendingRequest = (overrides: Partial<PendingRequest> = {}): PendingRequest => ({
  id: "r1",
  sessionId: "s",
  processId: "agent",
  turnId: "t1",
  kind: "tool-permission",
  title: "Bash",
  detail: {
    toolName: "Bash",
    input: { command: "pnpm db:migrate", description: "Apply the migrations" },
    suggestions: [],
  },
  questions: null,
  status: "pending",
  decision: null,
  answers: null,
  createdAt: "2026-10-19T08:59:00.000Z",
  ...overrides,
});

/** The wait a conversation's request makes, as the store reads it. */
export const requestWait = (
  request: PendingRequest = pendingRequest(),
  answerer: string | null = null,
): WaitFact => {
  const view = requestView(request);
  return {
    via: "conversation",
    key: request.id,
    words: view.question,
    since: request.createdAt,
    request: view,
    answerer,
  };
};

/** Claude's AskUserQuestion: one single-select question with two options. */
export const whichDatabase = (overrides: Partial<PendingRequest> = {}): PendingRequest =>
  pendingRequest({
    kind: "user-input",
    title: "AskUserQuestion",
    detail: null,
    questions: [
      {
        id: "q1",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "The one in docker-compose" },
          { label: "SQLite", description: null },
        ],
        multiSelect: false,
      },
    ],
    ...overrides,
  });
