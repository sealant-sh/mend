/**
 * Pull requests on the phone (docs/adr/0007-landing.md): the one a session's change has, as `gh`
 * last reported it, wherever it was opened — by Mend's landing, or by the agent with `gh pr
 * create` and adopted. The session's conversation shows a card for it where it was first
 * recorded; lists show a mono fact that opens it on GitHub. Pure, so it is tested without a
 * device; the queries are in pull-request-queries.ts.
 */
import type { StatusTone } from "@/components/status";
import type { ConversationRow } from "@/data/pending-turns";

export type PullRequestStateDto = "open" | "closed" | "merged";

/** A landing's pull request, as `gh` last reported it. */
export interface LandedPullRequestDto {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestStateDto;
  /** Null from rows recorded before Mend kept the title, and from older servers. */
  readonly title?: string | null;
  readonly observedAt: string;
}

/** One landing of the change, as `GET /sessions/:id` and `/sessions/:id/landings` carry it. */
export interface ChangeLandingDto {
  readonly id: string;
  readonly remoteBranch: string;
  readonly trigger: "manual" | "automatic" | "adopted";
  readonly pullRequest: LandedPullRequestDto | null;
  readonly pullRequestCrossRepository?: boolean;
  readonly pullRequestHeadOwner?: string | null;
  readonly createdAt: string;
}

/** A list row's pull request: the change's newest, from the annotation. */
export interface ChangePullRequestDto {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestStateDto;
  /** Null from rows recorded before Mend kept the title. */
  readonly title?: string | null;
  readonly observedAt: string;
  readonly adopted: boolean;
}

/** What the conversation card shows for one pull request. */
export interface PullRequestCard {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestStateDto;
  readonly title: string | null;
  readonly observedAt: string;
  /** Its branch on origin, as the newest landing that names it recorded it. */
  readonly branch: string;
  /** Opened outside Mend (by the agent, or by hand) and adopted. */
  readonly outside: boolean;
  /** Whose fork its head is in; null for origin's own branch. */
  readonly fork: string | null;
  /** The newest landing that names it: what Refresh refreshes. */
  readonly landingId: string;
  /** When Mend first recorded it: where it sits in the conversation. */
  readonly recordedAt: string;
}

/**
 * One card per pull request the change's landings name, oldest first. Each shows the newest
 * landing's report of it; it was opened outside Mend when the first landing that named it was an
 * adoption. Oldest first means in the order Mend first recorded them.
 */
export const pullRequestCards = (
  landings: ReadonlyArray<ChangeLandingDto>,
): ReadonlyArray<PullRequestCard> => {
  // Landings arrive newest first; walking oldest first keeps each card's first record. An index
  // walk, not `toReversed`: the phone's runtime lacks the newer Array methods.
  const cards = new Map<number, PullRequestCard>();
  for (let index = landings.length - 1; index >= 0; index -= 1) {
    const landing = landings[index];
    const pullRequest = landing?.pullRequest ?? null;
    if (landing === undefined || pullRequest === null) continue;
    const first = cards.get(pullRequest.number);
    cards.set(pullRequest.number, {
      number: pullRequest.number,
      url: pullRequest.url,
      state: pullRequest.state,
      title: pullRequest.title ?? first?.title ?? null,
      observedAt: pullRequest.observedAt,
      branch: landing.remoteBranch,
      outside: first?.outside ?? landing.trigger === "adopted",
      fork:
        landing.pullRequestCrossRepository === true ? (landing.pullRequestHeadOwner ?? "") : null,
      landingId: landing.id,
      recordedAt: first?.recordedAt ?? landing.createdAt,
    });
  }
  return [...cards.values()];
};

/** The pull request Mend recorded last: the one a review or a terminal transcript shows. */
export const newestPullRequest = (
  landings: ReadonlyArray<ChangeLandingDto>,
): PullRequestCard | undefined => pullRequestCards(landings).at(-1);

export type ConversationRowWithPullRequests =
  | ConversationRow
  | { readonly kind: "pull-request"; readonly key: string; readonly card: PullRequestCard };

/** When a row happened; a send not recorded yet is newer than anything recorded. */
const rowTime = (row: ConversationRow): number => {
  switch (row.kind) {
    case "turn":
      return row.view.turn === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(row.view.turn.createdAt);
    case "item":
      return Date.parse(row.item.createdAt);
    case "request":
      return Date.parse(row.request.createdAt);
  }
};

/**
 * The conversation with each pull request's card placed where Mend first recorded it: before the
 * first row that happened after, else at the end. An adoption is recorded when the turn that
 * opened the pull request ends, so its card closes that turn. `cards` come as `pullRequestCards`
 * gives them, in the order they were recorded.
 */
export const withPullRequests = (
  rows: ReadonlyArray<ConversationRow>,
  cards: ReadonlyArray<PullRequestCard>,
): ReadonlyArray<ConversationRowWithPullRequests> => {
  if (cards.length === 0) return rows;
  const placed: Array<ConversationRowWithPullRequests> = [];
  let next = 0;
  for (const row of rows) {
    const at = rowTime(row);
    while (next < cards.length) {
      const card = cards[next];
      if (card === undefined || Date.parse(card.recordedAt) >= at) break;
      placed.push({ kind: "pull-request", key: `pull-request:${card.number}`, card });
      next += 1;
    }
    placed.push(row);
  }
  for (const card of cards.slice(next)) {
    placed.push({ kind: "pull-request", key: `pull-request:${card.number}`, card });
  }
  return placed;
};

/** The dot and word a pull request's state reads as (DESIGN.md §4): merged is a result. */
export const pullRequestTone = (state: PullRequestStateDto): StatusTone =>
  state === "merged" ? "observed" : "pending";

/** `#412 · open`: what a list row says. */
export const pullRequestFact = (pullRequest: {
  readonly number: number;
  readonly state: PullRequestStateDto;
}): string => `#${pullRequest.number} · ${pullRequest.state}`;

/** The provenance line under the card's title. */
export const pullRequestOrigin = (card: PullRequestCard): string => {
  const parts = [card.outside ? "opened outside Mend" : "opened by Mend's landing"];
  if (card.fork !== null) parts.push(card.fork === "" ? "from a fork" : `from ${card.fork}'s fork`);
  return parts.join(" · ");
};

// ─── what the server says about the change's landings ──────────────────────

/** A landing fact; the card reads only `changed-since-landing`. */
export interface LandingFactDto {
  readonly _tag: string;
  readonly files?: number;
}

/** `GET /sessions/:id/landings`: the record, what was observed since, and who may land. */
export interface SessionLandingsDto {
  readonly land: boolean;
  readonly landings: ReadonlyArray<ChangeLandingDto>;
  readonly facts: ReadonlyArray<LandingFactDto>;
}

/** Files the worktree changed since the change last landed; null when nothing says so. */
export const changedSinceLanding = (facts: ReadonlyArray<LandingFactDto>): number | null =>
  facts.find((fact) => fact._tag === "changed-since-landing")?.files ?? null;
