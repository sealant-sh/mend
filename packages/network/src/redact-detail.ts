/**
 * What may leave the server inside an error message (docs/adr/0004, "Errors and browser headers";
 * MEND-11). Error text written by Mend is meant for the person reading it. Text that arrives from
 * below (git's stderr, a platform message, a Node exception) was written for an operator, and
 * carries where things live: store paths, internal hostnames, URLs with credentials, tokens. This
 * keeps the sentence and removes the map.
 */
const MAX_DETAIL = 600;
/** Nothing past this is even looked at, so the patterns below run over a bounded input. */
const MAX_INPUT = 8 * 1024;

/**
 * Absolute paths under the places a server keeps things, a home-relative path, and a Windows
 * drive path. The leaf stays: it is usually the clue. The directory name must end where the match
 * says it does, so `/application` and `/nixos` are words, not `/app` and `/nix` with a tail.
 */
const SERVER_PATH =
  /(?<![\w./~-])(?:\/(?:home|root|Users|var|tmp|srv|data|opt|etc|run|mnt|workspace|mend|app|usr|private|nix)(?![\w.-])|~(?=\/)|\b[A-Za-z]:(?=\\))(?:[\\/][^\s"'`:,;()<>]*)?/g;

/** Any URL. Its credentials, query and fragment go; an internal host goes too. */
const URL_LIKE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s"'`<>()]+/gi;

/** A value that names itself a credential: `token=…`, `password=…`. The name stays. */
const NAMED_SECRET =
  /\b(token|ticket|code|password|passwd|secret|signature|api[-_]?key|access[-_]?key|key)=[^\s"'`&,;()<>]+/gi;
/** `Authorization` values, wherever they were echoed. */
const AUTH_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/g;
/** A JWT: all of it. Its header and payload name the issuer, the subject and the audience. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g;
/** Bearers Mend, Sealant and the providers mint, then anything long enough to be a secret. */
const KNOWN_TOKEN =
  /\b(?:mdt|mut|slt|ghp|gho|ghu|ghs|ghr|github_pat|sk|xox[abprs])[-_][A-Za-z0-9_-]{8,}|\bA[KS]IA[0-9A-Z]{16}\b/g;
/**
 * Long enough to be a secret, or to be a commit or a digest, which are the one fact in "checkpoint
 * … not found". So the head stays and the rest goes: twelve hex characters still name a commit,
 * eight of anything else still name a branch, and neither is a usable part of a secret.
 */
const LONG_HEX = /\b[a-f0-9]{32,}\b/g;
const LONG_SECRET = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;
/** A forty-character base64 value with `/` or `+` in it: the shape of a cloud secret key. */
const BASE64_SECRET =
  /(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*[+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/=])/g;

const INTERNAL_HOST =
  /^(?:localhost|.*\.(?:local|internal|svc|cluster\.local|lan|home\.arpa)|[^.]+|(?:10|127)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|169\.254\.\d+\.\d+|\[[0-9a-f:]+\])$/i;

const redactOneUrl = (raw: string): string => {
  // Trailing punctuation belongs to the sentence, not the URL.
  const trailing = /[.,;:!?)\]]+$/.exec(raw)?.[0] ?? "";
  const candidate = trailing === "" ? raw : raw.slice(0, -trailing.length);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return `<url>${trailing}`;
  }
  const host = INTERNAL_HOST.test(parsed.hostname) ? "<internal>" : parsed.host;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${host}${path}${trailing}`;
};

export const redactDetail = (detail: string): string => {
  const scrubbed = detail
    .slice(0, MAX_INPUT)
    .replace(URL_LIKE, (match) => redactOneUrl(match))
    .replace(NAMED_SECRET, (_match, name: string) => `${name}=<redacted>`)
    .replace(AUTH_SCHEME, (_match, scheme: string) => `${scheme} <redacted>`)
    .replace(JWT, "<redacted>")
    .replace(KNOWN_TOKEN, "<redacted>")
    .replace(SERVER_PATH, (match) => {
      const segments = match.split(/[\\/]/).filter((segment) => segment !== "");
      const leaf = segments.at(-1);
      return leaf === undefined || segments.length < 2 ? "<path>" : `<path>/${leaf}`;
    })
    .replace(BASE64_SECRET, "<redacted>")
    .replace(LONG_HEX, (match) => `${match.slice(0, 12)}…`)
    .replace(LONG_SECRET, (match) => `${match.slice(0, 8)}…`);
  return scrubbed.length > MAX_DETAIL ? `${scrubbed.slice(0, MAX_DETAIL)}…` : scrubbed;
};
