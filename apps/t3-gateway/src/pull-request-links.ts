import type {
  OrchestrationV2Command,
  ThreadPullRequestKey,
  ThreadPullRequestLink,
} from "@mend/t3-contracts";

/** The PR metadata commands backed by the person's gateway state. */
export type PullRequestLinkCommand = Extract<
  OrchestrationV2Command,
  {
    readonly type:
      | "thread.pull-request.link"
      | "thread.pull-request.unlink"
      | "thread.pull-request-link.sync";
  }
>;

/** Hosts and repository names are case insensitive, as in T3's own link reducer. */
export const samePullRequest = (left: ThreadPullRequestKey, right: ThreadPullRequestKey): boolean =>
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.repository.toLowerCase() === right.repository.toLowerCase() &&
  left.number === right.number;

/** A link must point at the PR its key names, with no credentials in the URL. */
export const pullRequestLinkRefusal = (key: ThreadPullRequestKey, url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The pull request URL is invalid.";
  }
  return parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.host.toLowerCase() === key.host.toLowerCase() &&
    parsed.pathname.toLowerCase().replace(/\/$/u, "") ===
      `/${key.repository}/pull/${key.number}`.toLowerCase()
    ? null
    : "The pull request URL must match its host, repository and number.";
};

/** Apply a link, unlink or observation without changing the linked PR's original timestamp. */
export const changePullRequestLinks = (
  links: ReadonlyArray<ThreadPullRequestLink>,
  command: PullRequestLinkCommand,
  at: string,
): ReadonlyArray<ThreadPullRequestLink> => {
  const key = {
    host: command.host.toLowerCase(),
    repository: command.repository.toLowerCase(),
    number: command.number,
  };
  const existing = links.find((link) => samePullRequest(link, key));
  switch (command.type) {
    case "thread.pull-request.link":
      if (existing !== undefined && existing.source !== "stack-dismissed") return links;
      return [
        ...links.filter((link) => !samePullRequest(link, key)),
        {
          ...key,
          url: command.url,
          source: command.source,
          linkedAt: existing?.linkedAt ?? at,
          snapshot: existing?.snapshot ?? null,
          stack: existing?.stack ?? null,
          ...(command.repositoryWebUrl === undefined
            ? {}
            : { repositoryWebUrl: command.repositoryWebUrl }),
        },
      ];
    case "thread.pull-request.unlink":
      return links.flatMap((link) =>
        !samePullRequest(link, key)
          ? [link]
          : link.source === "stack" || link.stack !== null
            ? [{ ...link, source: "stack-dismissed" as const }]
            : [],
      );
    case "thread.pull-request-link.sync":
      return links.map((link) =>
        samePullRequest(link, key)
          ? { ...link, snapshot: command.snapshot, stack: command.stack }
          : link,
      );
  }
};
