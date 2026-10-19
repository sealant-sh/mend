/**
 * Which token the editor sends to a server, from what it keeps in its secret storage and what the
 * Mend CLI saved on this machine (`cli.json`). The editor's own entry wins for its URL, and that
 * includes an entry that says "no token": after a sign-out the editor must not quietly fall back to
 * the CLI's sign-in, which may be another account.
 */

/** What the editor keeps for one server URL. */
export type StoredCredential =
  | {
      readonly kind: "token";
      readonly url: string;
      readonly token: string;
      /** The device a browser sign-in created; sign-out revokes it. Null for a pasted token. */
      readonly deviceId: string | null;
      /** The account the sign-in approved, for the Accounts menu while Mend cannot be read. */
      readonly email?: string;
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
    const email = value["email"];
    return {
      kind: "token",
      url,
      token,
      deviceId: typeof deviceId === "string" ? deviceId : null,
      ...(typeof email === "string" ? { email } : {}),
    };
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
        ? {
            url: credential.url,
            token: credential.token,
            deviceId: credential.deviceId,
            ...(credential.email === undefined ? {} : { email: credential.email }),
          }
        : { url: credential.url, token: null },
    ),
  });

/** The store with no entry of its own for `url`: the CLI's sign-in for it applies again. */
export const withoutCredential = (store: CredentialStore, url: string): CredentialStore => {
  const next = new Map(store);
  next.delete(canonicalServerUrl(url));
  return next;
};

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

/**
 * Mend refused `token` at `url` (401): the store with "no token" there, so every window and the
 * Accounts menu drop the account together. Null when the editor no longer sends that token there
 * (a sign-in or a sign-out since), so a late refusal never undoes a newer sign-in.
 */
export const refusedIn = (
  store: CredentialStore,
  refused: { readonly url: string; readonly token: string },
  cli: CliCredential | null,
): CredentialStore | null =>
  tokenFor(refused.url, credentialFor(store, refused.url), cli) === refused.token
    ? withCredential(store, { kind: "none", url: refused.url })
    : null;

/** What Mend answered when asked to revoke a device (`DELETE /me/devices/:id`). */
export type RevokeOutcome =
  | { readonly kind: "revoked" }
  /** 401 or 404: the device's token no longer signs in, or the device is gone. */
  | { readonly kind: "alreadySignedOut" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "refused"; readonly status: number };

/** A revoke's outcome from the status Mend answered with; null when nothing answered. */
export const revokeOutcomeOf = (status: number | null): RevokeOutcome => {
  if (status === null) return { kind: "unreachable" };
  if (status === 401 || status === 404) return { kind: "alreadySignedOut" };
  return { kind: "refused", status };
};

/** What a sign-out ended: the editor's own device, a pasted token, or only the CLI's fallback. */
export type SignedOut =
  | { readonly kind: "device"; readonly outcome: RevokeOutcome }
  | { readonly kind: "pastedToken" }
  | { readonly kind: "cliFallback" };

/** The one message of a sign-out she chose, in what Mend answered. */
export const signOutMessage = (url: string, signedOut: SignedOut): string => {
  switch (signedOut.kind) {
    case "cliFallback":
      return `Signed out of Mend at ${url} in this editor. The Mend CLI on this machine keeps its own sign-in; mend logout ends it.`;
    case "pastedToken":
      return `Signed out of Mend at ${url}. The pasted token stays valid until it is revoked under Settings → Devices.`;
    case "device":
      switch (signedOut.outcome.kind) {
        case "revoked":
          return `Signed out of Mend at ${url}, and revoked this editor's device.`;
        case "alreadySignedOut":
          return `Signed out of Mend at ${url}. This device was already signed out.`;
        case "unreachable":
          return `Signed out of Mend at ${url}; Mend could not be reached to revoke this editor's device. Revoke it under Settings → Devices.`;
        case "refused":
          return `Signed out of Mend at ${url}; Mend answered ${signedOut.outcome.status} when asked to revoke this editor's device. Revoke it under Settings → Devices.`;
      }
  }
};

/**
 * Said once when a new sign-in replaced this editor's earlier device and Mend did not revoke it;
 * null when it is gone.
 */
export const replacedDeviceWarning = (url: string, outcome: RevokeOutcome): string | null => {
  switch (outcome.kind) {
    case "revoked":
    case "alreadySignedOut":
      return null;
    case "unreachable":
      return `Signed in again to Mend at ${url}; Mend could not be reached to revoke this editor's earlier device. Revoke it under Settings → Devices.`;
    case "refused":
      return `Signed in again to Mend at ${url}; Mend answered ${outcome.status} when asked to revoke this editor's earlier device. Revoke it under Settings → Devices.`;
  }
};
