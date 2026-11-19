import { execFile } from "node:child_process";

import {
  type ConnectedAccount,
  CurrentUser,
  GhFailure,
  GhOwnersView,
  GhOwnerView,
  GhRepoView,
  GhStatusView,
  MendApi,
  PullRequestView,
} from "@mend/api-contracts";
import { GithubLoginsRepo, type HeldGithubLogin, UserEvents } from "@mend/db";
import { loginChoiceOf } from "@mend/domain/default-login";
import { SealantClients } from "@mend/sealant";
import { SecretCipher } from "@mend/store";
import { Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";
import { HttpApiBuilder } from "effect/http-api";

import { GithubIdentity, loginOf, NO_GITHUB_IDENTITY } from "../github-identity.ts";
import { lookupProjectRepository } from "../project-operations.ts";
import { GithubApi, type GithubApiFailure } from "../services/github-api.ts";

/**
 * Adoption discovery: whose GitHub repositories a person can add. With a connected GitHub login,
 * Mend asks GitHub's API itself with its own sealed copy of that login (docs/adr/0028). Without
 * one, the host's own GitHub CLI answers for the operator of a single-organization install (plan
 * §17): whatever `gh auth login` set up on this machine, and a missing or signed-out gh is
 * reported as status.
 */

/** A gh invocation that exited nonzero (or could not run at all). */
export class GhError extends Schema.TaggedError<GhError>()("GhError", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  stderr: Schema.String,
}) {}

/** gh answers within this window or the endpoint reports the stall instead of hanging. */
const GH_TIMEOUT_MS = 20_000;

/**
 * Run gh with args; resolve with both streams (gh splits status output between
 * them by version). Mirrors store/git.ts: plain `node:child_process`, args as
 * a vector — user input never meets a shell.
 */
const gh = (
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, GhError> =>
  Effect.callback<{ readonly stdout: string; readonly stderr: string }, GhError>((resume) => {
    const child = execFile(
      "gh",
      [...args],
      {
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resume(Effect.succeed({ stdout, stderr }));
          return;
        }
        resume(
          Effect.fail(
            new GhError({
              args: [...args],
              exitCode: typeof error.code === "number" ? error.code : null,
              stderr: (error.stderr ?? error.message).trim(),
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

/** gh's JSON, decoded; output in any other shape fails as gh's own failure would. */
const parseJson = <S extends Schema.Decoder<unknown>>(
  schema: S,
  raw: string,
  args: ReadonlyArray<string>,
): Effect.Effect<S["Type"], GhError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      () =>
        new GhError({ args: [...args], exitCode: null, stderr: "gh returned unparseable JSON" }),
    ),
  );

/** `gh repo list --json` items — visibility UPPERCASE, language nested. */
const RepoListItems = Schema.Array(
  Schema.Struct({
    nameWithOwner: Schema.String,
    description: Schema.String,
    visibility: Schema.String,
    isFork: Schema.Boolean,
    primaryLanguage: Schema.NullOr(Schema.Struct({ name: Schema.String })),
    stargazerCount: Schema.Number,
    pushedAt: Schema.NullOr(Schema.String),
    url: Schema.String,
  }),
);

/** `gh search repos --json` items — visibility lowercase, language flat. */
const RepoSearchItems = Schema.Array(
  Schema.Struct({
    fullName: Schema.String,
    description: Schema.String,
    visibility: Schema.String,
    isFork: Schema.Boolean,
    language: Schema.NullOr(Schema.String),
    stargazersCount: Schema.Number,
    pushedAt: Schema.NullOr(Schema.String),
    url: Schema.String,
  }),
);

const REPO_LIMIT = 30;
const LIST_FIELDS =
  "nameWithOwner,description,visibility,isFork,primaryLanguage,stargazerCount,pushedAt,url";
const SEARCH_FIELDS =
  "fullName,description,visibility,isFork,language,stargazersCount,pushedAt,url";

/**
 * owner/name from a GitHub origin URL — https, ssh scp-style, ssh://, with or
 * without `.git`. Null for anything else (GitLab, a local path, a bare repo).
 */
export const parseGithubRepo = (originUrl: string | null): string | null => {
  if (originUrl === null) return null;
  const trimmed = originUrl.trim();
  const match =
    /^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?|git:\/\/)(?:www\.)?github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    ) ?? /^(?:[^@\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (match === null) return null;
  const [, owner, name] = match;
  return owner === undefined || name === undefined ? null : `${owner}/${name}`;
};

/** Why gh could not answer, read from its own output — reported as state, never rephrased. */
export type GhUnavailable = "gh-missing" | "gh-signed-out" | "rate-limited" | "error";

export const classifyGhError = (error: GhError): GhUnavailable => {
  const text = error.stderr.toLowerCase();
  if (error.exitCode === null && (text.includes("enoent") || text.includes("not found"))) {
    return "gh-missing";
  }
  if (text.includes("rate limit")) return "rate-limited";
  if (
    text.includes("gh auth login") ||
    text.includes("not logged in") ||
    text.includes("authentication") ||
    text.includes("http 401")
  ) {
    return "gh-signed-out";
  }
  return "error";
};

/** What one gh call printed and how it exited, wherever it ran. */
export interface GhOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs gh with these arguments as some GitHub login (the host's own `gh`; a stand-in in tests). A
 * gh that exits nonzero answers with its exit code; `E` is only the failure to run it at all.
 */
export type GhRun<E> = (args: ReadonlyArray<string>) => Effect.Effect<GhOutput, E>;

/** A GitHub account or organization name: what gh is given as an owner, never a flag. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** gh's own words for a failed call, or what was asked when it gave none. */
const ghWords = (output: GhOutput, asked: string): string => output.stderr.trim() || asked;

const ownedBy = (owner: string | undefined): ReadonlyArray<string> =>
  owner === undefined ? [] : [owner];

/**
 * gh's arguments for one owner's repositories (the login's own when there is no owner), most
 * recently pushed first, or a search within that owner. `--` keeps a query positional, never
 * parsed as a flag; an owner is checked against GitHub's name rules before it gets here.
 */
const repoArgs = (owner: string | undefined, query: string): ReadonlyArray<string> => {
  const trimmed = query.trim();
  if (trimmed === "")
    return [
      "repo",
      "list",
      ...ownedBy(owner),
      "--limit",
      String(REPO_LIMIT),
      "--json",
      LIST_FIELDS,
    ];
  return [
    "search",
    "repos",
    "--limit",
    String(REPO_LIMIT),
    "--json",
    SEARCH_FIELDS,
    ...(owner === undefined ? [] : ["--owner", owner]),
    "--",
    trimmed,
  ];
};

/** What `repoArgs`' gh printed, in one shape whichever of the two commands ran. */
const parseRepos = (
  args: ReadonlyArray<string>,
  stdout: string,
): Effect.Effect<ReadonlyArray<GhRepoView>, GhError> =>
  args[0] === "repo"
    ? parseJson(RepoListItems, stdout, args).pipe(
        Effect.map((items) =>
          items.map(
            (item) =>
              new GhRepoView({
                nameWithOwner: item.nameWithOwner,
                description: item.description === "" ? null : item.description,
                visibility: item.visibility.toLowerCase(),
                isFork: item.isFork,
                language: item.primaryLanguage?.name ?? null,
                stars: item.stargazerCount,
                pushedAt: item.pushedAt,
                url: item.url,
              }),
          ),
        ),
      )
    : parseJson(RepoSearchItems, stdout, args).pipe(
        Effect.map((items) =>
          items.map(
            (item) =>
              new GhRepoView({
                nameWithOwner: item.fullName,
                description: item.description === "" ? null : item.description,
                visibility: item.visibility.toLowerCase(),
                isFork: item.isFork,
                language: item.language === "" ? null : item.language,
                stars: item.stargazersCount,
                pushedAt: item.pushedAt,
                url: item.url,
              }),
          ),
        ),
      );

/**
 * One owner's repositories, or a search within them, as the login `run` runs as. An owner that
 * isn't a GitHub name is refused before gh runs.
 */
export const listRepos = <E>(
  run: GhRun<E>,
  owner: string | undefined,
  query: string,
): Effect.Effect<ReadonlyArray<GhRepoView>, GhFailure | E> =>
  Effect.gen(function* () {
    if (owner !== undefined && !GITHUB_LOGIN.test(owner))
      return yield* new GhFailure({ message: `${owner} isn't a GitHub account or organization.` });
    const args = repoArgs(owner, query);
    const output = yield* run(args);
    if (output.exitCode !== 0)
      return yield* new GhFailure({
        message: ghWords(output, "GitHub didn't list the repositories for this login."),
      });
    return yield* parseRepos(args, output.stdout).pipe(
      Effect.mapError(() => new GhFailure({ message: "GitHub returned an unreadable list." })),
    );
  });

/**
 * Whose repositories the login can list: its own account, then each organization it belongs to
 * (`user/orgs`, every page), by name. An organization that limits which apps may read it still
 * appears; its list may come back empty until it approves the login.
 */
export const listOwners = <E>(run: GhRun<E>): Effect.Effect<GhOwnersView, GhFailure | E> =>
  Effect.gen(function* () {
    const user = yield* run(["api", "user", "--jq", ".login"]);
    const login = user.stdout.trim();
    if (user.exitCode !== 0 || !GITHUB_LOGIN.test(login))
      return yield* new GhFailure({
        message: ghWords(user, "GitHub didn't say whose login this is."),
      });
    const orgs = yield* run(["api", "user/orgs", "--paginate", "--jq", ".[].login"]);
    if (orgs.exitCode !== 0)
      return yield* new GhFailure({
        message: ghWords(orgs, "GitHub didn't list the organizations for this login."),
      });
    const organizations = orgs.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => GITHUB_LOGIN.test(name))
      .toSorted((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    return new GhOwnersView({
      login,
      owners: [
        new GhOwnerView({ login, kind: "user" }),
        ...organizations.map((name) => new GhOwnerView({ login: name, kind: "organization" })),
      ],
    });
  });

/** The host's own gh, as a `GhRun`: a gh that can't start answers as gh's own failure would. */
const hostRun: GhRun<never> = (args) =>
  gh(args).pipe(
    Effect.map(({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr })),
    Effect.catch((error) =>
      Effect.succeed({ exitCode: error.exitCode ?? 1, stdout: "", stderr: error.stderr }),
    ),
  );

/**
 * Who answers the caller's repository list. Mend's own copy of their GitHub login first
 * (docs/adr/0028): `token` is it unsealed, for this request only. A GitHub login they connected
 * before Mend kept copies has none, and is asked to connect again rather than answered from a
 * workspace. Without a connected login, the host's gh for the operator of a single-organization
 * install, as before; everyone else is told why there is nothing to show.
 */
type ListAuthority =
  | {
      readonly kind: "own";
      readonly userId: string;
      readonly held: HeldGithubLogin;
      readonly token: Redacted.Redacted;
    }
  | { readonly kind: "host-gh" }
  | {
      readonly kind: "none";
      readonly login: string | null;
      readonly detail: string;
      /** A connected login Mend holds no usable copy of: connecting it again fixes the list. */
      readonly connectAgain: boolean;
    };

/** What a GitHub login connected before this change sees: Mend holds no copy of it. */
export const CONNECT_GITHUB_AGAIN =
  "Mend lists your repositories with its own copy of your GitHub login, and it has none of the one you connected. Connect GitHub again with mend connect github.";

/** What the list says once Mend's copy can no longer be unsealed (the server's key changed). */
const UNREADABLE_COPY =
  "Mend can't read its copy of your GitHub login any more. Connect GitHub again with mend connect github.";

/** Several GitHub logins and none chosen: the person's sessions can't start on GitHub either. */
export const CHOOSE_DEFAULT_GITHUB =
  "You have several GitHub logins and none is your default, so Mend doesn't know which one to list with. Choose one with mend connect github --default.";

/** The platform couldn't say which of several copies is the default. */
const DEFAULT_UNKNOWN =
  "Mend couldn't ask Sealant which of your GitHub logins is your default. Try again in a moment.";

/** Which of Mend's copies the person's list uses, decided from their logins on the platform. */
export type GithubCopyChoice =
  | { readonly kind: "copy"; readonly copy: HeldGithubLogin }
  /** Their default GitHub login has no copy in Mend. */
  | { readonly kind: "connect-again"; readonly login: string | null }
  /** Several GitHub logins, none of them chosen. */
  | { readonly kind: "choose" }
  /** No GitHub login at all. */
  | { readonly kind: "no-login" }
  /** The platform couldn't be read, and Mend holds several copies. */
  | { readonly kind: "unknown" };

/**
 * The copy of the person's default GitHub login (`loginChoiceOf`, the rule their sessions use: the
 * chosen login, or the only one), and the copies of logins the platform no longer holds, which go.
 * `accounts` is null when the platform couldn't be read: a single copy is then the one to use.
 */
export const githubCopyFor = (
  accounts: ReadonlyArray<ConnectedAccount> | null,
  copies: ReadonlyArray<HeldGithubLogin>,
): { readonly choice: GithubCopyChoice; readonly stale: ReadonlyArray<HeldGithubLogin> } => {
  if (accounts === null) {
    const [only, ...more] = copies;
    if (only === undefined) return { choice: { kind: "no-login" }, stale: [] };
    return {
      choice: more.length === 0 ? { kind: "copy", copy: only } : { kind: "unknown" },
      stale: [],
    };
  }
  const live = new Set(
    accounts
      .filter((account) => account.provider === "github" && account.status !== "archived")
      .map((account) => account.id),
  );
  const stale = copies.filter((copy) => !live.has(copy.accountId));
  const choice = loginChoiceOf(accounts, "github");
  if (choice._tag === "none") return { choice: { kind: "no-login" }, stale };
  if (choice._tag === "unchosen" && choice.accounts.length > 1)
    return { choice: { kind: "choose" }, stale };
  const followed = choice._tag === "chosen" ? choice.account : choice.accounts[0];
  const copy = copies.find((held) => held.accountId === followed.id);
  return {
    choice:
      copy === undefined
        ? { kind: "connect-again", login: loginOf(followed) }
        : { kind: "copy", copy },
    stale,
  };
};

const listAuthority = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const userId = caller.user.id;
  const logins = yield* GithubLoginsRepo;
  const copies = yield* logins.held(userId);
  // A platform that can't be read leaves the choice to the copies alone (`githubCopyFor`).
  const accounts = yield* (yield* SealantClients)
    .connectedAccounts(userId)
    .list()
    .pipe(
      Effect.tapError(() =>
        Effect.logInfo("github: the caller's connected accounts could not be read"),
      ),
      Effect.orElseSucceed(() => null),
    );
  const { choice, stale } = githubCopyFor(accounts, copies);
  // A login removed on the platform itself takes its copy with it.
  for (const copy of stale) yield* logins.forgetAccount(userId, copy.accountId);
  switch (choice.kind) {
    case "copy": {
      const token = yield* (yield* SecretCipher)
        .decrypt(choice.copy.sealedToken)
        .pipe(Effect.option);
      if (token._tag === "Some")
        return {
          kind: "own",
          userId,
          held: choice.copy,
          token: Redacted.make(token.value),
        } satisfies ListAuthority;
      yield* forgetRefused(userId, choice.copy);
      return {
        kind: "none",
        login: choice.copy.login,
        detail: UNREADABLE_COPY,
        connectAgain: true,
      } satisfies ListAuthority;
    }
    case "connect-again":
      return {
        kind: "none",
        login: choice.login,
        detail: CONNECT_GITHUB_AGAIN,
        connectAgain: true,
      } satisfies ListAuthority;
    case "choose":
      return {
        kind: "none",
        login: null,
        detail: CHOOSE_DEFAULT_GITHUB,
        connectAgain: false,
      } satisfies ListAuthority;
    case "unknown":
      return {
        kind: "none",
        login: null,
        detail: DEFAULT_UNKNOWN,
        connectAgain: false,
      } satisfies ListAuthority;
    case "no-login": {
      // No GitHub login of their own: the host rule (`GithubIdentity`) decides, as before.
      const authority = yield* (yield* GithubIdentity).forCaller();
      if (authority.kind === "host-gh") return { kind: "host-gh" } satisfies ListAuthority;
      return {
        kind: "none",
        login: null,
        detail: authority.kind === "none" ? authority.detail : NO_GITHUB_IDENTITY,
        connectAgain: false,
      } satisfies ListAuthority;
    }
  }
});

/**
 * Removes the copy GitHub refused (or Mend can no longer read), and tells the person's open pages,
 * which read their logins and this list again and then say to connect GitHub again.
 */
const forgetRefused = (userId: string, copy: HeldGithubLogin) =>
  Effect.gen(function* () {
    const removed = yield* (yield* GithubLoginsRepo).forgetRefused(
      userId,
      copy.accountId,
      copy.sealedToken,
    );
    if (!removed) return;
    yield* Effect.logInfo("github: Mend's copy of a GitHub login was removed (refused)");
    yield* (yield* UserEvents).changed(userId, "accounts");
  });

/** A call made with Mend's copy, its failures in the list's words; a refusal removes the copy. */
const asOwn = <A>(
  own: Extract<ListAuthority, { readonly kind: "own" }>,
  call: Effect.Effect<A, GithubApiFailure>,
) =>
  call.pipe(
    Effect.catchTag("GithubLoginRefused", (refused) =>
      forgetRefused(own.userId, own.held).pipe(
        Effect.andThen(Effect.fail(new GhFailure({ message: refused.message }))),
      ),
    ),
    Effect.catchTag("GithubUnavailable", (unavailable) =>
      Effect.fail(new GhFailure({ message: unavailable.message })),
    ),
  );

const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** The login's own account, then each organization it belongs to, asked of GitHub directly. */
const ownOwners = (own: Extract<ListAuthority, { readonly kind: "own" }>) =>
  Effect.gen(function* () {
    const api = yield* GithubApi;
    const [user, organizations] = yield* asOwn(
      own,
      Effect.all([api.user(own.token), api.organizations(own.token)], {
        concurrency: "unbounded",
      }),
    );
    // The platform may not have named the login when it was connected: remember what GitHub says.
    if (own.held.login !== user.login)
      yield* (yield* GithubLoginsRepo).keep(own.userId, {
        accountId: own.held.accountId,
        login: user.login,
        sealedToken: own.held.sealedToken,
      });
    return new GhOwnersView({
      login: user.login,
      owners: [
        new GhOwnerView({ login: user.login, kind: "user" }),
        ...organizations
          .filter((name) => GITHUB_LOGIN.test(name))
          .toSorted(byName)
          .map((name) => new GhOwnerView({ login: name, kind: "organization" })),
      ],
    });
  });

/**
 * One owner's repositories, or a search within them, asked of GitHub directly: what the login owns
 * for its own account (and when no owner is named), what it can see for an organization.
 */
const ownRepositories = (
  own: Extract<ListAuthority, { readonly kind: "own" }>,
  owner: string | undefined,
  query: string,
) =>
  Effect.gen(function* () {
    if (owner !== undefined && !GITHUB_LOGIN.test(owner))
      return yield* new GhFailure({ message: `${owner} isn't a GitHub account or organization.` });
    const api = yield* GithubApi;
    const self = own.held.login ?? (yield* asOwn(own, api.user(own.token))).login;
    const mine = owner === undefined || owner.toLowerCase() === self.toLowerCase();
    const words = query.trim();
    if (words !== "")
      return yield* asOwn(
        own,
        api.search(
          own.token,
          mine ? { kind: "user", login: self } : { kind: "organization", login: owner },
          words,
        ),
      );
    return yield* asOwn(
      own,
      mine ? api.ownRepositories(own.token) : api.organizationRepositories(own.token, owner),
    );
  });

/** `gh pr list --json` items. */
const PullRequestItems = Schema.Array(
  Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    state: Schema.String,
    isDraft: Schema.Boolean,
    url: Schema.String,
    headRefName: Schema.String,
    baseRefName: Schema.String,
    author: Schema.NullOr(Schema.Struct({ login: Schema.optionalKey(Schema.String) })),
    reviewDecision: Schema.String,
    additions: Schema.Number,
    deletions: Schema.Number,
    createdAt: Schema.String,
    updatedAt: Schema.String,
    mergedAt: Schema.NullOr(Schema.String),
  }),
);

const PR_LIMIT = 50;
const PR_FIELDS =
  "number,title,state,isDraft,url,headRefName,baseRefName,author,reviewDecision,additions,deletions,createdAt,updatedAt,mergedAt";

const prState = (state: string): "open" | "closed" | "merged" =>
  state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";

export class Gh extends Context.Service<
  Gh,
  {
    /** What the host's gh reports — absence and sign-out are content, not errors. */
    readonly status: () => Effect.Effect<GhStatusView>;
    /** Open, closed, and merged pull requests of one `owner/name`, most recently updated first. */
    readonly pullRequests: (repo: string) => Effect.Effect<ReadonlyArray<PullRequestView>, GhError>;
  }
>()("@mend/api/Gh") {}

/**
 * The live Gh: the real CLI on this machine. A separate constant — embedding
 * it in the class definition loses the provided-service type (`Layer<never>`).
 * Provided at the composition boundary like every other handler dependency:
 * group-scoped `HttpRouter.provideRequest` erases the requirement in types but
 * does NOT reach HttpApi group handlers at runtime ("Service not found").
 */
export const GhLive: Layer.Layer<Gh> = Layer.succeed(Gh, {
  status: () =>
    gh(["--version"]).pipe(
      Effect.flatMap(() =>
        gh(["auth", "status", "--hostname", "github.com"]).pipe(
          Effect.map(({ stdout, stderr }) => {
            const login = /account (\S+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? null;
            return new GhStatusView({
              available: true,
              authenticated: true,
              login,
              detail: null,
            });
          }),
          Effect.catch((error) =>
            Effect.succeed(
              new GhStatusView({
                available: true,
                authenticated: false,
                login: null,
                detail: error.stderr === "" ? "gh is signed out" : error.stderr,
              }),
            ),
          ),
        ),
      ),
      Effect.catch((error) =>
        Effect.succeed(
          new GhStatusView({
            available: false,
            authenticated: false,
            login: null,
            detail: error.stderr === "" ? "gh was not found" : error.stderr,
          }),
        ),
      ),
    ),
  pullRequests: (repo: string) => {
    const args = [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--limit",
      String(PR_LIMIT),
      "--json",
      PR_FIELDS,
    ];
    return gh(args).pipe(
      Effect.flatMap(({ stdout }) => parseJson(PullRequestItems, stdout, args)),
      Effect.map((items) =>
        items.map(
          (item) =>
            new PullRequestView({
              number: item.number,
              title: item.title,
              state: prState(item.state),
              isDraft: item.isDraft,
              url: item.url,
              headRefName: item.headRefName,
              baseRefName: item.baseRefName,
              author: item.author?.login ?? null,
              reviewDecision: item.reviewDecision === "" ? null : item.reviewDecision,
              additions: item.additions,
              deletions: item.deletions,
              createdAt: item.createdAt,
              updatedAt: item.updatedAt,
              mergedAt: item.mergedAt,
            }),
        ),
      ),
    );
  },
});

export const GithubGroupLive = HttpApiBuilder.group(MendApi, "github", (handlers) =>
  handlers
    .handle("repository", ({ payload }) => lookupProjectRepository(payload.repository))
    .handle("status", () =>
      Effect.gen(function* () {
        const authority = yield* listAuthority;
        // The caller's own login answers from Mend's copy of it: no workspace, no call to GitHub.
        if (authority.kind === "own")
          return new GhStatusView({
            available: true,
            authenticated: true,
            login: authority.held.login,
            detail: null,
          });
        if (authority.kind === "none")
          return new GhStatusView({
            available: authority.connectAgain,
            authenticated: false,
            login: authority.login,
            detail: authority.detail,
            ...(authority.connectAgain ? { connectAgain: true } : {}),
          });
        return yield* (yield* Gh).status();
      }),
    )
    .handle("owners", () =>
      Effect.gen(function* () {
        const authority = yield* listAuthority;
        if (authority.kind === "own") return yield* ownOwners(authority);
        if (authority.kind === "none") return yield* new GhFailure({ message: authority.detail });
        return yield* listOwners(hostRun);
      }),
    )
    .handle("repos", ({ query }) =>
      Effect.gen(function* () {
        const authority = yield* listAuthority;
        if (authority.kind === "own")
          return yield* ownRepositories(authority, query.owner, query.query ?? "");
        if (authority.kind === "none") return yield* new GhFailure({ message: authority.detail });
        return yield* listRepos(hostRun, query.owner, query.query ?? "");
      }),
    ),
);
