import { observedAgo, resolveAutoLand, type AutomationChoice } from "@mend/domain/workbench";

import type {
  ChangeLandingDto,
  ChangeLandingsDto,
  LandingFactDto,
  LandingReportDto,
} from "#/lib/api";

/**
 * Landing as the desktop states it (docs/adr/0007-landing.md): what the next landing pushes and
 * where, how each observed fact reads, and the composer's "Land when a turn completes". Ported
 * from the web app's `lib/landing.ts` over the wire shapes, so both say the same words. Every
 * line is an observation: Mend pushes and opens a pull request, it never merges, and nothing
 * here says a change is ready.
 */

const shortSha = (sha: string): string => sha.slice(0, 7);

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

const NOT_LANDED: Record<Extract<LandingFactDto, { _tag: "not-landed" }>["reason"], string> = {
  question: "the request read as a question",
  option: "the request said autopr=false",
  off: "automatic landing is off",
  "not-owner": "the turn was not sent by the owner",
};

/**
 * One fact as its status line, in the domain's words (`landingFactLine`, which a test holds this
 * to): terse, observed, and never a verdict.
 */
export const factLine = (fact: LandingFactDto, now: Date): string => {
  switch (fact._tag) {
    case "pushed":
      return `pushed · ${fact.branch} · ${shortSha(fact.sha)} · observed`;
    case "pull-request":
      return `pull request #${fact.number} · ${fact.state} · observed ${observedAgo(new Date(fact.observedAt), now)}`;
    case "origin-moved":
      return `origin has moved · ${fact.branch} has ${plural(fact.commits, "commit", "commits")} Mend has not seen`;
    case "changed-since-landing":
      return `changed since landing · ${plural(fact.files, "file", "files")}`;
    case "refused":
      return `push refused · ${fact.branch} · ${fact.message}`;
    case "failed":
      return `landing failed · ${fact.message}`;
    case "pull-request-failed":
      return `pull request step failed · ${fact.message}`;
    case "agent-push":
      return fact.sha === null
        ? `deleted by the agent · ${fact.ref}`
        : `pushed by the agent · ${fact.ref} · ${shortSha(fact.sha)}`;
    case "not-landed":
      return `changes not landed · ${NOT_LANDED[fact.reason]}`;
    case "intent-not-read":
      return "intent not read";
  }
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

const HEADLINE_ORDER: ReadonlyArray<LandingFactDto["_tag"]> = [
  "not-landed",
  "refused",
  "failed",
  "pull-request-failed",
  "pull-request",
  "pushed",
];

/**
 * The one fact the session's header shows: what the last attempt or turn said when it did not
 * land, else the pull request, else the push. Null when nothing was landed or held back.
 */
export const headlineFact = (facts: ReadonlyArray<LandingFactDto>): LandingFactDto | null => {
  for (const tag of HEADLINE_ORDER) {
    const fact = facts.find((candidate) => candidate._tag === tag);
    if (fact !== undefined) return fact;
  }
  return null;
};

/** Whether a completed turn left changes Mend did not land, so the button is worth pointing at. */
export const heldBack = (facts: ReadonlyArray<LandingFactDto>): boolean =>
  facts.some((fact) => fact._tag === "not-landed");

/**
 * The facts to show: the live record's, plus what the last "Check origin" fetch saw of origin's
 * branch. A plain read never fetches, so `origin-moved` comes only from that fetch.
 */
export const factsWithProbe = (
  facts: ReadonlyArray<LandingFactDto>,
  probed: ChangeLandingsDto | null,
): ReadonlyArray<LandingFactDto> => {
  const moved = probed?.facts.filter((fact) => fact._tag === "origin-moved") ?? [];
  return [...facts.filter((fact) => fact._tag !== "origin-moved"), ...moved];
};

/** The branch the next landing pushes: the one the change landed on before, else its own. */
export const nextRemoteBranch = (
  landings: ReadonlyArray<ChangeLandingDto>,
  worktreeBranch: string,
): string => landings[0]?.remoteBranch ?? worktreeBranch;

/** The pull request a landing recorded most recently, whatever GitHub last said of it. */
export const latestPullRequest = (
  landings: ReadonlyArray<ChangeLandingDto>,
): { readonly landingId: string; readonly pullRequest: PullRequestDto } | null => {
  const landing = landings.find((candidate) => candidate.pullRequest !== null);
  return landing === undefined || landing.pullRequest === null
    ? null
    : { landingId: landing.id, pullRequest: landing.pullRequest };
};

export type PullRequestDto = NonNullable<ChangeLandingDto["pullRequest"]>;

/**
 * The pull request the next landing updates: the recorded one while GitHub last said it was
 * open. A closed or merged one leads to a new pull request.
 */
export const pullRequestToUpdate = (
  landings: ReadonlyArray<ChangeLandingDto>,
): PullRequestDto | null => {
  const recorded = latestPullRequest(landings)?.pullRequest ?? null;
  return recorded !== null && recorded.state === "open" ? recorded : null;
};

/** The one button's words: what it will do, never what the change is. */
export const landButtonLabel = (view: {
  readonly pullRequestAvailable: boolean;
  readonly updates: boolean;
}): string =>
  !view.pullRequestAvailable
    ? "Push to origin"
    : view.updates
      ? "Push and update pull request"
      : "Push and open pull request";

/**
 * What the land request carries: an empty field sends null, so Mend keeps what GitHub has. The
 * pull request step is always asked for; where origin is not on GitHub the landing records why
 * it did not run. The branch is the one the change pushed to before, else `mend/<name>`.
 */
export const landRequestOf = (draft: { readonly title: string; readonly body: string }) => ({
  branch: null,
  pullRequest: true,
  title: draft.title.trim() === "" ? null : draft.title.trim(),
  body: draft.body.trim() === "" ? null : draft.body,
});

/**
 * What one landing just did, as the status line states it:
 * `pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened`.
 */
export const landingReportLine = (report: LandingReportDto): string => {
  const { landing, pullRequest } = report;
  if (landing.outcome === "refused") {
    return `push refused · ${landing.remoteBranch} · ${landing.message ?? "no reason given"}`;
  }
  if (landing.pushedSha === null) {
    return `landing failed · ${landing.message ?? "no reason given"}`;
  }
  const pushed = `pushed · ${landing.remoteBranch} · ${shortSha(landing.pushedSha)}`;
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

/**
 * One recorded landing as a history row: what it pushed, and what GitHub last said of its pull
 * request (`pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed`).
 */
export const landingRecordLine = (landing: ChangeLandingDto): string => {
  if (landing.outcome === "refused") {
    return `push refused · ${landing.remoteBranch} · ${landing.message ?? "no reason given"}`;
  }
  if (landing.pushedSha === null) {
    return `landing failed · ${landing.message ?? "no reason given"}`;
  }
  const pushed = `pushed · ${landing.remoteBranch} · ${shortSha(landing.pushedSha)}`;
  if (landing.pullRequest !== null) {
    return `${pushed} · pull request #${landing.pullRequest.number} · ${landing.pullRequest.state} · observed`;
  }
  if (landing.outcome === "failed") {
    return `${pushed} · pull request step failed · ${landing.message ?? "no reason given"}`;
  }
  return `${pushed} · observed`;
};

/** Who started a recorded landing, and when: `automatic · 2 min ago`. */
export const landingRecordMeta = (landing: ChangeLandingDto, now: Date): string =>
  `${landing.trigger} · ${observedAgo(new Date(landing.createdAt), now)}`;

/** When origin was last checked, or why it could not be. */
export const remoteLine = (view: ChangeLandingsDto, now: Date): string | null => {
  if (view.remoteFailure !== null) return `origin could not be checked · ${view.remoteFailure}`;
  const remote = view.remote;
  if (remote === null) return null;
  const tip =
    remote.remoteSha === null
      ? `origin has no ${remote.remoteBranch}`
      : `origin ${remote.remoteBranch} at ${shortSha(remote.remoteSha)}`;
  const holds = remote.holds ? "holds the landed commit" : "does not hold the landed commit";
  return `${tip} · ${holds} · checked ${observedAgo(new Date(remote.observedAt), now)}`;
};

// ─── the composer's "Land when a turn completes" ────────────────────────────

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
 * The composer's choices for one session, in the web composer's words. A project set to off
 * wins over any override, so it offers only that. `settings` is null while Settings load, or on
 * a server that has no such setting.
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

/**
 * The override a start sends. Only a conversation's turns land by themselves (a terminal agent
 * has no turns Mend sees end), and a project set to off wins, so both send null.
 */
export const autoLandToSend = (input: {
  readonly override: boolean | null;
  readonly project: AutomationChoice;
  readonly conversation: boolean;
}): boolean | null => (input.project === "off" || !input.conversation ? null : input.override);

/**
 * The project's stance as the wire gave it, or null from a server that predates landing: it
 * omits the key, and it would ignore an override, so the composer offers none.
 */
export const projectAutoLand = (project: {
  readonly autoLand: AutomationChoice | undefined;
}): AutomationChoice | null => project.autoLand ?? null;

/** Settings' "Land when a turn completes"; null while Settings load or from an older server. */
export const settingsAutoLand = (
  settings: { readonly autoLand: boolean | undefined } | undefined,
): boolean | null => settings?.autoLand ?? null;
