import { redact } from "./doctor-bundle.ts";
import { failureWords } from "./failure-words.ts";
import { MendRequestError } from "./server-request.ts";
import { jsonWithoutCredentials } from "./shared.ts";

/** Recovery information an outside agent can pass to the person supervising it. */
export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
}

export class CommandInputError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.name = "CommandInputError";
    this.code = code;
    this.fix = fix;
  }
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
  | {
      readonly status: "waiting";
      readonly url: string;
      readonly data?: T;
      readonly error: CommandError;
    }
  | {
      readonly status: "failed" | "usage" | "timeout";
      readonly data?: T;
      readonly error: CommandError;
    };

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

const gitRecovery = (message: string): string => {
  if (/could not resolve|name resolution|resolve hostname/i.test(message))
    return "Check DNS on the Mend server, then retry the Git operation.";
  if (
    /timed? out|timeout|connection refused|connection reset|network is unreachable/i.test(message)
  )
    return "Check the Mend server's network route to the Git host and retry after the connection or timeout is resolved.";
  if (
    /publickey|authentication failed|credential|not authorized|access denied|repository not found/i.test(
      message,
    )
  )
    return "Check the origin URL and access. For SSH, ask the person before adding Mend's public deploy key; for HTTPS, use the Git access method the server names.";
  return "Check the origin URL and the reported Git failure, then retry; a deploy key only helps an authentication failure.";
};

/** HTTP refusals expose their display sentence and stable tag, never the rest of the body. */
export const httpFailure = (status: number, body: unknown, call = ""): CommandResult<never> => {
  const described = failureWords(status, body);
  const credentialWrite =
    /\/(?:me\/sealant\/accounts|auth\/sign-up|me\/devices|operator\/password-resets|cli\/auth\/token)/.test(
      call,
    );
  const failure =
    credentialWrite || described.tag === null
      ? failureWords(status, described.tag === null ? null : { _tag: described.tag })
      : described;
  const message = failure.words;
  let code =
    failure.tag ??
    (status === 401 ? "not_signed_in" : status === 403 ? "forbidden" : "request_refused");
  let fix =
    "Follow the reported cause, check the command's arguments, and inspect state before retrying a write.";
  if (status === 401) fix = "Run mend login --url <server-url> --json.";
  else if (status === 403)
    fix = "Sign in with an account allowed to perform this operation, or ask the owner for access.";
  else if (/A project named .+ already exists/i.test(message)) {
    code = "project_name_taken";
    fix =
      "Use the existing project from mend projects, or pass --name <unused-name> to mend adopt --json.";
  } else if (failure.tag === "SourceRefused") {
    fix =
      "Check the repository source URL and the instance's allowed source policy with the operator.";
  } else if (
    failure.tag === "StoreFailure" &&
    call.endsWith("POST /projects") &&
    /clone|origin|remote|repository|publickey|authentication|resolve host/i.test(message)
  ) {
    code = "clone_failed";
    fix = gitRecovery(message);
  } else if (failure.tag === "StoreFailure" && /project name/i.test(message)) {
    fix = "Pass --name <lowercase-name> using letters, digits, dots, underscores or hyphens.";
  } else if (failure.tag === "ProtocolSessionNotLive" || failure.tag === "SessionNotLive") {
    fix = "Resume the conversation with mend message <session> <text> --resume --json.";
  } else if (failure.tag === "AgentRequestResolved") {
    fix =
      "Read mend history <session> --json for the recorded answer; do not send another response.";
  } else if (failure.tag === "NotFound" || status === 404) {
    fix = "Check the project, session or request id; list the current objects before retrying.";
  } else if (status === 429) {
    fix = "Wait for the server's rate limit to clear, then retry.";
  }
  if (credentialWrite && call.includes("/me/sealant/accounts"))
    fix =
      "Run mend connect status --json. Check the credential source privately, then reconnect the provider without printing its credential.";
  return { status: "failed", error: { code, message, fix } };
};

export const responseRefusal = async (
  response: Response,
  call: string,
): Promise<MendRequestError> => {
  const body: unknown = await response.json().catch(() => null);
  const failure = failureWords(response.status, body);
  return new MendRequestError("http", failure.words, response.status, {
    call,
    tag: failure.tag,
    body,
  });
};

/** Translate request facts without printing response bodies or uploaded credentials. */
export const requestFailure = (error: unknown): CommandResult<never> => {
  if (error instanceof CommandInputError)
    return { status: "usage", error: { code: error.code, message: error.message, fix: error.fix } };
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
    if (error.kind === "http")
      return httpFailure(
        error.status ?? 0,
        error.refused?.body ??
          (error.refused?.tag === null || error.refused?.tag === undefined
            ? null
            : { _tag: error.refused.tag }),
        error.refused?.call,
      );
    return {
      status: "failed",
      error: {
        code: error.kind,
        message: "The server did not return an answer.",
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
