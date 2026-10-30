import { TRPCClientError } from "@trpc/client";

/** For tests: a refusal as the web tier sends it, words for a person and the tag beside them. */
export const refusedWith = (tag: string | null, message: string) =>
  new TRPCClientError(message, {
    result: {
      error: {
        message,
        code: -32022,
        data: { code: "UNPROCESSABLE_CONTENT", httpStatus: 422, path: "x", tag },
      },
    },
  });

/** For tests: a refused removal as the web tier sends it, with its blockers beside the words. */
export const refusedRemoval = (message: string, removal: unknown) =>
  new TRPCClientError(message, {
    result: {
      error: {
        message,
        code: -32009,
        data: { code: "CONFLICT", httpStatus: 409, path: "x", tag: "RemovalRefused", removal },
      },
    },
  });
