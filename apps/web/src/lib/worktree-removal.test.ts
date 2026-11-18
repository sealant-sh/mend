import { SessionId, WorktreeId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import { refusedRemoval, refusedWith } from "./refusal-fixture.ts";
import {
  clearedWords,
  explainRefusal,
  forcedRemovalFailureOf,
  type RefusalContext,
  removalRefusalOf,
  removedWords,
} from "./worktree-removal.ts";

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

const files = Array.from({ length: 10 }, (_, index) => ({
  path: `${"abcdefghij"[index] ?? "z"}.ts`,
  additions: 0,
  deletions: 0,
}));

const ref = { worktreeId: WorktreeId.make("worktree-1"), worktreeName: "fix-login" };

const neverLandedBlocker = {
  _tag: "Unlanded",
  ...ref,
  owner: null,
  standing: { _tag: "never-landed", files },
} as const;

const neverLanded = refusedRemoval(WORDS, {
  scope: "worktree",
  forceWouldLift: true,
  blockers: [neverLandedBlocker],
});

const liveBlocker = {
  _tag: "SessionLive",
  ...ref,
  sessionId: SessionId.make("22222222"),
  owner: { userId: "grace", name: "Grace Hopper" },
  role: "inhabitant",
  activity: "live",
} as const;

const live = refusedRemoval(
  "not removed · Grace Hopper's session 22222222 is live · stop it first.",
  {
    scope: "worktree",
    forceWouldLift: false,
    blockers: [liveBlocker],
  },
);

const context: RefusalContext = {
  worktreeName: "fix-login",
  viewerId: "ada",
  sessionTitle: (id) => (id === "22222222" ? "Retry failed Stripe webhooks" : null),
  remote: "GitHub",
  changeOwner: "Ada Lovelace",
};

describe("removalRefusalOf", () => {
  it("lays out what is not on origin from the refusal's blockers, and keeps the words verbatim", () => {
    const refusal = removalRefusalOf(neverLanded);
    expect(refusal?.words).toBe(WORDS);
    expect(refusal?.forceable).toBe(true);
    expect(refusal?.unlanded).toEqual({
      files: 10,
      additions: 0,
      deletions: 0,
      named: files.slice(0, 5),
      more: 5,
    });
  });

  it("offers no override when a blocker force does not lift stands", () => {
    const refusal = removalRefusalOf(live);
    expect(refusal?.forceable).toBe(false);
    expect(refusal?.unlanded).toBeNull();
  });

  it("reads the change owner's refusal as forbidden, with no override", () => {
    const refusal = removalRefusalOf(
      refusedWith(
        "RemovalForbidden",
        "not removed · only Ada, who started this worktree's change, removes it.",
      ),
    );
    expect(refusal?.forbidden).toBe(true);
    expect(refusal?.forceable).toBe(false);
  });

  it("is not a refusal for any other failure, nor for blockers that do not decode", () => {
    expect(removalRefusalOf(refusedWith(null, "The Mend server is not answering."))).toBeNull();
    expect(removalRefusalOf(refusedWith("StoreFailure", WORDS))).toBeNull();
    expect(removalRefusalOf(refusedRemoval(WORDS, { scope: "worktree", blockers: [] }))).toBeNull();
    // The words alone never decide: a message that reads like a refusal is still none.
    expect(removalRefusalOf(new Error(`RemovalRefused: ${WORDS}`))).toBeNull();
  });
});

describe("forcedRemovalFailureOf", () => {
  it("after force, says plainly what force never lifts and offers a retry only for transport", () => {
    expect(forcedRemovalFailureOf(live)).toEqual(removalRefusalOf(live));
    expect(forcedRemovalFailureOf(refusedWith("WorktreeNotFound", "gone"))).toMatchObject({
      words: "This worktree is no longer in the store.",
      forceable: false,
    });
    expect(forcedRemovalFailureOf(refusedWith("StoreFailure", "git said no"))).toMatchObject({
      words: "git said no",
      forceable: false,
    });
    expect(
      forcedRemovalFailureOf(refusedWith(null, "The Mend server is not answering.")),
    ).toMatchObject({
      words: "The worktree was not removed. The Mend server is not answering. Try again.",
      forceable: true,
    });
  });
});

describe("explainRefusal", () => {
  it("says whose session runs there and to ask them to stop it, never to wait for it", () => {
    const refusal = removalRefusalOf(live);
    if (refusal === null) throw new Error("expected a refusal");
    expect(explainRefusal(refusal, context)).toEqual({
      lead: "fix-login is still here. Mend can't remove a worktree while a session in it is running.",
      reasons: [
        {
          tone: "info",
          title: "A session is still running in it.",
          body: "Grace Hopper's session Retry failed Stripe webhooks is working in this worktree. Ask Grace to stop it, then remove the worktree.",
        },
      ],
    });
  });

  it("names an untitled session by its short id, saying session once", () => {
    const refusal = removalRefusalOf(live);
    if (refusal === null) throw new Error("expected a refusal");
    const untitled = { ...context, sessionTitle: () => "shell session 22222222" };
    expect(explainRefusal(refusal, untitled).reasons[0]?.body).toBe(
      "Grace Hopper's session 22222222 is working in this worktree. Ask Grace to stop it, then remove the worktree.",
    );
  });

  it("doesn't add a workspace still ending beside the running session that holds it", () => {
    const both = removalRefusalOf(
      refusedRemoval("x", {
        scope: "worktree",
        forceWouldLift: false,
        blockers: [
          liveBlocker,
          { _tag: "Saving", ...ref, holds: [{ sessionId: null, kind: "executor", via: "own" }] },
        ],
      }),
    );
    if (both === null) throw new Error("expected a refusal");
    const words = explainRefusal(both, context);
    expect(words.lead).toBe(
      "fix-login is still here. Mend can't remove a worktree while a session in it is running.",
    );
    expect(words.reasons.map((reason) => reason.title)).toEqual([
      "A session is still running in it.",
    ]);
  });

  it("tells the viewer to stop their own session", () => {
    const own = removalRefusalOf(
      refusedRemoval("x", {
        scope: "worktree",
        forceWouldLift: false,
        blockers: [{ ...liveBlocker, owner: { userId: "ada", name: "Ada Lovelace" } }],
      }),
    );
    if (own === null) throw new Error("expected a refusal");
    expect(explainRefusal(own, context).reasons[0]?.body).toBe(
      "Your session Retry failed Stripe webhooks is working in this worktree. Stop it, then remove the worktree.",
    );
  });

  it("offers Remove anyway in the words only when force would lift the refusal", () => {
    const forceable = removalRefusalOf(neverLanded);
    const held = removalRefusalOf(
      refusedRemoval("x", {
        scope: "worktree",
        forceWouldLift: false,
        blockers: [liveBlocker, neverLandedBlocker],
      }),
    );
    if (forceable === null || held === null) throw new Error("expected refusals");
    expect(explainRefusal(forceable, context)).toEqual({
      lead: "fix-login is still here. Mend didn't remove it because its change was never landed.",
      reasons: [
        {
          tone: "warning",
          title: "This change isn't on GitHub.",
          body: "No session pushed it and no pull request holds it, so removing the worktree would lose it. Land it first, or remove it anyway if you don't need it.",
        },
      ],
    });
    const words = explainRefusal(held, context);
    expect(words.lead).toBe(
      "fix-login is still here. Mend didn't remove it, for the reasons below.",
    );
    expect(words.reasons[1]?.body).toBe(
      "No session pushed it and no pull request holds it, so removing the worktree would lose it. Land it first.",
    );
  });

  it("says a saving workspace holds the worktree until the session says Stopped", () => {
    const saving = removalRefusalOf(
      refusedRemoval("x", {
        scope: "worktree",
        forceWouldLift: false,
        blockers: [
          {
            _tag: "Saving",
            ...ref,
            holds: [{ sessionId: SessionId.make("22222222"), kind: "saving", via: "own" }],
          },
        ],
      }),
    );
    if (saving === null) throw new Error("expected a refusal");
    expect(explainRefusal(saving, context)).toEqual({
      lead: "fix-login is still here. Mend can't remove a worktree while its workspace is saving.",
      reasons: [
        {
          tone: "info",
          title: "The workspace is still saving.",
          body: "The session Retry failed Stripe webhooks stopped, and Mend is still copying its work out of the workspace. Removing the worktree now would lose that work. Try again once the session says Stopped.",
        },
      ],
    });
  });

  it("names who may remove a worktree whose change someone else started", () => {
    const forbidden = removalRefusalOf(refusedWith("RemovalForbidden", "not removed · only Ada…"));
    if (forbidden === null) throw new Error("expected a refusal");
    expect(explainRefusal(forbidden, context)).toEqual({
      lead: "fix-login is still here. Only Ada Lovelace, who started its change, can remove it.",
      reasons: [],
    });
  });

  it("keeps the server's words for a failure that gave no reasons", () => {
    const failed = forcedRemovalFailureOf(refusedWith(null, "The Mend server is not answering."));
    expect(explainRefusal(failed, context)).toEqual({
      lead: "fix-login is still here. Mend didn't remove it.",
      reasons: [
        {
          tone: "info",
          title: "",
          body: "The worktree was not removed. The Mend server is not answering. Try again.",
        },
      ],
    });
  });
});

describe("removedWords", () => {
  it("says what went with the worktree, and when its change was thrown away", () => {
    expect(removedWords("grpc-spike", 0, false)).toBe("Removed grpc-spike.");
    expect(removedWords("try-vitest-4", 1, true)).toBe(
      "Removed try-vitest-4 and its session. Its change was discarded.",
    );
    expect(removedWords("fix-login", 3, false)).toBe("Removed fix-login and its 3 sessions.");
  });
});

describe("clearedWords", () => {
  it("counts what Clear finished removed and names what it kept", () => {
    expect(
      clearedWords(3, [{ name: "try-vitest-4", because: "its change was never landed" }]),
    ).toBe("Removed 3 worktrees. Kept try-vitest-4: its change was never landed.");
    expect(clearedWords(1, [])).toBe("Removed 1 worktree.");
    expect(
      clearedWords(0, [
        { name: "a", because: "its change was never landed" },
        { name: "b", because: null },
      ]),
    ).toBe("Kept a, b. Remove each from its menu to see why.");
  });
});
