import { execFile } from "node:child_process";

import {
  CurrentUser,
  GhFailure,
  GhOwnersView,
  GhOwnerView,
  GhRepoView,
  GhStatusView,
  MendApi,
  PullRequestView,
} from "@mend/api-contracts";
import { gh as ghIn, PullRequestWorkspaces } from "@mend/landing";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { HttpApiBuilder } from "effect/http-api";

import { GithubIdentity } from "../github-identity.ts";
import { lookupProjectRepository } from "../project-operations.ts";

/**
 * Adoption discovery through the host's own GitHub CLI (plan §17, decided
 * 2026-08-02). The credentials are gh's, not Mend's: whatever `gh auth login`
 * set up on this machine answers here, and a missing or signed-out gh is
 * reported as status — never invented around with a Mend-held token.
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
 * Runs gh with these arguments as some GitHub login: the host's own `gh`, or the caller's `gh` in
 * a short-lived workspace of theirs. A gh that exits nonzero answers with its exit code; `E` is
 * only the failure to run it at all.
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
 * Runs `use` with the caller's own gh: in a short-lived workspace of theirs that carries their
 * connected GitHub login (`PullRequestWorkspaces.within`, as pull request reads do), so the token
 * stays with the platform and never reaches Mend.
 */
const asCaller = <A>(use: (run: GhRun<never>) => Effect.Effect<A, GhFailure>) =>
  Effect.gen(function* () {
    const caller = yield* CurrentUser;
    return yield* (yield* PullRequestWorkspaces)
      .within({ ownerUserId: caller.user.id, sessionId: null }, (workspace) =>
        use((args) =>
          workspace
            .exec(ghIn(args))
            .pipe(
              Effect.catch((error) =>
                Effect.succeed({ exitCode: 1, stdout: "", stderr: error.message }),
              ),
            ),
        ),
      )
      .pipe(
        Effect.catchTag("PullRequestStepError", (error) =>
          Effect.fail(new GhFailure({ message: error.message })),
        ),
      );
  });

/** Whose gh answers the caller (`GithubIdentity`), as a runner of `use`, or why none does. */
const withCallersGh = <A>(use: (run: GhRun<never>) => Effect.Effect<A, GhFailure>) =>
  Effect.gen(function* () {
    const authority = yield* (yield* GithubIdentity).forCaller();
    if (authority.kind === "none") return yield* new GhFailure({ message: authority.detail });
    if (authority.kind === "caller") return yield* asCaller(use);
    return yield* use(hostRun);
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
        const authority = yield* (yield* GithubIdentity).forCaller();
        // The caller's own login answers from their connected accounts, with no workspace.
        if (authority.kind === "caller") {
          return new GhStatusView({
            available: true,
            authenticated: true,
            login: authority.login,
            detail: null,
          });
        }
        if (authority.kind === "none") {
          return new GhStatusView({
            available: false,
            authenticated: false,
            login: null,
            detail: authority.detail,
          });
        }
        const cli = yield* Gh;
        return yield* cli.status();
      }),
    )
    .handle("owners", () => withCallersGh((run) => listOwners(run)))
    .handle("repos", ({ query }) =>
      withCallersGh((run) => listRepos(run, query.owner, query.query ?? "")),
    ),
);
