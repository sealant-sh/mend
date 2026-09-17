import { createHash } from "node:crypto";

import { NetworkConfig, type PublicNetwork } from "@mend/network";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import * as Context from "effect/Context";
import { Pool } from "pg";

/** What the rest of the product needs to know about who is signed in. */
export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** A signed-in user's session as the rest of Mend consumes it. */
export interface AuthSession {
  readonly user: AuthUser;
  readonly expiresAt: Date;
}

/** The header a sign-up request carries its invitation token in. */
export const INVITATION_HEADER = "x-mend-invitation";

/** Whether an account may be created, decided before Better Auth inserts it. */
export type RegistrationDecision =
  | { readonly kind: "bootstrap" }
  | { readonly kind: "invitation"; readonly token: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Registration is closed (docs/adr/0003-organizations-and-tenancy.md): the first account on an
 * unclaimed instance registers, and everyone after that joins through an invitation link. The
 * policy decides before the account row exists and completes the membership after; both run
 * inside Better Auth's hooks, so neither may fail or require anything.
 */
export class RegistrationPolicy extends Context.Service<
  RegistrationPolicy,
  {
    readonly decide: (input: {
      readonly email: string;
      readonly invitationToken: string | null;
    }) => Effect.Effect<RegistrationDecision>;
    /**
     * Complete a registration that `decide` admitted: make the first account owner and operator,
     * or spend the invitation. A failure here leaves an account with no organization, which
     * sees nothing; it is logged, not thrown, because the row already exists.
     */
    readonly registered: (
      user: { readonly id: string; readonly email: string },
      invitationToken: string | null,
    ) => Effect.Effect<void>;
  }
>()("@mend/auth/RegistrationPolicy") {}

/** Inputs for constructing the Better Auth request handler. */
export interface AuthHandlerOptions {
  /** The only browser origins Better Auth accepts. */
  readonly network: PublicNetwork;
  /** Better Auth's signing secret. */
  readonly secret: string;
  /** The production database, omitted to use Better Auth's in-memory adapter. */
  readonly database?: BetterAuthOptions["database"];
  /**
   * Who may register. Omitted only by tests that exercise Better Auth itself; the server always
   * supplies one through `AuthLive`.
   */
  readonly registration?: RegistrationPolicy["Service"];
}

const invitationTokenOf = (
  context: { readonly headers?: Headers | undefined } | null,
): string | null => {
  const token = context?.headers?.get(INVITATION_HEADER)?.trim() ?? "";
  return token === "" ? null : token;
};

const registrationHooks = (policy: RegistrationPolicy["Service"]) => ({
  user: {
    create: {
      before: async (
        user: { readonly email: string },
        context: { readonly headers?: Headers | undefined } | null,
      ) => {
        const decision = await Effect.runPromise(
          policy.decide({ email: user.email, invitationToken: invitationTokenOf(context) }),
        );
        if (decision.kind === "refused") {
          throw new APIError("FORBIDDEN", { message: decision.message });
        }
      },
      after: async (
        user: { readonly id: string; readonly email: string },
        context: { readonly headers?: Headers | undefined } | null,
      ) => {
        await Effect.runPromise(
          policy.registered({ id: user.id, email: user.email }, invitationTokenOf(context)),
        );
      },
    },
  },
});

const createBetterAuth = (options: AuthHandlerOptions) =>
  betterAuth({
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.registration === undefined
      ? {}
      : { databaseHooks: registrationHooks(options.registration) }),
    secret: options.secret,
    baseURL: options.network.appUrl,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true },
    // Accounts are deactivated, never deleted (docs/adr/0003); sessions of one are refused.
    user: {
      additionalFields: {
        deactivatedAt: { type: "date", required: false, input: false, fieldName: "deactivatedAt" },
      },
    },
    advanced: { disableOriginCheck: false },
    plugins: [bearer()],
    trustedOrigins: [...options.network.allowedOrigins],
  });

/** Construct the real Better Auth handler with Mend's fixed origin policy. */
export const createAuthHandler = (
  options: AuthHandlerOptions,
): ((request: Request) => Promise<Response>) => createBetterAuth(options).handler;

/**
 * better-auth mounted behind an Effect contract: cookie sessions for the web
 * app, bearer tokens (via the bearer plugin) for mobile and CLI-ish use later.
 * The server entry routes `/api/auth/*` to `handler`.
 */
export class Auth extends Context.Service<
  Auth,
  {
    readonly handler: (request: Request) => Effect.Effect<Response>;
    readonly getSession: (headers: Headers) => Effect.Effect<Option.Option<AuthSession>>;
  }
>()("@mend/auth/Auth") {}

/** Postgres-backed Better Auth and paired-device authentication. */
export const AuthLive: Layer.Layer<Auth, Config.ConfigError, NetworkConfig | RegistrationPolicy> =
  Layer.effect(
    Auth,
    Effect.gen(function* () {
      const databaseUrl = yield* Config.redacted("DATABASE_URL").pipe(
        Config.orElse(() =>
          Config.succeed(Redacted.make("postgres://mend:mend@localhost:5434/mend")),
        ),
      );
      const secret = yield* Config.redacted("BETTER_AUTH_SECRET").pipe(
        Config.orElse(() => Config.succeed(Redacted.make("mend-dev-secret-do-not-deploy"))),
      );
      // Better Auth otherwise reads this ambient variable in addition to its
      // options, which would create a second, unvalidated origin allowlist.
      yield* Config.schema(Schema.Literal(""), "BETTER_AUTH_TRUSTED_ORIGINS").pipe(
        Config.withDefault(""),
      );
      const network = yield* NetworkConfig;
      const registration = yield* RegistrationPolicy;

      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => new Pool({ connectionString: Redacted.value(databaseUrl) })),
        (p) => Effect.promise(() => p.end()),
      );

      // Registration is closed after the first account (docs/adr/0003).
      const auth = createBetterAuth({
        database: pool,
        secret: Redacted.value(secret),
        network,
        registration,
      });

      const handler = Effect.fn("Auth.handler")((request: Request) =>
        Effect.promise(() => auth.handler(request)),
      );

      // A fixed operator token for dev/device testing: MEND_STATIC_TOKEN=xyz
      // makes `Bearer xyz` authenticate as the FIRST user. Opt-in via env,
      // never set in anything deployed.
      const staticToken = yield* Config.string("MEND_STATIC_TOKEN").pipe(
        Config.orElse(() => Config.succeed("")),
      );

      // A paired device authenticates with its own bearer token (mdt_…): only the
      // sha256 is stored, so the check is a hash and a lookup. `last_used_at` is
      // a fact about the device, not a session clock — one write a minute is enough.
      const DEVICE_LAST_USED_INTERVAL_MS = 60_000;

      const deviceSession = Effect.fn("Auth.deviceSession")(function* (headers: Headers) {
        const authorization = headers.get("authorization");
        if (authorization === null || !authorization.startsWith("Bearer ")) {
          return Option.none<AuthSession>();
        }
        const token = authorization.slice("Bearer ".length).trim();
        if (token === "") return Option.none<AuthSession>();
        const tokenHash = createHash("sha256").update(token).digest("hex");

        const rows = yield* Effect.promise(() =>
          pool.query(
            `SELECT d.id AS device_id, d.last_used_at, u.id AS user_id, u.email, u.name
               FROM device_tokens d
               JOIN "user" u ON u.id = d.user_id
              WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND u."deactivatedAt" IS NULL
              LIMIT 1`,
            [tokenHash],
          ),
        );
        const row = rows.rows[0] as
          | {
              readonly device_id: string;
              readonly last_used_at: Date | null;
              readonly user_id: string;
              readonly email: string;
              readonly name: string;
            }
          | undefined;
        if (row === undefined) return Option.none<AuthSession>();

        const stale =
          row.last_used_at === null ||
          Date.now() - row.last_used_at.getTime() >= DEVICE_LAST_USED_INTERVAL_MS;
        if (stale) {
          yield* Effect.promise(() =>
            pool.query("UPDATE device_tokens SET last_used_at = now() WHERE id = $1", [
              row.device_id,
            ]),
          );
        }

        return Option.some<AuthSession>({
          user: { id: row.user_id, email: row.email, name: row.name },
          expiresAt: new Date(Date.now() + 86_400_000),
        });
      });

      const getSession = Effect.fn("Auth.getSession")(function* (headers: Headers) {
        if (staticToken !== "" && headers.get("authorization") === `Bearer ${staticToken}`) {
          // The machine token acts as the longest-standing active operator (docs/adr/0003), never
          // as whichever account happens to be oldest.
          const rows = yield* Effect.promise(() =>
            pool.query(
              `SELECT u.id, u.email, u.name FROM "user" u
               JOIN instance_roles r ON r.user_id = u.id AND r.role = 'operator'
               WHERE u."deactivatedAt" IS NULL
               ORDER BY r.granted_at ASC, u.id ASC LIMIT 1`,
            ),
          );
          const row = rows.rows[0] as
            | { readonly id: string; readonly email: string; readonly name: string }
            | undefined;
          if (row !== undefined) {
            return Option.some<AuthSession>({
              user: { id: row.id, email: row.email, name: row.name },
              expiresAt: new Date(Date.now() + 86_400_000),
            });
          }
        }
        const result = yield* Effect.promise(() => auth.api.getSession({ headers }));
        // Not a better-auth session: it may still be a paired device's token.
        if (result === null) return yield* deviceSession(headers);
        // A deactivated account keeps no working session (docs/adr/0003).
        if (result.user.deactivatedAt !== null && result.user.deactivatedAt !== undefined) {
          return Option.none<AuthSession>();
        }
        return Option.some<AuthSession>({
          user: {
            id: result.user.id,
            email: result.user.email,
            name: result.user.name,
          },
          expiresAt: result.session.expiresAt,
        });
      });

      return { handler, getSession };
    }),
  );
