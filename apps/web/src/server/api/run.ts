import { makeMendApiClient, type MendApiClient } from "@mend/api-contracts";
import { Cause, Effect, Exit, ManagedRuntime, Option } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { toTRPCError } from "./errors.ts";

/** Per-request API connection and caller provenance for the tRPC transport. */
export interface TrpcContext {
  /** Cookie, authorization and Origin are forwarded together to the API. */
  readonly headers: Headers;
  readonly apiUrl: string;
}

/** One fetch-backed runtime for every request; clients are per-request wiring only. */
const runtime = ManagedRuntime.make(FetchHttpClient.layer);

/** Never detach browser credentials from their Origin, or infer trust from Host. */
const credentialHeaders = (headers: Headers): Record<string, string> => {
  const forwarded: Record<string, string> = {};
  const cookie = headers.get("cookie");
  const authorization = headers.get("authorization");
  const origin = headers.get("origin");
  if (cookie !== null) forwarded["cookie"] = cookie;
  if (authorization !== null) forwarded["authorization"] = authorization;
  if (origin !== null) forwarded["origin"] = origin;
  // The chain the front proxy appended to (`proxy-headers.ts`) rides along, so the API counts this
  // call against the browser it was made for and not against the web tier. The API believes only
  // the entries its trusted hops appended (`clientAddressOf`), so this grants nothing.
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null) forwarded["x-forwarded-for"] = forwardedFor;
  return forwarded;
};

/** The contract-derived client, bound to this request's credentials. */
export const apiClientFor = (
  ctx: TrpcContext,
): Effect.Effect<MendApiClient, never, HttpClient.HttpClient> =>
  makeMendApiClient({
    baseUrl: ctx.apiUrl,
    transformClient: (client) =>
      HttpClient.mapRequest(client, HttpClientRequest.setHeaders(credentialHeaders(ctx.headers))),
  });

/**
 * One derived client per REQUEST, not per procedure: HttpApiClient.make walks
 * the whole contract eagerly (~4ms), and httpBatchLink puts many procedures
 * in one request. createContext makes one ctx object per request, so its
 * identity is the cache key; construction is pure wiring, so runSync is safe.
 */
const clients = new WeakMap<TrpcContext, MendApiClient>();
const clientOf = (ctx: TrpcContext): MendApiClient => {
  const cached = clients.get(ctx);
  if (cached !== undefined) return cached;
  const client = runtime.runSync(apiClientFor(ctx));
  clients.set(ctx, client);
  return client;
};

/**
 * Run one procedure body against the derived client. Failures the body did
 * not handle itself (outcome unions catch their own tags) become TRPCErrors
 * with the status the contract declares for them.
 */
export const run = async <A, E>(
  ctx: TrpcContext,
  use: (api: MendApiClient) => Effect.Effect<A, E>,
): Promise<A> => {
  const exit = await runtime.runPromiseExit(use(clientOf(ctx)));
  if (Exit.isSuccess(exit)) {
    // The client decodes into Schema.Class INSTANCES; superjson only walks
    // plain data, so Dates/bigints inside instances would dodge the
    // transformer and break JSON serialization. structuredClone flattens the
    // prototypes while keeping Dates and bigints as themselves.
    return exit.value === undefined ? exit.value : structuredClone(exit.value);
  }
  const failure = Cause.findErrorOption(exit.cause);
  throw toTRPCError(Option.isSome(failure) ? failure.value : Cause.squash(exit.cause));
};
