import * as path from "node:path";

/** Hosts that resolve an owner and repository name whatever its case. */
const CASE_BLIND_PATHS: ReadonlySet<string> = new Set(["github.com"]);

const DEFAULT_PORTS: ReadonlyMap<string, string> = new Map([
  ["ssh", "22"],
  ["git+ssh", "22"],
  ["ssh+git", "22"],
  ["https", "443"],
  ["http", "80"],
  ["git", "9418"],
]);

/**
 * A git remote URL as the repository it names, for telling whether two are one: the host in any
 * case, the port unless it is the scheme's default, and the path, whose case counts except on a
 * host in CASE_BLIND_PATHS. https, ssh and scp-style spellings of one repository are equal. Null
 * for anything that is not a URL-ish remote.
 */
const remoteIdentity = (raw: string): string | null => {
  const trimmed = raw.trim();
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]+@)?([^/\s:]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  const [scheme, rawHost, rawPort, rest] =
    url === null ? ["ssh", scp?.[1], undefined, scp?.[2]] : [url[1], url[2], url[3], url[4]];
  if (scheme === undefined || rawHost === undefined || rest === undefined) return null;
  const host = rawHost.toLowerCase();
  const port =
    rawPort === undefined || rawPort === DEFAULT_PORTS.get(scheme.toLowerCase()) ? "" : rawPort;
  const repoPath = (CASE_BLIND_PATHS.has(host) ? rest.toLowerCase() : rest)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return `${host}:${port}/${repoPath}`;
};

/** Whether two git remote URLs name one repository; see remoteIdentity. */
export const sameRepository = (a: string, b: string): boolean => {
  const identity = remoteIdentity(a);
  return identity !== null && identity === remoteIdentity(b);
};

export const originMatches = (
  remoteUrl: string,
  originUrl: string | null,
  cwd: string,
): boolean => {
  if (originUrl === null) return false;
  if (remoteIdentity(originUrl) !== null) return sameRepository(remoteUrl, originUrl);
  return (
    path.resolve(cwd, remoteUrl.replace(/^file:\/\//, "")) ===
    path.resolve(originUrl.replace(/^file:\/\//, ""))
  );
};
