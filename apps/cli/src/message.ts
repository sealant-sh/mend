import { stripVTControlCharacters } from "node:util";

import { SessionMessageResult, TURN_DELIVERY_UNCONFIRMED } from "@mend/domain/workbench";
import { Schema } from "effect";

import { writeCommandResult, type CommandExitCode, type CommandResult } from "./command-result.ts";
import { failureWords } from "./failure-words.ts";
import { usageOf } from "./help.ts";
import { MendRequestError, neverConnected } from "./server-request.ts";
import { isFlag, redactCredentials } from "./shared.ts";

interface MessageArguments {
  readonly session: string;
  readonly text: string;
  readonly queue: boolean;
  readonly json: boolean;
  readonly resume: boolean;
}

type ParsedMessageArguments =
  | { readonly _tag: "Valid"; readonly value: MessageArguments }
  | { readonly _tag: "Invalid"; readonly message: string; readonly json: boolean };

const beforeSeparator = (args: ReadonlyArray<string>) => {
  const end = args.indexOf("--");
  return end === -1 ? args : args.slice(0, end);
};

export const parseMessageArguments = (args: ReadonlyArray<string>): ParsedMessageArguments => {
  const options = beforeSeparator(args);
  const json = options.includes("--json");
  for (const flag of ["--queue", "--json", "--resume"])
    if (options.indexOf(flag) !== options.lastIndexOf(flag))
      return { _tag: "Invalid", message: `${flag} given twice · ${usageOf("message")}`, json };
  const positional: Array<string> = [];
  let queue = false;
  let resume = false;
  let literal = false;
  for (const word of args) {
    if (literal) positional.push(word);
    else if (word === "--") literal = true;
    else if (word === "--queue") queue = true;
    else if (word === "--resume") resume = true;
    else if (word === "--json") continue;
    else if (isFlag(word))
      return {
        _tag: "Invalid",
        message: `unknown message option; use -- before text beginning with a dash · ${usageOf("message")}`,
        json,
      };
    else positional.push(word);
  }
  const [session, text] = positional;
  if (positional.length !== 2 || session === undefined || text === undefined || !/\S/.test(session))
    return { _tag: "Invalid", message: usageOf("message"), json };
  if (!/\S/.test(text))
    return {
      _tag: "Invalid",
      message: "message text must contain a non-whitespace character",
      json,
    };
  return { _tag: "Valid", value: { session, text, queue, json, resume } };
};

type MessageExitCode = CommandExitCode;

const outcomeUnconfirmed = (result: SessionMessageResult): boolean =>
  result._tag === "Turn"
    ? result.turn.status === "failed" && result.turn.error === TURN_DELIVERY_UNCONFIRMED
    : result.steer.delivery._tag === "Sending" || result.steer.delivery._tag === "Unknown";

const exitCodeOf = (result: SessionMessageResult): MessageExitCode => {
  if (result._tag === "Steer") {
    switch (result.steer.delivery._tag) {
      case "Accepted":
      case "Queued":
        return 0;
      case "NotSent":
        return 1;
      case "Sending":
      case "Unknown":
        return 1;
    }
  }
  switch (result.turn.status) {
    case "queued":
    case "running":
    case "completed":
      return 0;
    case "failed":
      return 1;
    case "cancelled":
    case "interrupted":
      return 1;
  }
};

const presentMessage = (
  result: SessionMessageResult,
): { readonly line: string; readonly exitCode: MessageExitCode } => {
  const target = result._tag === "Turn" ? result.turn : result.steer;
  const ids =
    result._tag === "Turn"
      ? `turn ${result.turn.id.slice(0, 8)}`
      : `steer ${result.steer.id.slice(0, 8)} · turn ${(result.steer.delivery._tag === "Queued" ? result.steer.delivery.turnId : result.steer.turnId).slice(0, 8)}`;
  return {
    line: `${result.explanation} · session ${target.sessionId.slice(0, 8)} · ${ids}`,
    exitCode: exitCodeOf(result),
  };
};

export interface MessageServer {
  readonly resolveSession: (word: string) => Promise<{ readonly id: string }>;
  readonly post: (
    route: string,
    body: {
      readonly input: string;
      readonly clientMessageId: string;
      readonly queue?: true;
      readonly resume?: true;
    },
  ) => Promise<unknown>;
}

export interface MessageBoundary {
  /** The server the CLI's config names; throws when the config cannot be read. */
  readonly connect: () => MessageServer;
  readonly readStdin: () => Promise<string>;
  readonly uuid: () => string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Layer 3's refusals for this route, whose sentences are fixed and never quote the request. */
const FIXED_SENTENCE_TAGS: ReadonlySet<string> = new Set([
  "SessionNotSteerable",
  "ProtocolSessionNotLive",
  "MessageKeyConflict",
  "MessageTargetAmbiguous",
  "TurnSteerForbidden",
]);

const printable = (text: string): string => redactCredentials(stripVTControlCharacters(text));

/**
 * The words of a failure: the CLI's own sentence, or the server's when its tag is one of layer 3's
 * fixed refusals, and `null` for any other body, which may quote the message.
 */
const ownWordsOf = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  if (error instanceof MendRequestError && error.refused !== null) {
    const tag = error.refused.tag;
    if (tag === null || !FIXED_SENTENCE_TAGS.has(tag)) return null;
  }
  return printable(error.message);
};

const unreadableRefusal = (error: unknown): boolean =>
  error instanceof MendRequestError && error.kind !== "http" && error.status !== null;

const refusalWordsOf = (error: unknown): string =>
  (unreadableRefusal(error) ? null : ownWordsOf(error)) ??
  (error instanceof MendRequestError
    ? failureWords(error.status ?? 0, { _tag: error.refused?.tag }).words
    : "Mend could not send this message.");

const isRefusal = (error: unknown): error is MendRequestError =>
  error instanceof MendRequestError &&
  error.status !== null &&
  error.status >= 400 &&
  error.status < 500;

export const messageCommand = async (
  args: ReadonlyArray<string>,
  boundary: MessageBoundary,
): Promise<MessageExitCode> => {
  const parsed = parseMessageArguments(args);
  const json = parsed._tag === "Valid" ? parsed.value.json : parsed.json;
  const fail = (
    tag: string,
    message: string,
    clientMessageId: string | null,
    code: 1 | 2 | 124,
  ) => {
    if (json) {
      const result: CommandResult<unknown> = {
        status: code === 2 ? "usage" : code === 124 ? "timeout" : "failed",
        data: { clientMessageId },
        error: {
          code: tag,
          message,
          fix:
            clientMessageId === null
              ? "Check the arguments and server, then retry."
              : "Read the session history before sending again. A new invocation sends a new message.",
        },
      };
      return writeCommandResult(result, boundary.stdout);
    } else
      boundary.stderr(
        `${message}${clientMessageId === null ? "" : ` · client message ${clientMessageId}`}\n`,
      );
    return code;
  };
  if (parsed._tag === "Invalid") return fail("InvalidMessageArguments", parsed.message, null, 2);
  const options = parsed.value;
  let server: MessageServer;
  try {
    server = boundary.connect();
  } catch (error) {
    return fail("CliConfigUnreadable", refusalWordsOf(error), null, 1);
  }
  let input: string;
  try {
    input = options.text === "-" ? await boundary.readStdin() : options.text;
  } catch {
    return fail("MessageStdinUnavailable", "could not read message text from stdin", null, 1);
  }
  if (!/\S/.test(input))
    return fail(
      "InvalidMessageArguments",
      "message text must contain a non-whitespace character",
      null,
      2,
    );
  let session: { readonly id: string };
  try {
    session = await server.resolveSession(options.session);
  } catch (error) {
    return fail("MessageSessionUnresolved", refusalWordsOf(error), null, 1);
  }
  const clientMessageId = boundary.uuid();
  const unconfirmed = (reason: string, code: 1 | 124 = 1) =>
    fail(
      "MessageOutcomeUnconfirmed",
      `Message outcome not confirmed · ${reason} · check the session before sending again`,
      clientMessageId,
      code,
    );
  let raw: unknown;
  try {
    raw = await server.post(`/sessions/${encodeURIComponent(session.id)}/messages`, {
      input,
      clientMessageId,
      ...(options.queue ? { queue: true } : {}),
      ...(options.resume ? { resume: true } : {}),
    });
  } catch (error) {
    if (isRefusal(error))
      return fail(
        error.refused?.tag ?? "MessageRefused",
        refusalWordsOf(error),
        clientMessageId,
        1,
      );
    if (error instanceof MendRequestError && neverConnected(error.cause))
      return fail("MessageNotSent", refusalWordsOf(error), null, 1);
    return unconfirmed(
      error instanceof MendRequestError && error.kind !== "unreachable"
        ? (ownWordsOf(error) ?? "the server or an edge in front of it answered with an error")
        : "this CLI could not read the server's answer",
      error instanceof MendRequestError && error.kind === "timeout" ? 124 : 1,
    );
  }
  const decoded = Schema.decodeUnknownResult(SessionMessageResult)(raw);
  if (decoded._tag === "Failure")
    return unconfirmed("this CLI could not read the server's receipt");
  const result = decoded.success;
  const presentation = presentMessage(result);
  const unsure = outcomeUnconfirmed(result);
  if (json) {
    const receipt =
      result._tag === "Turn"
        ? {
            _tag: result._tag,
            explanation: result.explanation,
            turn: {
              id: result.turn.id,
              sessionId: result.turn.sessionId,
              status: result.turn.status,
            },
          }
        : {
            _tag: result._tag,
            explanation: result.explanation,
            steer: {
              id: result.steer.id,
              sessionId: result.steer.sessionId,
              turnId: result.steer.turnId,
              delivery: result.steer.delivery,
            },
          };
    const data = { clientMessageId, result: receipt };
    return writeCommandResult(
      presentation.exitCode === 0
        ? { status: "done", data }
        : {
            status: "failed",
            data,
            error: {
              code: unsure ? "MessageOutcomeUnconfirmed" : "MessageNotDelivered",
              message: unsure
                ? "Message delivery is not confirmed."
                : "The message did not complete.",
              fix: "Read the session history before sending again. A new invocation sends a new message.",
            },
          },
      boundary.stdout,
    );
  } else {
    boundary.stdout(`${printable(presentation.line)}\n`);
    if (unsure)
      boundary.stderr(
        `client message ${clientMessageId} · check the session before sending again\n`,
      );
  }
  return presentation.exitCode;
};
