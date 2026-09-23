import { Option, Schema } from "effect";

import type { GitHubRepository } from "./github.ts";

/**
 * The `gh` calls of the pull request step, as argv for a workspace `exec`, and the parsers for
 * what `gh` answers (docs/adr/0007-landing.md, "Where each step runs"). The repository and both
 * branches are always explicit, so nothing depends on the directory `gh` runs in, and every value
 * a person chose rides as `--flag=value` so it can never read as an option. The body travels in a
 * file Mend writes first: `exec` takes no stdin.
 */

/** `gh` never prompts, never checks for updates and never colours what Mend parses. */
const gh = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "env",
  "GH_PROMPT_DISABLED=1",
  "GH_NO_UPDATE_NOTIFIER=1",
  "NO_COLOR=1",
  "gh",
  ...args,
];

/** The fields Mend reads back from every pull request `gh` shows. */
export const PULL_REQUEST_FIELDS = "number,url,state,title,body";

/** One pull request, by number or URL. */
export const viewArgv = (repository: GitHubRepository, pullRequest: number | string) =>
  gh([
    "pr",
    "view",
    String(pullRequest),
    `--repo=${repository.slug}`,
    `--json=${PULL_REQUEST_FIELDS}`,
  ]);

/** The open pull request from a branch, when there is one: the agent may have opened it. */
export const openForBranchArgv = (repository: GitHubRepository, branch: string) =>
  gh([
    "pr",
    "list",
    `--repo=${repository.slug}`,
    `--head=${branch}`,
    "--state=open",
    `--json=${PULL_REQUEST_FIELDS}`,
    "--limit=1",
  ]);

export const createArgv = (input: {
  readonly repository: GitHubRepository;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly bodyFile: string;
}) =>
  gh([
    "pr",
    "create",
    `--repo=${input.repository.slug}`,
    `--head=${input.head}`,
    `--base=${input.base}`,
    `--title=${input.title}`,
    `--body-file=${input.bodyFile}`,
  ]);

/** An update: the body always, the title only when the owner gave one for this landing. */
export const editArgv = (input: {
  readonly repository: GitHubRepository;
  readonly number: number;
  readonly title: string | null;
  readonly bodyFile: string;
}) =>
  gh([
    "pr",
    "edit",
    String(input.number),
    `--repo=${input.repository.slug}`,
    `--body-file=${input.bodyFile}`,
    ...(input.title === null ? [] : [`--title=${input.title}`]),
  ]);

/** Argument chunks stay well under Linux's 128 KiB limit for one argument. */
const CHUNK = 60_000;

/**
 * Write `content` to `file` inside the workspace, readable by its owner only. The content rides
 * base64-encoded in argument chunks, since `exec` has no stdin.
 */
export const writeFileArgv = (file: string, content: string): ReadonlyArray<string> => {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  const chunks: Array<string> = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK) {
    chunks.push(encoded.slice(offset, offset + CHUNK));
  }
  const script =
    'umask 077; file="$1"; shift; for chunk; do printf %s "$chunk"; done | base64 -d > "$file"';
  return ["sh", "-c", script, "sh", file, ...chunks];
};

export const removeFileArgv = (file: string): ReadonlyArray<string> => ["rm", "-f", "--", file];

// ─── What gh answers ────────────────────────────────────────────────────────

const GhPullRequest = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  title: Schema.String,
  body: Schema.String,
});

/** A pull request as `gh` showed it, in Mend's words for its state. */
export interface PullRequestView {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly title: string;
  readonly body: string;
}

const toView = (wire: typeof GhPullRequest.Type): PullRequestView => ({
  number: wire.number,
  url: wire.url,
  state: wire.state === "OPEN" ? "open" : wire.state === "CLOSED" ? "closed" : "merged",
  title: wire.title,
  body: wire.body,
});

const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(GhPullRequest));
const decodeList = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(GhPullRequest)));

/** `gh pr view --json`; null when the output is not the JSON asked for. */
export const parsePullRequest = (stdout: string): PullRequestView | null =>
  Option.match(decodeView(stdout.trim()), { onNone: () => null, onSome: toView });

/** `gh pr list --json`: the first pull request, null when there is none or the output is not JSON. */
export const parseFirstPullRequest = (stdout: string): PullRequestView | null =>
  Option.match(decodeList(stdout.trim()), {
    onNone: () => null,
    onSome: (list) => {
      const first = list[0];
      return first === undefined ? null : toView(first);
    },
  });

/**
 * What `gh pr create` printed as the new pull request's URL: its last line that is one. `gh`
 * prints warnings before it on stderr, and some versions echo progress to stdout.
 */
export const createdUrl = (stdout: string): string | null =>
  stdout
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => /^https:\/\/\S+\/pull\/\d+$/.test(line)) ?? null;

const nonEmptyLines = (text: string): ReadonlyArray<string> =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A failed `gh` call in its own words: its stderr, else its stdout, else the exit code. */
export const ghWords = (result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): string => {
  const stderr = nonEmptyLines(result.stderr);
  if (stderr.length > 0) return stderr.slice(-4).join(" · ");
  const stdout = nonEmptyLines(result.stdout);
  if (stdout.length > 0) return stdout.slice(-4).join(" · ");
  return `gh exited ${result.exitCode}`;
};
