import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SessionId, WorktreeId } from "../ids.ts";
import {
  decideRemoval,
  describeUnlanded,
  fenceStep,
  LIFTED_BY_FORCE,
  NO_REMOTE_OUTSIDE_MEND,
  notChangeOwnerWords,
  OWNERLESS_OUTSIDE_MEND,
  type ProjectFacts,
  projectRefusalWords,
  REMOVAL_FENCE_LEASE_SECONDS,
  REMOVAL_FORCE_HINT,
  RemovalBlocker,
  type UnlandedStanding,
  type WorktreeFacts,
  worktreeRefusalWords,
  worktreeRemovalRight,
  hasProvenOwner,
} from "./removal.ts";

const file = (path: string, additions: number, deletions: number) => ({
  path,
  additions,
  deletions,
});
const anna = { userId: "u-anna", name: "Anna" };
const kostas = { userId: "u-kostas", name: "Kostas" };

const worktree = (overrides: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  worktreeId: WorktreeId.make("w-1"),
  name: "fix-auth",
  changeOwner: anna,
  sessions: [],
  holds: [],
  standing: { _tag: "at-base" },
  nestedRepositories: [],
  ...overrides,
});

const neverLanded: UnlandedStanding = {
  _tag: "never-landed",
  files: [file("src/login.ts", 12, 3), file("notes.md", 1, 0)],
};
const noRemote: UnlandedStanding = { _tag: "no-remote", files: [file("src/a.ts", 10, 2)] };

const liveSession = (id: string, owner = anna) => ({
  sessionId: SessionId.make(id),
  owner,
  role: "inhabitant" as const,
  activity: "live" as const,
});

const project = (overrides: Partial<ProjectFacts> = {}): ProjectFacts => ({
  worktrees: [],
  foreignHolders: [],
  resources: [],
  ...overrides,
});

const refuse = (blockers: ReadonlyArray<RemovalBlocker>, forceWouldLift = false) => ({
  blockers,
  forceWouldLift,
});

const refusedBlockers = (decision: ReturnType<typeof decideRemoval>) =>
  decision._tag === "Refuse" ? decision.blockers.map((blocker) => blocker._tag) : [];

describe("decideRemoval, a worktree", () => {
  it("removes a worktree at base with only settled sessions", () => {
    const facts = worktree({ sessions: [{ ...liveSession("s-1"), activity: "settled" }] });
    expect(decideRemoval({ kind: "worktree", force: false, worktree: facts })).toEqual({
      _tag: "Remove",
    });
  });

  it("removes a change on origin without force", () => {
    const facts = worktree({
      standing: {
        _tag: "on-origin",
        landed: { remoteBranch: "mend/fix-auth", sha: "3f2a1c0aa" },
        via: "branch",
      },
    });
    expect(decideRemoval({ kind: "worktree", force: false, worktree: facts })._tag).toBe("Remove");
  });

  it("lists every blocker at once, in the order the words read", () => {
    const facts = worktree({
      sessions: [liveSession("s-1")],
      holds: [{ sessionId: SessionId.make("s-2"), kind: "saving", via: "own" }],
      standing: neverLanded,
      nestedRepositories: [{ path: "core", branch: "main" }],
    });
    const decision = decideRemoval({ kind: "worktree", force: false, worktree: facts });
    expect(refusedBlockers(decision)).toEqual([
      "SessionLive",
      "Saving",
      "Unlanded",
      "NestedRepositories",
    ]);
    expect(decision._tag === "Refuse" && decision.forceWouldLift).toBe(false);
  });

  it("offers force only when force lifts every blocker", () => {
    const facts = worktree({
      standing: neverLanded,
      nestedRepositories: [{ path: "core", branch: "main" }],
    });
    const decision = decideRemoval({ kind: "worktree", force: false, worktree: facts });
    expect(decision._tag === "Refuse" && decision.forceWouldLift).toBe(true);
    expect(decideRemoval({ kind: "worktree", force: true, worktree: facts })._tag).toBe("Remove");
  });

  it("keeps what force never lifts, and lists only those under force", () => {
    const facts = worktree({
      sessions: [liveSession("s-1")],
      holds: [{ sessionId: null, kind: "executor", via: "own" }],
      standing: neverLanded,
    });
    const decision = decideRemoval({ kind: "worktree", force: true, worktree: facts });
    expect(refusedBlockers(decision)).toEqual(["SessionLive", "Saving"]);
    expect(decision._tag === "Refuse" && decision.forceWouldLift).toBe(false);
  });

  it("refuses a no-remote change, and the owner's force removes it (decision Q3)", () => {
    const facts = worktree({ standing: noRemote });
    const refused = decideRemoval({ kind: "worktree", force: false, worktree: facts });
    expect(refused._tag === "Refuse" && refused.blockers[0]).toMatchObject({
      _tag: "Unlanded",
      standing: { _tag: "no-remote" },
      owner: anna,
    });
    expect(decideRemoval({ kind: "worktree", force: true, worktree: facts })._tag).toBe("Remove");
  });

  it("counts an origin it could not check as not on origin", () => {
    const facts = worktree({
      standing: {
        _tag: "origin-unchecked",
        landed: { remoteBranch: "mend/fix-auth", sha: "3f2a1c0aa" },
        reason: "could not resolve host",
      },
    });
    const decision = decideRemoval({ kind: "worktree", force: false, worktree: facts });
    expect(refusedBlockers(decision)).toEqual(["Unlanded"]);
    expect(decision._tag === "Refuse" && decision.forceWouldLift).toBe(true);
  });
});

describe("a change Mend could not read", () => {
  const unread: UnlandedStanding = { _tag: "unread", reason: "git diff failed." };

  it("is refused beside every other blocker, and the owner's force lifts it", () => {
    const facts = worktree({ sessions: [liveSession("s-1")], standing: unread });
    const decision = decideRemoval({ kind: "worktree", force: false, worktree: facts });
    expect(refusedBlockers(decision)).toEqual(["SessionLive", "Unlanded"]);
    const alone = worktree({ standing: unread });
    expect(decideRemoval({ kind: "worktree", force: true, worktree: alone })._tag).toBe("Remove");
  });

  it("says so in Mend and outside it", () => {
    const blockers = [
      {
        _tag: "Unlanded" as const,
        worktreeId: WorktreeId.make("w-1"),
        worktreeName: "fix-auth",
        owner: anna,
        standing: unread,
      },
    ];
    expect(worktreeRefusalWords(refuse(blockers, true), "in-mend")).toBe(
      `Mend could not read this worktree's change · git diff failed. Try again, ${REMOVAL_FORCE_HINT}.`,
    );
    expect(worktreeRefusalWords(refuse(blockers), "outside-mend")).toBe(
      "Mend could not read this worktree's change · git diff failed. Mend keeps the worktree; try again from Mend.",
    );
    expect(projectRefusalWords(blockers, "in-mend")).toContain(
      "fix-auth holds Anna's change, which Mend could not read",
    );
  });
});

describe("decideRemoval, a project", () => {
  it("removes a project whose every worktree is kept and idle", () => {
    expect(
      decideRemoval({ kind: "project", project: project({ worktrees: [worktree()] }) }),
    ).toEqual({ _tag: "Remove" });
  });

  it("refuses for a teammate's live session and a teammate's unlanded change, naming both", () => {
    const decision = decideRemoval({
      kind: "project",
      project: project({
        worktrees: [
          worktree({ standing: neverLanded }),
          worktree({
            worktreeId: WorktreeId.make("w-2"),
            name: "api-v2",
            changeOwner: kostas,
            sessions: [liveSession("s-9", kostas)],
          }),
        ],
      }),
    });
    expect(decision._tag).toBe("Refuse");
    if (decision._tag !== "Refuse") return;
    expect(decision.forceWouldLift).toBe(false);
    expect(decision.blockers).toEqual([
      expect.objectContaining({ _tag: "SessionLive", worktreeName: "api-v2", owner: kostas }),
      expect.objectContaining({ _tag: "Unlanded", worktreeName: "fix-auth", owner: anna }),
    ]);
  });

  it("refuses for a live session of another project holding it, and for declared resources", () => {
    const decision = decideRemoval({
      kind: "project",
      project: project({
        foreignHolders: [
          { sessionId: SessionId.make("s-x"), path: "repos/api", activity: "stopping" },
        ],
        resources: ["db"],
      }),
    });
    expect(refusedBlockers(decision)).toEqual(["HeldByOtherProject", "ResourcesDeclared"]);
  });

  it("ignores a settled holder from another project", () => {
    const decision = decideRemoval({
      kind: "project",
      project: project({
        foreignHolders: [
          { sessionId: SessionId.make("s-x"), path: "repos/api", activity: "settled" },
        ],
      }),
    });
    expect(decision._tag).toBe("Remove");
  });
});

describe("LIFTED_BY_FORCE", () => {
  it("lifts only work that is not on origin", () => {
    expect(
      Object.entries(LIFTED_BY_FORCE)
        .filter(([, lifted]) => lifted)
        .map(([tag]) => tag),
    ).toEqual(["Unlanded", "NestedRepositories"]);
  });
});

describe("worktreeRemovalRight (decisions Q4, Q7, Q8)", () => {
  it("lets only the change's proven owner remove the worktree", () => {
    expect(
      worktreeRemovalRight({
        callerUserId: "u-anna",
        changeOwner: anna,
        changeOwnerProven: true,
        managesProject: false,
        ownsEverySession: false,
      }),
    ).toEqual({ _tag: "allowed" });
    expect(
      worktreeRemovalRight({
        callerUserId: "u-kostas",
        changeOwner: anna,
        changeOwnerProven: true,
        managesProject: true,
        ownsEverySession: true,
      }),
    ).toEqual({ _tag: "not-change-owner", owner: anna });
  });

  it("keeps today's rule for a worktree with no owner, or one the history cannot prove", () => {
    for (const unproven of [
      { callerUserId: "u-kostas", changeOwner: null, changeOwnerProven: false },
      { callerUserId: "u-kostas", changeOwner: anna, changeOwnerProven: false },
    ]) {
      expect(
        worktreeRemovalRight({ ...unproven, managesProject: true, ownsEverySession: false }),
      ).toEqual({ _tag: "allowed" });
      expect(
        worktreeRemovalRight({ ...unproven, managesProject: false, ownsEverySession: true }),
      ).toEqual({ _tag: "allowed" });
      expect(
        worktreeRemovalRight({ ...unproven, managesProject: false, ownsEverySession: false }),
      ).toEqual({ _tag: "hidden" });
    }
  });
});

describe("hasProvenOwner (decision Q8)", () => {
  it("lets a client outside Mend ask only for a worktree whose first owner is proven", () => {
    expect(hasProvenOwner({ changeOwnerUserId: "u-anna", changeOwnerProven: true })).toBe(true);
    expect(hasProvenOwner({ changeOwnerUserId: "u-anna", changeOwnerProven: false })).toBe(false);
    expect(hasProvenOwner({ changeOwnerUserId: null, changeOwnerProven: false })).toBe(false);
  });
});

describe("fenceStep", () => {
  const now = new Date("2026-10-30T10:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const stale = REMOVAL_FENCE_LEASE_SECONDS + 1;

  it("takes a free fence, and a checking fence whose checker went quiet", () => {
    expect(fenceStep(null, now)).toEqual({ _tag: "acquire" });
    expect(fenceStep({ phase: "checking", since: ago(stale) }, now)).toEqual({ _tag: "acquire" });
  });

  it("refuses while another removal holds a fresh fence", () => {
    expect(fenceStep({ phase: "checking", since: ago(5) }, now)).toEqual({ _tag: "underway" });
    expect(fenceStep({ phase: "deleting", since: ago(5) }, now)).toEqual({ _tag: "underway" });
  });

  it("finishes a removal that passed its checks and stopped while deleting", () => {
    expect(fenceStep({ phase: "deleting", since: ago(stale) }, now)).toEqual({ _tag: "finish" });
  });
});

describe("worktreeRefusalWords", () => {
  const unlanded = (standing: UnlandedStanding): RemovalBlocker => ({
    _tag: "Unlanded",
    worktreeId: WorktreeId.make("w-1"),
    worktreeName: "fix-auth",
    owner: anna,
    standing,
  });

  it("says the decision Q3 sentence exactly for a no-remote change outside Mend", () => {
    expect(worktreeRefusalWords(refuse([unlanded(noRemote)], true), "outside-mend")).toBe(
      "This worktree has work that is not on any remote. Remove it from Mend if you mean to discard it.",
    );
    expect(NO_REMOTE_OUTSIDE_MEND).toBe(
      "This worktree has work that is not on any remote. Remove it from Mend if you mean to discard it.",
    );
  });

  it("keeps the Q3 sentence verbatim beside other blockers", () => {
    const words = worktreeRefusalWords(
      refuse([
        {
          _tag: "Saving",
          worktreeId: WorktreeId.make("w-1"),
          worktreeName: "fix-auth",
          holds: [{ sessionId: null, kind: "saving", via: "own" }],
        },
        unlanded(noRemote),
      ]),
      "outside-mend",
    );
    expect(words).toContain(NO_REMOTE_OUTSIDE_MEND);
    expect(words).toContain("still saving");
  });

  it("never offers force outside Mend", () => {
    for (const standing of [neverLanded, noRemote]) {
      expect(
        worktreeRefusalWords(refuse([unlanded(standing)], true), "outside-mend"),
      ).not.toContain("force");
    }
  });

  it("names the files in Mend and keeps the force hint old clients read", () => {
    const words = worktreeRefusalWords(refuse([unlanded(neverLanded)], true), "in-mend");
    expect(words).toBe(
      `This worktree holds a change that was never landed · ${describeUnlanded(neverLanded.files)}. Land it or discard it before removal, ${REMOVAL_FORCE_HINT}.`,
    );
    expect(worktreeRefusalWords(refuse([unlanded(neverLanded)], false), "in-mend")).not.toContain(
      REMOVAL_FORCE_HINT,
    );
  });

  it("has words for every blocker in both audiences", () => {
    const blockers: ReadonlyArray<RemovalBlocker> = [
      {
        _tag: "SessionLive",
        worktreeId: WorktreeId.make("w-1"),
        worktreeName: "fix-auth",
        sessionId: SessionId.make("s-1"),
        owner: kostas,
        role: "inhabitant",
        activity: "forward-open",
      },
      {
        _tag: "Saving",
        worktreeId: WorktreeId.make("w-1"),
        worktreeName: "fix-auth",
        holds: [{ sessionId: null, kind: "not-saved", via: "holder" }],
      },
      unlanded({
        _tag: "origin-moved",
        landed: { remoteBranch: "mend/fix-auth", sha: "3f2a1c0aa" },
        remoteSha: null,
      }),
      {
        _tag: "NestedRepositories",
        worktreeId: WorktreeId.make("w-1"),
        worktreeName: "fix-auth",
        repositories: [{ path: "core", branch: "main" }],
      },
      {
        _tag: "HeldByOtherProject",
        sessionId: SessionId.make("s-x"),
        path: "repos/api",
        activity: "live",
      },
      { _tag: "ResourcesDeclared", names: ["db"] },
      { _tag: "RemovalUnderway" },
    ];
    for (const blocker of blockers) {
      for (const audience of ["in-mend", "outside-mend"] as const) {
        expect(worktreeRefusalWords(refuse([blocker]), audience).length).toBeGreaterThan(20);
        expect(projectRefusalWords([blocker], audience).length).toBeGreaterThan(20);
      }
    }
  });
});

describe("projectRefusalWords", () => {
  it("names each blocking worktree and the people whose work it is (decision Q2)", () => {
    const words = projectRefusalWords(
      [
        {
          _tag: "SessionLive",
          worktreeId: WorktreeId.make("w-2"),
          worktreeName: "api-v2",
          sessionId: SessionId.make("s-9"),
          owner: kostas,
          role: "inhabitant",
          activity: "live",
        },
        {
          _tag: "Unlanded",
          worktreeId: WorktreeId.make("w-1"),
          worktreeName: "fix-auth",
          owner: anna,
          standing: neverLanded,
        },
      ],
      "outside-mend",
    );
    expect(words).toBe(
      "Mend kept this project. Kostas's session in api-v2 is live. fix-auth holds Anna's change, which is not on origin. Stop, land or remove those in Mend, then remove the project again.",
    );
  });
});

describe("owner words", () => {
  it("names who may remove the worktree", () => {
    expect(notChangeOwnerWords(anna, "outside-mend")).toBe(
      "Only Anna, who started this worktree's change, can remove it. Mend keeps it.",
    );
    expect(OWNERLESS_OUTSIDE_MEND).not.toContain("force");
  });
});

describe("RemovalBlocker on the wire", () => {
  it("round-trips through JSON", () => {
    const blocker: RemovalBlocker = {
      _tag: "Unlanded",
      worktreeId: WorktreeId.make("w-1"),
      worktreeName: "fix-auth",
      owner: null,
      standing: noRemote,
    };
    const codec = Schema.toCodecJson(RemovalBlocker);
    const wire = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(blocker)));
    expect(Schema.decodeUnknownSync(codec)(wire)).toEqual(blocker);
  });
});
