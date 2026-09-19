import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptedFingerprints,
  ed25519PublicKey,
  keygenFingerprint,
} from "./packaged-git-access-acceptance.mjs";

// A real ed25519 public key and its real fingerprint; the private half was never kept.
const blob = "AAAAC3NzaC1lZDI1NTE5AAAAIB3LiCnTEUjfSy6Q05bfg3z3heD92adbQtqhfIAjvtK4";
const fingerprint = "SHA256:J3ZyDSFA7M6S3H1WWR323W8x8VlUyInqLJVVUYMvXk8";
const other = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("a public key line is accepted with or without its comment, and returned without it", () => {
  assert.equal(ed25519PublicKey(`ssh-ed25519 ${blob}`), `ssh-ed25519 ${blob}`);
  assert.equal(
    ed25519PublicKey(`ssh-ed25519 ${blob} someone@example.invalid`),
    `ssh-ed25519 ${blob}`,
  );
});

test("anything but one well-formed ed25519 public key is refused before it is authorized", async (t) => {
  const cases = {
    empty: "",
    "cli notice": "no Mend key yet",
    rsa: `ssh-rsa ${blob}`,
    "second line": `ssh-ed25519 ${blob}\nssh-ed25519 ${blob}`,
    "authorized_keys option": `command="sh" ssh-ed25519 ${blob}`,
    truncated: `ssh-ed25519 ${blob.slice(0, -4)}`,
    "wrong inner type": `ssh-ed25519 ${Buffer.from("\0\0\0\u000bssh-ed25518".padEnd(51, "x")).toString("base64")}`,
    private: "-----BEGIN OPENSSH PRIVATE KEY-----",
  };
  for (const [name, line] of Object.entries(cases))
    await t.test(name, () => assert.throws(() => ed25519PublicKey(line)));
});

test("ssh-keygen -lf output yields the SHA256 fingerprint of one ed25519 key", () => {
  assert.equal(keygenFingerprint(`256 ${fingerprint} probe (ED25519)\n`), fingerprint);
  assert.equal(
    keygenFingerprint(`256 ${fingerprint} a comment with spaces (ED25519)`),
    fingerprint,
  );
  assert.throws(() => keygenFingerprint(`3072 ${fingerprint} probe (RSA)\n`));
  assert.throws(() =>
    keygenFingerprint(`256 ${fingerprint} a (ED25519)\n256 ${other} b (ED25519)\n`),
  );
});

test("only a completed publickey login counts as a signature, in log order", () => {
  const log = [
    "Server listening on 0.0.0.0 port 2222.",
    `Accepted key ED25519 ${fingerprint} found at /etc/ssh/authorized/git:1`,
    "Postponed publickey for git from 172.18.0.4 port 40112 ssh2 [preauth]",
    `Accepted publickey for git from 172.18.0.4 port 40112 ssh2: ED25519 ${fingerprint}`,
    `Failed publickey for git from 172.18.0.4 port 40114 ssh2: ED25519 ${other}`,
    `Accepted publickey for root from 172.18.0.4 port 40116 ssh2: ED25519 ${other}`,
    `Accepted publickey for git from fd00::4 port 40118 ssh2: ED25519 ${other}`,
  ].join("\n");
  assert.deepEqual(acceptedFingerprints(log), [fingerprint, other]);
  assert.deepEqual(acceptedFingerprints(""), []);
});
