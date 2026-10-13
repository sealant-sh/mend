import type { GitAuthMode } from "@mend/domain/workbench";
import { Effect, type Scope } from "effect";

import { AgentBridge } from "./agent-bridge.ts";
import { MendKeys } from "./git-auth.ts";
import type { GitRemoteOperation } from "./git-remote-operation.ts";
import { GitError } from "./git.ts";
import { resolveRemoteEnvForUrls } from "./remote-env.ts";
import type { SourceActor, SourcePolicy } from "./source-policy.ts";

/** Defer policy and signer selection until the adapter knows the actual Git operation. */
export type GitRemoteEnvironment =
  | Readonly<Record<string, string>>
  | ((
      operation: GitRemoteOperation,
    ) => Effect.Effect<Record<string, string>, GitError, Scope.Scope>);

/** Resolve a deferred environment, or retain an explicitly supplied low-level environment. */
export const gitRemoteEnvironment = (
  environment: GitRemoteEnvironment,
  operation: GitRemoteOperation,
): Effect.Effect<Record<string, string>, GitError, Scope.Scope> =>
  typeof environment === "function" ? environment(operation) : Effect.succeed({ ...environment });

/**
 * Capture the owning account's signer services, but ask policy in the execution context. The
 * original operand remains Git's operand; only its checked destinations select authentication.
 */
export const preparedRemoteEnvironment = (input: {
  readonly policy: SourcePolicy["Service"];
  readonly source: string | null;
  readonly actor: SourceActor;
  readonly mode: GitAuthMode;
  readonly userId: string | null;
  readonly env?: Readonly<Record<string, string>>;
}): Effect.Effect<GitRemoteEnvironment, never, MendKeys | AgentBridge> =>
  Effect.gen(function* () {
    const signers = yield* Effect.context<MendKeys | AgentBridge>();
    return (operation: GitRemoteOperation) =>
      Effect.gen(function* () {
        const cleared = yield* input.policy.prepare(input.source, input.actor, {
          ...operation,
          env: { ...operation.env, ...input.env },
        });
        const authentication = yield* resolveRemoteEnvForUrls(
          input.mode,
          input.userId,
          cleared.urls,
        ).pipe(Effect.provide(signers));
        return cleared.pinnedEnv(authentication);
      }).pipe(
        Effect.mapError(
          (error) =>
            new GitError({
              args: ["remote", "prepare"],
              cwd:
                operation.direction === "clone" ? operation.cwd : (operation.repositoryPath ?? "/"),
              exitCode: null,
              stderr:
                error._tag === "KeygenError"
                  ? "Could not create the account's Mend key."
                  : error.message,
            }),
        ),
      );
  });
