import { execFileSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { checkMendKeyWithGitHub, readGitHubGreeting } from "./git-access-check.ts";
import { MendKeys, MendKeysConfig, MendKeysLive } from "./git-auth.ts";

const keyPath = "/srv/mend/keys/users/user-a/id_ed25519";

describe("readGitHubGreeting", () => {
  it("reads GitHub's greeting as the account's login, whatever ssh exits with", () => {
    expect(
      readGitHubGreeting(
        "\nWarning: Permanently added 'github.com' (ED25519) to the list of known hosts.\r\nHi linus-p! You've successfully authenticated, but GitHub does not provide shell access.\n",
        1,
        keyPath,
      ),
    ).toEqual({
      state: "accepted",
      githubLogin: "linus-p",
      deployKeyRepository: null,
      observed:
        "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
    });
  });

  it("reads a deploy key's greeting as its repository, not a login", () => {
    expect(
      readGitHubGreeting(
        "Hi northwind/api! You've successfully authenticated, but GitHub does not provide shell access.",
        1,
        keyPath,
      ),
    ).toMatchObject({
      state: "accepted",
      githubLogin: null,
      deployKeyRepository: "northwind/api",
    });
  });

  it("reads the publickey refusal as refused, keeping the key's path out", () => {
    const read = readGitHubGreeting(
      `Load key "${keyPath}": bad permissions\ngit@github.com: Permission denied (publickey).\n`,
      255,
      keyPath,
    );
    expect(read).toEqual({
      state: "refused",
      observed: "git@github.com: Permission denied (publickey).",
    });
  });

  it("reads anything else as no answer about the key", () => {
    expect(
      readGitHubGreeting(
        "ssh: Could not resolve hostname github.com: Temporary failure in name resolution\n",
        255,
        keyPath,
      ),
    ).toEqual({
      state: "unreachable",
      observed: "ssh: Could not resolve hostname github.com: Temporary failure in name resolution",
    });
    expect(
      readGitHubGreeting(`Warning: Identity file ${keyPath} not accessible`, 255, keyPath),
    ).toEqual({
      state: "unreachable",
      observed: "Warning: Identity file <Mend key> not accessible",
    });
    expect(readGitHubGreeting("\n", 255, keyPath)).toEqual({
      state: "unreachable",
      observed: "ssh exited 255 with no output.",
    });
  });
});

const hasSsh = (() => {
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (error) {
    // `-?` is not a flag: ssh-keygen prints usage and exits 1 when present.
    return error instanceof Error && "status" in error && error.status === 1;
  }
})();

/** A loopback port nothing listens on: bound, then closed. */
const closedPort = Effect.promise(async () => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  server.close();
  await once(server, "close");
  return address.port;
});

describe.skipIf(!hasSsh)("checkMendKeyWithGitHub", () => {
  it.live("answers no-key without creating one, then asks over ssh once the key exists", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "mend-key-check-"))),
        (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
      );
      const keys = MendKeysLive.pipe(Layer.provide(MendKeysConfig.layerFor(root)));
      const port = yield* closedPort;
      const server = { host: "127.0.0.1", port };

      const before = yield* checkMendKeyWithGitHub("user-a", "a@example.com", server).pipe(
        Effect.provide(keys),
      );
      expect(before.state).toBe("no-key");
      expect(fs.readdirSync(root)).toEqual([]);

      yield* Effect.gen(function* () {
        yield* (yield* MendKeys).ensure("user-a", "a@example.com");
      }).pipe(Effect.provide(keys));
      const after = yield* checkMendKeyWithGitHub("user-a", "a@example.com", server).pipe(
        Effect.provide(keys),
      );
      expect(after).toMatchObject({ state: "unreachable" });
      expect(after.state === "unreachable" ? after.observed : "").toMatch(/Connection refused/);
      expect(JSON.stringify(after)).not.toContain(root);
    }).pipe(Effect.scoped),
  );
});
