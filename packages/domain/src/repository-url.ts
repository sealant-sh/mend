/**
 * Credentials in repository URLs. Mend stores a repository URL and returns it to everyone who can
 * see what it belongs to, so a token or password in one is readable by them all. Mend refuses such
 * a URL where it enters, and redacts any that reaches a response or a log.
 *
 * Over ssh the user is a login name (`ssh://git@host/path`, `git@host:path`) and stays. Over every
 * other scheme the user is where tokens go (`https://oauth2:TOKEN@host`, `https://TOKEN@host`), so
 * the whole userinfo goes.
 */

/**
 * `scheme://userinfo@`. Greedy up to the last `@` before the authority ends, the way URL parsers
 * split it, so a raw `@` inside a password cannot leave part of it behind.
 */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#'"<>]*)@/gi;

const isSshScheme = (scheme: string): boolean => /^(?:git\+)?ssh(?:\+git)?$/i.test(scheme);

/**
 * `text` with the credential part of every URL in it removed: the password of an ssh URL, the whole
 * userinfo of any other. Works on one URL and on free text (git's stderr, a log line) alike.
 */
export const redactUrlCredentials = (text: string): string =>
  text.replace(URL_USERINFO, (_match, scheme: string, userinfo: string) => {
    if (!isSshScheme(scheme)) return `${scheme}://`;
    const user = userinfo.split(":")[0] ?? "";
    return user === "" ? `${scheme}://` : `${scheme}://${user}@`;
  });

/** `redactUrlCredentials` over a nullable column. */
export const redactNullableUrlCredentials = (url: string | null): string | null =>
  url === null ? null : redactUrlCredentials(url);

/** Whether a repository URL carries a login or token Mend must not store. */
export const repositoryUrlHasCredential = (url: string): boolean =>
  redactUrlCredentials(url) !== url;

/** Why a repository URL with a credential is refused, and the supported ways instead. */
export const REPOSITORY_URL_CREDENTIAL_GUIDANCE =
  'This URL carries a login or token before the "@". Mend shows a repository URL to everyone who can see the repository, so it never stores one. Use the SSH URL (git@host:owner/repo.git) with your Mend key (`mend keys` shows it), or your own key through the agent bridge (`--auth bridge`).';
