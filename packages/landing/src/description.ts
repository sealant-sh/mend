import type { DiffFileFact, DiffFileStatus } from "@mend/store";

/**
 * The pull request's description and title, and Mend's commit message (docs/adr/0007-landing.md,
 * "The pull request's description"). Pure: the landing service gathers the facts, these render
 * them.
 *
 * The description is evidence, not a verdict. It says what changed and what the record shows, and
 * never that the change is ready, tested or safe. Checks appear only as the record shows them.
 */

/** Where Mend's section starts and ends. Text outside the markers is the person's and is kept. */
export const DESCRIPTION_START = "<!-- mend:landing:start -->";
export const DESCRIPTION_END = "<!-- mend:landing:end -->";

/** More files than this are counted, not listed, so the description stays within GitHub's limit. */
export const DESCRIPTION_FILE_LIMIT = 200;

/** GitHub refuses a pull request body longer than this. */
export const GITHUB_BODY_LIMIT = 65_536;

export interface DescribedFile {
  readonly path: string;
  /** The path before a rename; null otherwise. */
  readonly oldPath: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** A file of the landed range, as git's diff facts name it. */
export const describedFileOf = (fact: DiffFileFact): DescribedFile => ({
  path: fact.newPath ?? fact.oldPath ?? "",
  oldPath: fact.status === "renamed" || fact.status === "copied" ? fact.oldPath : null,
  status: fact.status,
  additions: fact.additions,
  deletions: fact.deletions,
  binary: fact.binary,
});

/** A check as the record shows it: the command and its exit code, observed. */
export interface DescribedCheck {
  readonly command: string;
  readonly exitCode: number;
}

export interface DescriptionInput {
  /** The review tour's summary and approach; null when no tour exists. */
  readonly tour: { readonly summary: string; readonly approach: string | null } | null;
  /** The changed files with their line counts; null when they could not be read. */
  readonly files: ReadonlyArray<DescribedFile> | null;
  readonly checks: ReadonlyArray<DescribedCheck>;
  readonly checkpoint: { readonly ordinal: number; readonly sha: string };
  /** Links back to Mend; null where the install has no web origin to build one from. */
  readonly links: {
    readonly session: string | null;
    readonly review: string | null;
    readonly checkpoint: string | null;
  };
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** A path in Markdown code; a backtick in the name widens the fence so it cannot break out. */
const code = (text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

/** One changed file: `path` · added · +12 −0. */
const fileLine = (file: DescribedFile): string => {
  const name =
    file.oldPath !== null && file.oldPath !== file.path
      ? `${code(file.oldPath)} → ${code(file.path)}`
      : code(file.path);
  const counts = file.binary ? "binary" : `+${file.additions} −${file.deletions}`;
  const status = file.status === "modified" ? "" : ` · ${file.status}`;
  return `- ${name}${status} · ${counts}`;
};

const filesSection = (
  files: ReadonlyArray<DescribedFile> | null,
  limit: number,
): ReadonlyArray<string> => {
  if (files === null) return ["## Changed files", "", "Not read · Mend could not list the files."];
  if (files.length === 0) return ["## Changed files", "", "No files differ from the base."];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const listed = files.slice(0, limit).map(fileLine);
  const rest = files.length - listed.length;
  return [
    "## Changed files",
    "",
    `${plural(files.length, "file", "files")} · +${additions} −${deletions}`,
    "",
    ...listed,
    ...(rest > 0 ? [`- and ${plural(rest, "more file", "more files")}`] : []),
  ];
};

const link = (label: string, url: string | null, fallback: string): string =>
  url === null ? `- ${label}: ${fallback}` : `- ${label}: [${fallback}](${url})`;

const renderSection = (input: DescriptionInput, fileLimit: number): string => {
  const shortSha = input.checkpoint.sha.slice(0, 7);
  const summary =
    input.tour === null
      ? ["No summary · Mend has not composed a review tour for this change."]
      : [
          "## Summary",
          "",
          input.tour.summary.trim(),
          ...(input.tour.approach === null || input.tour.approach.trim() === ""
            ? []
            : ["", "## Approach", "", input.tour.approach.trim()]),
        ];
  const checks =
    input.checks.length === 0
      ? []
      : [
          "",
          "## Checks in the record",
          "",
          ...input.checks.map(
            (check) => `- ${code(check.command)} · exit ${check.exitCode} · observed`,
          ),
        ];
  return [
    DESCRIPTION_START,
    ...summary,
    "",
    ...filesSection(input.files, fileLimit),
    ...checks,
    "",
    "## In Mend",
    "",
    link("Session", input.links.session, "session"),
    link("Review", input.links.review, "review"),
    link(
      "Landed checkpoint",
      input.links.checkpoint,
      `checkpoint ${input.checkpoint.ordinal} · ${shortSha}`,
    ),
    "",
    "<sub>Mend writes this section from the session record and replaces it on each landing. Text outside it is kept.</sub>",
    DESCRIPTION_END,
  ].join("\n");
};

/**
 * Mend's section of the description, between its markers: the tour's summary and approach, the
 * changed files with their line counts, the checks the record shows, and links back to Mend.
 */
export const describePullRequest = (input: DescriptionInput): string => {
  const full = renderSection(input, DESCRIPTION_FILE_LIMIT);
  // A long list of long paths can outgrow GitHub's limit: the counts stay, the list goes.
  return full.length <= GITHUB_BODY_LIMIT / 2 ? full : renderSection(input, 0);
};

/**
 * The body to send: Mend's section in place of the one it wrote before, so anything a person
 * wrote above or below it survives. A body with no markers (a person rewrote it, or the agent
 * opened the pull request) keeps its text, with Mend's section after it.
 */
export const mergeDescription = (existing: string | null, section: string): string => {
  const body = existing ?? "";
  if (body.trim() === "") return section;
  const start = body.indexOf(DESCRIPTION_START);
  const end = start === -1 ? -1 : body.indexOf(DESCRIPTION_END, start);
  if (start === -1 || end === -1) return `${body.trimEnd()}\n\n${section}`;
  return `${body.slice(0, start)}${section}${body.slice(end + DESCRIPTION_END.length)}`;
};

/**
 * The title Mend opens a pull request with: the owner's own when they gave one, else the
 * session's label. On an update Mend sends only a title the owner gave for that landing, so a
 * title edited on GitHub is kept.
 */
export const pullRequestTitle = (input: {
  readonly explicit: string | null;
  readonly label: string | null;
  readonly sessionId: string;
}): string => {
  const explicit = input.explicit?.trim() ?? "";
  if (explicit !== "") return explicit;
  const label = input.label?.trim() ?? "";
  if (label !== "") return label;
  return `Mend session ${input.sessionId.slice(0, 8)}`;
};

const SUBJECT_LIMIT = 72;

/** The first line cut at a word boundary to fit a commit subject. */
const subjectOf = (line: string): { readonly subject: string; readonly cut: boolean } => {
  if (line.length <= SUBJECT_LIMIT) return { subject: line, cut: false };
  const room = line.slice(0, SUBJECT_LIMIT - 1);
  const space = room.lastIndexOf(" ");
  return { subject: `${(space > 20 ? room.slice(0, space) : room).trimEnd()}…`, cut: true };
};

/**
 * The message of the commit Mend writes for work the agent left uncommitted: the tour's summary
 * when a tour exists, the session's label otherwise, and a `Mend-Session:` trailer that links to
 * the session (its id when the install has no web origin).
 */
export const landingCommitMessage = (input: {
  readonly tourSummary: string | null;
  readonly label: string | null;
  readonly sessionId: string;
  readonly sessionUrl: string | null;
}): string => {
  const trailer = `Mend-Session: ${input.sessionUrl ?? input.sessionId}`;
  const summary = input.tourSummary?.trim() ?? "";
  if (summary === "") {
    const title = pullRequestTitle({
      explicit: null,
      label: input.label,
      sessionId: input.sessionId,
    });
    const { subject, cut } = subjectOf(title.split("\n")[0] ?? title);
    return `${subject}\n\n${cut ? `${title}\n\n` : ""}${trailer}\n`;
  }
  const [first = "", ...rest] = summary.split("\n");
  const { subject, cut } = subjectOf(first.trim());
  const body = (cut ? summary : rest.join("\n")).trim();
  return `${subject}\n\n${body === "" ? "" : `${body}\n\n`}${trailer}\n`;
};
