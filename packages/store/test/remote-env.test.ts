import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { AgentBridge } from "../src/agent-bridge.ts";
import { MendKeys } from "../src/git-auth.ts";
import { resolveRemoteEnv } from "../src/remote-env.ts";

/** A Mend key that records every ensure: a remote no key signs must never make one. */
const keysLayer = (ensured: Array<string | null>) =>
  Layer.succeed(MendKeys, {
    ensure: (userId) =>
      Effect.sync(() => {
        ensured.push(userId);
        return { publicKey: "ssh-ed25519 AAAA", fingerprint: "256 SHA256:x", privateKeyPath: "/k" };
      }),
    read: () => Effect.succeed(null),
  });

const bridgeLayer = (connected: boolean) =>
  Layer.succeed(AgentBridge, {
    attach: () => Effect.die("not in test"),
    status: () => Effect.succeed({ connected, clientName: null, since: null }),
    socketPath: (userId) => `/bridge/${userId}.sock`,
    begin: () => Effect.succeed(() => {}),
  });

const resolve = (
  mode: "mend-key" | "bridge",
  remote: string | undefined,
  options: { readonly connected?: boolean; readonly ensured?: Array<string | null> } = {},
) =>
  resolveRemoteEnv(mode, "anna", remote).pipe(
    Effect.provide(
      Layer.mergeAll(keysLayer(options.ensured ?? []), bridgeLayer(options.connected ?? false)),
    ),
  );

describe("resolveRemoteEnv", () => {
  it.effect("bridge with nobody sharing still reaches an https remote: no key signs it", () =>
    Effect.gen(function* () {
      const env = yield* resolve("bridge", "https://github.com/octocat/Hello-World.git");
      expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
      expect(env["SSH_AUTH_SOCK"]).toBeUndefined();
    }),
  );

  it.effect("bridge with nobody sharing refuses an ssh remote, and one it was not told", () =>
    Effect.gen(function* () {
      const ssh = yield* resolve("bridge", "git@github.com:acme/api.git").pipe(Effect.flip);
      expect(ssh._tag).toBe("NoSignerError");
      const unknown = yield* resolve("bridge", undefined).pipe(Effect.flip);
      expect(unknown._tag).toBe("NoSignerError");
    }),
  );

  it.effect("bridge with a share signs an ssh remote through its socket", () =>
    Effect.gen(function* () {
      const env = yield* resolve("bridge", "git@github.com:acme/api.git", { connected: true });
      expect(env["SSH_AUTH_SOCK"]).toBe("/bridge/anna.sock");
    }),
  );

  it.effect("mend-key makes the key for an ssh remote, never for an https one", () =>
    Effect.gen(function* () {
      const ensured: Array<string | null> = [];
      yield* resolve("mend-key", "https://github.com/octocat/Hello-World.git", { ensured });
      expect(ensured).toEqual([]);
      const env = yield* resolve("mend-key", "git@github.com:acme/api.git", { ensured });
      expect(ensured).toEqual(["anna"]);
      expect(env["GIT_SSH_COMMAND"]).toContain("-i '/k'");
    }),
  );
});
