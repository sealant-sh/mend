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
 *   canonical path (`canonicalRepositoryPath`), or to the origin of another repository the
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
  const originPath =
    origin === null ? null : canonicalRepositoryPath(originRepositoryPath(input.originUrl));
  if (originPath === null) {
    return refuse(
      "Mend cannot read one repository from this project's origin, so its Git signer pushes nowhere",
    );
  }
  const targetPath = canonicalRepositoryPath(input.repository);
  const pushable = new Set([originPath]);
  for (const other of input.repositoryOrigins) {
    const location = gitRemoteLocation(other);
    const path = location === null ? null : canonicalRepositoryPath(originRepositoryPath(other));
    if (location !== null && path !== null && isSameGitRemote(location, input.target)) {
      pushable.add(path);
    }
  }
  if (targetPath === null || !pushable.has(targetPath)) {
    return refuse(
      `Mend's Git signer pushes only to this project's own repository (${originPath}); ${JSON.stringify(input.repository)} is another`,
    );
  }
  return { ok: true };
};

/**
 * The repository path of a clone URL `gitRemoteLocation` accepts: the URL's path, or what follows
 * the host of an SCP-style `user@host:path` (split where `gitRemoteLocation` splits it).
 */
const originRepositoryPath = (originUrl: string): string =>
  originUrl.includes("://")
    ? new URL(originUrl).pathname
    : originUrl.slice(originUrl.lastIndexOf(":") + 1);

/**
 * One spelling per repository, or null for a path that reads more than one way. Percent-escapes
 * are decoded once (a `%` left after that is refused, never decoded again), leading and trailing
 * slashes and one `.git` suffix are dropped, and case is folded, the way the common Git hosts
 * route a repository. An empty, `.` or `..` segment, a backslash or a control character is
 * refused: the host might resolve it to another repository than the one it names.
 */
export const canonicalRepositoryPath = (raw: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  for (const character of decoded) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 0x7f || character === "\\" || character === "%") return null;
  }
  const segments = decoded.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase().split("/");
  const last = segments.length - 1;
  segments[last] = (segments[last] ?? "").replace(/\.git$/, "");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
};
