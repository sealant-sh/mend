import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import { MendKeysConfig } from "./git-auth.ts";

/**
 * Encryption at rest for project secrets. AES-256-GCM via node:crypto; the 32-byte key lives in
 * `<keys root>/secrets.key` (0600, generated on first use, never copied anywhere — same discipline
 * as the machine's Mend deploy key). Sealed format: `v1.<iv b64url>.<tag b64url>.<ciphertext b64url>`.
 * A lost key means the stored secrets are unrecoverable by design: re-enter them.
 */

export const SEALED_SECRET_VERSION = "v1";
const KEY_FILE = "secrets.key";

export class SecretCipherError extends Schema.TaggedError<SecretCipherError>()(
  "SecretCipherError",
  {
    operation: Schema.Literals(["key", "encrypt", "decrypt"]),
    message: Schema.String,
  },
) {}

export class SecretCipher extends Context.Service<
  SecretCipher,
  {
    readonly encrypt: (plaintext: string) => Effect.Effect<string, SecretCipherError>;
    readonly decrypt: (sealed: string) => Effect.Effect<string, SecretCipherError>;
  }
>()("@mend/store/SecretCipher") {}

const b64url = (bytes: Buffer): string => bytes.toString("base64url");
const fromB64url = (text: string): Buffer => Buffer.from(text, "base64url");

/** Read the machine secrets key, generating it 0600 on first use. */
const loadOrCreateKey = (root: string): Effect.Effect<Buffer, SecretCipherError> =>
  Effect.try({
    try: () => {
      const file = path.join(root, KEY_FILE);
      if (fs.existsSync(file)) {
        const key = fs.readFileSync(file);
        if (key.length !== 32) {
          throw new Error(`${file} must hold exactly 32 bytes (found ${key.length})`);
        }
        return key;
      }
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      fs.writeFileSync(file, key, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      return key;
    },
    catch: (cause) =>
      new SecretCipherError({
        operation: "key",
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const SecretCipherLive: Layer.Layer<SecretCipher, never, MendKeysConfig> = Layer.effect(
  SecretCipher,
  Effect.gen(function* () {
    const config = yield* MendKeysConfig;

    const encrypt = Effect.fn("SecretCipher.encrypt")(function* (plaintext: string) {
      const key = yield* loadOrCreateKey(config.root);
      return yield* Effect.try({
        try: () => {
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv);
          const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
          const tag = cipher.getAuthTag();
          return `${SEALED_SECRET_VERSION}.${b64url(iv)}.${b64url(tag)}.${b64url(ciphertext)}`;
        },
        catch: (cause) =>
          new SecretCipherError({
            operation: "encrypt",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    });

    const decrypt = Effect.fn("SecretCipher.decrypt")(function* (sealed: string) {
      const key = yield* loadOrCreateKey(config.root);
      return yield* Effect.try({
        try: () => {
          const [version, iv, tag, ciphertext, ...rest] = sealed.split(".");
          if (
            version !== SEALED_SECRET_VERSION ||
            iv === undefined ||
            tag === undefined ||
            ciphertext === undefined ||
            rest.length > 0
          ) {
            throw new Error("sealed secret has an unrecognized shape");
          }
          const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(iv));
          decipher.setAuthTag(fromB64url(tag));
          return Buffer.concat([
            decipher.update(fromB64url(ciphertext)),
            decipher.final(),
          ]).toString("utf8");
        },
        catch: (cause) =>
          new SecretCipherError({
            operation: "decrypt",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    });

    return { encrypt, decrypt };
  }),
);
