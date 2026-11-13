import { randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { isIP } from "node:net";

import { SecretCipher } from "@mend/store";
import { fromNodeHeaders } from "better-auth/node";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { Pool, type PoolClient } from "pg";

import { ExecutorAuthority, executorCertificates } from "./executor-certificates.ts";
import { createExecutorProvider, executorIdentityHash } from "./executor-provider.ts";

/** Private sign-in failures never include an authorization URL, ticket or remote response. */
export class ExecutorIdentityFailure extends Schema.TaggedError<ExecutorIdentityFailure>()(
  "ExecutorIdentityFailure",
  { message: Schema.String },
) {}
/** Only public trust/configuration material leaves the private identity service. */
export interface ExecutorIdentitySettings {
  readonly ca: string;
  readonly discovery: string;
  readonly clientId: string;
  readonly domain: string;
}
/** Owns private identities, sealed TLS authority, stored sessions and atomic link tickets. */
export class ExecutorIdentity extends Context.Service<
  ExecutorIdentity,
  {
    readonly prepare: (
      organizationId: string,
      clientSecret: Redacted.Redacted,
    ) => Effect.Effect<ExecutorIdentitySettings, ExecutorIdentityFailure>;
    readonly authorize: (
      organizationId: string,
      userId: string,
      authorizeURL: string,
    ) => Effect.Effect<string, ExecutorIdentityFailure>;
    readonly remove: (organizationId: string) => Effect.Effect<void, ExecutorIdentityFailure>;
    /** Served exclusively on the private callback listener, never the public router. */
    readonly handle: (request: Request) => Effect.Effect<Response, ExecutorIdentityFailure>;
    readonly listen: Effect.Effect<void, ExecutorIdentityFailure, import("effect/Scope").Scope>;
  }
>()("@mend/auth/ExecutorIdentity") {}

const unavailable = () =>
  new ExecutorIdentityFailure({
    message:
      "Mend's private Executor sign-in is unavailable. The operator can check its callback listener and database.",
  });
const refused = () =>
  new ExecutorIdentityFailure({
    message: "Mend refused an expired or mismatched private Executor sign-in. Click Link again.",
  });
const callbackOrigin = "http://executor.localhost:4400";
const callbacks = ["/api/auth/callback/sso", "/api/auth/oauth2/callback/sso"].map(
  (path) => callbackOrigin + path,
);
const clientId = (organizationId: string) => `mend-${executorIdentityHash(organizationId)}`;
const ResultUser = Schema.Struct({ user_id: Schema.String });

/** One shared database-backed authority; listener lifetime belongs to the API composition root. */
export const ExecutorIdentityLive: Layer.Layer<ExecutorIdentity, never, SecretCipher> =
  Layer.effect(
    ExecutorIdentity,
    Effect.gen(function* () {
      const cipher = yield* SecretCipher;
      const databaseUrl = yield* Config.Redacted("DATABASE_URL").pipe(
        Config.withDefault(Redacted.make("postgres://mend:mend@localhost:5434/mend")),
        Effect.orDie,
      );
      const host = yield* Config.String("MEND_EXECUTOR_CALLBACK_HOST").pipe(
        Config.withDefault(""),
        Effect.orDie,
      );
      const runtime = yield* Config.String("MEND_EXECUTOR_RUNTIME").pipe(
        Config.withDefault("unconfigured"),
        Effect.orDie,
      );
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const created = new Pool({
            connectionString: Redacted.value(databaseUrl),
            application_name: "mend-executor-identity",
            max: 4,
            options: "-c search_path=executor_identity",
            connectionTimeoutMillis: 10_000,
          });
          created.on("error", () =>
            Effect.runFork(Effect.logError("Executor identity database connection ended")),
          );
          return created;
        }),
        (created) => Effect.promise(() => created.end()),
      );
      const attempt = <A>(body: () => Promise<A>) =>
        Effect.tryPromise({ try: body, catch: unavailable });
      const issuer = (organizationId: string) =>
        `https://${host}:4401/executor-identity/${encodeURIComponent(organizationId)}`;
      const checkHost = () => {
        if (host === "" || (!isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host)))
          throw new Error("Unconfigured callback host");
      };
      // No plaintext cache: each process reads the same sealed CA and retains it only for TLS use.
      const authority = () =>
        Effect.scoped(
          Effect.gen(function* () {
            checkHost();
            const connection = yield* Effect.acquireRelease(
              attempt(() => pool.connect()),
              (c) => Effect.sync(() => c.release()),
            );
            yield* attempt(() => connection.query("BEGIN"));
            const work = Effect.gen(function* () {
              yield* attempt(() =>
                connection.query(
                  "SELECT pg_advisory_xact_lock(hashtextextended('mend:executor:authority',0))",
                ),
              );
              const rows = yield* attempt(() =>
                connection.query("SELECT sealed_state FROM authority WHERE id = true"),
              );
              const row = yield* Schema.decodeUnknownEffect(
                Schema.NullOr(Schema.Struct({ sealed_state: Schema.String })),
              )(rows.rows[0] ?? null).pipe(Effect.mapError(unavailable));
              const previous =
                row === null
                  ? undefined
                  : yield* cipher
                      .decrypt(row.sealed_state)
                      .pipe(
                        Effect.flatMap(
                          Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorAuthority)),
                        ),
                        Effect.mapError(unavailable),
                      );
              const current = yield* attempt(() => executorCertificates(host, previous));
              if (current !== previous) {
                const sealed = yield* cipher
                  .encrypt(Schema.encodeSync(Schema.fromJsonString(ExecutorAuthority))(current))
                  .pipe(Effect.mapError(unavailable));
                yield* attempt(() =>
                  connection.query(
                    "INSERT INTO authority(id,sealed_state) VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET sealed_state=EXCLUDED.sealed_state",
                    [sealed],
                  ),
                );
              }
              return current;
            });
            return yield* work.pipe(
              Effect.tap(() => attempt(() => connection.query("COMMIT"))),
              Effect.onError(() => attempt(() => connection.query("ROLLBACK")).pipe(Effect.ignore)),
            );
          }),
        );
      const consume = async (ticket: string, authorizeURL: string) => {
        // DELETE commits before validation, so a wrong query also spends the single-use ticket.
        const spent = await pool.query(
          "DELETE FROM link_tickets WHERE digest=$1 RETURNING organization_id,user_id,authorize_url,expires_at",
          [executorIdentityHash(ticket)],
        );
        const row = Schema.decodeUnknownSync(
          Schema.NullOr(
            Schema.Struct({
              organization_id: Schema.String,
              user_id: Schema.String,
              authorize_url: Schema.String,
              expires_at: Schema.Date,
            }),
          ),
        )(spent.rows[0] ?? null);
        if (
          row === null ||
          row.authorize_url !== authorizeURL ||
          row.expires_at.getTime() <= Date.now()
        )
          return null;
        const member = await pool.query(
          "SELECT user_id FROM public.organization_members WHERE organization_id=$1 AND user_id=$2",
          [row.organization_id, row.user_id],
        );
        return member.rowCount === 1 ? row.user_id : null;
      };
      const provider = (organizationId: string, state: ExecutorAuthority) =>
        createExecutorProvider({
          issuer: issuer(organizationId),
          secret: Redacted.value(state.secret),
          database: pool,
          consume,
        });
      const prepare = Effect.fn("ExecutorIdentity.prepare")(function* (
        organizationId: string,
        clientSecret: Redacted.Redacted,
      ) {
        const state = yield* authority();
        yield* attempt(() =>
          pool.query(
            `INSERT INTO "oauthClient" (id,"clientId","clientSecret",name,"redirectUris","tokenEndpointAuthMethod","grantTypes","responseTypes",type,public,"requirePKCE","skipConsent",disabled,scopes,"createdAt")
      VALUES($1,$1,$2,'Mend-run Executor',$3::jsonb,'client_secret_post','["authorization_code"]','["code"]','web',false,false,true,false,'["openid","email","profile"]',now())
      ON CONFLICT("clientId") DO UPDATE SET "clientSecret"=EXCLUDED."clientSecret",disabled=false`,
            [
              clientId(organizationId),
              executorIdentityHash(Redacted.value(clientSecret)),
              JSON.stringify(callbacks),
            ],
          ),
        );
        return {
          ca: state.ca,
          discovery: `${issuer(organizationId)}/.well-known/openid-configuration`,
          clientId: clientId(organizationId),
          domain: `${organizationId}.people.mend.invalid`,
        };
      });
      const authorize = Effect.fn("ExecutorIdentity.authorize")(function* (
        organizationId: string,
        userId: string,
        authorizeURL: string,
      ) {
        const state = yield* authority();
        const url = yield* attempt(async () => new URL(authorizeURL));
        if (
          url.origin + url.pathname !== issuer(organizationId) + "/oauth2/authorize" ||
          url.searchParams.get("client_id") !== clientId(organizationId) ||
          !callbacks.includes(url.searchParams.get("redirect_uri") ?? "")
        )
          return yield* refused();
        const member = yield* attempt(() =>
          pool.query(
            'SELECT m.user_id,u.name FROM public.organization_members m JOIN public."user" u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.user_id=$2',
            [organizationId, userId],
          ),
        );
        const person = yield* Schema.decodeUnknownEffect(
          Schema.NullOr(Schema.Struct({ ...ResultUser.fields, name: Schema.String })),
        )(member.rows[0] ?? null).pipe(Effect.mapError(unavailable));
        if (person === null) return yield* refused();
        yield* attempt(() =>
          pool.query(
            'INSERT INTO "user" (id,name,email,"emailVerified") VALUES($1,$2,$3,true) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,email=EXCLUDED.email,"emailVerified"=true',
            [userId, person.name, `${userId}@${organizationId}.people.mend.invalid`],
          ),
        );
        const ticket = randomBytes(32).toString("base64url");
        yield* attempt(() => pool.query("DELETE FROM link_tickets WHERE expires_at <= now()"));
        yield* attempt(() =>
          pool.query(
            "INSERT INTO link_tickets(digest,organization_id,user_id,authorize_url,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 seconds')",
            [executorIdentityHash(ticket), organizationId, userId, authorizeURL],
          ),
        );
        const auth = provider(organizationId, state);
        const response = yield* attempt(() =>
          auth.handler(
            new Request(authorizeURL, {
              headers: { "x-mend-link-ticket": ticket, Accept: "text/html" },
            }),
          ),
        );
        const location = response.headers.get("location");
        if (response.status !== 302 || location === null) return yield* refused();
        const returned = yield* attempt(async () => new URL(location));
        if (
          !callbacks.includes(returned.origin + returned.pathname) ||
          !returned.searchParams.get("code")
        )
          return yield* refused();
        return returned.href;
      });
      const remove = (organizationId: string) =>
        attempt(async () => {
          const connection: PoolClient = await pool.connect();
          try {
            await connection.query("BEGIN");
            await connection.query('DELETE FROM "oauthClient" WHERE "clientId"=$1', [
              clientId(organizationId),
            ]);
            await connection.query(`DELETE FROM "user" WHERE split_part(email,'@',2)=$1`, [
              `${organizationId}.people.mend.invalid`,
            ]);
            await connection.query("DELETE FROM link_tickets WHERE organization_id=$1", [
              organizationId,
            ]);
            await connection.query("COMMIT");
          } catch (error) {
            await connection.query("ROLLBACK");
            throw error;
          } finally {
            connection.release();
          }
        });
      const handle = (request: Request) =>
        Effect.gen(function* () {
          const url = new URL(request.url);
          const match = /^\/executor-identity\/([^/]+)\/(.+)$/.exec(url.pathname);
          const organizationId = match?.[1] === undefined ? null : decodeURIComponent(match[1]);
          const path = match?.[2];
          if (
            organizationId === null ||
            url.origin !== new URL(issuer(organizationId)).origin ||
            !(
              (request.method === "GET" &&
                [
                  ".well-known/openid-configuration",
                  "jwks",
                  "oauth2/authorize",
                  "oauth2/userinfo",
                ].includes(path ?? "")) ||
              (request.method === "POST" && path === "oauth2/token")
            )
          )
            return new Response(null, { status: 404 });
          const registered = yield* attempt(() =>
            pool.query('SELECT id FROM "oauthClient" WHERE "clientId"=$1 AND disabled=false', [
              clientId(organizationId),
            ]),
          );
          if (registered.rowCount !== 1) return new Response(null, { status: 404 });
          const state = yield* authority();
          const auth = provider(organizationId, state);
          return path === ".well-known/openid-configuration"
            ? yield* attempt(async () => Response.json(await auth.api.getOpenIdConfig()))
            : yield* attempt(() => auth.handler(request));
        });
      const listen =
        runtime !== "docker"
          ? Effect.void
          : Effect.gen(function* () {
              const state = yield* authority();
              yield* Effect.acquireRelease(
                attempt(
                  () =>
                    new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
                      const server = createServer(
                        {
                          key: Redacted.value(state.key),
                          cert: state.certificate,
                          maxHeaderSize: 16_384,
                        },
                        (req, res) => {
                          const dispatch = async () => {
                            const url = new URL(req.url ?? "/", `https://${host}:4401`);
                            if (Number(req.headers["content-length"] ?? 0) > 65_536) {
                              res.writeHead(413).end();
                              return;
                            }
                            let length = 0;
                            const chunks: Buffer[] = [];
                            for await (const chunk of req) {
                              if (!Buffer.isBuffer(chunk)) {
                                res.writeHead(400).end();
                                return;
                              }
                              length += chunk.length;
                              if (length > 65_536) {
                                res.writeHead(413).end();
                                return;
                              }
                              chunks.push(chunk);
                            }
                            const response = await Effect.runPromise(
                              handle(
                                new Request(url, {
                                  method: req.method ?? "GET",
                                  headers: fromNodeHeaders(req.headers),
                                  ...(chunks.length === 0
                                    ? {}
                                    : { body: Buffer.concat(chunks).toString("utf8") }),
                                }),
                              ),
                            );
                            res.writeHead(response.status, Object.fromEntries(response.headers));
                            res.end(Buffer.from(await response.arrayBuffer()));
                          };
                          void dispatch().catch(() => {
                            if (!res.headersSent) res.writeHead(503);
                            res.end();
                          });
                        },
                      );
                      server.requestTimeout = 15_000;
                      server.headersTimeout = 10_000;
                      server.once("error", reject);
                      server.listen(4401, "0.0.0.0", () => {
                        server.removeListener("error", reject);
                        resolve(server);
                      });
                    }),
                ),
                (server) =>
                  Effect.promise(
                    () =>
                      new Promise<void>((resolve) => {
                        server.close(() => resolve());
                        server.closeAllConnections();
                      }),
                  ),
              );
            });
      return ExecutorIdentity.of({ prepare, authorize, remove, handle, listen });
    }),
  );
