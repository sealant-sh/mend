import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SessionId, WorktreeId } from "../ids.ts";
import {
  decideRemoval,
  describeUnlanded,
  LIFTED_BY_FORCE,
  NO_REMOTE_OUTSIDE_MEND,
  notChangeOwnerWords,
  OWNERLESS_OUTSIDE_MEND,
  type ProjectFacts,
  projectRefusalWords,
  REMOVAL_FORCE_HINT,
  RemovalBlocker,
  underwayWith,
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
  setupRunning: false,
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
      `Mend could not read this worktree's change · git diff failed. Try again. ${REMOVAL_FORCE_HINT}`,
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

  it("names a session holding a worktree, while resources no longer block removal", () => {
    const holder = {
      ...liveSession("s-x", kostas),
      role: "holder" as const,
      activity: "stopping" as const,
    };
    const decision = decideRemoval({
      kind: "project",
      project: project({ worktrees: [worktree({ sessions: [holder] })], resources: ["db"] }),
    });
    expect(refusedBlockers(decision)).toEqual(["SessionLive"]);
    if (decision._tag !== "Refuse") return;
    expect(projectRefusalWords(decision.blockers, "in-mend")).toBe(
      "not removed · Kostas's session holding fix-auth is stopping · stop, land or remove those first, then remove the project again.",
    );
  });

  it("refuses for a starting session, a linked project's session and a running Service setup", () => {
    const decision = decideRemoval({
      kind: "project",
      project: project({
        worktrees: [
          worktree({
            setupRunning: true,
            sessions: [
              { ...liveSession("s-1"), activity: "starting" },
              { ...liveSession("s-2", kostas), role: "linked" },
            ],
          }),
        ],
      }),
    });
    expect(refusedBlockers(decision)).toEqual(["SessionLive", "SessionLive", "SetupRunning"]);
  });

  it("ignores a settled session of another project", () => {
    const decision = decideRemoval({
      kind: "project",
      project: project({
        worktrees: [
          worktree({ sessions: [{ ...liveSession("s-x"), role: "holder", activity: "settled" }] }),
        ],
      }),
    });
    expect(decision._tag).toBe("Remove");
  });
});

describe("a removal that meets another", () => {
  it("lists the other first, with every blocker of its own", () => {
    const decision = decideRemoval({
      kind: "worktree",
      force: false,
      worktree: worktree({ standing: neverLanded }),
    });
    expect(underwayWith(null, decision).map((blocker) => blocker._tag)).toEqual([
      "RemovalUnderway",
      "Unlanded",
    ]);
  });

  it("says a deletion that stopped partway is finished by removing it again", () => {
    const stopped = underwayWith({ kind: "project", name: "api" }, { _tag: "Remove" });
    expect(worktreeRefusalWords(refuse(stopped), "in-mend")).toBe(
      "not removed · the removal of project api stopped partway · remove that project again to finish it.",
    );
    expect(worktreeRefusalWords(refuse(stopped), "outside-mend")).toBe(
      "Mend started removing project api and stopped partway. Remove it again from Mend to finish.",
    );
    expect(
      projectRefusalWords(
        underwayWith({ kind: "worktree", name: "fix-auth" }, { _tag: "Remove" }),
        "in-mend",
      ),
    ).toBe(
      "not removed · the removal of worktree fix-auth stopped partway, so remove that worktree again first · stop, land or remove those first, then remove the project again.",
    );
  });
});

describe("LIFTED_BY_FORCE", () => {
  it("lifts only work that is not on origin", () => {
    expect(
      Object.entries(LIFTED_BY_FORCE)
        .filter(([, lifted]) => lifted)
        .map(([tag]) => tag),
    ).toEqual(["Unlanded", "NestedRepositories"]);
    expect(LIFTED_BY_FORCE.SetupRunning).toBe(false);
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

  it("names the files in Mend, and says force once when it lifts every blocker", () => {
    const words = worktreeRefusalWords(refuse([unlanded(neverLanded)], true), "in-mend");
    expect(words).toBe(
      `This worktree holds a change that was never landed · ${describeUnlanded(neverLanded.files)}. Land it or discard it before removal. ${REMOVAL_FORCE_HINT}`,
    );
    const nested: RemovalBlocker = {
      _tag: "NestedRepositories",
      worktreeId: WorktreeId.make("w-1"),
      worktreeName: "fix-auth",
      repositories: [{ path: "core", branch: "main" }],
    };
    const both = worktreeRefusalWords(refuse([unlanded(neverLanded), nested], true), "in-mend");
    expect(both.split(REMOVAL_FORCE_HINT)).toHaveLength(2);
    expect(both.endsWith(REMOVAL_FORCE_HINT)).toBe(true);
    expect(both).not.toContain("Push what you need");
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
        _tag: "SessionLive",
        worktreeId: WorktreeId.make("w-1"),
        worktreeName: "fix-auth",
        sessionId: SessionId.make("s-2"),
        owner: null,
        role: "linked",
        activity: "starting",
      },
      { _tag: "SetupRunning", worktreeId: WorktreeId.make("w-1"), worktreeName: "fix-auth" },
      { _tag: "ResourcesDeclared", names: ["db"] },
      { _tag: "RemovalUnderway", stopped: null },
      { _tag: "RemovalUnderway", stopped: { kind: "worktree", name: "fix-auth" } },
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
