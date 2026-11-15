import { errorStatusByTag, MendApi, ServiceSetupFailed } from "@mend/api-contracts";
import { SetupStepFailure } from "@mend/domain/workbench";
import { TRPCError } from "@trpc/server";
import { Schema } from "effect";
import { FindMyWay, HttpClientError, type HttpClientRequest, type HttpRouter } from "effect/http";
import { HttpApi } from "effect/http-api";

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

const isRoutePath = (path: string): path is HttpRouter.PathInput => path.startsWith("/");

const operations = FindMyWay.make<string>();
HttpApi.reflect(MendApi, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint }) => {
    if (isRoutePath(endpoint.path))
      operations.on(endpoint.method, endpoint.path, `${group.identifier}.${endpoint.identifier}`);
  },
});

const operationOf = (request: HttpClientRequest.HttpClientRequest, apiUrl: string): string => {
  const base = URL.parse(apiUrl)?.pathname.replace(/\/+$/, "") ?? "";
  const path = URL.parse(request.url)?.pathname ?? "";
  const routed = base !== "" && path.startsWith(`${base}/`) ? path.slice(base.length) : path;
  return operations.find(request.method, routed)?.handler ?? "unknown operation";
};

const hasTag = (error: unknown): error is Refusal =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string";

/** A Service's `[setup]` step that did not finish (`ServiceSetupFailed`), as JSON carries it. */
export type SetupFailureData = typeof SetupStepFailure.Encoded;

/**
 * The tag of a refusal the API declared, carried as the tRPC error's cause so the error formatter
 * can put it in `data.tag` (routers/trpc.ts) for the pages that branch on it. Never in a message.
 * The facts of the two refusals a page lays out from data ride beside it, so the page never reads
 * them back out of the words.
 */
export class ApiRefusal extends Error {
  readonly tag: string;
  /** A refused removal's blockers (`RemovalRefused`). Null for every other refusal. */
  readonly removal: unknown;
  /** The setup step that did not finish (`ServiceSetupFailed`). Null for every other refusal. */
  readonly setup: SetupFailureData | null;
  constructor(tag: string, removal: unknown = null, setup: SetupFailureData | null = null) {
    super(tag);
    this.name = "ApiRefusal";
    this.tag = tag;
    this.removal = removal;
    this.setup = setup;
  }
}

const removalOf = (refusal: Refusal): unknown =>
  refusal._tag === "RemovalRefused"
    ? {
        scope: refusal["scope"],
        blockers: refusal["blockers"],
        forceWouldLift: refusal["forceWouldLift"],
      }
    : null;

const encodeSetup = Schema.encodeSync(SetupStepFailure);

const setupOf = (refusal: Refusal): SetupFailureData | null =>
  refusal instanceof ServiceSetupFailed ? encodeSetup(refusal.setup) : null;

/**
 * One translation from an API-call failure to the tRPC wire. Contract errors carry their status
 * via the contract itself (errorStatusByTag) and cross in words (`refusalWords`), the tag logged
 * here and kept off the message. Transport failures (API process down) surface as a plain "not
 * answering", never the internal URL the client was dialing. An UNDECLARED response status keeps
 * its status so 401→login and friends still work; a DECLARED status whose body no longer decodes
 * is contract drift and stays a loud 500. Anything else is logged server-side and crosses as a
 * generic failure.
 */
export const toTRPCError = (error: unknown, apiUrl = ""): TRPCError => {
  if (error instanceof TRPCError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (hasTag(error)) {
    const status = errorStatusByTag.get(error._tag);
    if (status !== undefined) {
      if (status >= 500) console.warn(`[trpc] api refused: ${error._tag}: ${message}`);
      return new TRPCError({
        code: codeForStatus(status),
        message: refusalWords(error),
        cause: new ApiRefusal(error._tag, removalOf(error), setupOf(error)),
      });
    }
  }
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason._tag;
    const operation = operationOf(error.request, apiUrl);
    if (reason === "TransportError" || reason === "InvalidUrlError" || reason === "EncodeError") {
      console.warn(`[trpc] api unreachable: ${operation} ${reason}`);
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: API_UNREACHABLE });
    }
    const responseStatus = error.response?.status;
    if (reason === "StatusCodeError") {
      // A status the contract DECLARES arrived, but its body failed the
      // contract's decode — drift between tiers must stay loud.
      console.error(
        `[trpc] contract drift decoding API response: ${operation} ${reason} ${responseStatus}`,
      );
      return new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: API_DRIFT });
    }
    console.warn(`[trpc] api responded ${responseStatus ?? "with no status"}: ${operation}`);
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
