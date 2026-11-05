import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Better Auth 1.6.23 provider tables are isolated from real Mend accounts. */
export const executorIdentityMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE SCHEMA executor_identity`;
  yield* sql`create table executor_identity."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null)`;
  yield* sql`create table executor_identity."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references executor_identity."user" ("id") on delete cascade)`;
  yield* sql`create table executor_identity."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references executor_identity."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null)`;
  yield* sql`create table executor_identity."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null)`;
  yield* sql`create table executor_identity."jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz)`;
  yield* sql`create table executor_identity."oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "userId" text references executor_identity."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "tokenEndpointAuthMethod" text, "grantTypes" jsonb, "responseTypes" jsonb, "public" boolean, "type" text, "requirePKCE" boolean, "referenceId" text, "metadata" jsonb)`;
  yield* sql`create table executor_identity."oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references executor_identity."oauthClient" ("clientId") on delete cascade, "sessionId" text references executor_identity."session" ("id") on delete set null, "userId" text not null references executor_identity."user" ("id") on delete cascade, "referenceId" text, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "authTime" timestamptz, "scopes" jsonb not null)`;
  yield* sql`create table executor_identity."oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references executor_identity."oauthClient" ("clientId") on delete cascade, "sessionId" text references executor_identity."session" ("id") on delete set null, "userId" text references executor_identity."user" ("id") on delete cascade, "referenceId" text, "refreshId" text references executor_identity."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "scopes" jsonb not null)`;
  yield* sql`create table executor_identity."oauthConsent" ("id" text not null primary key, "clientId" text not null references executor_identity."oauthClient" ("clientId") on delete cascade, "userId" text references executor_identity."user" ("id") on delete cascade, "referenceId" text, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null)`;
  yield* sql`create index "session_userId_idx" on executor_identity."session" ("userId")`;
  yield* sql`create index "account_userId_idx" on executor_identity."account" ("userId")`;
  yield* sql`create index "verification_identifier_idx" on executor_identity."verification" ("identifier")`;
  yield* sql`create index "oauthClient_userId_idx" on executor_identity."oauthClient" ("userId")`;
  yield* sql`create index "oauthRefreshToken_clientId_idx" on executor_identity."oauthRefreshToken" ("clientId")`;
  yield* sql`create index "oauthRefreshToken_sessionId_idx" on executor_identity."oauthRefreshToken" ("sessionId")`;
  yield* sql`create index "oauthRefreshToken_userId_idx" on executor_identity."oauthRefreshToken" ("userId")`;
  yield* sql`create index "oauthAccessToken_clientId_idx" on executor_identity."oauthAccessToken" ("clientId")`;
  yield* sql`create index "oauthAccessToken_sessionId_idx" on executor_identity."oauthAccessToken" ("sessionId")`;
  yield* sql`create index "oauthAccessToken_userId_idx" on executor_identity."oauthAccessToken" ("userId")`;
  yield* sql`create index "oauthAccessToken_refreshId_idx" on executor_identity."oauthAccessToken" ("refreshId")`;
  yield* sql`create index "oauthConsent_clientId_idx" on executor_identity."oauthConsent" ("clientId")`;
  yield* sql`create index "oauthConsent_userId_idx" on executor_identity."oauthConsent" ("userId")`;
  yield* sql`CREATE TABLE executor_identity.authority (id boolean PRIMARY KEY DEFAULT true CHECK (id), sealed_state text NOT NULL)`;
  yield* sql`CREATE TABLE executor_identity.link_tickets (
    digest text PRIMARY KEY, organization_id text NOT NULL REFERENCES public.organizations(id),
    user_id text NOT NULL REFERENCES public."user"(id), authorize_url text NOT NULL,
    expires_at timestamptz NOT NULL
  )`;
  yield* sql`CREATE INDEX link_tickets_expiry_idx ON executor_identity.link_tickets(expires_at)`;
});
