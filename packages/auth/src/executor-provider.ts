import { createHash } from "node:crypto";

import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { jwt } from "better-auth/plugins";

export const executorIdentityHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Separate users and stored sessions exist only for Executor's private sign-in protocol. */
export const createExecutorProvider = (input: {
  readonly issuer: string;
  readonly secret: string;
  readonly database: BetterAuthOptions["database"];
  readonly consume: (ticket: string, authorizeURL: string) => Promise<string | null>;
}) =>
  betterAuth({
    baseURL: new URL(input.issuer).origin,
    basePath: new URL(input.issuer).pathname,
    secret: input.secret,
    database: input.database,
    logger: { disabled: true },
    session: { expiresIn: 60, updateAge: 60 },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/authorize") return;
        const userId = await input.consume(
          ctx.headers?.get("x-mend-link-ticket") ?? "",
          ctx.request?.url ?? "",
        );
        if (userId === null)
          throw new APIError("UNAUTHORIZED", {
            message: "Missing, expired, consumed or mismatched Mend link ticket",
          });
        const user = await ctx.context.internalAdapter.findUserById(userId);
        if (user === null)
          throw new APIError("UNAUTHORIZED", { message: "Mend link identity is unavailable" });
        // The code exchange checks this real stored session. A cookie alone cannot authorize.
        const session = await ctx.context.internalAdapter.createSession(
          user.id,
          false,
          { expiresAt: new Date(Date.now() + 60_000) },
          true,
        );
        return { context: { context: { session: { session, user } } } };
      }),
    },
    plugins: [
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } }, jwt: { issuer: input.issuer } }),
      oauthProvider({
        loginPage: "/unavailable",
        consentPage: "/unavailable",
        scopes: ["openid", "email", "profile"],
        grantTypes: ["authorization_code"],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        storeClientSecret: { hash: executorIdentityHash },
        silenceWarnings: { openidConfig: true, oauthAuthServerConfig: true },
      }),
    ],
  });
