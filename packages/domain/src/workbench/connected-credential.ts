/**
 * What Mend sends when someone connects a provider, and nothing more
 * (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
 *
 * Claude Code writes one document that holds two unrelated things: `claudeAiOauth`, the grant for
 * Claude itself, and `mcpOAuth`, refresh tokens for whichever MCP servers the person authorized on
 * that machine — Figma, Atlassian, Linear. Only the first is Mend's business. The second belongs to
 * the laptop that authorized those servers, and a workspace has no use for it.
 *
 * So a Claude credential is narrowed to its `claudeAiOauth` section before it leaves the machine,
 * and again on the way through Mend's API, because a hand-rolled client is a client too. Anything
 * that is not that document — a `setup-token`, a Codex `auth.json`, a GitHub token — travels as the
 * provider's CLI wrote it.
 */

/** The providers a person can connect. */
export type CredentialProvider = "claude" | "codex" | "github";

/** What narrowing did, so a caller can say it plainly instead of guessing. */
export type NarrowOutcome =
  /** A Claude credential document; `dropped` names the sections left behind. */
  | { readonly kind: "narrowed"; readonly secret: string; readonly dropped: ReadonlyArray<string> }
  /** Not a document this knows how to narrow (a token, another provider): unchanged. */
  | { readonly kind: "unchanged"; readonly secret: string };

/** The one section of a Claude credential document Mend sends. */
export const CLAUDE_GRANT_SECTION = "claudeAiOauth";

/**
 * Narrow a credential to what Mend sends. Never throws, and never widens: a payload it cannot
 * parse, or one without a `claudeAiOauth` section, comes back untouched, because guessing at a
 * credential's shape is how a person's `setup-token` gets mangled.
 */
export const narrowCredential = (provider: CredentialProvider, secret: string): NarrowOutcome => {
  if (provider !== "claude") return { kind: "unchanged", secret };
  const parsed = parseDocument(secret);
  if (parsed === null) return { kind: "unchanged", secret };
  const grant = parsed[CLAUDE_GRANT_SECTION];
  if (grant === undefined) return { kind: "unchanged", secret };
  const dropped = Object.keys(parsed)
    .filter((key) => key !== CLAUDE_GRANT_SECTION)
    .toSorted();
  return {
    kind: "narrowed",
    // Two spaces and a trailing newline: the shape Claude Code writes, so a round trip through
    // Mend leaves a file a person can still read.
    secret: `${JSON.stringify({ [CLAUDE_GRANT_SECTION]: grant }, null, 2)}\n`,
    dropped,
  };
};

/** A JSON object, or null for anything else — a bare token, an array, a number, malformed text. */
const parseDocument = (secret: string): Record<string, unknown> | null => {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** What a Claude grant says about itself, for a person to read. Never the tokens. */
export interface ClaudeGrantFacts {
  readonly accessExpiresAt: Date | null;
  readonly refreshExpiresAt: Date | null;
  readonly subscriptionType: string | null;
  /** Whether the document carries a refresh token at all; a cleared grant does not. */
  readonly hasRefreshToken: boolean;
}

/**
 * Read the facts a Claude credential document states. A `setup-token` or an unparseable payload
 * answers null: Mend then reports what it observed, which is nothing.
 */
export const claudeGrantFacts = (secret: string): ClaudeGrantFacts | null => {
  const parsed = parseDocument(secret);
  const grant = parsed?.[CLAUDE_GRANT_SECTION];
  if (typeof grant !== "object" || grant === null) return null;
  const record: Record<string, unknown> = { ...grant };
  const refreshToken = record["refreshToken"];
  return {
    accessExpiresAt: asDate(record["expiresAt"]),
    refreshExpiresAt: asDate(record["refreshTokenExpiresAt"]),
    subscriptionType:
      typeof record["subscriptionType"] === "string" ? record["subscriptionType"] : null,
    hasRefreshToken: typeof refreshToken === "string" && refreshToken !== "",
  };
};

/** Milliseconds since the epoch, as Claude Code writes them; anything else is unknown. */
const asDate = (value: unknown): Date | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Whether two credential documents carry the same grant, compared by refresh token. Mend asks this
 * before it connects a credential: two copies of one grant race on refresh, and the copy that
 * refreshes second is logged out (ADR 0005).
 */
export const sameGrant = (left: string, right: string): boolean => {
  const token = (secret: string): string | null => {
    const grant = parseDocument(secret)?.[CLAUDE_GRANT_SECTION];
    if (typeof grant !== "object" || grant === null) return null;
    const value = (grant as Record<string, unknown>)["refreshToken"];
    return typeof value === "string" && value !== "" ? value : null;
  };
  const a = token(left);
  const b = token(right);
  return a !== null && b !== null && a === b;
};
