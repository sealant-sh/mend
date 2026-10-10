import { errorStatusByTag } from "@mend/api-contracts";
import { TRPCError } from "@trpc/server";
import { HttpClientError } from "effect/unstable/http";

import { NOT_DONE, type Refusal, refusalWords } from "./refusal-words.ts";

type TrpcCode = ConstructorParameters<typeof TRPCError>[0]["code"];

const codeForStatus = (status: number): TrpcCode => {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE_CONTENT";
    case 429:
      return "TOO_MANY_REQUESTS";
    default:
      return status < 500 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
  }
};

const hasTag = (error: unknown): error is Refusal =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string";

/**
 * The tag of a refusal the API declared, carried as the tRPC error's cause so the error formatter
 * can put it in `data.tag` (routers/trpc.ts) for the pages that branch on it. Never in a message.
 */
export class ApiRefusal extends Error {
  readonly tag: string;
  constructor(tag: string) {
    super(tag);
    this.name = "ApiRefusal";
    this.tag = tag;
  }
}

/**
 * One translation from an API-call failure to the tRPC wire. Contract errors carry their status
 * via the contract itself (errorStatusByTag) and cross in words (`refusalWords`), the tag logged
 * here and kept off the message. Transport failures (API process down) surface as a plain "not
 * answering", never the internal URL the client was dialing. An UNDECLARED response status keeps
 * its status so 401→login and friends still work; a DECLARED status whose body no longer decodes
 * is contract drift and stays a loud 500. Anything else is logged server-side and crosses as a
 * generic failure.
 */
export const toTRPCError = (error: unknown): TRPCError => {
  if (error instanceof TRPCError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (hasTag(error)) {
    const status = errorStatusByTag.get(error._tag);
    if (status !== undefined) {
      if (status >= 500) console.warn(`[trpc] api refused: ${error._tag}: ${message}`);
      return new TRPCError({
        code: codeForStatus(status),
        message: refusalWords(error),
        cause: new ApiRefusal(error._tag),
      });
    }
  }
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason._tag;
    if (reason === "TransportError" || reason === "InvalidUrlError" || reason === "EncodeError") {
      console.warn(`[trpc] api unreachable: ${reason}`);
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: API_UNREACHABLE });
    }
    if (reason === "StatusCodeError") {
      // A status the contract DECLARES arrived, but its body failed the
      // contract's decode — drift between tiers must stay loud.
      console.error("[trpc] contract drift decoding API response:", message);
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: API_DRIFT });
    }
    const responseStatus = error.response?.status;
    console.warn(`[trpc] api responded ${responseStatus ?? "with no status"}`);
    return new TRPCError({ code: codeForStatus(responseStatus ?? 502), message: NOT_DONE });
  }
  // Unmapped failure or defect: keep the detail on the server, not the wire.
  console.error("[trpc] unmapped failure:", error);
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: NOT_DONE });
};

/** The Mend server did not answer the web tier at all. */
export const API_UNREACHABLE = "The Mend server is not answering. Try again in a moment.";
/** The web tier and the server read this answer differently: two versions side by side. */
export const API_DRIFT =
  "The web app and the Mend server disagree about this answer. Reload; if it stays, they run different versions.";
