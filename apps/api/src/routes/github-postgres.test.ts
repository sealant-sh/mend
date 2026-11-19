import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { ConnectedAccount, type ConnectAccountInput } from "@mend/api-contracts";
import { GithubLoginsRepo, GithubLoginsRepoLive, MendDBLive, migrations } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import type { SealantClients } from "@mend/sealant";
import { MendKeysConfig, SecretCipher, SecretCipherLive } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type GithubStandIn,
  STAND_IN_WORLD,
  startGithubStandIn,
} from "../../test/support/github-stand-in.ts";
import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { makeGithubApi } from "../services/github-api.ts";
import { CONNECT_GITHUB_AGAIN } from "./github.ts";

/**
 * The repository list asks GitHub's API itself with Mend's sealed copy of the person's GitHub
 * login (docs/adr/0028): through the real routes, a real Postgres, the real cipher, and a stand-in
 * for GitHub's API on a local port that the server is pointed at by address.
 */

const TOKEN = Object.keys(STAND_IN_WORLD.tokens)[0] ?? "";
const postgres = postgresTestConfig();
const database = `mend_github_test_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pg = PgClient.layer({ url: Redacted.make(url.toString()) });
const keys = fs.mkdtempSync(path.join(os.tmpdir(), "mend-github-keys-"));
const dependencies = Layer.mergeAll(
  GithubLoginsRepoLive.pipe(Layer.provide(MendDBLive)),
  SecretCipherLive.pipe(Layer.provide(MendKeysConfig.layerFor(keys))),
).pipe(Layer.provideMerge(pg));
const runAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));

/** The platform's side: each person's connected accounts, as Sealant would keep them. */
const platform = () => {
  const accounts = new Map<string, Array<ConnectedAccount>>();
  const account = (userId: string, input: ConnectAccountInput) =>
    new ConnectedAccount({
      id: `cacc_${userId}_${input.provider}`,
      provider: input.provider,
      name: "default",
      kind: "gh-cli-token",
      status: "active",
      metadata: { login: "linus-p" },
      connectedAt: new Date("2026-11-19T10:00:00.000Z"),
      updatedAt: new Date("2026-11-19T10:00:00.000Z"),
      lastUsedAt: null,
      isDefault: true,
    });
  const connectedAccounts: SealantClients["Service"]["connectedAccounts"] = (userId) => ({
    list: () => Effect.sync(() => accounts.get(userId) ?? []),
    connect: (input) =>
      Effect.sync(() => {
        const made = account(userId, input);
        accounts.set(userId, [made]);
        return made;
      }),
    disconnect: (id) =>
      Effect.suspend(() => {
        const [found] = (accounts.get(userId) ?? []).filter((held) => held.id === id);
        if (found === undefined) return Effect.die(new Error("no such account"));
        accounts.set(userId, []);
        return Effect.succeed(found);
      }),
  });
  return { accounts, connectedAccounts, account };
};

describe.skipIf(postgres.skip)(
  "the repository list, asked of GitHub's API with Mend's copy",
  () => {
    let runtime: ManagedRuntime.ManagedRuntime<
      GithubLoginsRepo | SecretCipher | PgClient.PgClient | SqlClient.SqlClient,
      SqlError.SqlError
    >;
    let github: GithubStandIn;
    let api: TenancyApi;
    let sealant: ReturnType<typeof platform>;
    const logs: Array<string> = [];
    const events: Array<string> = [];
    /** Every body the API answered, to prove none of them carries the token. */
    const answered: Array<string> = [];

    const call = async (
      user: "carol" | "bob" | "erin",
      method: string,
      route: string,
      body?: unknown,
    ) => {
      const response = await api.request(user, method, route, body);
      const text = await response.text();
      answered.push(text);
      const parsed: unknown = text === "" ? null : JSON.parse(text);
      return { status: response.status, body: parsed };
    };
    const sealedRows = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            user_id: string;
            account_id: string;
            login: string | null;
            sealed_token: string;
          }>`SELECT user_id, account_id, login, sealed_token FROM user_github_logins ORDER BY user_id`;
        }),
      );

    beforeAll(async () => {
      await runAdmin(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
        }),
      );
      runtime = ManagedRuntime.make(dependencies);
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
            a.localeCompare(b),
          ))
            yield* migration;
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES
          ('carol', 'Carol', 'carol@github.invalid', now()),
          ('bob', 'Bob', 'bob@github.invalid', now()),
          ('erin', 'Erin', 'erin@github.invalid', now())`;
        }),
      );
      github = await startGithubStandIn();
      sealant = platform();
      api = await createTenancyApi(undefined, {
        logs,
        implement: {
          githubLogins: await runtime.runPromise(GithubLoginsRepo),
          cipher: await runtime.runPromise(SecretCipher),
          githubApi: makeGithubApi(github.url),
          connectedAccounts: sealant.connectedAccounts,
          userEvents: {
            changed: (userId, facet) => Effect.sync(() => void events.push(`${userId}:${facet}`)),
          },
        },
      });
    });
    afterAll(async () => {
      await api?.dispose();
      await github?.close();
      await runtime?.dispose();
      await runAdmin(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(
            `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
          );
        }),
      );
      fs.rmSync(keys, { recursive: true, force: true });
    });
    beforeEach(() => {
      github.requests.length = 0;
      github.revoked.clear();
      github.rateLimited = false;
      events.length = 0;
    });

    it("keeps a sealed copy on connect and lists owners and repositories as that login", async () => {
      const connected = await call("carol", "POST", "/api/me/sealant/accounts", {
        provider: "github",
        secret: `${TOKEN}\n`,
      });
      expect(connected.status).toBe(200);
      const [row] = await sealedRows();
      expect(row).toMatchObject({
        user_id: "carol",
        account_id: "cacc_carol_github",
        login: "linus-p",
      });
      expect(row?.sealed_token).not.toContain(TOKEN);
      const unsealed = await runtime.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SecretCipher).decrypt(row?.sealed_token ?? "");
        }),
      );
      expect(unsealed).toBe(TOKEN);

      expect((await call("carol", "GET", "/api/github/status")).body).toEqual({
        available: true,
        authenticated: true,
        login: "linus-p",
        detail: null,
      });
      // Status answers from what Mend holds: GitHub isn't asked.
      expect(github.requests).toEqual([]);

      expect((await call("carol", "GET", "/api/github/owners")).body).toEqual({
        login: "linus-p",
        owners: [
          { login: "linus-p", kind: "user" },
          { login: "acme", kind: "organization" },
          { login: "northwind", kind: "organization" },
        ],
      });
      // Both pages of organizations were read, every call as carol's own login.
      expect(github.requests.map((request) => request.path).toSorted()).toEqual([
        "/user",
        "/user/orgs",
        "/user/orgs",
      ]);
      expect(new Set(github.requests.map((request) => request.authorization))).toEqual(
        new Set([`Bearer ${TOKEN}`]),
      );

      const own = await call("carol", "GET", "/api/github/repos?owner=linus-p");
      expect(own.body).toEqual([
        {
          nameWithOwner: "linus-p/dotfiles",
          description: "dotfiles, most recently pushed",
          visibility: "private",
          isFork: false,
          language: "TypeScript",
          stars: 0,
          pushedAt: "2026-11-19T12:00:00.000Z",
          url: "https://github.com/linus-p/dotfiles",
        },
        expect.objectContaining({ nameWithOwner: "linus-p/notes", visibility: "public" }),
      ]);
      const northwind = await call("carol", "GET", "/api/github/repos?owner=northwind");
      expect(northwind.body).toEqual([
        expect.objectContaining({ nameWithOwner: "northwind/checkout-api" }),
        expect.objectContaining({ nameWithOwner: "northwind/web" }),
        expect.objectContaining({ nameWithOwner: "northwind/checkout-web" }),
      ]);
      expect((await call("carol", "GET", "/api/github/repos?owner=acme")).body).toEqual([]);
      const searched = await call(
        "carol",
        "GET",
        "/api/github/repos?owner=northwind&query=checkout",
      );
      expect(searched.body).toEqual([
        expect.objectContaining({ nameWithOwner: "northwind/checkout-api" }),
        expect.objectContaining({ nameWithOwner: "northwind/checkout-web" }),
      ]);
      expect(github.requests.map((request) => request.path).slice(-4)).toEqual([
        "/user/repos",
        "/orgs/northwind/repos",
        "/orgs/acme/repos",
        "/search/repositories",
      ]);
    });

    it("reports the rate limit and GitHub's other refusals as sentences, without the token", async () => {
      github.rateLimited = true;
      const limited = await call("carol", "GET", "/api/github/owners");
      expect(limited).toEqual({
        status: 422,
        body: {
          _tag: "GhFailure",
          message: expect.stringMatching(/rate limit for your login is used up until 15:42 UTC/),
        },
      });
      github.rateLimited = false;
      const missing = await call("carol", "GET", "/api/github/repos?owner=nobody-here");
      expect(missing.body).toEqual({
        _tag: "GhFailure",
        message:
          "GitHub answered 404 when Mend asked for the repositories in nobody-here: Not Found",
      });
      // An owner that isn't a GitHub name never reaches GitHub.
      github.requests.length = 0;
      expect((await call("carol", "GET", "/api/github/repos?owner=--help")).status).toBe(422);
      expect(github.requests).toEqual([]);
    });

    it("removes the copy when GitHub refuses it, and the list asks to connect again", async () => {
      github.revoked.add(TOKEN);
      const refused = await call("carol", "GET", "/api/github/repos?owner=northwind");
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        message: expect.stringContaining("Connect GitHub again with mend connect github."),
      });
      expect(await sealedRows()).toEqual([]);
      expect(events).toEqual(["carol:accounts"]);
      // The platform still holds the login; Mend has no copy, so nothing reaches GitHub.
      github.requests.length = 0;
      expect((await call("carol", "GET", "/api/github/status")).body).toEqual({
        available: true,
        authenticated: false,
        login: "linus-p",
        detail: CONNECT_GITHUB_AGAIN,
        connectAgain: true,
      });
      expect((await call("carol", "GET", "/api/github/owners")).body).toEqual({
        _tag: "GhFailure",
        message: CONNECT_GITHUB_AGAIN,
      });
      expect(github.requests).toEqual([]);
    });

    it("asks a login connected before Mend kept copies to connect again, and never uses another person's", async () => {
      // Carol connects again; bob's login reached the platform before this change, with no copy.
      await call("carol", "POST", "/api/me/sealant/accounts", {
        provider: "github",
        secret: TOKEN,
      });
      await Effect.runPromise(
        sealant.connectedAccounts("bob").connect({ provider: "github", secret: "never-seen" }),
      );
      github.requests.length = 0;
      expect((await call("bob", "GET", "/api/github/repos")).body).toEqual({
        _tag: "GhFailure",
        message: CONNECT_GITHUB_AGAIN,
      });
      expect((await call("bob", "GET", "/api/github/status")).body).toMatchObject({
        authenticated: false,
        detail: CONNECT_GITHUB_AGAIN,
        connectAgain: true,
      });
      // Someone with no GitHub login at all is told how to connect one.
      expect((await call("erin", "GET", "/api/github/owners")).body).toMatchObject({
        _tag: "GhFailure",
        message: expect.stringContaining("Connect your GitHub login"),
      });
      expect(github.requests).toEqual([]);
    });

    it("removes the copy when the person disconnects GitHub", async () => {
      await call("carol", "POST", "/api/me/sealant/accounts", {
        provider: "github",
        secret: TOKEN,
      });
      expect(await sealedRows()).toHaveLength(1);
      expect(
        (await call("carol", "DELETE", "/api/me/sealant/accounts/cacc_carol_github")).status,
      ).toBe(200);
      expect(await sealedRows()).toEqual([]);
    });

    it("removes the copy with the person's account", async () => {
      await call("carol", "POST", "/api/me/sealant/accounts", {
        provider: "github",
        secret: TOKEN,
      });
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('gone', 'Gone', 'gone@github.invalid', now())`;
          const repo = yield* GithubLoginsRepo;
          yield* repo.keep("gone", {
            accountId: "cacc_gone",
            login: "gone",
            sealedToken: "v1.x.y.z",
          });
          yield* sql`DELETE FROM "user" WHERE id = 'gone'`;
        }),
      );
      expect((await sealedRows()).map((row) => row.user_id)).toEqual(["carol"]);
    });

    it("never puts the token in a log line or an answer", () => {
      // Every test above ran through the same server; GitHub's stand-in even echoed the token back.
      expect(answered.length).toBeGreaterThan(10);
      expect(answered.join("\n")).not.toContain(TOKEN);
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join("\n")).not.toContain(TOKEN);
    });
  },
);
