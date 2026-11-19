import {
  describePullRequest,
  type DescribedFile,
  forkPullRequestReason,
  landingFactLine,
  observedAgo,
  openForkPullRequest,
  ownerDescription,
  type PullRequestMediaItem,
  pullRequestBase,
  pullRequestMediaLine,
  pullRequestTitle,
  pullRequestToUpdate as pullRequestOnOriginToUpdate,
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
 * Landing's rules (docs/adr/0007-landing.md): what the next landing pushes and where, what its
 * pull request will say, how each observed fact reads, and what the Change view's toolbar, the
 * Land dialog and the conversation say about it. Pure, so every place reads the same words.
 */

type RecordedPullRequest = NonNullable<ChangeLandingDto["pullRequest"]>;

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
): RecordedPullRequest | null => pullRequestOnOriginToUpdate(landings);

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
  readonly media?: ReadonlyArray<PullRequestMediaItem>;
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
 * Mend's section between its markers. The landed checkpoint does not exist yet, so the section
 * says it is taken when the change lands.
 */
export const descriptionPreview = (input: DescriptionPreviewInput): string => {
  const origin = input.webOrigin.replace(/\/+$/, "");
  const section = describePullRequest({
    tour: input.tour,
    media: input.media ?? [],
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

/** The title a new pull request opens with when the owner leaves it as Mend wrote it. */
export const defaultPullRequestTitle = (session: {
  readonly label: string | null;
  readonly id: string;
}): string => pullRequestTitle({ explicit: null, label: session.label, sessionId: session.id });

/** The branch the pull request merges into: the session's base as a branch, else the default. */
export const landingBase = (baseRef: string | null, defaultBranch: string): string =>
  pullRequestBase(baseRef, defaultBranch);

/**
 * What the land request carries. The title field starts as the title Mend would use (the session's
 * label for a new pull request, the recorded title for one it updates): left as it started, it is
 * sent as null, so Mend opens with the label and keeps a title someone edited on GitHub. An empty
 * description is null too, so Mend replaces only its own section.
 */
export const landRequestOf = (draft: {
  readonly title: string;
  readonly body: string;
  /** What the title field started as. */
  readonly startTitle: string;
}) => {
  const title = draft.title.trim();
  return {
    branch: null,
    pullRequest: true,
    title: title === "" || title === draft.startTitle.trim() ? null : title,
    body: draft.body.trim() === "" ? null : draft.body,
  };
};

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

/** Whether a completed turn left changes that Mend did not land. */
export const heldBack = (facts: ReadonlyArray<LandingFactDto>): boolean =>
  facts.some((fact) => fact._tag === "not-landed");

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

/**
 * What "Check origin" found, always a line: when origin was checked, why it couldn't be, or that
 * nothing Mend pushed was there to compare with (a refused push leaves nothing to compare).
 */
export const probeLine = (view: ChangeLandingsDto, now: Date): string =>
  remoteLine(view, now) ?? "origin not compared · nothing pushed from Mend yet";

// ─── The Change view's toolbar ──────────────────────────────────────────────

/** "Pull request #412 open": the link the toolbar and the conversation give to GitHub. */
export const pullRequestWords = (pullRequest: {
  readonly number: number;
  readonly state: RecordedPullRequest["state"];
}): string => `Pull request #${pullRequest.number} ${pullRequest.state}`;

/** What the toolbar's button does: land, land again, show what landed, or nothing. */
export type LandAction = "land" | "land-again" | "landed" | null;

export interface ToolbarLanding {
  /** "Checkpoint 9 is in pull request #412."; null before anything landed. */
  readonly line: string | null;
  /** The newest recorded pull request, for the link beside the line. */
  readonly pullRequest: RecordedPullRequest | null;
  readonly action: LandAction;
}

/**
 * What the Change view says about landing, and its one button (Doop "Change · landed", "Change ·
 * landed, new checkpoint"). After a landing the line names the pull request and which checkpoint
 * is in it; the owner's button is Land again… only when something is new to push (a newer
 * checkpoint, a turn that didn't land, or a push that didn't happen). Anyone else can look at
 * what landed.
 */
export const toolbarLanding = (input: {
  readonly view: ChangeLandingsDto;
  /** The ordinal of the checkpoint the last push landed; null when Mend can't tell. */
  readonly landedOrdinal: number | null;
  /** The checkpoint the view shows. */
  readonly currentOrdinal: number;
  readonly hasFiles: boolean;
}): ToolbarLanding => {
  const { view } = input;
  const lastPush = view.landings.find((landing) => landing.pushedSha !== null);
  const pullRequest = view.landings.find((landing) => landing.pullRequest !== null)?.pullRequest;
  const recorded = pullRequest ?? null;
  const moved = view.facts.some((fact) => fact._tag === "changed-since-landing");
  const latest = view.landings[0];
  const didNotPush =
    latest !== undefined && latest.pushedSha === null && latest.outcome !== "adopted";
  const landed = input.landedOrdinal === null ? "The change" : `Checkpoint ${input.landedOrdinal}`;
  const current = `Checkpoint ${input.currentOrdinal}`;
  const line =
    recorded !== null
      ? lastPush === undefined
        ? `Pull request #${recorded.number} was opened outside Mend.`
        : moved
          ? `${current} isn't in pull request #${recorded.number} yet.`
          : `${landed} is in pull request #${recorded.number}.`
      : lastPush === undefined
        ? null
        : moved
          ? `${current} isn't on origin yet.`
          : `${landed} is on origin as ${lastPush.remoteBranch}.`;
  const anything = view.landings.length > 0;
  const action: LandAction = !view.land
    ? anything
      ? "landed"
      : null
    : lastPush === undefined
      ? input.hasFiles
        ? "land"
        : anything
          ? "landed"
          : null
      : moved || didNotPush || heldBack(view.facts)
        ? "land-again"
        : "landed";
  return { line, pullRequest: recorded, action };
};

// ─── The Land dialog ────────────────────────────────────────────────────────

/** Origin as the dialog names it: `github.com/northwind/checkout-api`, without scheme or `.git`. */
export const originPlace = (originUrl: string | null): string => {
  if (originUrl === null || originUrl.trim() === "") return "origin";
  const url = originUrl.trim();
  const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
  const place =
    scp === null
      ? url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "")
      : `${scp[1] ?? ""}/${scp[2] ?? ""}`;
  return place.replace(/\.git$/, "").replace(/\/+$/, "");
};

/**
 * Why no pull request can be opened, as a sentence: the server says
 * "pull request unavailable · origin is on gitlab.com, not GitHub".
 */
export const unavailableWords = (reason: string | null): string => {
  const words = (reason ?? "").replace(/^pull request unavailable\s*·\s*/, "").trim();
  if (words === "") return "Mend can't open a pull request for this project.";
  return `No pull request: ${words}.`;
};

/** A session still working in the workspace, as the Land dialog names it. */
export interface StillEditing {
  readonly sessionId: string;
  readonly heading: string;
  readonly body: string;
}

/**
 * The other sessions still running in the workspace (Doop "Session · Land while … edits"): landing
 * isn't blocked, so the dialog names each and says what happens to what it writes next.
 */
export const stillEditing = (
  rows: ReadonlyArray<{
    readonly session: {
      readonly id: string;
      readonly status: string;
      readonly ownerUserId: string | null;
    };
    readonly title: string;
    readonly activity?: { readonly kind: string; readonly subject: string | null } | null;
  }>,
  sessionId: string,
  viewerId: string | null,
): ReadonlyArray<StillEditing> =>
  rows
    .filter(
      (row) =>
        row.session.id !== sessionId &&
        (row.session.status === "running" || row.session.status === "starting"),
    )
    .map((row) => {
      const whose =
        viewerId !== null && row.session.ownerUserId === viewerId
          ? "It's your other session in this workspace"
          : "It's another session in this workspace";
      const doing = row.activity == null ? "" : `, and it's ${activityNow(row.activity)} now`;
      return {
        sessionId: row.session.id,
        heading: `${row.title} is still editing`,
        body: `${whose}${doing}. Mend pushes the files as they are now. Edits it makes after that stay in the workspace until you land again.`,
      };
    });

const activityNow = (doing: { readonly kind: string; readonly subject: string | null }): string => {
  const subject = doing.subject === null ? null : doing.subject;
  switch (doing.kind) {
    case "command":
    case "task":
      return subject === null ? "running a command" : `running ${subject}`;
    case "edit":
      return subject === null ? "editing files" : `editing ${subject}`;
    case "search":
      return "searching the web";
    case "thinking":
      return "thinking";
    case "writing":
      return "writing a reply";
    case "planning":
      return "planning";
    default:
      return "using a tool";
  }
};

/** A refused or failed landing, as the dialog states it. */
export interface LandingProblem {
  /** "GitHub refused the push", "The pull request wasn't opened". */
  readonly heading: string;
  /** The remote's or `gh`'s own words, shown as they came. */
  readonly words: string;
  /** What happens now and what to do. */
  readonly next: string;
}

/**
 * What went wrong with a landing, from the report just made or the newest recorded landing:
 * a refused push in the remote's own words, a push that never happened, or a pull request step
 * that failed after the push. Null when it went through.
 */
export const landingProblem = (
  landing: ChangeLandingDto | undefined,
  github: boolean,
): LandingProblem | null => {
  if (landing === undefined) return null;
  const words = landing.message ?? "no reason given";
  const host = github ? "GitHub" : "Origin";
  if (landing.outcome === "refused")
    return {
      heading: `${host} refused the push`,
      words,
      next: `Nothing was pushed${github ? ", and no pull request was opened" : ""}. Sort out what ${host === "Origin" ? "origin" : "GitHub"} says, then try again.`,
    };
  if (landing.outcome !== "failed") return null;
  if (landing.pushedSha === null)
    return {
      heading: "The landing didn't finish",
      words,
      next: "Nothing was pushed. Try again; if it fails the same way, the words above say why.",
    };
  return {
    heading: "The pull request wasn't opened",
    words,
    next: `Mend pushed ${landing.remoteBranch}. Try again to open the pull request.`,
  };
};

/**
 * What went wrong with the landing just made: the record's own words, or a pull request step that
 * failed after a push the record counts as pushed.
 */
export const reportProblem = (report: LandingReportDto, github: boolean): LandingProblem | null =>
  landingProblem(report.landing, github) ??
  (report.pullRequest._tag === "failed" && report.landing.pushedSha !== null
    ? {
        heading: "The pull request wasn't opened",
        words: report.pullRequest.message,
        next: `Mend pushed ${report.landing.remoteBranch}. Try again to open the pull request.`,
      }
    : null);

/** What one landing just did, in a sentence for the toast; null when it didn't go through. */
export const landedSentence = (report: LandingReportDto): string | null => {
  const { landing, pullRequest } = report;
  if (landing.pushedSha === null || landing.outcome === "refused" || landing.outcome === "failed")
    return null;
  switch (pullRequest._tag) {
    case "opened":
      return withMedia(
        `Pushed ${landing.remoteBranch} and opened pull request #${pullRequest.pullRequest.number}.`,
        pullRequest.media,
      );
    case "updated":
      return withMedia(
        `Pushed ${landing.remoteBranch} to pull request #${pullRequest.pullRequest.number}.`,
        pullRequest.media,
      );
    case "failed":
      return null;
    case "unavailable":
    case "off":
    case "not-reached":
      return `Pushed ${landing.remoteBranch} to origin.`;
  }
};

const withMedia = (sentence: string, media: Parameters<typeof pullRequestMediaLine>[0]): string => {
  const line = pullRequestMediaLine(media);
  return line === null ? sentence : `${sentence} ${line}.`;
};

// ─── The conversation ───────────────────────────────────────────────────────

/** A landing as the conversation marks it, after the turn it followed. */
export interface LandingMark {
  readonly key: string;
  /** "Checkpoint 9 landed as pull request #412". */
  readonly label: string;
  readonly sha: string;
  readonly at: string;
  readonly pullRequest: { readonly url: string } | null;
}

/**
 * The session's own landings that pushed, oldest first, in the conversation's words (Doop
 * "Session · landed"): the first into a pull request "landed as", later ones "added to". A refused
 * or failed landing is the Change view's to say.
 */
export const landingMarks = (
  landings: ReadonlyArray<ChangeLandingDto>,
  checkpoints: ReadonlyArray<{ readonly id: string; readonly ordinal: number }>,
  sessionId: string,
): ReadonlyArray<LandingMark> => {
  const oldestFirst = landings.toReversed();
  return oldestFirst.flatMap((landing, index) => {
    if (landing.sessionId !== sessionId || landing.pushedSha === null) return [];
    const ordinal = checkpoints.find(
      (checkpoint) => checkpoint.id === landing.checkpointId,
    )?.ordinal;
    // "Checkpoint 9 landed as …", or "Landed as …" when the checkpoint is gone.
    const say = (verb: string) =>
      ordinal === undefined
        ? `${verb.charAt(0).toUpperCase()}${verb.slice(1)}`
        : `Checkpoint ${ordinal} ${verb}`;
    const pullRequest = landing.pullRequest;
    const before = oldestFirst
      .slice(0, index)
      .some(
        (earlier) =>
          earlier.pushedSha !== null &&
          pullRequest !== null &&
          earlier.pullRequest?.number === pullRequest.number,
      );
    const label =
      pullRequest === null
        ? say(`pushed to origin as ${landing.remoteBranch}`)
        : before
          ? say(`added to pull request #${pullRequest.number}`)
          : say(`landed as pull request #${pullRequest.number}`);
    return [
      {
        key: `landing:${landing.id}`,
        label,
        sha: landing.pushedSha.slice(0, 7),
        at: new Date(landing.createdAt).toISOString(),
        pullRequest: pullRequest === null ? null : { url: pullRequest.url },
      },
    ];
  });
};
