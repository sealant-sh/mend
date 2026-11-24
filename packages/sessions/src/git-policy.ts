import { type GitTransportKind, gitRemoteLocation, isSameGitRemote } from "@mend/domain/workbench";

import type { GitTransportCeiling } from "./access-policy.ts";

const refuse = (message: string) => ({ ok: false, message }) as const;

/**
 * Whether Mend's Git signer opens one workspace transport (docs/GIT-ACCESS.md; agent-home
 * `workspace-isolation-architecture.md` §7.4). The signer signs with a person's key, so what it
 * reaches is decided here, before any key is touched:
 *
 * - the worktree's `gitTransport` ceiling first: `disabled` signs nothing, `read-only` no push;
 * - a fetch or an archive is bound to the origin's host and port only, so submodules, private
 *   dependencies on the same host and other repositories of the session (ADR 0011) still fetch;
 * - a push is bound to the origin's repository itself: the same host and port, and the same
 *   canonical path (`repositoryKey`), or to the origin of another repository the
 *   session holds (ADR 0011) on that host. A project whose origin is missing, or whose path
 *   cannot be read one way only, pushes nowhere through the signer.
 *
 * `bindToOrigin` false is the operator's opt-out for a machine they alone use, for mirrors and
 * forks (`MEND_GIT_TRANSPORT_BIND_ORIGIN`): no origin binding of either kind, the ceiling still.
 */
export const decideGitTransport = (input: {
  readonly ceiling: GitTransportCeiling;
  readonly kind: GitTransportKind;
  /** The repository argument of the remote command, as `parseGitRemoteCommand` read it. */
  readonly repository: string;
  readonly target: { readonly host: string; readonly port: number | null };
  readonly originUrl: string | null;
  /** The origins of the other repositories the session holds (ADR 0011), which it may push. */
  readonly repositoryOrigins: ReadonlyArray<string>;
  readonly bindToOrigin: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
  if (input.ceiling === "disabled") {
    return refuse(
      "this worktree's Access policy turns Mend's Git signer off (gitTransport: disabled); it signs no fetch or push",
    );
  }
  if (input.ceiling === "read-only" && input.kind === "push") {
    return refuse(
      "this worktree's Access policy lets Mend's Git signer fetch only (gitTransport: read-only); it signs no push",
    );
  }
  if (!input.bindToOrigin) return { ok: true };
  const origin = input.originUrl === null ? null : gitRemoteLocation(input.originUrl);
  if (origin !== null && !isSameGitRemote(origin, input.target)) {
    return refuse(
      `this session's Git access is bound to ${origin.host}; pushes and fetches to ${input.target.host} run without Mend's signer`,
    );
  }
  if (input.kind !== "push") return { ok: true };
  if (input.originUrl === null) {
    return refuse("this project has no origin, so Mend's Git signer pushes nowhere");
  }
  const host = input.target.host.slice(input.target.host.lastIndexOf("@") + 1).toLowerCase();
  const originRaw = origin === null ? null : originRepositoryPath(input.originUrl);
  const originKey = originRaw === null ? null : repositoryKey(originRaw, host);
  if (originKey === null) {
    return refuse(
      "Mend cannot read one repository from this project's origin, so its Git signer pushes nowhere",
    );
  }
  const pushable = new Set([originKey]);
  for (const other of input.repositoryOrigins) {
    const location = gitRemoteLocation(other);
    if (location === null || !isSameGitRemote(location, input.target)) continue;
    const raw = originRepositoryPath(other);
    const key = raw === null ? null : repositoryKey(raw, host);
    if (key !== null) pushable.add(key);
  }
  // Git hands the ssh command the path literally: it is never percent-decoded here.
  const targetKey = repositoryKey(input.repository, host);
  if (targetKey === null || !pushable.has(targetKey)) {
    return refuse(
      `Mend's Git signer pushes only to this project's own repository (${originRaw}); ${JSON.stringify(input.repository)} is another`,
    );
  }
  return { ok: true };
};

/**
 * Hosts that route a repository whatever its ASCII case and whether its path leads with `/`, so
 * `git@github.com:Acme/API.git` and `/acme/api` are one repository there. Any other host is a
 * plain SSH or HTTP server, where both can name another repository.
 */
const CASE_INSENSITIVE_FORGES = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/**
 * The repository path an origin names, as Git would hand it to the ssh command, or null when it
 * reads more than one way. An SCP-style `user@host:path` is taken literally. A URL's path is cut
 * from the text as written, never through a URL parser, which would collapse a `..` before
 * `repositoryKey` could refuse it; its percent-escapes are decoded once, as Git decodes a URL,
 * and a `%` left after that is refused.
 */
const originRepositoryPath = (originUrl: string): string | null => {
  if (!originUrl.includes("://")) return originUrl.slice(originUrl.lastIndexOf(":") + 1);
  const afterScheme = originUrl.slice(originUrl.indexOf("://") + 3);
  const slash = afterScheme.indexOf("/");
  if (slash === -1) return null;
  const written = afterScheme.slice(slash).replace(/[?#][\s\S]*$/, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(written);
  } catch {
    return null;
  }
  return decoded.includes("%") ? null : decoded;
};

/** No empty, `.` or `..` segment between the first and last, no backslash, no control character. */
const segmentsReadOneWay = (path: string): boolean => {
  for (const character of path) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 0x7f || character === "\\") return false;
  }
  const inner = path.replace(/^\//, "").replace(/\/+$/, "");
  return inner.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

/**
 * The key a repository path compares by on `host`, or null for a path that reads more than one
 * way. Trailing slashes and one `.git` suffix are dropped everywhere, as Git's own server looks
 * for `<path>` and `<path>.git` alike. On a case-insensitive forge (`CASE_INSENSITIVE_FORGES`) a
 * leading `/` is dropped and ASCII letters are folded; on any other host both are kept, since
 * `/srv/git/api.git` and `srv/git/api.git`, or `API.git` and `api.git`, can be two repositories.
 * Only ASCII is folded: a Unicode fold maps signs such as `K` (Kelvin) onto letters.
 */
export const repositoryKey = (path: string, host: string): string | null => {
  if (!segmentsReadOneWay(path)) return null;
  const forge = CASE_INSENSITIVE_FORGES.has(host.toLowerCase());
  const leading = path.startsWith("/");
  const inner = path
    .replace(/^\//, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (inner === "" || inner.endsWith("/")) return null;
  if (forge) return inner.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return leading ? `/${inner}` : inner;
};
