import { gitRemoteLocation, type GitAuthMode } from "@mend/domain/workbench";
import { Effect, Schema } from "effect";

import { AgentBridge, NO_SIGNER_MESSAGE } from "./agent-bridge.ts";
import { MendKeys, remoteGitEnv, sshCommandFor, type KeygenError } from "./git-auth.ts";

/** Bridge mode with nobody sharing an agent — the op would hang, so it refuses instead. */
export class NoSignerError extends Schema.TaggedErrorClass<NoSignerError>()("NoSignerError", {
  message: Schema.String,
}) {}

/**
 * Whether a remote op on `remote` can need a signer: an ssh remote, or one the caller did not
 * name. https, http and git:// never ask for a key, so neither the Mend key nor a connected
 * bridge has anything to sign there.
 */
const needsSigner = (remote: string | null | undefined): boolean =>
  remote === undefined || gitRemoteLocation(remote ?? "")?.scheme === "ssh";

/**
 * The one resolution of `mode` → env for a host-side remote git op, shared by
 * the API routes and the session engine (docs/GIT-ACCESS.md). `userId` is
 * whose Mend key signs in mend-key mode (generated on first use; null means
 * the only user on a single-user install) and whose shared agent signs in
 * bridge mode. Bridge mode requires that account's connected signer and fails
 * fast with the readable line when there is none; it never falls back to
 * another account's signer (docs/adr/0003-organizations-and-tenancy.md).
 * `remote` is the URL the op reaches: a remote no key signs (https) needs no
 * signer, so a public https project adopts and fetches with nobody sharing.
 */
export const resolveRemoteEnv = (
  mode: GitAuthMode,
  userId: string | null,
  remote?: string | null,
): Effect.Effect<Record<string, string>, NoSignerError | KeygenError, MendKeys | AgentBridge> =>
  Effect.gen(function* () {
    if (!needsSigner(remote)) return remoteGitEnv(sshCommandFor(mode, null));
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
