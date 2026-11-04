import { randomUUID } from "node:crypto";

import { Effect } from "effect";

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
        Effect.timeout("20 seconds"),
        Effect.match({
          onSuccess: (): GitAccessObservation => ({
            state: "ok",
            method: direction === "read" ? "ls-remote" : "push-dry-run",
            detail:
              direction === "read"
                ? "Origin's refs were readable."
                : "Origin accepted a push dry-run. No refs were written; server hooks and branch protection were not tested.",
          }),
          onFailure: (): GitAccessObservation => ({
            state: "failed",
            method: direction === "read" ? "ls-remote" : "push-dry-run",
            detail:
              direction === "read"
                ? "Reading origin's refs did not succeed."
                : "A push dry-run did not succeed.",
          }),
        }),
      );
    const read = yield* observe("read");
    const push = yield* observe("push");
    return { read, push, observedAt: new Date().toISOString() };
  });
