/**
 * Which token the editor sends to a server, from what it keeps in its secret storage and what the
 * Mend CLI saved on this machine (`cli.json`). The editor's own entry wins for its URL, and that
 * includes an entry that says "no token": after a sign-out the editor must not quietly fall back to
 * the CLI's sign-in, which may be another account.
 */

/** What the editor keeps for one server URL, as the rest of the extension reads it. */
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
  | { readonly kind: "none"; readonly url: string }
  /**
   * Mend refused the CLI's token there: that token is not sent again, and the CLI's sign-in applies
   * once it holds another (`mend login`). Kept by its sha256, never the token itself.
   */
  | { readonly kind: "cliRefused"; readonly url: string; readonly tokenHash: string };

/** The CLI's saved sign-in, when there is one. */
export interface CliCredential {
  readonly url: string;
  readonly token: string | null;
}

import { createHash } from "node:crypto";

import { normalizeServerUrl } from "./sign-in.js";

const fingerprint = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Whether `token`, the CLI's, is the one Mend refused at the entry's server. */
export const cliTokenRefused = (stored: StoredCredential | null, token: string): boolean =>
  stored?.kind === "cliRefused" && stored.tokenHash === fingerprint(token);

/**
 * The one form a server URL is kept and compared in: what Connect writes (lowercase scheme and
 * host, no default :80 or :443, no trailing slash; the path's case kept, so instances under
 * different paths stay apart). Anything that is not an http(s) URL is kept as typed, trimmed.
 */
export const canonicalServerUrl = (url: string): string => normalizeServerUrl(url) ?? url.trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One entry of the blob before 0.37; entries written before "none" existed are tokens. */
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
  if (token !== null) return null;
  const refused = value["refusedCliToken"];
  return typeof refused === "string"
    ? { kind: "cliRefused", url, tokenHash: refused }
    : { kind: "none", url };
};

/**
 * Every server's entry in one JSON blob: where an editor before 0.37 kept them, and where a window
 * still running one keeps them until it reloads. Read for a server with no key of its own; never
 * written.
 */
const LEGACY_KEY = "mend.serverToken";

/**
 * The blob's entries, each under its canonical URL. An editor that signed in before there was one
 * entry per server kept a single entry; it reads as a blob of one. Entries saved under spellings of
 * one server collapse into one: a signed-out entry wins over any token; among tokens, the last.
 */
const legacyEntries = (value: string | undefined): ReadonlyMap<string, StoredCredential> => {
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

/**
 * What the editor keeps for one server under that server's own key: a sign-in's token, a sign-out
 * ("no token", and no falling back to the CLI's), or Use it (the CLI's sign-in applies).
 */
type ServerEntry =
  | {
      readonly kind: "token";
      readonly token: string;
      readonly deviceId: string | null;
      readonly email?: string;
    }
  | { readonly kind: "none" }
  | { readonly kind: "cli" };

const serverKey = (url: string): string => `mend.server:${canonicalServerUrl(url)}`;

const refusalKey = (url: string, token: string): string =>
  `mend.refused:${canonicalServerUrl(url)}#${fingerprint(token)}`;

/** A value under a server's key. One this editor cannot read sends no token: it fails closed. */
const serverEntryOf = (value: string): ServerEntry => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { kind: "none" };
  }
  if (!isRecord(parsed)) return { kind: "none" };
  if (parsed["kind"] === "cli") return { kind: "cli" };
  const { token, deviceId, email } = parsed;
  if (parsed["kind"] !== "token" || typeof token !== "string") return { kind: "none" };
  return {
    kind: "token",
    token,
    deviceId: typeof deviceId === "string" ? deviceId : null,
    ...(typeof email === "string" ? { email } : {}),
  };
};

/** What happened to the editor's sign-in at one server. */
export type CredentialChange =
  | {
      readonly kind: "signedIn";
      readonly url: string;
      readonly token: string;
      readonly deviceId: string | null;
      readonly email?: string;
    }
  | { readonly kind: "signedOut"; readonly url: string }
  /** Use it: the editor keeps nothing of its own there, and the CLI's sign-in applies. */
  | { readonly kind: "useCli"; readonly url: string }
  /** Mend at `url` answered 401 to `token`. */
  | { readonly kind: "refused"; readonly url: string; readonly token: string };

/**
 * The one secret a change writes. Every VS Code window writes the same secret storage, and a window
 * can read another's write late, so no write carries anything a window read: the value comes from
 * the change alone. A sign-in, a sign-out and Use it write their server's own key, so a change at
 * one server never rewrites another's. A refusal writes a key of its own token, so it never ends a
 * newer sign-in at the same server. A server's value carries `write`, fresh for each write:
 * VS Code sends no write of the value a window already holds, so an identical Use it or sign-out
 * would be dropped while another window's earlier write is still on its way. A refusal carries
 * none: nothing else is written under its key, so a dropped repeat leaves the same refusal there.
 */
export const secretWriteOf = (
  change: CredentialChange,
  write: string,
): { readonly key: string; readonly value: string } => {
  switch (change.kind) {
    case "signedIn":
      return {
        key: serverKey(change.url),
        value: JSON.stringify({
          kind: "token",
          token: change.token,
          deviceId: change.deviceId,
          ...(change.email === undefined ? {} : { email: change.email }),
          write,
        }),
      };
    case "signedOut":
      return {
        key: serverKey(change.url),
        value: JSON.stringify({ kind: "none", write }),
      };
    case "useCli":
      return { key: serverKey(change.url), value: JSON.stringify({ kind: "cli", write }) };
    case "refused":
      return { key: refusalKey(change.url, change.token), value: "refused" };
  }
};

type ReadSecret = (key: string) => Promise<string | undefined>;

/** Whether Mend at `url` refused `token`, as this window reads it. */
export const isRefused = async (read: ReadSecret, url: string, token: string): Promise<boolean> =>
  (await read(refusalKey(url, token))) !== undefined;

const ownEntry = async (read: ReadSecret, server: string): Promise<StoredCredential | null> => {
  const value = await read(serverKey(server));
  if (value === undefined) return legacyEntries(await read(LEGACY_KEY)).get(server) ?? null;
  const entry = serverEntryOf(value);
  switch (entry.kind) {
    case "cli":
      return null;
    case "none":
      return { kind: "none", url: server };
    case "token":
      return { ...entry, url: server };
  }
};

/**
 * The editor's own entry for `url`, under any spelling of it: its server's key, else what the blob
 * before 0.37 kept for it. When Mend refused the token that entry would send, the entry reads as
 * the refusal: its own token as "no token" (the CLI's sign-in does not quietly take over), the
 * CLI's as `cliRefused` (the CLI's next token is sent).
 */
export const keptCredential = async (
  read: ReadSecret,
  url: string,
  cli: CliCredential | null,
): Promise<StoredCredential | null> => {
  const server = canonicalServerUrl(url);
  const own = await ownEntry(read, server);
  const sent = tokenFor(server, own, cli);
  if (sent === null || !(await isRefused(read, server, sent))) return own;
  return own?.kind === "token"
    ? { kind: "none", url: server }
    : { kind: "cliRefused", url: server, tokenHash: fingerprint(sent) };
};

/** The token for `url`: the editor's own entry for it first, then the CLI's for the same URL. */
export const tokenFor = (
  url: string,
  stored: StoredCredential | null,
  cli: CliCredential | null,
): string | null => {
  const server = canonicalServerUrl(url);
  const own = stored !== null && canonicalServerUrl(stored.url) === server ? stored : null;
  if (own?.kind === "token") return own.token;
  if (own?.kind === "none") return null;
  const token = cli !== null && canonicalServerUrl(cli.url) === server ? cli.token : null;
  return token === null || cliTokenRefused(own, token) ? null : token;
};

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
