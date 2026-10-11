import { execFile } from "node:child_process";

import { gitRemoteLocation, type GitAuthMode } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { AgentBridge, NO_SIGNER_MESSAGE } from "./agent-bridge.ts";
import {
  MendKeys,
  noSignerGitEnv,
  remoteGitEnv,
  sshCommandFor,
  type KeygenError,
} from "./git-auth.ts";

/** Bridge mode with nobody sharing an agent — the op would hang, so it refuses instead. */
export class NoSignerError extends Schema.TaggedErrorClass<NoSignerError>()("NoSignerError", {
  message: Schema.String,
}) {}

/** One `url.<base>.insteadOf` (or `pushInsteadOf`) rule from git's config. */
export interface GitUrlRewrite {
  /** What a matching URL becomes: `<base>`. */
  readonly base: string;
  /** The prefix it replaces. */
  readonly prefix: string;
  /** `pushInsteadOf`: applies to pushes only. */
  readonly push: boolean;
}

/**
 * The URL git dials for `url` under `rules`, by git's own rule: the longest matching prefix wins;
 * for a push a `pushInsteadOf` match comes first, then `insteadOf`.
 */
export const rewriteGitUrl = (
  url: string,
  rules: ReadonlyArray<GitUrlRewrite>,
  push: boolean,
): string => {
  const longest = (candidates: ReadonlyArray<GitUrlRewrite>) =>
    candidates
      .filter((rule) => url.startsWith(rule.prefix))
      .reduce<GitUrlRewrite | null>(
        (best, rule) => (best === null || rule.prefix.length > best.prefix.length ? rule : best),
        null,
      );
  const rule =
    (push ? longest(rules.filter((candidate) => candidate.push)) : null) ??
    longest(rules.filter((candidate) => !candidate.push));
  return rule === null ? url : rule.base + url.slice(rule.prefix.length);
};

/** `git config --null --get-regexp` output for url rewrites, as rules. */
export const parseGitUrlRewrites = (output: string): ReadonlyArray<GitUrlRewrite> =>
  output
    .split("\0")
    .filter((entry) => entry !== "")
    .flatMap((entry) => {
      const newline = entry.indexOf("\n");
      if (newline === -1) return [];
      const key = entry.slice(0, newline);
      const prefix = entry.slice(newline + 1);
      const kind = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
      if (!key.startsWith("url.") || (kind !== "insteadof" && kind !== "pushinsteadof")) return [];
      return [{ base: key.slice(4, key.lastIndexOf(".")), prefix, push: kind === "pushinsteadof" }];
    });

/**
 * The url rewrites in the git config every host-side remote op runs under (the server process's
 * system and global config), or null when git could not say. Read outside any repository, as
 * the ops' own config: Mend writes no rewrite into a store.
 */
const readGitUrlRewrites: Effect.Effect<ReadonlyArray<GitUrlRewrite> | null> = Effect.callback(
  (resume) => {
    const child = execFile(
      "git",
      ["config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
      { cwd: "/" },
      (error, stdout) => {
        // Exit 1 is "no such key": no rewrites at all.
        if (error === null) resume(Effect.succeed(parseGitUrlRewrites(stdout)));
        else resume(Effect.succeed(error.code === 1 ? [] : null));
      },
    );
    return Effect.sync(() => child.kill());
  },
);

/**
 * Whether a remote op on `remote` can need a signer: when the URL git actually dials — after
 * its `insteadOf` and, for a push, `pushInsteadOf` rewrites — is ssh, or when that cannot be
 * told (no remote named, git's config unreadable). https, http and git:// never ask for a key.
 */
const needsSigner = (remote: string | null | undefined, push: boolean) =>
  Effect.gen(function* () {
    if (remote === undefined) return true;
    if (remote === null) return false;
    const rules = yield* readGitUrlRewrites;
    if (rules === null) return true;
    return gitRemoteLocation(rewriteGitUrl(remote, rules, push))?.scheme === "ssh";
  });

/**
 * The one resolution of `mode` → env for a host-side remote git op, shared by
 * the API routes and the session engine (docs/GIT-ACCESS.md). `userId` is
 * whose Mend key signs in mend-key mode (generated on first use; null means
 * the only user on a single-user install) and whose shared agent signs in
 * bridge mode. Bridge mode requires that account's connected signer and fails
 * fast with the readable line when there is none; it never falls back to
 * another account's signer (docs/adr/0003-organizations-and-tenancy.md).
 * `remote` is the URL the op reaches and `push` whether it pushes: a remote no
 * key signs (https) needs no signer, so a public https project adopts and
 * fetches with nobody sharing — and its env makes ssh refuse, should git's
 * config send it over ssh anyway, rather than answer as the server process.
 */
export const resolveRemoteEnv = (
  mode: GitAuthMode,
  userId: string | null,
  remote?: string | null,
  push = false,
): Effect.Effect<Record<string, string>, NoSignerError | KeygenError, MendKeys | AgentBridge> =>
  Effect.gen(function* () {
    if (!(yield* needsSigner(remote, push))) return noSignerGitEnv();
    if (mode === "bridge") {
      if (userId === null) {
        return yield* new NoSignerError({
          message: "this operation has no owner, so no signer can be chosen",
        });
      }
      const bridge = yield* AgentBridge;
      const bridgeStatus = yield* bridge.status(userId);
      if (!bridgeStatus.connected) {
        return yield* new NoSignerError({ message: NO_SIGNER_MESSAGE });
      }
      return remoteGitEnv(sshCommandFor("bridge", null), bridge.socketPath(userId));
    }
    const keys = yield* MendKeys;
    const key = yield* keys.ensure(userId);
    return remoteGitEnv(sshCommandFor("mend-key", key.privateKeyPath));
  });
