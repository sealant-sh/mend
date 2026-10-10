/**
 * Credentials in repository URLs. Mend stores a repository URL and returns it to everyone who can
 * see what it belongs to, so a token or password in one is readable by them all. Mend refuses such
 * a URL where it enters, and redacts any that reaches a response or a log.
 *
 * One parser decides both, for one URL and for free text alike (the server's logs and errors, every
 * line the CLI prints), read the way RFC 3986 and URL parsers read an authority: it runs from
 * `scheme://` to the next `/`, `?` or `#`, and its userinfo is everything before the LAST `@` in
 * it, whatever characters that holds. Quotes, angle brackets, unicode and `%`-escapes are userinfo
 * like any other character (review of mend#640), and so is whitespace: a URL parser drops a tab or
 * a newline and encodes a space, so `oauth2:p<TAB>tok@` is a password too (review 3 of mend#611).
 * Whitespace is userinfo only in a URL that holds it, though: the authority spans whitespace only
 * when a host (and a numeric port) follows its last `@` and a path, query or fragment follows the
 * host, as in every repository URL. Otherwise the authority ends at the whitespace, so prose such as
 * `file:// URLs do not … git@github.com:acme/api.git` keeps every word (the scp-style `github.com:
 * acme` is no host and port). Output that must keep its shape (JSON) redacts each string on its own.
 *
 * Over ssh the user is a login name (`ssh://git@host/path`, `git@host:path`) and stays; a password
 * goes, and a login holding an `@` goes whole. Over every other scheme the user is where tokens go
 * (`https://oauth2:TOKEN@host`, `https://TOKEN@host`), so the whole userinfo goes. scp-like
 * `git@host:path` has no `//` and stays as it is.
 */

const isSshScheme = (scheme: string): boolean => /^(?:git\+)?ssh(?:\+git)?$/i.test(scheme);

/** Where an authority starting at `from` ends: its first `/`, `?` or `#`. */
const authorityEnd = (text: string, from: number): number => {
  const rest = text.slice(from).search(/[/?#]/u);
  return rest === -1 ? text.length : from + rest;
};

/**
 * What an authority keeps of its userinfo: nothing, or an ssh login with its password dropped. A
 * login holding an `@` is not one name, so it goes whole.
 */
const keptUserinfo = (scheme: string, userinfo: string): string => {
  if (!isSshScheme(scheme)) return "";
  const user = userinfo.split(":")[0] ?? "";
  return user === "" || user.includes("@") ? "" : `${user}@`;
};

/** A host as an authority ends with it: a name or an address in brackets, then a numeric port. */
const isHostAndPort = (value: string): boolean =>
  /^(?:\[[0-9a-f:.]+\]|[^\s@:[\]]+)(?::\d*)?$/iu.test(value);

/**
 * The authority starting at `from`, up to `end`, read as free text: whitespace in it is userinfo
 * only when a host follows its last `@` and a path, query or fragment follows that host, else the
 * authority ends at the whitespace.
 */
const authorityIn = (text: string, from: number, end: number): string => {
  const authority = text.slice(from, end);
  const space = authority.search(/\s/u);
  if (space === -1) return authority;
  const at = authority.lastIndexOf("@");
  const holdsWhitespace = at > space && end < text.length && isHostAndPort(authority.slice(at + 1));
  return holdsWhitespace ? authority : authority.slice(0, space);
};

const isSchemeChar = (char: string): boolean => /[a-z0-9+.-]/iu.test(char);

/**
 * The scheme that ends at `separator` (the index of a `://`), found no further back than `floor`:
 * the run of scheme characters before it, from its first letter. A `scheme://` counts wherever it
 * stands, after a letter, a digit, `.` or `-` too (`...https://`, `-https://`, `1https://`), since
 * what comes before it in text says nothing of the credential after it (review 2 of mend#640). A
 * longer spelling only takes more away: every scheme but ssh loses its whole userinfo. Found from
 * each `://` backwards, so the scan stays linear in the text, whatever it holds.
 */
const schemeBefore = (text: string, separator: number, floor: number): string | null => {
  let start = separator;
  while (start > floor && isSchemeChar(text.charAt(start - 1))) start -= 1;
  while (start < separator && !/[a-z]/iu.test(text.charAt(start))) start += 1;
  return start < separator ? text.slice(start, separator) : null;
};

/** Redact the userinfo of every `scheme://authority` in `text`. */
const redact = (text: string): string => {
  let out = "";
  let copied = 0;
  // The previous `://` and the text before it are no scheme of the next one.
  let floor = 0;
  for (let separator = text.indexOf("://"); separator !== -1; ) {
    const authorityStart = separator + 3;
    const scheme = schemeBefore(text, separator, floor);
    if (scheme !== null) {
      const authority = authorityIn(text, authorityStart, authorityEnd(text, authorityStart));
      const at = authority.lastIndexOf("@");
      if (at !== -1) {
        const userinfo = authority.slice(0, at);
        const kept = keptUserinfo(scheme, userinfo);
        if (kept !== `${userinfo}@`) {
          out += `${text.slice(copied, authorityStart)}${kept}`;
          copied = authorityStart + at + 1;
        }
      }
    }
    floor = authorityStart;
    separator = text.indexOf("://", authorityStart);
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
 * userinfo of any other. For free text (git's stderr, a log line, a line the CLI prints) and for a
 * single URL alike.
 */
export const redactUrlCredentials = (text: string): string => redact(text);

/**
 * One repository URL with its credential removed, kept as typed otherwise: a stored origin, a git
 * remote, an argument. `redactUrlCredentials`, and should a URL parser still find a credential the
 * scan did not, the parser clears it.
 */
export const redactRepositoryUrl = (url: string): string => {
  const scanned = redact(url);
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
