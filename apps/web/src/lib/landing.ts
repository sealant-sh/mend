import {
  describePullRequest,
  forkPullRequestReason,
  landingFactLine,
  observedAgo,
  openForkPullRequest,
  ownerDescription,
  pullRequestBase,
  pullRequestTitle,
  pullRequestToUpdate as pullRequestOnOriginToUpdate,
  resolveAutoLand,
  type AutomationChoice,
  type DescribedFile,
} from "@mend/domain/workbench";

import type {
  ChangeLandingDto,
  ChangeLandingsDto,
  LandingFactDto,
  LandingReportDto,
  PullRequestCheckDto,
  ReviewDiffFileDto,
} from "#/lib/api";

/**
 * The Land panel's model (docs/adr/0007-landing.md, "Surfaces"): what the next landing pushes and
 * where, what its pull request will say, and how each observed fact reads. Pure, so the panel and
 * the session page read the same words.
 */

/**
 * The branch the next landing pushes, as the server chose it (`nextBranch`: the last landing's,
 * the agent's own push, an adopted pull request's head on origin, else the worktree's). An older
 * server does not say: the branch the change landed on before, else the worktree's.
 */
export const nextRemoteBranch = (
  view: Pick<ChangeLandingsDto, "landings" | "nextBranch">,
  worktreeBranch: string,
): string =>
  view.nextBranch ??
  view.landings.find((landing) => landing.pushedSha !== null)?.remoteBranch ??
  worktreeBranch;

/**
 * The pull request the next landing updates: the newest recorded, adopted or Mend's own, while it
 * is open and its head is on origin. A closed or merged one leads to a new pull request; a fork's
 * is never updated.
 */
export const pullRequestToUpdate = (
  landings: ReadonlyArray<ChangeLandingDto>,
): NonNullable<ChangeLandingDto["pullRequest"]> | null => pullRequestOnOriginToUpdate(landings);

/**
 * Why the next landing opens no pull request although origin is on GitHub: the change is under
 * review in a pull request from a fork, and Mend pushes to origin only. Null otherwise.
 */
export const forkNote = (landings: ReadonlyArray<ChangeLandingDto>): string | null => {
  const fork = openForkPullRequest(landings);
  return fork === null ? null : forkPullRequestReason(fork);
};

/** The one button's words: what it will do, never what the change is. */
export const landButtonLabel = (view: {
  readonly pullRequestAvailable: boolean;
  readonly updates: boolean;
  /** An open pull request from a fork: the landing pushes to origin and opens none. */
  readonly fork?: boolean;
}): string =>
  !view.pullRequestAvailable || view.fork === true
    ? "Push to origin"
    : view.updates
      ? "Push and update pull request"
      : "Push and open pull request";

/** What "Check GitHub" found, as its status line. */
export const checkLine = (check: PullRequestCheckDto): string => {
  switch (check.outcome) {
    case "adopted":
      return check.landing?.pullRequest == null
        ? "pull request recorded · opened outside Mend"
        : `pull request #${check.landing.pullRequest.number} recorded · opened outside Mend`;
    case "observed":
      return check.landing?.pullRequest == null
        ? "pull request already recorded · state read again"
        : `pull request #${check.landing.pullRequest.number} already recorded · ${check.landing.pullRequest.state} · observed`;
    case "none":
      return "no pull request on GitHub for the change's branches or the agent's commit";
    case "skipped":
      return `GitHub not checked · ${check.reason ?? "no reason given"}`;
  }
};

/** A review file as the description lists it: the same facts git gave the landing. */
export const describedFileOfReview = (file: ReviewDiffFileDto): DescribedFile => ({
  path: file.newPath ?? file.oldPath ?? "",
  oldPath: file.status === "renamed" || file.status === "copied" ? file.oldPath : null,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  binary: file.binary,
});

export interface DescriptionPreviewInput {
  /** The owner's own text; empty keeps what people wrote on GitHub. */
  readonly ownerText: string;
  readonly tour: { readonly summary: string; readonly approach: string | null } | null;
  readonly files: ReadonlyArray<DescribedFile>;
  /** Where this page is served from; the landing links back to the same install. */
  readonly webOrigin: string;
  readonly sessionId: string;
  readonly changeId: string;
}

/**
 * The description the landing will send, as far as this page can know it: the owner's text, then
 * Mend's section. The landed checkpoint does not exist yet, so the section says it is taken when
 * the change lands.
 */
export const descriptionPreview = (input: DescriptionPreviewInput): string => {
  const origin = input.webOrigin.replace(/\/+$/, "");
  const section = describePullRequest({
    tour: input.tour,
    files: input.files,
    checks: [],
    checkpoint: null,
    links: {
      session: `${origin}/sessions/${encodeURIComponent(input.sessionId)}`,
      review: `${origin}/changes/${encodeURIComponent(input.changeId)}`,
      checkpoint: null,
    },
  });
  return input.ownerText.trim() === "" ? section : ownerDescription(input.ownerText, section);
};

/** The title a new pull request opens with when the owner leaves the field empty. */
export const defaultPullRequestTitle = (session: {
  readonly label: string | null;
  readonly id: string;
}): string => pullRequestTitle({ explicit: null, label: session.label, sessionId: session.id });

/** The branch the pull request merges into: the session's base as a branch, else the default. */
export const landingBase = (baseRef: string | null, defaultBranch: string): string =>
  pullRequestBase(baseRef, defaultBranch);

/**
 * What the land request carries: an empty field sends null, so Mend keeps what GitHub has. The
 * pull request step is always asked for; where origin is not on GitHub the landing records why
 * it did not run.
 */
export const landRequestOf = (draft: { readonly title: string; readonly body: string }) => ({
  branch: null,
  pullRequest: true,
  title: draft.title.trim() === "" ? null : draft.title.trim(),
  body: draft.body.trim() === "" ? null : draft.body,
});

/** How a fact's dot reads: observed success, observed failure, or a plain observation. */
export type FactTone = "observed" | "failure" | "neutral";

export const factTone = (fact: LandingFactDto): FactTone => {
  switch (fact._tag) {
    case "pushed":
    case "pull-request":
      return "observed";
    case "refused":
    case "failed":
    case "pull-request-failed":
      return "failure";
    default:
      return "neutral";
  }
};

/**
 * The one fact the session page shows: what the last attempt or turn said when it did not
 * land, else the pull request, else the push. Null when nothing was ever landed or held back.
 */
const HEADLINE_ORDER: ReadonlyArray<LandingFactDto["_tag"]> = [
  "not-landed",
  "refused",
  "failed",
  "pull-request-failed",
  "pull-request",
  "pushed",
];

export const headlineFact = (facts: ReadonlyArray<LandingFactDto>): LandingFactDto | null => {
  for (const tag of HEADLINE_ORDER) {
    const fact = facts.find((candidate) => candidate._tag === tag);
    if (fact !== undefined) return fact;
  }
  return null;
};

export const factLine = (fact: LandingFactDto, now: Date): string => landingFactLine(fact, now);

/**
 * The facts to show: the live record's, plus what the owner's last "Check origin" fetch saw of
 * origin's branch. A plain read never fetches, so `origin-moved` comes only from that fetch.
 */
export const factsWithProbe = (
  facts: ReadonlyArray<LandingFactDto>,
  probed: ChangeLandingsDto | null,
): ReadonlyArray<LandingFactDto> => {
  const moved = probed?.facts.filter((fact) => fact._tag === "origin-moved") ?? [];
  return [...facts.filter((fact) => fact._tag !== "origin-moved"), ...moved];
};

/** Whether the change's own "not landed" state asks for the button: a turn held it back. */
export const heldBack = (facts: ReadonlyArray<LandingFactDto>): boolean =>
  facts.some((fact) => fact._tag === "not-landed");

/**
 * "Land when a turn completes" as a session started here would get it: the composer's own
 * choice, else the project's, else Settings. Slack sessions follow their own rules and never
 * start from the composer.
 */
export const composerAutoLand = (input: {
  readonly override: boolean | null;
  readonly project: AutomationChoice;
  readonly settings: boolean;
}): boolean =>
  resolveAutoLand({
    origin: "mend",
    project: input.project,
    settings: input.settings,
    session: input.override,
    slack: false,
  });

/** The project row's value in the setup index: `inherit · off`, `on`, `off`. */
export const autoLandFact = (project: AutomationChoice, settings: boolean | undefined): string =>
  project === "inherit"
    ? `inherit · ${settings === undefined ? "…" : settings ? "on" : "off"}`
    : project;

/**
 * What one landing just did, as the status line states it:
 * `pushed · mend/fix-login · pull request #412 · opened`.
 */
export const landingReportLine = (report: LandingReportDto): string => {
  const { landing, pullRequest } = report;
  if (landing.outcome === "refused") {
    return `push refused · ${landing.remoteBranch} · ${landing.message ?? "no reason given"}`;
  }
  if (landing.pushedSha === null) {
    return `landing failed · ${landing.message ?? "no reason given"}`;
  }
  const pushed = `pushed · ${landing.remoteBranch} · ${landing.pushedSha.slice(0, 7)}`;
  switch (pullRequest._tag) {
    case "opened":
    case "updated":
      return `${pushed} · pull request #${pullRequest.pullRequest.number} · ${pullRequest._tag}`;
    case "unavailable":
      return `${pushed} · ${pullRequest.reason}`;
    case "failed":
      return `${pushed} · pull request step failed · ${pullRequest.message}`;
    case "off":
    case "not-reached":
      return pushed;
  }
};

/** When origin was last checked, or why it could not be. */
export const remoteLine = (view: ChangeLandingsDto, now: Date): string | null => {
  if (view.remoteFailure !== null) return `origin could not be checked · ${view.remoteFailure}`;
  const remote = view.remote;
  if (remote === null) return null;
  const tip =
    remote.remoteSha === null
      ? `origin has no ${remote.remoteBranch}`
      : `origin ${remote.remoteBranch} at ${remote.remoteSha.slice(0, 7)}`;
  const holds = remote.holds ? "holds the landed commit" : "does not hold the landed commit";
  return `${tip} · ${holds} · checked ${observedAgo(remote.observedAt, now)}`;
};

export interface AutoLandItem {
  readonly key: "follow" | "on" | "off";
  readonly label: string;
  /** Quiet mono detail beside the label: what following the project means now. */
  readonly detail: string | null;
  readonly selected: boolean;
  /** The session's own override this item sets; null follows the project. */
  readonly override: boolean | null;
}

/**
 * The composer's "Land when a turn completes" choices for one session. A project set to off wins
 * over any override, so it offers only that. `settings` is null while Settings load.
 */
export const autoLandItems = (input: {
  readonly override: boolean | null;
  readonly project: AutomationChoice;
  readonly settings: boolean | null;
}): { readonly items: ReadonlyArray<AutoLandItem>; readonly summary: string | null } => {
  if (input.project === "off") {
    return {
      items: [
        {
          key: "follow",
          label: "Off for this project",
          detail: null,
          selected: true,
          override: null,
        },
      ],
      summary: null,
    };
  }
  const followed =
    input.settings === null && input.project === "inherit"
      ? "…"
      : composerAutoLand({
            override: null,
            project: input.project,
            settings: input.settings ?? false,
          })
        ? "on"
        : "off";
  return {
    items: [
      {
        key: "follow",
        label: "As the project",
        detail: followed,
        selected: input.override === null,
        override: null,
      },
      { key: "on", label: "Land", detail: null, selected: input.override === true, override: true },
      {
        key: "off",
        label: "Do not land",
        detail: null,
        selected: input.override === false,
        override: false,
      },
    ],
    summary: input.override === null ? null : input.override ? "land" : "no land",
  };
};
