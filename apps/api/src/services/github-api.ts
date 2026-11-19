import { GhRepoView } from "@mend/api-contracts";
import { Config, Effect, Layer, Redacted, Schema } from "effect";
import * as Context from "effect/Context";

/**
 * GitHub's REST API, asked as one person's own GitHub login (docs/adr/0028). Only the repository
 * picker calls it: the person's account, their organizations, and the repositories of one owner.
 * The token reaches only `fetch`'s Authorization header, and only for the configured API origin.
 */

/** GitHub answered 401: the login is no longer good. */
export class GithubLoginRefused extends Schema.TaggedError<GithubLoginRefused>()(
  "GithubLoginRefused",
  { message: Schema.String },
) {}

/** GitHub couldn't be asked, or answered with something other than what was asked for. */
export class GithubUnavailable extends Schema.TaggedError<GithubUnavailable>()(
  "GithubUnavailable",
  { message: Schema.String },
) {}

export type GithubApiFailure = GithubLoginRefused | GithubUnavailable;

/** Whose repositories a search looks within: the login's own account, or an organization. */
export interface SearchOwner {
  readonly kind: "user" | "organization";
  readonly login: string;
}

export class GithubApi extends Context.Service<
  GithubApi,
  {
    /** The account the token belongs to (`GET /user`). */
    readonly user: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<{ readonly login: string }, GithubApiFailure>;
    /** Every organization the login belongs to (`GET /user/orgs`, all pages), by name. */
    readonly organizations: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ReadonlyArray<string>, GithubApiFailure>;
    /** What the login owns, most recently pushed first. */
    readonly ownRepositories: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<ReadonlyArray<GhRepoView>, GithubApiFailure>;
    /** What the login can see in one organization, most recently pushed first. */
    readonly organizationRepositories: (
      token: Redacted.Redacted<string>,
      organization: string,
    ) => Effect.Effect<ReadonlyArray<GhRepoView>, GithubApiFailure>;
    /** Repositories matching `words` within one owner. */
    readonly search: (
      token: Redacted.Redacted<string>,
      owner: SearchOwner,
      words: string,
    ) => Effect.Effect<ReadonlyArray<GhRepoView>, GithubApiFailure>;
  }
>()("@mend/api/GithubApi") {}

/** How many repositories one list or search returns (the picker shows up to this many). */
export const REPOSITORY_LIMIT = 30;
/** GitHub answers within this window, or the list says it didn't. */
const TIMEOUT_MS = 10_000;
/** A person in more organizations than 100 per page × this many is shown the first ones. */
const MAX_ORGANIZATION_PAGES = 10;

const GithubAccount = Schema.Struct({ login: Schema.String });
const GithubOrganizations = Schema.Array(GithubAccount);
const GithubRepository = Schema.Struct({
  full_name: Schema.String,
  description: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
  visibility: Schema.optional(Schema.String),
  fork: Schema.Boolean,
  language: Schema.NullOr(Schema.String),
  stargazers_count: Schema.Number,
  pushed_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
});
const GithubRepositories = Schema.Array(GithubRepository);
const GithubSearch = Schema.Struct({ items: GithubRepositories });
/** GitHub's error body: only its `message` is ever read. */
const GithubErrorBody = Schema.Struct({ message: Schema.String });

const repositoryView = (repository: typeof GithubRepository.Type): GhRepoView =>
  new GhRepoView({
    nameWithOwner: repository.full_name,
    description: repository.description === "" ? null : repository.description,
    visibility: repository.visibility ?? (repository.private ? "private" : "public"),
    isFork: repository.fork,
    language: repository.language === "" ? null : repository.language,
    stars: Math.trunc(repository.stargazers_count),
    pushedAt: repository.pushed_at,
    url: repository.html_url,
  });

/** The `rel="next"` address in a Link header, if any. */
const nextLink = (header: string | null): string | null => {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
};

/** A time of day GitHub gave as epoch seconds, as a person reads it (UTC). */
const clockTime = (epochSeconds: number): string =>
  `${new Date(epochSeconds * 1000).toISOString().slice(11, 16)} UTC`;

/**
 * What GitHub said, fit to show: its `message` only, never the body, with anything that looks like
 * the token taken out and the length bounded.
 */
const githubWords = (body: unknown, token: string): string | null => {
  const decoded = Schema.decodeUnknownOption(GithubErrorBody)(body);
  if (decoded._tag === "None") return null;
  const words = decoded.value.message.split(token).join("…").replace(/\s+/g, " ").trim();
  if (words === "") return null;
  return words.length > 200 ? `${words.slice(0, 199)}…` : words;
};

interface Answer {
  readonly body: unknown;
  readonly next: string | null;
}

/** GitHub's API at `baseUrl` (GitHub Enterprise's `/api/v3` prefix included, when it has one). */
export const makeGithubApi = (baseUrl: URL): GithubApi["Service"] => {
  const base = new URL(baseUrl.href.endsWith("/") ? baseUrl.href : `${baseUrl.href}/`);
  /** Whether an address is on the configured API, the only place the token is ever sent. */
  const onApi = (address: URL) =>
    address.origin === base.origin && address.pathname.startsWith(base.pathname);

  /** One GET as the login: `asked` names the call in every sentence a failure becomes. */
  const get = (
    token: Redacted.Redacted<string>,
    address: URL,
    asked: string,
  ): Effect.Effect<Answer, GithubApiFailure> =>
    Effect.gen(function* () {
      if (!onApi(address))
        return yield* new GithubUnavailable({
          message: `GitHub pointed Mend away from ${base.host} when it asked for ${asked}.`,
        });
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(address, {
            headers: {
              accept: "application/vnd.github+json",
              authorization: `Bearer ${Redacted.value(token)}`,
              "user-agent": "mend",
              "x-github-api-version": "2022-11-28",
            },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          }),
        // Never keep the request, its headers or fetch's own exception.
        catch: () =>
          new GithubUnavailable({
            message: `Mend couldn't reach GitHub at ${base.host} when it asked for ${asked}.`,
          }),
      });
      const body: unknown = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      if (response.ok) return { body, next: nextLink(response.headers.get("link")) };
      const said = githubWords(body, Redacted.value(token));
      if (response.status === 401)
        return yield* new GithubLoginRefused({
          message: `GitHub refused your GitHub login when Mend asked for ${asked}${said === null ? "" : ` ("${said}")`}. Connect GitHub again with mend connect github.`,
        });
      const remaining = response.headers.get("x-ratelimit-remaining");
      const limited =
        response.status === 429 ||
        (response.status === 403 && (remaining === "0" || /rate limit/i.test(said ?? "")));
      if (limited) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const retryAfter = Number(response.headers.get("retry-after"));
        const until =
          Number.isFinite(reset) && reset > 0
            ? ` until ${clockTime(reset)}`
            : Number.isFinite(retryAfter) && retryAfter > 0
              ? ` for ${Math.ceil(retryAfter)} seconds`
              : "";
        return yield* new GithubUnavailable({
          message: `GitHub's rate limit for your login is used up${until}. Mend asked for ${asked}.`,
        });
      }
      return yield* new GithubUnavailable({
        message: `GitHub answered ${response.status} when Mend asked for ${asked}${said === null ? "." : `: ${said}`}`,
      });
    }).pipe(
      Effect.tapError((failure) =>
        Effect.logInfo("github: a call to GitHub's API failed").pipe(
          Effect.annotateLogs({ asked, failure: failure._tag }),
        ),
      ),
      Effect.withSpan("GithubApi.get", { attributes: { asked } }),
    );

  const decode = <S extends Schema.Decoder<unknown>>(schema: S, body: unknown, asked: string) =>
    Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(
        () =>
          new GithubUnavailable({
            message: `GitHub's answer to ${asked} wasn't one Mend can read.`,
          }),
      ),
    );

  const at = (path: string, params: Readonly<Record<string, string>>) => {
    const address = new URL(path, base);
    for (const [key, value] of Object.entries(params)) address.searchParams.set(key, value);
    return address;
  };

  const repositories = (token: Redacted.Redacted<string>, address: URL, asked: string) =>
    get(token, address, asked).pipe(
      Effect.flatMap((answer) => decode(GithubRepositories, answer.body, asked)),
      Effect.map((items) => items.slice(0, REPOSITORY_LIMIT).map(repositoryView)),
    );

  const listing = {
    sort: "pushed",
    direction: "desc",
    per_page: String(REPOSITORY_LIMIT),
  } as const;

  return GithubApi.of({
    user: (token) =>
      get(token, at("user", {}), "your GitHub account").pipe(
        Effect.flatMap((answer) => decode(GithubAccount, answer.body, "your GitHub account")),
      ),
    organizations: (token) =>
      Effect.gen(function* () {
        const asked = "your organizations";
        const names: Array<string> = [];
        let address: URL | null = at("user/orgs", { per_page: "100" });
        for (let page = 0; address !== null && page < MAX_ORGANIZATION_PAGES; page += 1) {
          const answer: Answer = yield* get(token, address, asked);
          const organizations = yield* decode(GithubOrganizations, answer.body, asked);
          names.push(...organizations.map((organization) => organization.login));
          address = answer.next === null ? null : new URL(answer.next);
        }
        return names;
      }),
    ownRepositories: (token) =>
      repositories(
        token,
        at("user/repos", { affiliation: "owner", ...listing }),
        "the repositories you own",
      ),
    organizationRepositories: (token, organization) =>
      repositories(
        token,
        at(`orgs/${encodeURIComponent(organization)}/repos`, { type: "all", ...listing }),
        `the repositories in ${organization}`,
      ),
    search: (token, owner, words) => {
      const asked = `repositories matching "${words}" in ${owner.login}`;
      const qualifier = owner.kind === "user" ? "user" : "org";
      return get(
        token,
        at("search/repositories", {
          q: `${words} ${qualifier}:${owner.login}`,
          per_page: String(REPOSITORY_LIMIT),
        }),
        asked,
      ).pipe(
        Effect.flatMap((answer) => decode(GithubSearch, answer.body, asked)),
        Effect.map((found) => found.items.slice(0, REPOSITORY_LIMIT).map(repositoryView)),
      );
    },
  });
};

/** GitHub's API at a given address: a stand-in in tests, GitHub Enterprise, or GitHub itself. */
export const githubApiLayer = (baseUrl: URL): Layer.Layer<GithubApi> =>
  Layer.succeed(GithubApi, makeGithubApi(baseUrl));

/** GitHub's API at `MEND_GITHUB_API_URL`, `https://api.github.com` unless it says otherwise. */
export const GithubApiLive: Layer.Layer<GithubApi, Config.ConfigError> = Layer.unwrap(
  Effect.gen(function* () {
    const baseUrl = yield* Config.URL("MEND_GITHUB_API_URL").pipe(
      Config.withDefault(new URL("https://api.github.com")),
    );
    return githubApiLayer(baseUrl);
  }),
);
