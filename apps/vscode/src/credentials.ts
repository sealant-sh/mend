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

import { normalizeServerUrl } from "./sign-in.js";

/**
 * The one form a server URL is kept and compared in: what Connect writes (lowercase scheme and
 * host, no default :80 or :443, no trailing slash; the path's case kept, so instances under
 * different paths stay apart). Anything that is not an http(s) URL is kept as typed, trimmed.
 */
export const canonicalServerUrl = (url: string): string => normalizeServerUrl(url) ?? url.trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One stored entry; entries written before "none" existed are tokens. */
const credentialOf = (value: unknown): StoredCredential | null => {
  if (!isRecord(value) || typeof value["url"] !== "string") return null;
  const url = canonicalServerUrl(value["url"]);
  const token = value["token"];
  if (typeof token === "string") {
    const deviceId = value["deviceId"];
    return { kind: "token", url, token, deviceId: typeof deviceId === "string" ? deviceId : null };
  }
  return token === null ? { kind: "none", url } : null;
};

/** What the editor keeps, one entry per server URL. */
export type CredentialStore = ReadonlyMap<string, StoredCredential>;

/**
 * Read the stored entries, each under its canonical URL. An editor that signed in before there was
 * one entry per server kept a single entry; it reads as a store of one. Entries saved under
 * spellings of one server (case, a default port, a trailing slash) collapse into one: a signed-out
 * entry wins over any token, so a stale token cannot undo a sign-out; among tokens, the last saved.
 */
export const parseCredentialStore = (value: string | undefined): CredentialStore => {
  const store = new Map<string, StoredCredential>();
  if (value === undefined) return store;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return store;
  }
  const entries =
    isRecord(parsed) && Array.isArray(parsed["entries"]) ? parsed["entries"] : [parsed];
  for (const entry of entries) {
    const credential = credentialOf(entry);
    if (credential === null) continue;
    if (store.get(credential.url)?.kind === "none") continue;
    store.set(credential.url, credential);
  }
  return store;
};

export const serializeCredentialStore = (store: CredentialStore): string =>
  JSON.stringify({
    entries: [...store.values()].map((credential) =>
      credential.kind === "token"
        ? { url: credential.url, token: credential.token, deviceId: credential.deviceId }
        : { url: credential.url, token: null },
    ),
  });

/** The store with `credential` as its server's entry, every other server's left as it was. */
export const withCredential = (
  store: CredentialStore,
  credential: StoredCredential,
): CredentialStore => {
  const url = canonicalServerUrl(credential.url);
  return new Map([...store, [url, { ...credential, url }]]);
};

/** The editor's own entry for `url`, under any spelling of it. */
export const credentialFor = (store: CredentialStore, url: string): StoredCredential | null =>
  store.get(canonicalServerUrl(url)) ?? null;

/** The token for `url`: the editor's own entry for it first, then the CLI's for the same URL. */
export const tokenFor = (
  url: string,
  stored: StoredCredential | null,
  cli: CliCredential | null,
): string | null => {
  const server = canonicalServerUrl(url);
  if (stored !== null && canonicalServerUrl(stored.url) === server) {
    return stored.kind === "token" ? stored.token : null;
  }
  return cli !== null && canonicalServerUrl(cli.url) === server ? cli.token : null;
};

/**
 * Signing out of `url`: the editor's own token entry for it (to revoke), and the store with "no
 * token" for it. Other servers' entries, and the CLI's sign-in, are untouched.
 */
export const signOutOf = (
  url: string,
  store: CredentialStore,
): {
  readonly own: Extract<StoredCredential, { kind: "token" }> | null;
  readonly next: CredentialStore;
} => {
  const server = canonicalServerUrl(url);
  const entry = store.get(server);
  return {
    own: entry !== undefined && entry.kind === "token" ? entry : null,
    next: withCredential(store, { kind: "none", url: server }),
  };
};
