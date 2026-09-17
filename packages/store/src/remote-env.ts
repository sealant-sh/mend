import type { GitAuthMode } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { AgentBridge, NO_SIGNER_MESSAGE } from "./agent-bridge.ts";
import { MendKeys, remoteGitEnv, sshCommandFor, type KeygenError } from "./git-auth.ts";

/** Bridge mode with nobody sharing an agent — the op would hang, so it refuses instead. */
export class NoSignerError extends Schema.TaggedErrorClass<NoSignerError>()("NoSignerError", {
  message: Schema.String,
}) {}

/**
 * The one resolution of `mode` → env for a host-side remote git op, shared by
 * the API routes and the session engine (docs/GIT-ACCESS.md). `userId` is
 * whose Mend key signs in mend-key mode (generated on first use; null means
 * the only user on a single-user install) and whose shared agent signs in
 * bridge mode. Bridge mode requires that account's connected signer and fails
 * fast with the readable line when there is none; it never falls back to
 * another account's signer (docs/adr/0003-organizations-and-tenancy.md).
 */
export const resolveRemoteEnv = (
  mode: GitAuthMode,
  userId: string | null,
): Effect.Effect<Record<string, string>, NoSignerError | KeygenError, MendKeys | AgentBridge> =>
  Effect.gen(function* () {
    if (mode === "ambient") return remoteGitEnv(sshCommandFor("ambient", null));
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
