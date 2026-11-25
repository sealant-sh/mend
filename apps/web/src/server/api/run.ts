import { makeMendApiClient, type MendApiClient } from "@mend/api-contracts";
import { reportCause, telemetryLayer } from "@mend/telemetry";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, type Tracer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { isWebTierFailure, toTRPCError } from "./errors.ts";

/** Per-request API connection and caller provenance for the tRPC transport. */
export interface TrpcContext {
  /** Cookie, authorization and Origin are forwarded together to the API. */
  readonly headers: Headers;
  readonly apiUrl: string;
  /**
   * The procedure this call belongs to (`routers/trpc.ts`): its span, which the API calls it makes
   * are children of, and its path, which names a failure it reports.
   */
  readonly procedure?: { readonly span: Tracer.Span; readonly path: string };
}

const version = process.env["MEND_VERSION"]?.trim() ?? "";

/**
 * One fetch-backed runtime for every request; clients are per-request wiring only. With
 * `SENTRY_DSN` it exports the web tier's spans and reports its errors as part of Mend's server
 * (`@mend/telemetry`, the release the API names); without, it adds nothing and sends nothing.
 */
const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    FetchHttpClient.layer,
    telemetryLayer({
      name: "mend-web",
      release: version === "" || version === "dev" ? undefined : `mend-server@${version}`,
    }),
  ),
);

// On a stop, the runtime goes: the exporters send what they hold (2 s at most) and their timers
// end, so nitro's own graceful stop can let the process exit. Left running, they would hold it
// open after nitro closed its server.
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void runtime.dispose());

/** Only Sentry's own `baggage` entries go on: the rest is the browser's, not the API's business. */
const sentryBaggage = (baggage: string): string =>
  baggage
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("sentry-"))
    .join(",");

/**
 * Never detach browser credentials from their Origin, or infer trust from Host. The trace goes on
 * too: `traceparent` is the procedure's own span's (Effect's client sets it on every request),
 * and the caller's `tracestate` and `sentry-*` baggage ride beside it.
 */
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
  const tracestate = headers.get("tracestate");
  if (tracestate !== null) forwarded["tracestate"] = tracestate;
  const baggage = sentryBaggage(headers.get("baggage") ?? "");
  if (baggage !== "") forwarded["baggage"] = baggage;
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
 * in one request. createContext makes one headers object per request (each
 * procedure's ctx is a copy carrying its own span), so the headers are the
 * key; construction is pure wiring, so runSync is safe.
 */
const clients = new WeakMap<Headers, MendApiClient>();
const clientOf = (ctx: TrpcContext): MendApiClient => {
  const cached = clients.get(ctx.headers);
  if (cached !== undefined) return cached;
  const client = runtime.runSync(apiClientFor(ctx));
  clients.set(ctx.headers, client);
  return client;
};

/** The runtime's tracer and clock, for the procedure spans `routers/trpc.ts` opens and ends. */
export const runSync = <A>(effect: Effect.Effect<A>): A => runtime.runSync(effect);

/**
 * Run one procedure body against the derived client. Failures the body did
 * not handle itself (outcome unions catch their own tags) become TRPCErrors
 * with the status the contract declares for them. A failure that is the web
 * tier's own (the API unreachable, drift, a defect) is reported first, with
 * its whole cause, in the procedure's trace.
 */
export const run = async <A, E>(
  ctx: TrpcContext,
  call: (api: MendApiClient) => Effect.Effect<A, E>,
): Promise<A> => {
  const span = ctx.procedure?.span;
  const effect = call(clientOf(ctx));
  const exit = await runtime.runPromiseExit(
    span === undefined ? effect : Effect.withParentSpan(effect, span),
  );
  if (Exit.isSuccess(exit)) {
    // The client decodes into Schema.Class INSTANCES; superjson only walks
    // plain data, so Dates/bigints inside instances would dodge the
    // transformer and break JSON serialization. structuredClone flattens the
    // prototypes while keeping Dates and bigints as themselves.
    return exit.value === undefined ? exit.value : structuredClone(exit.value);
  }
  const failure = Cause.findErrorOption(exit.cause);
  const error = Option.isSome(failure) ? failure.value : Cause.squash(exit.cause);
  if (Cause.hasDies(exit.cause) || isWebTierFailure(error)) {
    const report = reportCause(exit.cause, {
      operation: "mend.web.trpc",
      tags: ctx.procedure === undefined ? undefined : { "trpc.path": ctx.procedure.path },
    });
    runtime.runSync(span === undefined ? report : Effect.withParentSpan(report, span));
  }
  throw toTRPCError(error, ctx.apiUrl);
};
