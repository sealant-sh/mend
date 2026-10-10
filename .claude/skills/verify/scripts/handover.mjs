#!/usr/bin/env node
// The verify skill's handover: the stack's first account, from the session to this machine, with
// nothing usable in any recorded terminal. A session's terminal output is a durable record, so a
// secret printed there outlives the run. Here only a public key goes in and only ciphertext comes
// out: the private key never leaves this machine.
//
//   node .claude/skills/verify/scripts/handover.mjs keygen --dir <private dir>     here: prints the public key
//   node .claude/skills/verify/scripts/handover.mjs seal --to <public key>         in the session
//   node .claude/skills/verify/scripts/handover.mjs open --dir <private dir> < <seal output>
//                                                                                   here: writes <dir>/account.json (0600)
//
// `seal` reads the first account the stack made (its email, password and CLI token, in the Docker
// volume `verify-stack-state`, through a container of the session's Docker) and prints one line,
// `verify-handover v1 <ephemeral key> <iv> <tag> <ciphertext>`: X25519 with an ephemeral key,
// SHA-256 of the shared secret and both public keys as the AES-256-GCM key.

import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
// Anything unexpected ends with a fixed message: an exception's text could quote what was read.
process.on("uncaughtException", () => {
  process.stderr.write("handover: failed unexpectedly; nothing of what it read is shown\n");
  process.exit(1);
});
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const fail = (message) => {
  process.stderr.write(`handover: ${message}\n`);
  process.exit(1);
};

const publicDer = (key) =>
  (key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" });
const present = (value) => typeof value === "string" && value.length > 0;
const keyOf = (shared, ephemeral, recipient) =>
  createHash("sha256")
    .update(Buffer.concat([shared, ephemeral, recipient]))
    .digest();

if (command === "keygen") {
  const dir = flag("dir") ?? fail("keygen needs --dir");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  writeFileSync(join(dir, "handover.key"), privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  process.stdout.write(`${publicDer(publicKey).toString("base64url")}\n`);
} else if (command === "seal") {
  const to = flag("to") ?? fail("seal needs --to <public key>");
  const recipient = createPublicKey({
    key: Buffer.from(to, "base64url"),
    format: "der",
    type: "spki",
  });
  // The stack's state names the image it runs its CLI in; that image has `cat`.
  const cache =
    process.env.MEND_VERIFY_STACK_CACHE ??
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "mend-verify-stack");
  let image;
  try {
    image = JSON.parse(readFileSync(join(cache, "stack.json"), "utf8")).images.cli;
  } catch {
    fail("no verify stack here: `stack.mjs up` (or the stack Service) starts one");
  }
  const read = (path) => {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        "verify-stack-state:/state:ro",
        "--entrypoint",
        "cat",
        image,
        `/state/${path}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    // Never echo what was read: on failure, the exit alone.
    if (run.status !== 0)
      fail(`reading the stack's ${path.split("/").at(-1)} exited ${run.status}`);
    // What was read holds secrets: a parse error would quote it. Only a fixed message leaves.
    try {
      return JSON.parse(run.stdout);
    } catch {
      return fail(`the stack's ${path.split("/").at(-1)} is not valid JSON; nothing of it shown`);
    }
  };
  const account = read("client/.config/mend-verify-stack/account.json");
  const cli = read("client/.config/mend/cli.json");
  if (!present(account?.email) || !present(account?.password) || !present(cli?.token))
    fail("the stack's account state lacks an email, a password or a token; nothing of it shown");
  const plaintext = Buffer.from(
    JSON.stringify({ email: account.email, password: account.password, token: cli.token }),
  );
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralDer = publicDer(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyOf(shared, ephemeralDer, publicDer(recipient)),
    iv,
  );
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const fields = [ephemeralDer, iv, cipher.getAuthTag(), sealed].map((part) =>
    part.toString("base64url"),
  );
  process.stdout.write(`verify-handover v1 ${fields.join(" ")}\n`);
} else if (command === "open") {
  const dir = flag("dir") ?? fail("open needs --dir");
  const privateKey = createPrivateKey(readFileSync(join(dir, "handover.key")));
  const line = readFileSync(0, "utf8")
    .replaceAll("\r", "")
    .split("\n")
    .find((text) => text.startsWith("verify-handover v1 "));
  if (!line) fail("no `verify-handover v1` line on stdin");
  const [ephemeralDer, iv, tag, sealed] = line
    .split(" ")
    .slice(2)
    .map((part) => Buffer.from(part, "base64url"));
  const ephemeral = createPublicKey({ key: ephemeralDer, format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyOf(shared, ephemeralDer, publicDer(privateKey)),
    iv,
  );
  decipher.setAuthTag(tag);
  let account;
  try {
    account = JSON.parse(Buffer.concat([decipher.update(sealed), decipher.final()]).toString());
  } catch {
    fail("the handover does not open with this key: it was sealed to another one, or changed");
  }
  writeFileSync(join(dir, "account.json"), JSON.stringify(account), { mode: 0o600 });
  process.stdout.write(
    `handover · the stack's first account (${account.email}) · ${join(dir, "account.json")}\n`,
  );
} else {
  fail("usage: handover.mjs keygen --dir <dir> | seal --to <public key> | open --dir <dir>");
}
