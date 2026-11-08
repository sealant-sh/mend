import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * An access key reads `mak_<id>_<secret>` (docs/adr/0023-access-keys.md, decision 4). The id is
 * its row's and has no `_`; the secret is 32 random bytes in base64url, which may. Only the
 * SHA-256 of the secret is stored.
 */
export const ACCESS_KEY_PREFIX = "mak_";

export const mintAccessKeySecret = (): string => randomBytes(32).toString("base64url");

export const hashAccessKeySecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

export const formatAccessKey = (id: string, secret: string): string =>
  `${ACCESS_KEY_PREFIX}${id}_${secret}`;

export const parseAccessKey = (
  key: string,
): { readonly id: string; readonly secret: string } | null => {
  if (!key.startsWith(ACCESS_KEY_PREFIX)) return null;
  const rest = key.slice(ACCESS_KEY_PREFIX.length);
  const split = rest.indexOf("_");
  if (split <= 0 || split === rest.length - 1) return null;
  return { id: rest.slice(0, split), secret: rest.slice(split + 1) };
};

/** Whether `secret` hashes to `storedHash`, compared in constant time. */
export const accessKeySecretMatches = (secret: string, storedHash: string): boolean => {
  const stored = Buffer.from(storedHash, "hex");
  const presented = createHash("sha256").update(secret).digest();
  return stored.length === presented.length && timingSafeEqual(stored, presented);
};

/**
 * The bearer an `Authorization` header carries, read the way Better Auth's bearer plugin reads
 * it: the scheme in any case, the token trimmed.
 */
export const bearerOf = (headers: Headers): string | null => {
  const authorization = headers.get("authorization");
  if (authorization === null || authorization.slice(0, 7).toLowerCase() !== "bearer ") return null;
  const token = authorization.slice(7).trim();
  return token === "" ? null : token;
};

/** A request whose bearer is an access key is resolved as one and nothing else. */
export const bearsAccessKey = (headers: Headers): boolean =>
  bearerOf(headers)?.startsWith(ACCESS_KEY_PREFIX) === true;
