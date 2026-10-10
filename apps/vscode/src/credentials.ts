/**
 * Which token the editor sends to a server, from what it keeps in its secret storage and what the
 * Mend CLI saved on this machine (`cli.json`). The editor's own entry wins for its URL, and that
 * includes an entry that says "no token": after a sign-out, or a connect with no token, the editor
 * must not quietly fall back to the CLI's sign-in, which may be another account.
 */

/** What the editor keeps for one server URL. */
export type StoredCredential =
  | {
      readonly kind: "token";
      readonly url: string;
      readonly token: string;
      /** The device a browser sign-in created; sign-out revokes it. Null for a pasted token. */
      readonly deviceId: string | null;
    }
  | { readonly kind: "none"; readonly url: string };

/** The CLI's saved sign-in, when there is one. */
export interface CliCredential {
  readonly url: string;
  readonly token: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read the stored entry; entries written before "none" existed are tokens. */
export const parseStoredCredential = (value: string | undefined): StoredCredential | null => {
  if (value === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed["url"] !== "string") return null;
  const url = parsed["url"];
  const token = parsed["token"];
  if (typeof token === "string") {
    const deviceId = parsed["deviceId"];
    return { kind: "token", url, token, deviceId: typeof deviceId === "string" ? deviceId : null };
  }
  return token === null ? { kind: "none", url } : null;
};

export const serializeStoredCredential = (credential: StoredCredential): string =>
  JSON.stringify(
    credential.kind === "token"
      ? { url: credential.url, token: credential.token, deviceId: credential.deviceId }
      : { url: credential.url, token: null },
  );

/** The token for `url`: the editor's own entry for it first, then the CLI's for the same URL. */
export const tokenFor = (
  url: string,
  stored: StoredCredential | null,
  cli: CliCredential | null,
): string | null => {
  if (stored !== null && stored.url === url) return stored.kind === "token" ? stored.token : null;
  return cli !== null && cli.url === url ? cli.token : null;
};
