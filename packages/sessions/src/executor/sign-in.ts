import { createHash, randomBytes } from "node:crypto";

import { Effect, Redacted, Schema } from "effect";
import { CookieJar } from "tough-cookie";

import { ExecutorFailure } from "./failure.ts";
import { executorAuthority, requestExecutor, type ExecutorTarget } from "./http.ts";
import {
  type ExecutorCredentials,
  type ExecutorGrantKind,
  type ExecutorTransport,
  executorResource,
} from "./transport.ts";

const invalid = () =>
  new ExecutorFailure({
    kind: "invalid",
    message: "Executor returned an unreadable sign-in answer · observed",
  });
const decode = <S extends Schema.Top>(schema: S, response: Response) =>
  Effect.tryPromise({ try: (): Promise<unknown> => response.json(), catch: invalid }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(invalid),
  );
const nonce = () => randomBytes(32).toString("base64url");

const requireStatus = (response: Response, status: number) =>
  response.status === status
    ? Effect.succeed(response)
    : Effect.fail(
        new ExecutorFailure({
          kind: response.status === 401 || response.status === 403 ? "refused" : "unavailable",
          message: `Executor refused sign-in · HTTP ${response.status} · observed`,
        }),
      );

/** A server-only cookie jar; redirects are validated individually and never reach a browser. */
export const executorSession = (target: ExecutorTarget) => {
  const jar = new CookieJar();
  const origin = executorAuthority(target);
  const request = (
    path: string,
    body?: Readonly<Record<string, unknown>>,
    extra: Readonly<Record<string, string>> = {},
  ) =>
    Effect.gen(function* () {
      const url = new URL(path, origin);
      const response = yield* requestExecutor(target, url.href, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...extra,
          Cookie: jar.getCookieStringSync(url.href),
          ...(body === undefined ? {} : { Origin: origin, "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url.href);
      return response;
    });
  const organization = () =>
    request("/api/auth/organization/list").pipe(
      Effect.flatMap((response) => requireStatus(response, 200)),
      Effect.flatMap((response) =>
        decode(Schema.Array(Schema.Struct({ id: Schema.String })), response),
      ),
      Effect.flatMap((rows) =>
        rows.length === 1 && rows[0] !== undefined
          ? Effect.succeed(rows[0].id)
          : Effect.fail(invalid()),
      ),
    );
  const grants = (
    transport: ExecutorTransport["Service"],
    organizationId: string,
    callback: string,
  ): Effect.Effect<ExecutorCredentials, ExecutorFailure> =>
    Effect.gen(function* () {
      const registration = yield* transport.register(target, callback);
      const grant = (kind: ExecutorGrantKind) =>
        Effect.gen(function* () {
          const state = nonce();
          const verifier = nonce();
          const authorization = new URL(origin + "/api/auth/oauth2/authorize");
          authorization.search = new URLSearchParams({
            response_type: "code",
            client_id: registration.client_id,
            redirect_uri: callback,
            scope: kind === "tool" ? "mcp offline_access" : "executor offline_access",
            resource: executorResource(target, kind),
            state,
            code_challenge: createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
          }).toString();
          const answer = yield* request(authorization.href, undefined, { Accept: "text/html" });
          yield* requireStatus(answer, 302);
          const location = answer.headers.get("location");
          if (location === null) return yield* invalid();
          const consent = new URL(location, origin);
          if (consent.origin !== origin || consent.pathname !== "/mcp/authorize")
            return yield* invalid();
          const accepted = yield* request(
            "/api/auth/oauth2/consent",
            { accept: true, oauth_query: consent.search.slice(1) },
            { "X-Executor-Organization": organizationId },
          );
          yield* requireStatus(accepted, 200);
          const result = yield* decode(Schema.Struct({ url: Schema.String }), accepted);
          const returned = new URL(result.url);
          const code = returned.searchParams.get("code");
          if (
            returned.origin + returned.pathname !== callback ||
            returned.searchParams.get("state") !== state ||
            !code
          )
            return yield* invalid();
          return yield* transport.grant(target, registration, kind, {
            grant_type: "authorization_code",
            redirect_uri: callback,
            code,
            code_verifier: verifier,
          });
        });
      const tool = yield* grant("tool");
      const service = yield* grant("service").pipe(
        Effect.tapError(() => transport.revoke(target, registration, tool).pipe(Effect.ignore)),
      );
      if (tool.subject !== service.subject) {
        yield* transport.revoke(target, registration, tool).pipe(Effect.ignore);
        yield* transport.revoke(target, registration, service).pipe(Effect.ignore);
        return yield* invalid();
      }
      return { registration, tool, service };
    });
  return { request, requireStatus, organization, grants };
};

/** Setup is once-only; a retry signs Mend's member in with its original sealed credentials. */
export const signInExecutorOwner = (
  target: ExecutorTarget,
  input: {
    readonly email: string;
    readonly password: Redacted.Redacted;
    readonly organizationName: string;
  },
  callback: string,
  transport: ExecutorTransport["Service"],
): Effect.Effect<
  { readonly organizationId: string; readonly credentials: ExecutorCredentials },
  ExecutorFailure
> =>
  Effect.gen(function* () {
    const session = executorSession(target);
    const fields = {
      name: "Mend's member",
      email: input.email,
      password: Redacted.value(input.password),
    };
    const setup = yield* session.request("/api/auth/self-host/setup", {
      ...fields,
      organizationName: input.organizationName,
    });
    if (setup.status === 403) {
      const login = yield* session.request("/api/auth/sign-in/email", {
        email: fields.email,
        password: fields.password,
      });
      yield* session.requireStatus(login, 200);
    } else yield* session.requireStatus(setup, 200);
    const organizationId = yield* session.organization();
    return {
      organizationId,
      credentials: yield* session.grants(transport, organizationId, callback),
    };
  });

/** A person's SSO and both consent exchanges happen in this one server-only cookie jar. */
export const signInExecutorPerson = (
  target: ExecutorTarget,
  input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly mendOrganizationId: string;
    readonly authorize: (url: string) => Effect.Effect<string, ExecutorFailure>;
  },
  callback: string,
  transport: ExecutorTransport["Service"],
): Effect.Effect<ExecutorCredentials, ExecutorFailure> =>
  Effect.gen(function* () {
    const session = executorSession(target);
    const origin = executorAuthority(target);
    const start = yield* session.request("/api/auth/sign-in/social", {
      provider: "sso",
      callbackURL: `${origin}/`,
      disableRedirect: true,
    });
    yield* session.requireStatus(start, 200);
    const authorization = yield* decode(Schema.Struct({ url: Schema.String }), start);
    const callbackURL = yield* input.authorize(authorization.url);
    const response = yield* session.request(callbackURL);
    yield* session.requireStatus(response, 302);
    const returned = response.headers.get("location");
    if (returned === null || new URL(returned, origin).origin !== origin) return yield* invalid();
    const answer = yield* session.request("/api/auth/get-session");
    yield* session.requireStatus(answer, 200);
    const person = yield* decode(
      Schema.Struct({
        user: Schema.Struct({
          id: Schema.String,
          email: Schema.String,
          emailVerified: Schema.Boolean,
        }),
      }),
      answer,
    );
    if (
      person.user.email.toLowerCase() !==
        `${input.userId}@${input.mendOrganizationId}.people.mend.invalid`.toLowerCase() ||
      !person.user.emailVerified
    )
      return yield* invalid();
    const accountsResponse = yield* session.request("/api/auth/list-accounts");
    yield* session.requireStatus(accountsResponse, 200);
    const accounts = yield* decode(
      Schema.Array(Schema.Struct({ providerId: Schema.String, accountId: Schema.String })),
      accountsResponse,
    );
    if (
      accounts.length !== 1 ||
      accounts[0]?.providerId !== "sso" ||
      accounts[0].accountId !== input.userId
    )
      return yield* invalid();
    if ((yield* session.organization()) !== input.organizationId) return yield* invalid();
    const credentials = yield* session.grants(transport, input.organizationId, callback);
    if (credentials.tool.subject !== person.user.id) {
      yield* transport
        .revoke(target, credentials.registration, credentials.tool)
        .pipe(Effect.ignore);
      yield* transport
        .revoke(target, credentials.registration, credentials.service)
        .pipe(Effect.ignore);
      return yield* invalid();
    }
    return credentials;
  });
