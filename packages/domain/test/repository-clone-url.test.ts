import { Result, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  redactUrlCredentials,
  REPOSITORY_URL_CREDENTIAL_GUIDANCE,
  repositoryUrlHasCredential,
} from "../src/repository-url.ts";
import { RepositoryCloneUrl, repositoryCloneUrlIssue } from "../src/workbench/project.ts";

const accepted = [
  "https://github.com/sealant-sh/Mend",
  "http://git.example.test/team/repo.git",
  "ssh://git@git.example.test:2222/team/repo.git",
  "git@git.example.test:team/repo.git",
  "host:repo",
  "host:/srv/repo.git",
  "git@host:~/repo.git",
  "git@[::1]:team/repo.git",
  "[2001:db8::1]:/srv/repo.git",
  "ssh://git@[::1]:2222/repo.git",
  "git://git.example.test/team/repo.git",
  "http://127.0.0.1:8080/team/repo.git",
] as const;

const rejected = [
  "--upload-pack=foo@host:repo",
  "-host:repo",
  "ext::/bin/false",
  "https::https://host/repo",
  "custom::host:repo",
  "file:///Users/me/code/repo",
  "file:/srv/repo",
  "file:repo",
  "/Users/me/code/repo",
  "../repo",
  "./repo",
  "repo",
  "~/repo",
  "./host:repo",
  "C:\\Users\\me\\repo",
  "C:/Users/me/repo",
  "C:repo",
  "c:relative/repo",
  "C://repo/path",
  "\\\\server\\share\\repo",
  "//server/share/repo",
  "https://github.com",
  "https://github.com/",
  "https:///github.com/repo",
  "https:/github.com/repo",
  "https://host\\other/repo",
  "https://host/repo\u0000suffix",
  "https://host/repo\n",
  " host:repo",
  "host:repo ",
  "host:",
  "git@-host:repo",
  "ftp://host/repo",
  "EXT::/bin/false",
  "",
] as const;

const decode = Schema.decodeUnknownResult(RepositoryCloneUrl);
const encode = Schema.encodeSync(RepositoryCloneUrl);

const expectRejected = (value: string) => {
  expect(repositoryCloneUrlIssue(value)).toContain("Local paths and file:// URLs");
  expect(Result.isFailure(decode(value))).toBe(true);
};

// Generated names exclude separators deliberately, so the property varies names
// without accidentally changing which Git transport syntax it is exercising.
const segment = FastCheck.array(
  FastCheck.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"),
  {
    minLength: 1,
    maxLength: 30,
  },
).map((chars) => chars.join(""));

const networkUrl = FastCheck.tuple(segment, segment, segment).chain(([host, owner, repo]) =>
  FastCheck.constantFrom(
    `https://git-${host}.test/${owner}/${repo}.git`,
    `http://git-${host}.test/${owner}/${repo}.git`,
    `ssh://git@git-${host}.test:2222/${owner}/${repo}.git`,
    `git@git-${host}.test:${owner}/${repo}.git`,
    `git://git-${host}.test/${owner}/${repo}.git`,
  ),
);

describe("RepositoryCloneUrl", () => {
  it.each(accepted)("accepts %s without rewriting Git's source", (value) => {
    expect(repositoryCloneUrlIssue(value)).toBeNull();
    const result = decode(value);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) expect(encode(result.success)).toBe(value);
  });

  it.each(rejected)("rejects %s", expectRejected);

  it("roundtrips generated network URLs without changing their transport spelling", () => {
    FastCheck.assert(
      FastCheck.property(networkUrl, (value) => {
        const result = decode(value);
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result)) expect(encode(result.success)).toBe(value);
      }),
    );
  });

  it("never accepts option-prefixed or external-helper sources", () => {
    FastCheck.assert(
      FastCheck.property(segment, networkUrl, (helper, source) => {
        expectRejected(`--upload-pack=${helper}@host:repo`);
        expectRejected(`-${source}`);
        expectRejected(`${helper}::${source}`);
        expectRejected(`${helper}::/bin/false`);
      }),
    );
  });

  it("rejects generated local and Windows drive paths", () => {
    FastCheck.assert(
      FastCheck.property(
        segment,
        FastCheck.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        (repo, drive) => {
          for (const source of [
            repo,
            `./${repo}`,
            `../${repo}`,
            `/${repo}`,
            `file:${repo}`,
            `${drive}:${repo}`,
            `${drive}:/${repo}`,
            `${drive}:\\${repo}`,
          ]) {
            expectRejected(source);
          }
        },
      ),
    );
  });
});

describe("a credential in a repository URL", () => {
  const withCredential = [
    "https://oauth2:glpat-xyz@gitlab.com/org/repo.git",
    "https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/org/repo.git",
    "https://x-access-token:ghs_abc@github.com/org/repo.git",
    "http://deploy:s3cret@git.example.test/team/repo.git",
    "https://deploy@git.example.test/team/repo.git",
    "https://:token-only@git.example.test/team/repo.git",
    "git://user@git.example.test/team/repo.git",
    "ssh://git:s3cret@git.example.test/team/repo.git",
  ] as const;

  it.each(withCredential)("refuses %s, naming the supported ways instead", (value) => {
    expect(repositoryUrlHasCredential(value)).toBe(true);
    expect(repositoryCloneUrlIssue(value)).toBe(REPOSITORY_URL_CREDENTIAL_GUIDANCE);
    expect(Result.isFailure(decode(value))).toBe(true);
    expect(REPOSITORY_URL_CREDENTIAL_GUIDANCE).toContain("mend keys");
  });

  it("keeps an ssh login name, which is how the host is reached", () => {
    for (const value of [
      "ssh://git@git.example.test:2222/team/repo.git",
      "git@git.example.test:team/repo.git",
      "https://github.com/sealant-sh/Mend",
    ]) {
      expect(repositoryUrlHasCredential(value)).toBe(false);
      expect(redactUrlCredentials(value)).toBe(value);
    }
  });

  it("redacts the credential and keeps where the repository is", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://oauth2:glpat-xyz@gitlab.com/org/repo.git", "https://gitlab.com/org/repo.git"],
      ["https://ghp_abc@github.com/org/repo.git", "https://github.com/org/repo.git"],
      // A raw `@` in the password: everything up to the last one before the path goes.
      [
        "https://user:p@ss@host.example:8443/org/repo.git",
        "https://host.example:8443/org/repo.git",
      ],
      ["ssh://git:s3cret@host.example/srv/repo.git", "ssh://git@host.example/srv/repo.git"],
      ["git+ssh://:s3cret@host.example/repo.git", "git+ssh://host.example/repo.git"],
    ];
    for (const [stored, shown] of cases) expect(redactUrlCredentials(stored), stored).toBe(shown);
  });

  it("redacts every URL in free text, as git's errors and log lines carry them", () => {
    expect(
      redactUrlCredentials(
        "Command failed: git clone --bare -- https://oauth2:TOKEN@github.com/org/repo.git /store/p/repo.git\nfatal: unable to access 'https://oauth2:TOKEN@github.com/org/repo.git/': 403",
      ),
    ).toBe(
      "Command failed: git clone --bare -- https://github.com/org/repo.git /store/p/repo.git\nfatal: unable to access 'https://github.com/org/repo.git/': 403",
    );
  });

  it("never leaves a generated token behind", () => {
    FastCheck.assert(
      FastCheck.property(segment, segment, networkUrl, (user, token, url) => {
        const withToken = url.replace("://", `://${user}:${token}@`).replace("git@", "");
        expect(redactUrlCredentials(withToken)).not.toContain(`:${token}@`);
      }),
    );
  });
});
