import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/**
 * Variables that point git at another repository, another config file or a template. The probes
 * below run in a repository of their own or none: inherited from the server process, these would
 * write the probe's remote into someone else's repository or config, or seed the probe with
 * rules the real operation never sees. The system and global config (`GIT_CONFIG_GLOBAL`,
 * `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`) stay: their `url.*` rules are the point.
 */
const GIT_LOCATION_OVERRIDES: ReadonlyArray<string> = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_CONFIG",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_TEMPLATE_DIR",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
];

const probeEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of GIT_LOCATION_OVERRIDES) delete env[name];
  return env;
};

/** Run git outside any repository; its trimmed stdout, or null when it failed. */
const gitAnswer = (args: ReadonlyArray<string>): Effect.Effect<string | null> =>
  Effect.callback((resume) => {
    const child = execFile("git", [...args], { cwd: "/", env: probeEnv() }, (error, stdout) => {
      resume(Effect.succeed(error === null ? stdout.trim() : null));
    });
    return Effect.sync(() => child.kill());
  });

/**
 * The URL git dials for `remote` under the git config every host-side remote op runs under (the
 * server process's system and global config), asked of git itself so its `insteadOf` and
 * `pushInsteadOf` rules apply exactly as they will (the longest prefix, and among equal ones the
 * base git saw first). A push asks `git remote get-url --push`, which tries `pushInsteadOf`
 * before `insteadOf`. It needs a repository whose config names the remote (git does not see a
 * remote given only with `-c`), so a throwaway bare one holds it: made without a template, its
 * remote written to its own config file under a name nothing else can have set. Mend writes no
 * rewrite into a store. Null when git could not answer.
 */
export const effectiveGitUrl = (remote: string, push: boolean): Effect.Effect<string | null> => {
  // An accepted remote never starts with "-"; anything that does is no URL git should be asked.
  if (remote.startsWith("-")) return Effect.succeed(null);
  if (!push) return gitAnswer(["ls-remote", "--get-url", remote]);
  return Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-push-url-"))),
    (dir) =>
      Effect.gen(function* () {
        const gitDir = path.join(dir, "probe.git");
        const name = `mend-probe-${crypto.randomUUID()}`;
        if ((yield* gitAnswer(["init", "-q", "--bare", "--template=", gitDir])) === null) {
          return null;
        }
        const configured = yield* gitAnswer([
          "config",
          "--file",
          path.join(gitDir, "config"),
          `remote.${name}.url`,
          remote,
        ]);
        if (configured === null) return null;
        return yield* gitAnswer([`--git-dir=${gitDir}`, "remote", "get-url", "--push", name]);
      }),
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  );
};

/**
 * Whether a remote op on `remote` can need a signer: when the URL git actually dials — after
 * its `insteadOf` and, for a push, `pushInsteadOf` rewrites — is ssh, or when that cannot be
 * told (no remote named, git unable to answer). https, http and git:// never ask for a key.
 */
const needsSigner = (remote: string | null | undefined, push: boolean) =>
  Effect.gen(function* () {
    if (remote === undefined) return true;
    if (remote === null) return false;
    const dialed = yield* effectiveGitUrl(remote, push);
    if (dialed === null) return true;
    return gitRemoteLocation(dialed)?.scheme === "ssh";
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
