import type { RepositoryIdentity } from "@mend/t3-contracts";

/** Adopted origin identity, normalized as T3 v0.1.2 groups HTTPS and SSH remotes. */
export const repositoryIdentityOf = (
  origin: string | null | undefined,
  rootPath: string,
): RepositoryIdentity | null => {
  if (origin == null) return null;
  const remote = origin.trim().replace(/\/+$/, "");
  const trimmed = remote.replace(/\.git$/i, "");
  let host: string;
  let path: string;
  let remoteUrl: string;
  if (/^(?:ssh|https?|git):\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    host = url.hostname.toLowerCase();
    path = url.pathname
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "");
    if (url.protocol !== "ssh:") url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    remoteUrl = url.toString();
  } else {
    const match = /^(?:[^@\s/:]+@)?([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/.exec(trimmed);
    if (match?.[1] === undefined || match[2] === undefined || /^[a-z]:[\\/]/i.test(trimmed))
      return null;
    host = match[1].toLowerCase();
    path = match[2];
    remoteUrl = remote;
  }
  const segments = path.split("/").filter(Boolean);
  if (host === "" || segments.length < 2) return null;
  const canonical = segments.map((part) => part.toLowerCase());
  const [marker, org, project, repo] = canonical;
  let canonicalKey = `${host}/${canonical.join("/")}`;
  if (
    (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") &&
    canonical.length === 4 &&
    marker === "v3"
  )
    canonicalKey =
      host === "ssh.dev.azure.com"
        ? `dev.azure.com/${org}/${project}/_git/${repo}`
        : `${org}.visualstudio.com/${project}/_git/${repo}`;
  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    rootPath,
    displayName: segments.join("/"),
    ...(segments[0] === undefined ? {} : { owner: segments[0] }),
    ...(segments.at(-1) === undefined ? {} : { name: segments.at(-1) ?? "" }),
    ...(host === "github.com" ? { provider: "github" } : {}),
  };
};
