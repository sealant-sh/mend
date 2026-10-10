/**
 * Credentials in repository URLs. Mend stores a repository URL and returns it to everyone who can
 * see what it belongs to, so a token or password in one is readable by them all. Mend refuses such
 * a URL where it enters, and redacts any that reaches a response or a log.
 *
 * One parser decides both, read the way RFC 3986 and URL parsers read an authority: it runs from
 * `scheme://` to the next `/`, `?` or `#`, and its userinfo is everything before the LAST `@` in
 * it, whatever characters that holds (quotes, angle brackets, spaces, unicode, `%`-escapes, more
 * `@`s). No character class decides what a credential may contain.
 *
 * Over ssh the user is a login name (`ssh://git@host/path`, `git@host:path`) and stays; a password
 * goes. Over every other scheme the user is where tokens go (`https://oauth2:TOKEN@host`,
 * `https://TOKEN@host`), so the whole userinfo goes.
 */

/** A `scheme://` whose scheme does not continue a longer word. */
const SCHEME_START = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*):\/\//gi;

const isSshScheme = (scheme: string): boolean => /^(?:git\+)?ssh(?:\+git)?$/i.test(scheme);

/** Where an authority starting at `from` ends: its first `/`, `?` or `#` (or whitespace, in text). */
const authorityEnd = (text: string, from: number, inText: boolean): number => {
  for (let index = from; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "/" || char === "?" || char === "#") return index;
    if (inText && /\s/u.test(char)) return index;
  }
  return text.length;
};

/**
 * What an authority keeps of its userinfo: nothing, or an ssh login with no password. A login that
 * itself holds an `@` or a `:` is not a plain name, so it goes whole.
 */
const keptUserinfo = (scheme: string, userinfo: string): string => {
  if (!isSshScheme(scheme)) return "";
  const user = userinfo.split(":")[0] ?? "";
  return user === "" || user.includes("@") ? "" : `${user}@`;
};

/**
 * Redact every `scheme://authority` in `text`. `inText`: free text (a log line, git's stderr),
 * where whitespace also ends an authority so one URL cannot reach into the next word. Without it
 * the string is one URL, and only `/`, `?` and `#` end its authority.
 */
const redact = (text: string, inText: boolean): string => {
  let out = "";
  let copied = 0;
  for (const match of text.matchAll(SCHEME_START)) {
    const scheme = match[1] ?? "";
    const authorityStart = match.index + match[0].length;
    if (authorityStart < copied) continue;
    const end = authorityEnd(text, authorityStart, inText);
    const authority = text.slice(authorityStart, end);
    const at = authority.lastIndexOf("@");
    if (at === -1) continue;
    const userinfo = authority.slice(0, at);
    const kept = keptUserinfo(scheme, userinfo);
    if (kept === `${userinfo}@`) continue;
    out += `${text.slice(copied, authorityStart)}${kept}`;
    copied = authorityStart + at + 1;
  }
  return copied === 0 ? text : out + text.slice(copied);
};

/** Whether a URL parser finds a credential in `url`: a password, or a user over any scheme but ssh. */
const parsedCredential = (url: string): boolean => {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  const scheme = parsed.protocol.slice(0, -1);
  return parsed.password !== "" || (parsed.username !== "" && !isSshScheme(scheme));
};

/** `url` with its credential cleared through a URL parser, which may respell it. */
const clearedByParser = (url: string): string => {
  const parsed = new URL(url);
  parsed.password = "";
  if (!isSshScheme(parsed.protocol.slice(0, -1))) parsed.username = "";
  return parsed.toString();
};

/**
 * `text` with the credential part of every URL in it removed: the password of an ssh URL, the whole
 * userinfo of any other. For free text: git's stderr, a log line, an error message.
 */
export const redactUrlCredentials = (text: string): string => redact(text, true);

/**
 * One repository URL with its credential removed, kept as typed otherwise: a stored origin, a git
 * remote, an argument. Whitespace does not end its authority here, and should a URL parser still
 * find a credential the scan did not, the parser clears it.
 */
export const redactRepositoryUrl = (url: string): string => {
  const scanned = redact(url, false);
  return parsedCredential(scanned) ? clearedByParser(scanned) : scanned;
};

/** `redactRepositoryUrl` over a nullable column. */
export const redactNullableUrlCredentials = (url: string | null): string | null =>
  url === null ? null : redactRepositoryUrl(url);

/**
 * Whether a repository URL carries a login or token Mend must not store: the authority scan finds
 * one, or a URL parser does. Either is enough to refuse.
 */
export const repositoryUrlHasCredential = (url: string): boolean =>
  redactRepositoryUrl(url) !== url || parsedCredential(url);

/** Why a repository URL with a credential is refused, and the supported ways instead. */
export const REPOSITORY_URL_CREDENTIAL_GUIDANCE =
  'This URL carries a login or token before the "@". Mend shows a repository URL to everyone who can see the repository, so it never stores one. Use the SSH URL (git@host:owner/repo.git) with your Mend key (`mend keys` shows it), or your own key through the agent bridge (`--auth bridge`).';
