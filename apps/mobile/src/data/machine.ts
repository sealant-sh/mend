import { failureLogLine, failureWords } from "@/data/failure-words";

/**
 * The server answered and said no (or did not answer: status 0). `message` is what a person reads
 * (`failureWords`): the server's own sentence when it gave one, else words for its tag or status.
 * The call and the status stay in the log.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The refusal's `_tag`, when the body carried one: for code that branches on it. */
    readonly tag: string | null = null,
    /** True when `message` is the server's own sentence; false for words Mend chose. */
    readonly serverWords: boolean = false,
  ) {
    super(message);
  }
}

/** A refusal as an `ApiError` in words, its call, status and tag logged. */
export const refusal = (method: string, route: string, status: number, body: unknown): ApiError => {
  console.warn(failureLogLine(`${method} ${route}`, status, body));
  const failure = failureWords(status, body);
  return new ApiError(failure.words, status, failure.tag, failure.serverWords !== null);
};
