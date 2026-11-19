import { ConnectedAccount, GhFailure } from "@mend/api-contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyGhError,
  GhError,
  githubCopyFor,
  listOwners,
  listRepos,
  parseGithubRepo,
} from "./github.ts";

describe("parseGithubRepo", () => {
  it("reads owner/name from every GitHub origin shape", () => {
    expect(parseGithubRepo("https://github.com/sealant-sh/mend")).toBe("sealant-sh/mend");
    expect(parseGithubRepo("https://github.com/sealant-sh/mend.git")).toBe("sealant-sh/mend");
    expect(parseGithubRepo("https://www.github.com/sealant-sh/mend/")).toBe("sealant-sh/mend");
    expect(parseGithubRepo("git@github.com:sealant-sh/mend.git")).toBe("sealant-sh/mend");
    expect(parseGithubRepo("ssh://git@github.com/sealant-sh/mend.git")).toBe("sealant-sh/mend");
    expect(parseGithubRepo("github.com:sealant-sh/mend")).toBe("sealant-sh/mend");
  });

  it("answers null for anything that is not GitHub", () => {
    expect(parseGithubRepo(null)).toBeNull();
    expect(parseGithubRepo("https://gitlab.com/sealant-sh/mend.git")).toBeNull();
    expect(parseGithubRepo("/home/yiannis/Developer/mend")).toBeNull();
    expect(parseGithubRepo("git@github.com:sealant-sh")).toBeNull();
    expect(parseGithubRepo("https://github.com/")).toBeNull();
  });
});

const error = (stderr: string, exitCode: number | null = 1) =>
  new GhError({ args: ["pr", "list"], exitCode, stderr });

describe("classifyGhError", () => {
  it("tells a missing gh from a signed-out one from a rate limit", () => {
    expect(classifyGhError(error("spawn gh ENOENT", null))).toBe("gh-missing");
    expect(
      classifyGhError(error("To get started with GitHub CLI, please run:  gh auth login")),
    ).toBe("gh-signed-out");
    expect(classifyGhError(error("HTTP 403: API rate limit exceeded for user ID 1"))).toBe(
      "rate-limited",
    );
    expect(classifyGhError(error("GraphQL: Could not resolve to a Repository"))).toBe("error");
  });
});

const answer = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
const refuse = (stderr: string) => ({ exitCode: 1, stdout: "", stderr });
const pushed = (index: number) => new Date(Date.UTC(2026, 10, 19 - index)).toISOString();

/**
 * A stand-in for gh over a small GitHub: one login, the organizations it belongs to, and each
 * account's repositories. It answers the commands gh answers, in gh's JSON shapes, and refuses
 * anything else the way gh does, so the listings are proven without anyone's real login.
 */
const standInGh = (world: {
  readonly login: string;
  readonly organizations: ReadonlyArray<string>;
  readonly repositories: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly signedOut?: boolean;
}) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const run = (args: ReadonlyArray<string>) =>
    Effect.sync(() => {
      calls.push(args);
      if (world.signedOut === true)
        return refuse("To get started with GitHub CLI, please run:  gh auth login");
      const [command, sub] = args;
      if (command === "api" && sub === "user") return answer(`${world.login}\n`);
      if (command === "api" && sub === "user/orgs")
        return answer(world.organizations.map((name) => `${name}\n`).join(""));
      if (command === "repo" && sub === "list") {
        const named = args[2];
        const owner = named === undefined || named.startsWith("--") ? world.login : named;
        const names = world.repositories[owner];
        if (names === undefined) return refuse(`GraphQL: Could not resolve to a RepositoryOwner`);
        return answer(
          JSON.stringify(
            names.map((name, index) => ({
              nameWithOwner: `${owner}/${name}`,
              description: "",
              visibility: "PRIVATE",
              isFork: false,
              primaryLanguage: null,
              stargazerCount: 0,
              pushedAt: pushed(index),
              url: `https://github.com/${owner}/${name}`,
            })),
          ),
        );
      }
      if (command === "search" && sub === "repos") {
        const at = args.indexOf("--owner");
        const owner = at === -1 ? undefined : args[at + 1];
        const words = args.at(-1) ?? "";
        const found = Object.entries(world.repositories)
          .filter(([account]) => owner === undefined || account === owner)
          .flatMap(([account, names]) =>
            names.filter((name) => name.includes(words)).map((name) => `${account}/${name}`),
          );
        return answer(
          JSON.stringify(
            found.map((fullName) => ({
              fullName,
              description: "",
              visibility: "private",
              isFork: false,
              language: "",
              stargazersCount: 0,
              pushedAt: null,
              url: `https://github.com/${fullName}`,
            })),
          ),
        );
      }
      return refuse(`unknown command "${command}" for "gh"`);
    });
  return { run, calls };
};

const WORLD = {
  login: "linus-p",
  organizations: ["northwind", "acme"],
  repositories: {
    "linus-p": ["dotfiles"],
    northwind: ["checkout-api", "web", "checkout-web"],
    acme: [],
  },
};

const fails = async <A>(effect: Effect.Effect<A, GhFailure>) =>
  Effect.runPromise(Effect.flip(effect));

describe("listing a GitHub login's organizations and repositories", () => {
  it("offers the login's own account first, then each organization it belongs to, by name", async () => {
    const owners = await Effect.runPromise(listOwners(standInGh(WORLD).run));
    expect(owners.login).toBe("linus-p");
    expect(owners.owners.map((owner) => [owner.login, owner.kind])).toEqual([
      ["linus-p", "user"],
      ["acme", "organization"],
      ["northwind", "organization"],
    ]);
  });

  it("lists the chosen organization's repositories, not only what the login owns", async () => {
    const gh = standInGh(WORLD);
    const listed = await Effect.runPromise(listRepos(gh.run, "northwind", ""));
    expect(listed.map((repository) => repository.nameWithOwner)).toEqual([
      "northwind/checkout-api",
      "northwind/web",
      "northwind/checkout-web",
    ]);
    const own = await Effect.runPromise(listRepos(gh.run, undefined, ""));
    expect(own.map((repository) => repository.nameWithOwner)).toEqual(["linus-p/dotfiles"]);
  });

  it("searches within the chosen owner", async () => {
    const listed = await Effect.runPromise(
      listRepos(standInGh(WORLD).run, "northwind", "checkout"),
    );
    expect(listed.map((repository) => repository.nameWithOwner)).toEqual([
      "northwind/checkout-api",
      "northwind/checkout-web",
    ]);
  });

  it("answers an organization that shows the login nothing with an empty list", async () => {
    expect(await Effect.runPromise(listRepos(standInGh(WORLD).run, "acme", ""))).toEqual([]);
  });

  it("refuses an owner that isn't a GitHub name before gh runs", async () => {
    const gh = standInGh(WORLD);
    const refused = await fails(listRepos(gh.run, "--help", ""));
    expect(refused).toBeInstanceOf(GhFailure);
    expect(gh.calls).toEqual([]);
  });

  it("passes on gh's own words when the login is signed out", async () => {
    const refused = await fails(listOwners(standInGh({ ...WORLD, signedOut: true }).run));
    expect(refused.message).toContain("gh auth login");
  });
});

const githubLogin = (id: string, isDefault: boolean) =>
  new ConnectedAccount({
    id,
    provider: "github",
    name: id,
    kind: "gh-cli-token",
    status: "active",
    metadata: { login: id },
    connectedAt: new Date("2026-11-19T10:00:00.000Z"),
    updatedAt: new Date("2026-11-19T10:00:00.000Z"),
    lastUsedAt: null,
    isDefault,
  });
const copyOf = (accountId: string) => ({
  accountId,
  login: accountId,
  sealedToken: `v1.sealed.${accountId}`,
  updatedAt: new Date("2026-11-19T10:00:00.000Z"),
});

describe("which of Mend's copies the list uses", () => {
  it("asks the person to choose when they hold several GitHub logins and none is the default", () => {
    const { choice } = githubCopyFor(
      [githubLogin("personal", false), githubLogin("work", false)],
      [copyOf("personal"), copyOf("work")],
    );
    expect(choice).toEqual({ kind: "choose" });
  });

  it("uses a lone copy when the platform can't be read, and guesses between none of several", () => {
    expect(githubCopyFor(null, [copyOf("personal")]).choice).toEqual({
      kind: "copy",
      copy: copyOf("personal"),
    });
    expect(githubCopyFor(null, [copyOf("personal"), copyOf("work")]).choice).toEqual({
      kind: "unknown",
    });
    expect(githubCopyFor(null, [copyOf("personal")]).stale).toEqual([]);
  });
});
