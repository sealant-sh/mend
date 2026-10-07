/**
 * Readers per person (docs/adr/0016-per-person-harness-homes.md, decision 12, Delivery 16): where
 * in a worktree's capture a session's conversation state and memory lie, by the layout of the
 * executor its process ran in. A `shared` executor's harness home is the capture's `harness/`; a
 * person's saved directory `P` is `harness/people/<account id>/`, and a conversation a session
 * shares (shared control, from the move into `C` on) is
 * `harness/people/<owner>/conversations/<session id>/`, laid out as a home is. Every reader goes by
 * that prefix, never past it, so one person's conversation or memory is never another's.
 */
import type { HarnessLayout } from "@mend/domain/workbench";

import { PEOPLE_DIR } from "./harness-layout.ts";
import { CARRIED_TRANSCRIPTS } from "./harness-state.ts";
import { homePathOfPersonSaved, personSavedPathOf } from "./person-deliveries.ts";

/** The capture's harness home, as every reader names it. */
export const CAPTURED_HARNESS = "harness";

/** Where one session's conversation state and memory lie in a capture. */
export interface ConversationPlace {
  readonly kind: "shared" | "person" | "conversation";
  /** The directory every read stays under, from the capture's root, with no trailing slash. */
  readonly root: string;
  /** Whose saved directory it is; null for the shared home. */
  readonly person: string | null;
  /** The list of conversations Mend carried in, from the capture's root; null where none is. */
  readonly carried: string | null;
  /** Where a home-relative path (as the memory store keeps it) lies under `root`. */
  readonly savedPathOf: (homeRelative: string) => string;
  /** And back: the home-relative path of a path under `root`. */
  readonly homePathOf: (savedRelative: string) => string;
}

const same = (relative: string) => relative;

/** A `shared` executor's home: the whole `harness/`, as before this release. */
export const SHARED_PLACE: ConversationPlace = {
  kind: "shared",
  root: CAPTURED_HARNESS,
  person: null,
  carried: `${CAPTURED_HARNESS}/${CARRIED_TRANSCRIPTS}`,
  savedPathOf: same,
  homePathOf: same,
};

/** A person's saved directory `P`: their own conversations and memory. */
export const personalPlaceOf = (accountId: string): ConversationPlace => {
  const root = `${CAPTURED_HARNESS}/${PEOPLE_DIR}/${accountId}`;
  return {
    kind: "person",
    root,
    person: accountId,
    carried: `${root}/${personSavedPathOf(CARRIED_TRANSCRIPTS)}`,
    savedPathOf: personSavedPathOf,
    homePathOf: homePathOfPersonSaved,
  };
};

/**
 * A conversation a session shares (`C`, decision 6), in its owner's saved directory: no memory and
 * nothing carried in, ever.
 */
export const sharedConversationPlaceOf = (owner: string, sessionId: string): ConversationPlace => ({
  kind: "conversation",
  root: `${CAPTURED_HARNESS}/${PEOPLE_DIR}/${owner}/conversations/${sessionId}`,
  person: null,
  carried: null,
  savedPathOf: same,
  homePathOf: same,
});

/**
 * The place a session's process read and wrote, by the layout of the executor it ran in
 * (decision 12): the shared home in a `shared` one; in a `person` one, its person's saved
 * directory, or its conversation in `C` once the session is shared. opencode's is always the
 * personal one (it is never shared). Null when the process's person is not known: nobody's.
 */
export const conversationPlaceOf = (input: {
  readonly layout: HarnessLayout;
  /** Who the process ran as. */
  readonly person: string | null;
  readonly harness: string;
  /** The session's conversation moved into `C` (shared control, Delivery 17); null otherwise. */
  readonly sharedConversation: { readonly owner: string; readonly sessionId: string } | null;
}): ConversationPlace | null => {
  if (input.layout === "shared") return SHARED_PLACE;
  if (input.sharedConversation !== null && input.harness !== "opencode") {
    return sharedConversationPlaceOf(
      input.sharedConversation.owner,
      input.sharedConversation.sessionId,
    );
  }
  return input.person === null ? null : personalPlaceOf(input.person);
};

/** A capture path under `place`, relative to it; null for one outside it. */
export const relativeTo = (place: ConversationPlace, capturePath: string): string | null =>
  capturePath.startsWith(`${place.root}/`) ? capturePath.slice(place.root.length + 1) : null;

/** A path under `place`, from the capture's root. */
export const underPlace = (place: ConversationPlace, relative: string): string =>
  `${place.root}/${relative}`;

/**
 * The conversations of one provider session in a capture's `harness/`, relative to it: Claude's
 * transcript and its `<id>/` directory (tool results, sub-agents), a Codex rollout, a pi session.
 * What the pre-release copy carries into its owner's `P` (decision 14).
 */
export const conversationFilesOf = (
  harness: string,
  providerSessionId: string,
  relativePaths: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const id = providerSessionId.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return [];
  return relativePaths.filter((relative) => {
    switch (harness) {
      case "claude": {
        const match = /^\.claude\/projects\/[^/]+\/([^/]+)(\.jsonl|\/.+)$/.exec(relative);
        return match?.[1] === id && (match[2] === ".jsonl" || (match[2] ?? "").startsWith("/"));
      }
      case "codex":
        return (
          /^\.codex\/(?:archived_)?sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/.test(relative) &&
          relative.endsWith(`-${id}.jsonl`)
        );
      case "pi":
        return (
          /^\.pi\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/.test(relative) &&
          relative.endsWith(`_${id}.jsonl`)
        );
      default:
        return false;
    }
  });
};
