import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { McpSchema } from "effect/ai";

/** Messages never include a remote response body, URL query or credential. */
export class ExecutorFailure extends Schema.TaggedError<ExecutorFailure>()("ExecutorFailure", {
  kind: Schema.Literals(["refused", "unavailable", "invalid"]),
  message: Schema.String,
}) {}

export const ExecutorRegistration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.RedactedFromValue(Schema.String),
});
export type ExecutorRegistration = typeof ExecutorRegistration.Type;
export const ExecutorGrant = Schema.Struct({
  accessToken: Schema.RedactedFromValue(Schema.String),
  refreshToken: Schema.RedactedFromValue(Schema.String),
  expiresAt: Schema.Number,
  subject: Schema.String,
});
export type ExecutorGrant = typeof ExecutorGrant.Type;
export const ExecutorCredentials = Schema.Struct({
  registration: ExecutorRegistration,
  tool: ExecutorGrant,
  service: ExecutorGrant,
});
export type ExecutorCredentials = typeof ExecutorCredentials.Type;
export type ExecutorGrantKind = "tool" | "service";
export const executorResource = (origin: string, kind: ExecutorGrantKind) =>
  origin + (kind === "tool" ? "/mcp" : "/api");

export class ExecutorTransport extends Context.Service<
  ExecutorTransport,
  {
    readonly register: (
      origin: string,
      callback: string,
    ) => Effect.Effect<ExecutorRegistration, ExecutorFailure>;
    readonly grant: (
      origin: string,
      registration: ExecutorRegistration,
      kind: ExecutorGrantKind,
      input: Readonly<Record<string, string>>,
    ) => Effect.Effect<ExecutorGrant, ExecutorFailure>;
    readonly revoke: (
      origin: string,
      registration: ExecutorRegistration,
      grant: ExecutorGrant,
    ) => Effect.Effect<void, ExecutorFailure>;
    readonly mcp: (
      origin: string,
      grant: ExecutorGrant,
      method: "tools/list" | "tools/call",
      params: unknown,
    ) => Effect.Effect<unknown, ExecutorFailure>;
  }
>()("@mend/sessions/ExecutorTransport") {}

const rejected = (message: string) => new ExecutorFailure({ kind: "refused", message });
const invalid = () =>
  new ExecutorFailure({
    kind: "invalid",
    message: "Executor returned an unreadable answer. Link again if this continues.",
  });
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
});
const Claims = Schema.Struct({
  active: Schema.Literal(true),
  sub: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  scope: Schema.String,
});
const Reply = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});

const form = (fields: Readonly<Record<string, string>>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});
const bearer = (grant: ExecutorGrant) => ({
  Authorization: `Bearer ${Redacted.value(grant.accessToken)}`,
});

/** Every request stays on the configured origin; credentials never follow redirects. */
export const ExecutorTransportLive: Layer.Layer<ExecutorTransport> = Layer.succeed(
  ExecutorTransport,
  (() => {
    const request = (url: string, options: RequestInit = {}, ms = 20_000) =>
      Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            ...options,
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
          });
          if (!response.ok) throw { status: response.status };
          const text = await response.text();
          if (text.length > 16 * 1024 * 1024) throw new Error("response limit");
          return { text, headers: response.headers };
        },
        catch: (cause) =>
          typeof cause === "object" &&
          cause !== null &&
          "status" in cause &&
          typeof cause.status === "number"
            ? new ExecutorFailure({
                kind: cause.status === 401 || cause.status === 403 ? "refused" : "unavailable",
                message: `Executor refused the request · HTTP ${cause.status} · observed`,
              })
            : new ExecutorFailure({
                kind: "unavailable",
                message: "Executor did not answer · observed",
              }),
      });
    const json = (text: string) => Effect.try({ try: () => JSON.parse(text), catch: invalid });
    return {
      register: (origin, callback) =>
        request(origin + "/api/auth/oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "Mend",
            application_type: new URL(callback).protocol === "http:" ? "native" : "web",
            redirect_uris: [callback],
            token_endpoint_auth_method: "client_secret_post",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
          }),
        }).pipe(
          Effect.flatMap((r) => json(r.text)),
          Effect.flatMap((value) => decode(ExecutorRegistration, value)),
        ),
      grant: (origin, registration, kind, input) =>
        Effect.gen(function* () {
          const response = yield* request(
            origin + "/api/auth/oauth2/token",
            form({
              ...input,
              client_id: registration.client_id,
              client_secret: Redacted.value(registration.client_secret),
              resource: executorResource(origin, kind),
            }),
          );
          const token = yield* decode(Token, yield* json(response.text));
          // Executor v2 issues opaque tokens. Its authenticated RFC 7662 endpoint supplies
          // the subject and audience for comparing the two consents, never for Mend sign-in.
          const introspected = yield* request(
            origin + "/api/auth/oauth2/introspect",
            form({
              client_id: registration.client_id,
              client_secret: Redacted.value(registration.client_secret),
              token: token.access_token,
              token_type_hint: "access_token",
            }),
          );
          const claims = yield* decode(Claims, yield* json(introspected.text));
          const resource = executorResource(origin, kind);
          const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
          if (
            !audiences.includes(resource) ||
            !claims.scope.split(" ").includes(kind === "tool" ? "mcp" : "executor") ||
            !claims.sub ||
            token.expires_in <= 0
          )
            return yield* invalid();
          return {
            accessToken: Redacted.make(token.access_token),
            refreshToken: Redacted.make(token.refresh_token),
            expiresAt: Date.now() + Math.min(token.expires_in, 3600) * 1000,
            subject: claims.sub,
          };
        }),
      revoke: (origin, registration, grant) =>
        Effect.gen(function* () {
          for (const [token, token_type_hint] of [
            [grant.accessToken, "access_token"],
            [grant.refreshToken, "refresh_token"],
          ] as const) {
            yield* request(
              origin + "/api/auth/oauth2/revoke",
              form({
                client_id: registration.client_id,
                client_secret: Redacted.value(registration.client_secret),
                token: Redacted.value(token),
                token_type_hint,
              }),
            );
          }
        }),
      mcp: (origin, grant, method, params) =>
        Effect.gen(function* () {
          const headers: Record<string, string> = {
            ...bearer(grant),
            "content-type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-03-26",
          };
          const rpc = (id: number | undefined, rpcMethod: string, rpcParams?: unknown) =>
            request(
              origin + "/mcp",
              {
                method: "POST",
                headers,
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  ...(id === undefined ? {} : { id }),
                  method: rpcMethod,
                  params: rpcParams,
                }),
              },
              100_000,
            );
          const answer = (text: string, id: number) =>
            Effect.gen(function* () {
              const messages = text.trim().startsWith("{")
                ? [text]
                : text
                    .split(/\r?\n\r?\n/)
                    .map((event) =>
                      event
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n"),
                    )
                    .filter(Boolean);
              for (const message of messages) {
                const decoded = yield* decode(Reply, yield* json(message));
                if (decoded.id !== id) continue;
                if (decoded.error !== undefined)
                  return yield* rejected("Executor refused this MCP request · observed");
                return decoded.result;
              }
              return yield* invalid();
            });
          const initialized = yield* rpc(1, "initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "mend", version: "1" },
          });
          yield* answer(initialized.text, 1);
          const session = initialized.headers.get("mcp-session-id");
          if (session !== null) headers["Mcp-Session-Id"] = session;
          return yield* Effect.gen(function* () {
            yield* rpc(undefined, "notifications/initialized");
            const result = yield* rpc(2, method, params);
            const value = yield* answer(result.text, 2);
            return method === "tools/call" ? yield* decode(McpSchema.CallToolResult, value) : value;
          }).pipe(
            Effect.ensuring(
              session === null
                ? Effect.void
                : request(origin + "/mcp", { method: "DELETE", headers }, 5000).pipe(Effect.ignore),
            ),
          );
        }),
    } satisfies ExecutorTransport["Service"];
  })(),
);
