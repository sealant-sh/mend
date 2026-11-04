import { redact } from "./doctor-bundle.ts";
import { MendRequestError } from "./server-request.ts";
import { jsonWithoutCredentials } from "./shared.ts";

/** Recovery information an outside agent can pass to the person supervising it. */
export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
}

/** One observed prerequisite, including the next action when it is unfinished. */
export interface ReadinessItem {
  readonly id: string;
  readonly state: "ok" | "todo" | "failed";
  readonly detail: string;
  readonly fix: string | null;
}

/** Terminal command outcomes. Login progress events use the same version separately. */
export type CommandResult<T> =
  | { readonly status: "done"; readonly data: T }
  | {
      readonly status: "not_ready";
      readonly data: T;
      readonly items: ReadonlyArray<ReadinessItem>;
      readonly error: CommandError;
    }
  | { readonly status: "waiting"; readonly url: string; readonly error: CommandError }
  | { readonly status: "failed" | "usage" | "timeout"; readonly error: CommandError };

/** Published exit statuses for the agent command contract. */
export type CommandExitCode = 0 | 1 | 2 | 3 | 4 | 124;

/** Determine exit status from the outcome, rather than assigning it independently. */
export const commandExitCode = <T>(result: CommandResult<T>): CommandExitCode => {
  switch (result.status) {
    case "done":
      return 0;
    case "failed":
      return 1;
    case "usage":
      return 2;
    case "waiting":
      return 3;
    case "not_ready":
      return 4;
    case "timeout":
      return 124;
  }
};

/** Write one versioned JSON value. Callers provide allowlisted data, never credentials. */
export const writeCommandResult = <T>(
  result: CommandResult<T>,
  write: (text: string) => void,
): CommandExitCode => {
  writeCommandEvent(result, write);
  return commandExitCode(result);
};

export const writeCommandEvent = (event: object, write: (text: string) => void): void => {
  const value: unknown = JSON.parse(jsonWithoutCredentials({ v: 1, ...event }));
  write(
    `${JSON.stringify(value, (key, field: unknown) => {
      if (/(?:password|secret|token|credential|privateKey|apiKey)/i.test(key)) return "[redacted]";
      return typeof field === "string" ? redact(field) : field;
    })}\n`,
  );
};

/** A missing explicit answer is usage, even when stdin happens to be a terminal. */
export const needsInput = (message: string, fix: string): CommandResult<never> => ({
  status: "usage",
  error: { code: "needs_input", message, fix },
});

/** Readiness is complete only when every prerequisite was observed as ok. */
export const readinessResult = <T>(
  data: T,
  items: ReadonlyArray<ReadinessItem>,
): CommandResult<T> =>
  items.every((item) => item.state === "ok")
    ? { status: "done", data }
    : {
        status: "not_ready",
        data,
        items,
        error: {
          code: "not_ready",
          message: "Some prerequisites are unfinished.",
          fix: "Follow each item's fix, then run the command again.",
        },
      };

/** Translate request facts without printing response bodies or uploaded credentials. */
export const requestFailure = (error: unknown): CommandResult<never> => {
  if (error instanceof MendRequestError) {
    if (error.kind === "timeout")
      return {
        status: "timeout",
        error: {
          code: "timeout",
          message: "The server did not answer before the deadline.",
          fix: "Inspect the server state before retrying a write; the request may still complete.",
        },
      };
    if (error.status === 401)
      return {
        status: "failed",
        error: {
          code: "not_signed_in",
          message: "The server did not accept this CLI's sign-in.",
          fix: "Run mend login --url <server-url>.",
        },
      };
    return {
      status: "failed",
      error: {
        code:
          error.status === 403
            ? "forbidden"
            : error.kind === "http"
              ? "request_refused"
              : error.kind,
        message:
          error.kind === "http"
            ? `The server refused the request (HTTP ${error.status}).`
            : "The server did not return an answer.",
        fix: "Check the server URL and mend doctor --json; inspect state before retrying a write.",
      },
    };
  }
  return {
    status: "failed",
    error: {
      code: "command_failed",
      message: "The command could not complete.",
      fix: "Check the arguments and server status, then retry.",
    },
  };
};
