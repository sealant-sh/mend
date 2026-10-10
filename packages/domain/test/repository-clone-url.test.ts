import { Result, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  redactRepositoryUrl,
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

  it("reads userinfo whatever it holds: quotes, angle brackets, spaces, unicode, escapes", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      // The reviewer's case: a real HTTP Basic clone accepted this before (review of mend#640).
      ["http://user:se'cret@127.0.0.1:8080/origin.git", "http://127.0.0.1:8080/origin.git"],
      ['https://user:se"cret@github.com/o/r.git', "https://github.com/o/r.git"],
      ["https://user:<secret>@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://us er:pa ss@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://ünï:pässwörd🔑@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://us%40er:p%3As%22s@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://a@b:c@d@github.com/o/r.git", "https://github.com/o/r.git"],
      ["ssh://git:se'cret@host.example/r.git", "ssh://git@host.example/r.git"],
    ];
    for (const [stored, shown] of cases) {
      expect(repositoryUrlHasCredential(stored), stored).toBe(true);
      expect(redactRepositoryUrl(stored), stored).toBe(shown);
      expect(repositoryCloneUrlIssue(stored), stored).not.toBeNull();
      expect(Result.isFailure(decode(stored)), stored).toBe(true);
    }
    // Free text reads the same way: a URL is redacted where it stands, and whitespace inside its
    // userinfo does not end it (a URL parser drops a tab and encodes a space; review 3 of mend#611).
    expect(
      redactUrlCredentials("mend: unknown argument https://oauth2:p\tse cret@github.com/a/r"),
    ).toBe("mend: unknown argument https://github.com/a/r");
    expect(
      redactUrlCredentials(
        "fatal: unable to access 'http://user:se'cret<x>@127.0.0.1/origin.git/': 401",
      ),
    ).toBe("fatal: unable to access 'http://127.0.0.1/origin.git/': 401");
  });

  // Anything but the characters that end an authority (`/`, `?`, `#`) can be userinfo.
  const userinfoPart = FastCheck.string({ unit: "binary", maxLength: 24 }).filter(
    (value) => !/[/?#]/u.test(value),
  );
  const host = FastCheck.constantFrom("github.com", "git.example.test:8443", "127.0.0.1", "[::1]");

  it("finds and removes any generated credential, as one URL and inside text", () => {
    FastCheck.assert(
      FastCheck.property(
        userinfoPart,
        userinfoPart,
        host,
        FastCheck.constantFrom("https", "http", "git"),
        (user, password, at, scheme) => {
          const clean = `${scheme}://${at}/org/repo.git`;
          const stored = `${scheme}://${user}:${password}@${at}/org/repo.git`;
          expect(repositoryUrlHasCredential(stored)).toBe(true);
          expect(redactRepositoryUrl(stored)).toBe(clean);
          expect(repositoryUrlHasCredential(redactRepositoryUrl(stored))).toBe(false);
          expect(redactUrlCredentials(`clone '${stored}' failed`)).toBe(`clone '${clean}' failed`);
        },
      ),
    );
  });

  // Whitespace of every kind, and what may stand before a scheme in text (review 2 of mend#640, N4).
  const whitespace = FastCheck.constantFrom(" ", "\t", "\n", "\r", "\u00a0", "\u2003");
  const before = FastCheck.constantFrom(
    "",
    ".",
    "...",
    "-",
    "--",
    "1",
    "x",
    "(",
    "'",
    '"',
    "<",
    "`",
  );

  it("redacts text whatever whitespace the userinfo holds and whatever stands before the scheme", () => {
    FastCheck.assert(
      FastCheck.property(
        userinfoPart,
        whitespace,
        userinfoPart,
        before,
        FastCheck.constantFrom("https", "http", "git"),
        (head, space, tail, prefix, scheme) => {
          const secret = `${head}${space}${tail}`;
          const text = `failed ${prefix}${scheme}://user:${secret}@github.com/org/repo.git: 403`;
          const redacted = redactUrlCredentials(text);
          expect(redacted).toBe(`failed ${prefix}${scheme}://github.com/org/repo.git: 403`);
        },
      ),
    );
  });

  // Review of mend#666: a rule that ended an authority at whitespace unless a host and a path
  // followed printed each of these whole. Every one stays redacted.
  it("redacts a password holding whitespace whatever follows the host", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["https://user:pa ss@host", "https://host"],
      ["https://oauth2:p\ttok@github.com", "https://github.com"],
      ["https://user:pa ss@host:8080", "https://host:8080"],
      ["fatal: https://user:pa ss@host refused", "fatal: https://host refused"],
      [
        "fatal: unable to access 'https://user:pa ss@host': 403",
        "fatal: unable to access 'https://host': 403",
      ],
      ['{"url":"https://user:pa ss@host"}', '{"url":"https://host"}'],
      ['{"url":"https://user:pa ss@host","path":"/x"}', '{"url":"https://host","path":"/x"}'],
      [
        "remote https://user:pa ss@host\nnext line /var/log",
        "remote https://host\nnext line /var/log",
      ],
      ["https://to ken@host", "https://host"],
      ["https:// user:tok@host", "https://host"],
      ["https://user:pa ss@[fe80::1%25eth0]/repo", "https://[fe80::1%25eth0]/repo"],
      ["https://user:pa ss@[v1.x]/repo", "https://[v1.x]/repo"],
    ];
    for (const [text, shown] of cases) {
      const redacted = redactUrlCredentials(text);
      expect(redacted, text).toBe(shown);
      expect(redacted, text).not.toMatch(/pa ss|p\ttok|to ken|user:tok/u);
    }
  });

  it("finds a URL that starts where another's authority ends, and stays linear in what it reads", () => {
    expect(redactUrlCredentials("https://user:x://evil:TOKEN@host/")).toBe(
      "https://user:x://host/",
    );
    expect(redactUrlCredentials("https://a:b@c://d:TOKEN@e/")).toBe("https://c://e/");
    const start = performance.now();
    for (const text of [
      `${"a".repeat(1_000_000)}://x`,
      "a://".repeat(250_000),
      `https://${"@".repeat(1_000_000)}`,
      `https://${"u".repeat(1_000_000)}@h/`,
    ]) {
      redactUrlCredentials(text);
    }
    // Quadratic would be minutes; linear is tens of milliseconds.
    expect(performance.now() - start).toBeLessThan(2_000);
  });

  it("keeps an ssh login and removes only what follows it", () => {
    FastCheck.assert(
      FastCheck.property(segment, userinfoPart, (login, password) => {
        const stored = `ssh://${login}:${password}@host.example/repo.git`;
        expect(redactRepositoryUrl(stored)).toBe(`ssh://${login}@host.example/repo.git`);
      }),
    );
  });
});
