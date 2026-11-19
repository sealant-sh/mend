import * as http from "node:http";

/**
 * A stand-in for GitHub's REST API, on a local port, for the calls Mend's repository list makes
 * (`GET /user`, `/user/orgs`, `/user/repos`, `/orgs/:org/repos`, `/search/repositories`). It
 * answers in GitHub's shapes, pages `/user/orgs` one organization at a time with a Link header,
 * and can refuse a token (401) or answer as if the rate limit were used up (403). Mend is pointed
 * at it with `MEND_GITHUB_API_URL`, so tests and drives use no one's real GitHub login.
 *
 * Run it alone for a local stack: `node apps/api/test/support/github-stand-in.ts <port>`.
 */

export interface StandInLogin {
  readonly login: string;
  readonly organizations: ReadonlyArray<string>;
}

export interface StandInWorld {
  /** Each token GitHub would accept, and whose login it is. */
  readonly tokens: Readonly<Record<string, StandInLogin>>;
  /** Each account's repositories, most recently pushed first. */
  readonly repositories: Readonly<Record<string, ReadonlyArray<string>>>;
}

export interface StandInRequest {
  readonly method: string;
  readonly path: string;
  /** The Authorization header exactly as it arrived. */
  readonly authorization: string | null;
}

export interface GithubStandIn {
  readonly url: URL;
  readonly requests: Array<StandInRequest>;
  /** Tokens GitHub refuses from now on (401), as if revoked. */
  readonly revoked: Set<string>;
  /** Whether every call answers as if the login's rate limit were used up. */
  rateLimited: boolean;
  /** How long each answer waits, to stand in for the trip to GitHub. */
  latencyMs: number;
  readonly close: () => Promise<void>;
}

/**
 * A small GitHub: one login in two organizations, one of which shows it nothing, and a second login
 * in an organization of its own.
 */
export const STAND_IN_WORLD: StandInWorld = {
  tokens: {
    "stand-in-token-for-linus-p": {
      login: "linus-p",
      organizations: ["northwind", "acme"],
    },
    // A second GitHub login the same person may connect, for work.
    "stand-in-token-for-linus-work": {
      login: "linus-work",
      organizations: ["contoso"],
    },
  },
  repositories: {
    "linus-p": ["dotfiles", "notes"],
    northwind: ["checkout-api", "web", "checkout-web"],
    acme: [],
    "linus-work": ["side-project"],
    contoso: ["portal"],
  },
};

/** The time the stand-in's rate limit "resets": 15:42 UTC on 19 Nov 2026, as epoch seconds. */
export const STAND_IN_RESET = Date.UTC(2026, 10, 19, 15, 42) / 1000;

const pushedAt = (index: number) => new Date(Date.UTC(2026, 10, 19 - index, 12)).toISOString();

const repository = (owner: string, name: string, index: number) => ({
  full_name: `${owner}/${name}`,
  description: index === 0 ? `${name}, most recently pushed` : null,
  private: index % 2 === 0,
  visibility: index % 2 === 0 ? "private" : "public",
  fork: false,
  language: index === 0 ? "TypeScript" : null,
  stargazers_count: index,
  pushed_at: pushedAt(index),
  html_url: `https://github.com/${owner}/${name}`,
});

const repositoriesOf = (world: StandInWorld, owner: string) =>
  (world.repositories[owner] ?? []).map((name, index) => repository(owner, name, index));

export const startGithubStandIn = async (
  world: StandInWorld = STAND_IN_WORLD,
  port = 0,
): Promise<GithubStandIn> => {
  const requests: Array<StandInRequest> = [];
  const state = { rateLimited: false, latencyMs: 0 };
  const revoked = new Set<string>();
  const server = http.createServer((request, response) => {
    const address = new URL(request.url ?? "/", "http://stand-in.invalid");
    const authorization = request.headers.authorization ?? null;
    requests.push({ method: request.method ?? "GET", path: address.pathname, authorization });
    const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      setTimeout(() => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      }, state.latencyMs);
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const who = token === null ? undefined : world.tokens[token];
    if (token === null || who === undefined || revoked.has(token))
      // GitHub's own words never carry the token; this one does, to prove Mend never repeats it.
      return answer(401, {
        message: `Bad credentials (${token ?? "none"})`,
        documentation_url: "https://docs.github.com/rest",
      });
    if (state.rateLimited)
      return answer(
        403,
        { message: `API rate limit exceeded for user ID 1. (${token})` },
        { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(STAND_IN_RESET) },
      );
    const path = address.pathname;
    if (path === "/user") return answer(200, { login: who.login, id: 1 });
    if (path === "/user/orgs") {
      const page = Number(address.searchParams.get("page") ?? "1");
      const organization = who.organizations[page - 1];
      const next =
        page < who.organizations.length
          ? {
              link: `<http://${request.headers.host}/user/orgs?per_page=1&page=${page + 1}>; rel="next"`,
            }
          : {};
      return answer(200, organization === undefined ? [] : [{ login: organization }], next);
    }
    if (path === "/user/repos") return answer(200, repositoriesOf(world, who.login));
    const org = /^\/orgs\/([^/]+)\/repos$/.exec(path)?.[1];
    if (org !== undefined)
      return world.repositories[org] === undefined
        ? answer(404, { message: "Not Found" })
        : answer(200, repositoriesOf(world, org));
    if (path === "/search/repositories") {
      const q = address.searchParams.get("q") ?? "";
      const owner = /\b(?:user|org):(\S+)/.exec(q)?.[1];
      const words = q.replace(/\b(?:user|org):\S+/, "").trim();
      const items = owner === undefined ? [] : repositoriesOf(world, owner);
      return answer(200, {
        total_count: items.length,
        incomplete_results: false,
        items: items.filter((item) => item.full_name.split("/")[1]?.includes(words)),
      });
    }
    return answer(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error("the stand-in has no port");
  return {
    url: new URL(`http://127.0.0.1:${bound.port}`),
    requests,
    revoked,
    get rateLimited() {
      return state.rateLimited;
    },
    set rateLimited(value: boolean) {
      state.rateLimited = value;
    },
    get latencyMs() {
      return state.latencyMs;
    },
    set latencyMs(value: number) {
      state.latencyMs = value;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

if (import.meta.main) {
  const standIn = await startGithubStandIn(STAND_IN_WORLD, Number(process.argv[2] ?? "0"));
  standIn.latencyMs = Number(process.env["STAND_IN_LATENCY_MS"] ?? "0");
  process.stdout.write(`GitHub stand-in on ${standIn.url.href}\n`);
}
