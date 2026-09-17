import { execFile } from "node:child_process";

import { GhFailure, GhRepoView, GhStatusView, MendApi, PullRequestView } from "@mend/api-contracts";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import { GithubIdentity } from "../github-identity.ts";

/**
 * Adoption discovery through the host's own GitHub CLI (plan §17, decided
 * 2026-08-02). The credentials are gh's, not Mend's: whatever `gh auth login`
 * set up on this machine answers here, and a missing or signed-out gh is
 * reported as status — never invented around with a Mend-held token.
 */

/** A gh invocation that exited nonzero (or could not run at all). */
export class GhError extends Schema.TaggedErrorClass<GhError>()("GhError", {
  args: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  stderr: Schema.String,
}) {}

interface ExecFailure {
  readonly code?: number | string;
  readonly stderr?: string;
  readonly message?: string;
}

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
        const failure = error as ExecFailure;
        resume(
          Effect.fail(
            new GhError({
              args: [...args],
              exitCode: typeof failure.code === "number" ? failure.code : null,
              stderr: (failure.stderr ?? failure.message ?? "").trim(),
            }),
          ),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

const parseJson = <T>(raw: string, args: ReadonlyArray<string>): Effect.Effect<T, GhError> =>
  Effect.try({
    try: () => JSON.parse(raw) as T,
    catch: () =>
      new GhError({ args: [...args], exitCode: null, stderr: "gh returned unparseable JSON" }),
  });

/** `gh repo list --json` item — visibility UPPERCASE, language nested. */
interface RepoListItem {
  readonly nameWithOwner: string;
  readonly description: string;
  readonly visibility: string;
  readonly isFork: boolean;
  readonly primaryLanguage: { readonly name: string } | null;
  readonly stargazerCount: number;
  readonly pushedAt: string | null;
  readonly url: string;
}

/** `gh search repos --json` item — visibility lowercase, language flat. */
interface RepoSearchItem {
  readonly fullName: string;
  readonly description: string;
  readonly visibility: string;
  readonly isFork: boolean;
  readonly language: string | null;
  readonly stargazersCount: number;
  readonly pushedAt: string | null;
  readonly url: string;
}

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

/** `gh pr list --json` item. */
interface PullRequestItem {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly url: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly author: { readonly login?: string } | null;
  readonly reviewDecision: string;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mergedAt: string | null;
}

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
    /** Empty query: the account's repos, most recently pushed first. Otherwise a GitHub-wide search. */
    readonly repos: (query: string) => Effect.Effect<ReadonlyArray<GhRepoView>, GhError>;
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
  repos: (query: string) => {
    const trimmed = query.trim();
    if (trimmed === "") {
      const args = ["repo", "list", "--limit", String(REPO_LIMIT), "--json", LIST_FIELDS];
      return gh(args).pipe(
        Effect.flatMap(({ stdout }) => parseJson<ReadonlyArray<RepoListItem>>(stdout, args)),
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
      );
    }
    // `--` so a query is always positional, never parsed as a flag.
    const args = [
      "search",
      "repos",
      "--limit",
      String(REPO_LIMIT),
      "--json",
      SEARCH_FIELDS,
      "--",
      trimmed,
    ];
    return gh(args).pipe(
      Effect.flatMap(({ stdout }) => parseJson<ReadonlyArray<RepoSearchItem>>(stdout, args)),
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
  },
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
      Effect.flatMap(({ stdout }) => parseJson<ReadonlyArray<PullRequestItem>>(stdout, args)),
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
    .handle("status", () =>
      Effect.gen(function* () {
        const authority = yield* (yield* GithubIdentity).forCaller();
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
    .handle("repos", ({ query }) =>
      Effect.gen(function* () {
        const authority = yield* (yield* GithubIdentity).forCaller();
        if (authority.kind === "none") return yield* new GhFailure({ message: authority.detail });
        const cli = yield* Gh;
        return yield* cli
          .repos(query.query ?? "")
          .pipe(
            Effect.mapError(
              (error) =>
                new GhFailure({ message: error.stderr === "" ? String(error) : error.stderr }),
            ),
          );
      }),
    ),
);
