import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { keyComment, MendKeys, MendKeysConfig, MendKeysLive, USERS_DIR } from "./git-auth.ts";

describe("keyComment", () => {
  it("reads the trailing comment of a public key line, spaces included", () => {
    expect(keyComment("ssh-ed25519 AAAAC3 someone@example.com")).toBe("someone@example.com");
    expect(keyComment("ssh-ed25519 AAAAC3 two words\n")).toBe("two words");
  });

  it("is empty for a bare key", () => {
    expect(keyComment("ssh-ed25519 AAAAC3")).toBe("");
  });
});

const hasKeygen = (() => {
  try {
    execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
    return true;
  } catch (error) {
    // `-?` is not a flag: ssh-keygen prints usage and exits 1 when present.
    return error instanceof Error && "status" in error;
  }
})();

describe.skipIf(!hasKeygen)("MendKeys labels", () => {
  let root = "";
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-keys-"));
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = <A, E>(effect: Effect.Effect<A, E, MendKeys>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(MendKeysLive.pipe(Layer.provide(MendKeysConfig.layerFor(root))))),
    );

  it("generates the key with the label as its comment", async () => {
    const key = await run(
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        return yield* keys.ensure("user-a", "a@example.com");
      }),
    );
    expect(keyComment(key.publicKey)).toBe("a@example.com");
    expect(key.privateKeyPath).toBe(path.join(root, USERS_DIR, "user-a", "id_ed25519"));
  });

  it("relabels an existing key in place, keeping the key material", async () => {
    const before = await run(
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        return yield* keys.ensure("user-b");
      }),
    );
    expect(keyComment(before.publicKey)).toMatch(/^mend@/);

    const after = await run(
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        return yield* keys.read("user-b", "b@example.com");
      }),
    );
    expect(after).not.toBeNull();
    expect(keyComment(after?.publicKey ?? "")).toBe("b@example.com");
    // Same key, new comment: the first two fields (type, material) are untouched.
    expect(after?.publicKey.split(" ").slice(0, 2)).toEqual(
      before.publicKey.split(" ").slice(0, 2),
    );
    expect(after?.fingerprint).toContain("b@example.com");
  });

  it("leaves the comment alone when no label is known", async () => {
    const key = await run(
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        return yield* keys.read("user-b");
      }),
    );
    expect(keyComment(key?.publicKey ?? "")).toBe("b@example.com");
  });
});
