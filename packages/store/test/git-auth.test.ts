import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  MendKeys,
  MendKeysConfig,
  MendKeysLive,
  describeGitRemoteFailure,
  sshUrlOfHttpsRemote,
  remoteGitEnv,
  sshCommandFor,
} from "../src/git-auth.ts";

const withKeys = <A, E>(work: (root: string) => Effect.Effect<A, E, MendKeys>): Promise<A> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-keys-test-"));
  const root = path.join(tmp, "keys");
  const layer = MendKeysLive.pipe(Layer.provide(MendKeysConfig.layerFor(root)));
  return Effect.runPromise(
    work(root).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => fs.rmSync(tmp, { recursive: true, force: true }))),
      Effect.orDie,
    ),
  );
};

describe("MendKeys", () => {
  it("generates one key per user, reads back, private key stays 0600", async () => {
    await withKeys((root) =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;

        // Nothing yet — read reports absence rather than creating.
        expect(yield* keys.read("u1")).toBeNull();

        const created = yield* keys.ensure("u1");
        expect(created.publicKey.startsWith("ssh-ed25519 ")).toBe(true);
        expect(created.fingerprint).toContain("ED25519");
        expect(created.privateKeyPath).toBe(path.join(root, "users", "u1", "id_ed25519"));
        const mode = fs.statSync(created.privateKeyPath).mode & 0o777;
        expect(mode).toBe(0o600);

        // Idempotent: a second ensure returns the same key, not a new one.
        const again = yield* keys.ensure("u1");
        expect(again.publicKey).toBe(created.publicKey);
        expect((yield* keys.read("u1"))?.publicKey).toBe(created.publicKey);

        // Another user gets their own key; neither sees the other's.
        const other = yield* keys.ensure("u2");
        expect(other.publicKey).not.toBe(created.publicKey);
        expect(other.privateKeyPath).toBe(path.join(root, "users", "u2", "id_ed25519"));
      }),
    );
  });

  it("re-pins 0600 on every use — a volume policy that loosens the key is undone", async () => {
    await withKeys(() =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        const created = yield* keys.ensure("u1");
        // What Kubernetes fsGroup does to every file on the volume at pod start.
        fs.chmodSync(created.privateKeyPath, 0o660);
        yield* keys.read("u1");
        expect(fs.statSync(created.privateKeyPath).mode & 0o777).toBe(0o600);
        fs.chmodSync(created.privateKeyPath, 0o660);
        yield* keys.ensure("u1");
        expect(fs.statSync(created.privateKeyPath).mode & 0o777).toBe(0o600);
      }),
    );
  });

  it("an unowned op uses the only user's key and refuses to guess between two", async () => {
    await withKeys(() =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        expect(yield* keys.read(null)).toBeNull();
        const only = yield* keys.ensure("u1");
        expect((yield* keys.ensure(null)).publicKey).toBe(only.publicKey);
        expect((yield* keys.read(null))?.publicKey).toBe(only.publicKey);

        yield* keys.ensure("u2");
        const refused = yield* keys.ensure(null).pipe(Effect.flip);
        expect(refused.stderr).toContain("per user");
        expect(yield* keys.read(null)).toBeNull();
      }),
    );
  });

  it("the first user claims a pre-per-user server-wide key", async () => {
    await withKeys((root) =>
      Effect.gen(function* () {
        const keys = yield* MendKeys;
        // A server-wide key from before, at the legacy path.
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        execFileSync("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          path.join(root, "id_ed25519"),
        ]);
        const legacy = yield* keys.ensure(null);
        expect(legacy.privateKeyPath).toBe(path.join(root, "id_ed25519"));

        // The first user to ask takes it over — same public key, moved into their dir.
        const claimed = yield* keys.ensure("u1");
        expect(claimed.publicKey).toBe(legacy.publicKey);
        expect(claimed.privateKeyPath).toBe(path.join(root, "users", "u1", "id_ed25519"));
        expect(fs.existsSync(path.join(root, "id_ed25519"))).toBe(false);

        // A second user gets a fresh key of their own.
        const second = yield* keys.ensure("u2");
        expect(second.publicKey).not.toBe(legacy.publicKey);
      }),
    );
  });
});

describe("sshCommandFor", () => {
  it("ambient adds accept-new and BatchMode to the user's ssh", () => {
    expect(sshCommandFor("ambient", null)).toContain("-o StrictHostKeyChecking=accept-new");
    expect(sshCommandFor("ambient", null)).toContain("-o BatchMode=yes");
  });

  it("mend-key pins the identity and accepts first-contact hosts", () => {
    const command = sshCommandFor("mend-key", "/home/user/.mend/keys/id_ed25519");
    expect(command).toContain("-i '/home/user/.mend/keys/id_ed25519'");
    expect(command).toContain("IdentitiesOnly=yes");
    expect(command).toContain("StrictHostKeyChecking=accept-new");
    expect(command).toContain("BatchMode=yes");
  });

  it("remoteGitEnv never prompts", () => {
    expect(remoteGitEnv("ssh")["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});

describe("describeGitRemoteFailure", () => {
  it("names permission denied per mode", () => {
    const stderr =
      "git@gitlab.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
    const ambient = describeGitRemoteFailure(stderr, "ambient");
    // The packaged server's container holds none of its host's keys: the line names the way out.
    expect(ambient).toContain("Mend server's own ssh setup");
    expect(ambient).toContain("--auth mend-key");
    expect(ambient).toContain("mend keys share");
    expect(ambient).not.toContain("shell here");
    expect(describeGitRemoteFailure(stderr, "mend-key")).toContain("git account's SSH keys");
    expect(describeGitRemoteFailure(stderr, "mend-key")).toContain("Permission denied (publickey)");
  });

  // Observed on 0.36.0-next.783 adopting a private repository by its https URL, every mode.
  const httpsRefusal =
    "Cloning into bare repository '/var/lib/mend/store/x/repo.git'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled";

  it.each(["ambient", "mend-key", "bridge"] as const)(
    "an https remote that wants a credential is never a refused key (%s)",
    (mode) => {
      const described = describeGitRemoteFailure(
        httpsRefusal,
        mode,
        "https://github.com/acme/api.git",
      );
      expect(described).toContain("public repositories only");
      expect(described).toContain("git@github.com:acme/api.git");
      expect(described).toContain("(observed: fatal: could not read Username");
      expect(described).not.toContain("Add your Mend public key");
      expect(described).not.toContain("connected signer's keys");
    },
  );

  it("an https refusal without a known remote still reads as https, from git's own line", () => {
    const described = describeGitRemoteFailure(httpsRefusal, "mend-key");
    expect(described).toContain("public repositories only");
    expect(described).toContain("git@host:owner/repo.git");
  });

  it("an ssh remote's not-found keeps its ssh reading", () => {
    const described = describeGitRemoteFailure(
      "ERROR: Repository not found.\nfatal: Could not read from remote repository.",
      "mend-key",
      "git@github.com:acme/api.git",
    );
    expect(described).toContain("Mend key is not authorized");
  });

  it("names a changed host key — first contact is accept-new in every mode", () => {
    const described = describeGitRemoteFailure("Host key verification failed.", "ambient");
    expect(described).toContain("host key changed");
  });

  it("names unresolvable hosts", () => {
    const described = describeGitRemoteFailure(
      "ssh: Could not resolve hostname gitlab.example.internal: Name or service not known",
      "ambient",
    );
    expect(described).toContain('"gitlab.example.internal"');
  });

  it("stays silent on unknown failures — verbatim stderr must win", () => {
    expect(
      describeGitRemoteFailure("fatal: the remote end hung up unexpectedly", "ambient"),
    ).toBeNull();
  });
});

describe("sshUrlOfHttpsRemote", () => {
  it("spells the ssh URL on hosts whose ssh path is the https path", () => {
    expect(sshUrlOfHttpsRemote("https://github.com/acme/api")).toBe("git@github.com:acme/api.git");
    expect(sshUrlOfHttpsRemote("https://GitHub.com/acme/api.git/")).toBe(
      "git@github.com:acme/api.git",
    );
    expect(sshUrlOfHttpsRemote("https://gitlab.com/group/sub/api.git")).toBe(
      "git@gitlab.com:group/sub/api.git",
    );
  });

  it("names nothing it cannot know", () => {
    expect(sshUrlOfHttpsRemote("https://git.acme.dev/acme/api.git")).toBeNull();
    expect(sshUrlOfHttpsRemote("git@github.com:acme/api.git")).toBeNull();
    expect(sshUrlOfHttpsRemote("https://github.com/acme")).toBeNull();
  });
});
