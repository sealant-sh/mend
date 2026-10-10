import * as path from "node:path";

import { redactRepositoryUrl, repositoryUrlHasCredential } from "@mend/domain/workbench";
import { Effect } from "effect";

import { git, GitError } from "./git.ts";

/**
 * A repository Mend runs git with, or hands a workspace, must have no login or token in its git
 * config (docs/GIT-ACCESS.md, "Credentials in repository URLs"). Servers before 0.36 cloned an
 * adopted URL as typed, token included. Mend never rewrites a store's config: it reads it, and
 * refuses every fetch, push, worktree and workspace mount of a repository whose config has a remote
 * URL with a credential, a `url.<base>.insteadOf` whose base holds one, or any include (Mend never
 * writes one, and a conditional one can turn on in a worktree after a check passed).
 *
 * What a person reads (an HTTP response, a session line) names the kind of thing found and that an
 * operator must remove it, never a URL, a config key that can hold one, or a path. The server log
 * carries the exact command for each finding, built from clean parts only.
 */

/** The config keys that decide where git's transport goes: remote URLs and URL rewrites. */
const REMOTE_CONFIG_KEYS = String.raw`^(remote\..*\.(url|pushurl)|url\..*\.(insteadof|pushinsteadof))$`;

/** The include keys: `include.path` and every `includeIf.<condition>.path`. */
const INCLUDE_KEYS = String.raw`^include(if\..*)?\.path$`;

/** A remote name that is only a name: echoed as is, and safe as a command's argument. */
const PLAIN_NAME = /^[A-Za-z0-9][\w.-]*$/u;

/**
 * One thing in a repository's git config that keeps Mend from running git with it. `what` names
 * it for anyone to read: a key only when it cannot hold a URL (`remote.origin.url`,
 * `include.path`), otherwise its kind (`an includeIf condition`, `a url rewrite (insteadOf)`).
 * `fix` is the command an operator runs where the store is, for the server log only.
 */
export interface RemoteCredentialFinding {
  readonly what: string;
  readonly file: string;
  readonly fix: string;
}

/** A shell word, quoted only when it has to be. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** One config entry, with the file it was read from as git names it (relative to where it ran). */
interface ConfigEntry {
  readonly origin: string;
  readonly key: string;
  readonly value: string;
}

/** `git config -z --show-origin` output: NUL-separated origin and `key\nvalue` pairs. */
const configEntries = (listed: string): ReadonlyArray<ConfigEntry> => {
  const fields = listed.split("\0");
  const entries: Array<ConfigEntry> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const entry = fields[index + 1] ?? "";
    const newline = entry.indexOf("\n");
    entries.push({
      origin: (fields[index] ?? "").replace(/^file:/u, ""),
      key: newline === -1 ? entry : entry.slice(0, newline),
      value: newline === -1 ? "" : entry.slice(newline + 1),
    });
  }
  return entries;
};

/**
 * What in the git config of the repository at `gitDir` (a project's bare store, a reference
 * clone, a worktree, which shares its store's config) keeps Mend from running git with it. Read
 * only: three `git config` reads, a few milliseconds.
 */
export const remoteCredentialFindings = (
  gitDir: string,
): Effect.Effect<ReadonlyArray<RemoteCredentialFinding>, GitError> =>
  Effect.gen(function* () {
    const absoluteGitDir = yield* git(["rev-parse", "--absolute-git-dir"], gitDir);
    const editor = `git --git-dir=${shellWord(absoluteGitDir)} config --edit`;
    // git names a file as it opened it, relative to where it ran: `gitDir`, not its git dir.
    const fileOf = (origin: string) => path.resolve(gitDir, origin);
    const findings: Array<RemoteCredentialFinding> = [];

    const includes = configEntries(
      yield* git(
        ["config", "-z", "--local", "--no-includes", "--show-origin", "--get-regexp", INCLUDE_KEYS],
        gitDir,
        undefined,
        [1],
      ),
    );
    for (const include of includes) {
      // An includeIf condition can itself hold a URL (`hasconfig:remote.*.url:…`): never echoed.
      const plain = include.key === "include.path";
      findings.push({
        what: plain ? "include.path" : "an includeIf condition",
        file: fileOf(include.origin),
        fix: plain
          ? `git --git-dir=${shellWord(absoluteGitDir)} config --unset-all include.path`
          : `${editor}   # remove the includeIf section`,
      });
    }

    // `-z`: a value may hold a newline, so entries end in NUL and a key ends at its first newline.
    const entries = configEntries(
      yield* git(
        [
          "config",
          "-z",
          "--local",
          "--includes",
          "--show-origin",
          "--get-regexp",
          REMOTE_CONFIG_KEYS,
        ],
        gitDir,
        undefined,
        [1],
      ),
    );
    const seen = new Set<string>();
    for (const entry of entries) {
      const file = fileOf(entry.origin);
      if (seen.has(`${file}\0${entry.key}`)) continue;
      if (/^url\./iu.test(entry.key)) {
        const base = entry.key.slice("url.".length, entry.key.lastIndexOf("."));
        if (!repositoryUrlHasCredential(base)) continue;
        seen.add(`${file}\0${entry.key}`);
        findings.push({
          what: "a url rewrite (insteadOf)",
          file,
          fix: `${editor}   # remove the url section whose address holds a login`,
        });
        continue;
      }
      const clean = redactRepositoryUrl(entry.value);
      if (clean === entry.value) continue;
      seen.add(`${file}\0${entry.key}`);
      const push = entry.key.endsWith(".pushurl");
      const name = entry.key.slice("remote.".length, entry.key.lastIndexOf("."));
      const plain = PLAIN_NAME.test(name);
      const single = entries.filter((other) => other.key === entry.key).length === 1;
      findings.push({
        what: plain ? entry.key : `a remote's ${push ? "pushurl" : "url"}`,
        file,
        fix:
          plain && single
            ? `git --git-dir=${shellWord(absoluteGitDir)} remote set-url${push ? " --push" : ""} ${name} ${shellWord(clean)}`
            : `${editor}   # take the login out of each ${push ? "pushurl" : "url"} of that remote`,
      });
    }
    return findings;
  });

/**
 * What a person reads when Mend refuses: what kind of thing was found, that an operator must
 * remove it and where the command is, and the supported way instead. No URL, key that can hold
 * one, path or command.
 */
export const remoteCredentialRefusal = (findings: ReadonlyArray<RemoteCredentialFinding>): string =>
  // What to do first: a response may be cut short, and only the list of findings may be lost.
  `Mend does not fetch, push or open a workspace with this repository until an operator removes what its git config holds (the server log names the exact command), or until the project is adopted again from its SSH URL with your Mend key (\`mend keys\`) or the agent bridge (\`--auth bridge\`). Found: ${findings
    .map((finding) =>
      /include/iu.test(finding.what)
        ? `${finding.what} (an include, which Mend never writes)`
        : `${finding.what} (a login or token, which Mend never stores or uses)`,
    )
    .join("; ")}.`;

/** The server log's line for a refused repository: each finding's file and exact command. */
export const logRemoteCredentialFindings = (
  repository: string,
  findings: ReadonlyArray<RemoteCredentialFinding>,
): Effect.Effect<void> =>
  Effect.logWarning(
    [
      `store: Mend refuses to run git with ${repository}, or hand it to a workspace, until an operator removes from its git config:`,
      ...findings.map((finding) => `  ${finding.what} in ${finding.file}: ${finding.fix}`),
    ].join("\n"),
  );

/**
 * The gate: `gitDir`'s config has nothing `remoteCredentialFindings` finds, or the exact commands
 * go to the server log and the caller gets a `GitError` whose `stderr` is the refusal a person may
 * read.
 */
export const refuseRemoteCredentials = (
  gitDir: string,
  repository: string = gitDir,
): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    const findings = yield* remoteCredentialFindings(gitDir);
    if (findings.length === 0) return;
    yield* logRemoteCredentialFindings(repository, findings);
    return yield* new GitError({
      args: ["mend", "remote-credentials"],
      cwd: gitDir,
      exitCode: null,
      stderr: remoteCredentialRefusal(findings),
    });
  });
