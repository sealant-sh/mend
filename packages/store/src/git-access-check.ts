import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import { redactUrlCredentials } from "@mend/domain/workbench";
import { Clock, Effect, Option } from "effect";

import { MendKeys, sshTransportArgs, type KeygenError } from "./git-auth.ts";
import { git } from "./git.ts";
import { refuseRemoteCredentials } from "./remote-credentials.ts";
import { gitRemoteEnvironment, type GitRemoteEnvironment } from "./remote-operation-env.ts";

/** An observation of a transport, never a promise that a later operation will succeed. */
export interface GitAccessObservation {
  readonly state: "ok" | "failed";
  readonly method: "ls-remote" | "push-dry-run";
  readonly detail: string;
}

/** Observe origin without changing its refs or the store's refs. */
export const checkGitAccess = (
  storePath: string,
  remoteEnv: GitRemoteEnvironment,
): Effect.Effect<{
  readonly read: GitAccessObservation;
  readonly push: GitAccessObservation;
  readonly observedAt: string;
}> =>
  Effect.gen(function* () {
    const observe = (direction: "read" | "push") =>
      Effect.gen(function* () {
        yield* refuseRemoteCredentials(storePath);
        const env = yield* gitRemoteEnvironment(remoteEnv, {
          direction,
          remote: "origin",
          repositoryPath: storePath,
          env: { GIT_TERMINAL_PROMPT: "0" },
        });
        yield* git(
          direction === "read"
            ? ["ls-remote", "--", "origin"]
            : [
                "-c",
                "core.hooksPath=/dev/null",
                "push",
                "--dry-run",
                "--no-verify",
                "--porcelain",
                "origin",
                `HEAD:refs/heads/mend-access-check-${randomUUID()}`,
              ],
          storePath,
          env,
        );
      }).pipe(
        Effect.scoped,
        Effect.timeout("60 seconds"),
        Effect.match({
          onSuccess: (): GitAccessObservation => ({
            state: "ok",
            method: direction === "read" ? "ls-remote" : "push-dry-run",
            detail:
              direction === "read"
                ? "Origin's refs were readable."
                : "Origin accepted a push dry-run. No refs were written; server hooks and branch protection were not tested.",
          }),
          onFailure: (error): GitAccessObservation => ({
            state: "failed",
            method: direction === "read" ? "ls-remote" : "push-dry-run",
            detail:
              error._tag === "TimeoutError"
                ? "Git access check timed out after 60 seconds."
                : redactUrlCredentials(stripVTControlCharacters(error.stderr))
                    .split(/\r?\n/)
                    .find((line) => line.trim() !== "")
                    ?.slice(0, 1000) ||
                  `Git ${direction === "read" ? "ls-remote" : "push --dry-run"} exited ${error.exitCode ?? "without an exit code"}${error.signal === undefined ? "" : ` (${error.signal})`}.`,
          }),
        }),
      );
    const read = yield* observe("read");
    const push = yield* observe("push");
    return { read, push, observedAt: new Date().toISOString() };
  });

/**
 * What GitHub's SSH greeting said of an account's Mend key, with no repository involved: whether
 * GitHub knows the key and as whom. It says nothing about any one repository's access.
 *
 * - `accepted`: GitHub greeted the key. A key on a GitHub account names its login; a deploy key
 *   names its repository (`owner/repo`) instead, and is accepted for that repository only.
 * - `refused`: GitHub answered and does not know the key.
 * - `unreachable`: no answer about the key: DNS, the network, a changed host key, a timeout, or
 *   ssh itself failed. `observed` says which.
 * - `no-key`: the account has no Mend key yet. The check never creates one.
 *
 * `observed` is the line GitHub or ssh printed, with the key's path on this host replaced; key
 * material never appears in ssh's output.
 */
export type GitHubKeyCheck =
  | {
      readonly state: "accepted";
      readonly githubLogin: string | null;
      readonly deployKeyRepository: string | null;
      readonly observed: string;
      readonly checkedAt: Date;
    }
  | { readonly state: "refused"; readonly observed: string; readonly checkedAt: Date }
  | { readonly state: "unreachable"; readonly observed: string; readonly checkedAt: Date }
  | { readonly state: "no-key"; readonly checkedAt: Date };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Where the greeting is asked. Only tests point it anywhere but GitHub. */
export interface SshGreetingServer {
  readonly host: string;
  readonly port: number | null;
}

const GITHUB_SSH: SshGreetingServer = { host: "github.com", port: null };

/** GitHub's whole answer, ssh's connect timeout included, must land within this. */
const GREETING_TIMEOUT_SECONDS = 30;

/** `Hi <login>! You've successfully authenticated, …`; a deploy key's name is `owner/repo`. */
const GREETING = /^Hi ([^\s!]+)! You've successfully authenticated/m;
const REFUSED = /Permission denied \(publickey/;
/** ssh's first-contact notice under accept-new: not an answer about the key. */
const KNOWN_HOSTS_NOTICE = /^Warning: Permanently added /;

/**
 * Read what `ssh -T git@github.com` printed (stdout and stderr together) into an answer about the
 * key. Only GitHub's own greeting or its publickey refusal speaks about the key; every other
 * outcome, exit codes included (GitHub exits 1 after a greeting), is no answer.
 */
export const readGitHubGreeting = (
  output: string,
  exitCode: number | null,
  privateKeyPath: string,
): DistributiveOmit<Exclude<GitHubKeyCheck, { readonly state: "no-key" }>, "checkedAt"> => {
  const lines = stripVTControlCharacters(output)
    .split(/\r?\n/)
    .map((line) => redactUrlCredentials(line.split(privateKeyPath).join("<Mend key>").trim()))
    .filter((line) => line !== "" && !KNOWN_HOSTS_NOTICE.test(line));
  const greeting = lines.find((line) => GREETING.test(line));
  const name = greeting?.match(GREETING)?.[1];
  if (greeting !== undefined && name !== undefined) {
    const deployKey = name.includes("/");
    return {
      state: "accepted",
      githubLogin: deployKey ? null : name,
      deployKeyRepository: deployKey ? name : null,
      observed: greeting.slice(0, 300),
    };
  }
  const refused = lines.find((line) => REFUSED.test(line));
  if (refused !== undefined) return { state: "refused", observed: refused.slice(0, 300) };
  return {
    state: "unreachable",
    observed:
      lines[0]?.slice(0, 300) ?? `ssh exited ${exitCode ?? "without an exit code"} with no output.`,
  };
};

/** Run ssh with the given argv; what it printed and its exit code. Interrupting kills it. */
const runSsh = (
  args: ReadonlyArray<string>,
): Effect.Effect<{ readonly output: string; readonly exitCode: number | null }> =>
  Effect.callback((resume) => {
    const child = execFile(
      "ssh",
      [...args],
      // The Mend key is the only identity on the command line; no agent stands beside it.
      { env: { ...process.env, SSH_AUTH_SOCK: "" } },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`;
        if (error === null) {
          resume(Effect.succeed({ output, exitCode: 0 }));
          return;
        }
        resume(
          Effect.succeed({
            output: output.trim() === "" ? `ssh could not run: ${error.message}` : output,
            exitCode: typeof error.code === "number" ? error.code : null,
          }),
        );
      },
    );
    return Effect.sync(() => child.kill());
  });

/**
 * Ask GitHub whether it knows `userId`'s Mend key, with no project: `ssh -T git@github.com`
 * signed by that key alone, under the same ssh options as every host-side remote op
 * (`sshTransportArgs`: no ssh config, only the Mend key, batch mode, accept-new host keys). It
 * runs on this host and starts no workspace. It reads the key and never creates it; the bridge is
 * never asked to sign, whatever the account's mode.
 */
export const checkMendKeyWithGitHub = (
  userId: string,
  label?: string,
  server: SshGreetingServer = GITHUB_SSH,
): Effect.Effect<GitHubKeyCheck, KeygenError, MendKeys> =>
  Effect.gen(function* () {
    const key = yield* (yield* MendKeys).read(userId, label);
    if (key === null) {
      return { state: "no-key", checkedAt: new Date(yield* Clock.currentTimeMillis) } as const;
    }
    const answered = yield* runSsh([
      ...sshTransportArgs("mend-key", key.privateKeyPath, server.port),
      "-o",
      `ConnectTimeout=${GREETING_TIMEOUT_SECONDS / 2}`,
      "-T",
      "--",
      `git@${server.host}`,
    ]).pipe(Effect.timeoutOption(`${GREETING_TIMEOUT_SECONDS} seconds`));
    const checkedAt = new Date(yield* Clock.currentTimeMillis);
    if (Option.isNone(answered)) {
      return {
        state: "unreachable",
        observed: `${server.host} did not answer within ${GREETING_TIMEOUT_SECONDS} seconds.`,
        checkedAt,
      } as const;
    }
    return {
      ...readGitHubGreeting(answered.value.output, answered.value.exitCode, key.privateKeyPath),
      checkedAt,
    };
  });
