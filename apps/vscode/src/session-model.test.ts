import { describe, expect, it } from "vitest";

import {
  clockTime,
  mergeLastSeen,
  othersLine,
  ownLine,
  seen,
  sessionModel,
  transitions,
  type Attention,
  type LandingFact,
  type ModelInput,
  type Notification,
  type WaitFact,
  type WindowModel,
} from "./session-model.js";
import type { Project, Session } from "./types.js";

const NOW = new Date("2026-10-19T09:00:00.000Z");
const YESTERDAY = "2026-10-18T18:00:00.000Z";

const project = (id: string, name = id): Project => ({
  id,
  name,
  originUrl: null,
  storePath: `/store/${id}`,
  defaultBranch: "main",
});

const newsroom = project("p1", "newsroom-api");

const session = (overrides: Partial<Session> & Pick<Session, "id">): Session => ({
  projectId: newsroom.id,
  harness: "claude",
  model: null,
  label: overrides.id,
  worktree: overrides.id,
  branch: `mend/${overrides.id}`,
  status: "running",
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-18T20:00:00.000Z",
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  ...overrides,
});

const waitFor = (since: string, words = "claude needs your permission to use Bash"): WaitFact => ({
  key: since,
  words,
  since,
  via: "terminal",
});

const input = (
  sessions: ReadonlyArray<Session>,
  overrides: Partial<ModelInput> = {},
): ModelInput => {
  const projects = overrides.projects ?? [newsroom];
  return {
    projects,
    details: projects.map((candidate) => ({
      project: candidate,
      sessions: sessions.filter((one) => one.projectId === candidate.id),
    })),
    viewer: "dana",
    members: [
      { userId: "dana", name: "Dana" },
      { userId: "ana", name: "Ana" },
    ],
    waits: new Map(),
    landings: new Map(),
    lastSeen: { baseline: YESTERDAY, sessions: {} },
    connection: { state: "online", lastHeardAt: NOW.toISOString() },
    window: { kind: "local" },
    now: NOW,
    ...overrides,
  };
};

const local = (model: WindowModel) => {
  if (model.kind !== "local") throw new Error("expected the local model");
  return model;
};

const rowsOf = (model: WindowModel) =>
  local(model).groups.map((group) =>
    group.kind === "projects"
      ? { group: group.kind, rows: group.projects.map((one) => one.project.name) }
      : { group: group.kind, rows: group.rows.map((row) => `${row.name} · ${row.line}`) },
  );

const looking: Attention = { focused: true, showing: new Set(), raised: new Set() };

const toasts = (notifications: ReadonlyArray<Notification>) =>
  notifications.flatMap((one) =>
    one.kind !== "withdrawn" && one.quiet === null ? [one.text] : [],
  );

describe("the morning after (story f)", () => {
  const since0214 = "2026-10-19T02:14:00.000Z";
  const overnight = [
    session({ id: "migrate-orders", status: "waiting" }),
    session({
      id: "add-rate-limit",
      status: "completed",
      summary: "4 files",
      settledAt: "2026-10-19T01:00:00.000Z",
    }),
    session({
      id: "flaky-auth-test",
      status: "failed",
      summary: "exit 1 at 03:40",
      settledAt: "2026-10-19T03:40:00.000Z",
    }),
    session({ id: "docs-typos", status: "completed", settledAt: "2026-10-18T23:00:00.000Z" }),
  ];
  const landing: LandingFact = {
    id: "l1",
    userId: "dana",
    createdAt: "2026-10-18T23:30:00.000Z",
    remoteBranch: "mend/docs-typos",
    pullRequest: { number: 412, state: "open" },
  };
  const model = sessionModel(
    input(overnight, {
      waits: new Map([["migrate-orders", waitFor(since0214, "approve schema change?")]]),
      landings: new Map([["docs-typos", landing]]),
    }),
  );

  it("groups Needs you, Since you last looked, then Projects, in the stories' words", () => {
    expect(rowsOf(model)).toEqual([
      {
        group: "needs",
        rows: [`migrate-orders · waiting · approve schema change? · since ${clockTime(since0214)}`],
      },
      {
        group: "since",
        rows: [
          "flaky-auth-test · failed · exit 1 at 03:40",
          "add-rate-limit · completed · observed · 4 files",
          "docs-typos · landed · pull request #412 · open · observed",
        ],
      },
      { group: "projects", rows: ["newsroom-api"] },
    ]);
  });

  it("badges what needs her and says the rest in the status bar", () => {
    expect(model.badge).toBe(1);
    expect(model.statusBar.text).toBe("Mend · 1 needs you · 2 finished");
  });

  it("names who landed a session when it was someone else", () => {
    const byAna = sessionModel(
      input(overnight, {
        landings: new Map([
          [
            "docs-typos",
            { ...landing, userId: "ana", pullRequest: { number: 415, state: "merged" } },
          ],
        ]),
      }),
    );
    expect(byAna.sessions.get("docs-typos")?.line).toBe(
      "landed by Ana · pull request #415 · merged · observed",
    );
  });

  it("leaves out what settled before this VS Code first read the server", () => {
    const fresh = sessionModel(
      input(overnight, {
        lastSeen: { baseline: "2026-10-19T08:00:00.000Z", sessions: {} },
        waits: new Map([["migrate-orders", waitFor(since0214)]]),
      }),
    );
    expect(local(fresh).groups.map((group) => group.kind)).toEqual(["needs", "projects"]);
  });

  it("groups Since you last looked by project after 8 rows", () => {
    const mend = project("p2", "mend");
    const many = Array.from({ length: 9 }, (_, index) =>
      session({
        id: `done-${index}`,
        projectId: index < 6 ? newsroom.id : mend.id,
        status: "completed",
        settledAt: `2026-10-19T0${index}:00:00.000Z`,
      }),
    );
    const grouped = local(sessionModel(input(many, { projects: [newsroom, mend] })));
    const since = grouped.groups.find((group) => group.kind === "since");
    expect(
      since?.kind === "since" &&
        since.byProject?.map((one) => `${one.project.name} ${one.rows.length}`),
    ).toEqual(["newsroom-api 6", "mend 3"]);
    const eight = local(sessionModel(input(many.slice(0, 8))));
    const notGrouped = eight.groups.find((group) => group.kind === "since");
    expect(notGrouped?.kind === "since" && notGrouped.byProject).toBeNull();
  });
});

describe("Since you last looked (Decided 3)", () => {
  it("merges two windows' records: the later look per session, the earlier baseline", () => {
    expect(
      mergeLastSeen(
        { baseline: "2026-10-18T10:00:00.000Z", sessions: { a: "2026-10-19T08:00:00.000Z" } },
        {
          baseline: "2026-10-18T12:00:00.000Z",
          sessions: { a: "2026-10-19T07:00:00.000Z", b: "2026-10-19T06:00:00.000Z" },
        },
      ),
    ).toEqual({
      baseline: "2026-10-18T10:00:00.000Z",
      sessions: { a: "2026-10-19T08:00:00.000Z", b: "2026-10-19T06:00:00.000Z" },
    });
  });

  it("reads a turn that settled after the session's last landing as that turn, not the landing", () => {
    const resumed = session({
      id: "docs-typos",
      status: "completed",
      settledAt: "2026-10-19T08:00:00.000Z",
    });
    const model = sessionModel(
      input([resumed], {
        landings: new Map([
          [
            "docs-typos",
            {
              id: "l1",
              userId: "dana",
              createdAt: "2026-10-19T01:00:00.000Z",
              remoteBranch: "mend/docs-typos",
              pullRequest: { number: 412, state: "open" },
            },
          ],
        ]),
      }),
    );
    expect(model.sessions.get("docs-typos")).toMatchObject({
      word: "completed",
      sinceYouLastLooked: true,
    });
  });

  const done = session({
    id: "add-rate-limit",
    status: "completed",
    settledAt: "2026-10-19T08:00:00.000Z",
  });

  it("drops a session she viewed after it settled", () => {
    const before = sessionModel(input([done]));
    expect(before.sessions.get(done.id)?.sinceYouLastLooked).toBe(true);
    const viewed = seen(
      { baseline: YESTERDAY, sessions: {} },
      [done.id],
      new Date("2026-10-19T08:30:00.000Z"),
    );
    const after = sessionModel(input([done], { lastSeen: viewed }));
    expect(after.sessions.get(done.id)?.sinceYouLastLooked).toBe(false);
    expect(local(after).groups.map((group) => group.kind)).toEqual(["projects"]);
    expect(after.statusBar.text).toBe("Mend");
  });

  it("keeps a session she viewed while it still ran", () => {
    const viewedWhileRunning = seen(
      { baseline: YESTERDAY, sessions: {} },
      [done.id],
      new Date("2026-10-19T07:00:00.000Z"),
    );
    const model = sessionModel(input([done], { lastSeen: viewedWhileRunning }));
    expect(model.sessions.get(done.id)?.sinceYouLastLooked).toBe(true);
  });
});

describe("the badge (rule 15)", () => {
  it("does not count a running session", () => {
    const model = sessionModel(input([session({ id: "add-rate-limit", status: "running" })]));
    expect(model.badge).toBe(0);
    expect(model.statusBar.text).toBe("Mend · 1 running");
  });

  it("does not count Ana's waiting session while she has shared control off", () => {
    const anas = session({ id: "anas", status: "waiting", ownerUserId: "ana" });
    const model = sessionModel(input([anas], { waits: new Map([["anas", waitFor(YESTERDAY)]]) }));
    expect(model.badge).toBe(0);
    expect(model.sessions.get("anas")?.line).toBe("waiting · Ana's session");
    expect(rowsOf(model)[0]).toEqual({
      group: "running",
      rows: ["anas · waiting · Ana's session"],
    });
  });

  const sharedByAna = session({
    id: "anas",
    status: "waiting",
    ownerUserId: "ana",
    sharedControlEnabledAt: YESTERDAY,
  });

  const request: WaitFact = {
    key: "r1",
    words: "run pnpm db:migrate?",
    since: YESTERDAY,
    via: "conversation",
  };

  it("does not count Ana's conversation even with shared control on: Answer gives Dana a read-only tab", () => {
    const model = sessionModel(input([sharedByAna], { waits: new Map([["anas", request]]) }));
    expect(model.badge).toBe(0);
    expect(model.sessions.get("anas")?.needsYou).toBe(false);
    expect(model.sessions.get("anas")?.line).toBe("waiting · Ana's session");
  });

  it("counts her own conversation's request: Answer offers her Continue here", () => {
    const mine = session({ id: "mine", status: "waiting" });
    const model = sessionModel(input([mine], { waits: new Map([["mine", request]]) }));
    expect(model.badge).toBe(1);
    expect(model.sessions.get("mine")?.line).toBe(
      `waiting · run pnpm db:migrate? · since ${clockTime(YESTERDAY)}`,
    );
  });

  it("does not count Ana's terminal agent waiting even with shared control on: only Ana types in it", () => {
    const model = sessionModel(
      input([sharedByAna], { waits: new Map([["anas", waitFor(YESTERDAY)]]) }),
    );
    expect(model.badge).toBe(0);
    expect(model.sessions.get("anas")?.line).toBe("waiting · Ana's session");
  });

  it("does not count her own terminal agent in a workspace Ana launched: Answer attaches nothing there", () => {
    const inAnas = session({ id: "mine", status: "waiting", workspaceLauncherUserId: "ana" });
    const model = sessionModel(input([inAnas], { waits: new Map([["mine", waitFor(YESTERDAY)]]) }));
    expect(model.badge).toBe(0);
    expect(model.sessions.get("mine")?.line).toBe(
      "waiting · claude needs your permission to use Bash",
    );
  });

  it("counts nothing, and calls nothing hers, when Mend could not read who she is", () => {
    const waiting = session({ id: "add-rate-limit", status: "waiting" });
    const unknown = sessionModel(
      input([waiting], { viewer: null, waits: new Map([["add-rate-limit", waitFor(YESTERDAY)]]) }),
    );
    expect(unknown.badge).toBe(0);
    expect(unknown.sessions.get("add-rate-limit")?.mine).toBe(false);
  });

  it("counts a waiting session only once Mend observed why it waits", () => {
    const waiting = session({ id: "add-rate-limit", status: "waiting" });
    expect(sessionModel(input([waiting])).badge).toBe(0);
    expect(
      sessionModel(input([waiting], { waits: new Map([["add-rate-limit", waitFor(YESTERDAY)]]) }))
        .badge,
    ).toBe(1);
  });
});

describe("a terminal agent that finished its turn (idle, #1089)", () => {
  const finishedTurn: WaitFact = {
    key: "2026-10-19T08:59:00.000Z",
    words: "claude finished its turn",
    since: "2026-10-19T08:59:00.000Z",
    via: "terminal",
  };
  const running = session({ id: "add-rate-limit", status: "running" });
  const idle = session({ id: "add-rate-limit", status: "idle" });
  const read = (one: Session) =>
    sessionModel(input([one], { waits: new Map([[one.id, finishedTurn]]) }));

  it("reads in G4's words under Running: not Needs you, no badge, not Since you last looked", () => {
    const model = read(idle);
    expect(model.sessions.get(idle.id)).toMatchObject({
      line: "idle · claude finished its turn",
      needsYou: false,
      sinceYouLastLooked: false,
    });
    expect(model.badge).toBe(0);
    expect(rowsOf(model)[0]).toEqual({
      group: "running",
      rows: ["add-rate-limit · idle · claude finished its turn"],
    });
    expect(model.statusBar.text).toBe("Mend · 1 running");
  });

  it("toasts nothing when a turn finishes", () => {
    expect(transitions(read(running), read(idle), looking)).toEqual([]);
  });
});

describe("toasts (rules 12-14)", () => {
  const running = session({ id: "add-rate-limit", status: "running" });
  const waiting = session({ id: "add-rate-limit", status: "waiting" });
  const wait = waitFor("2026-10-19T08:59:00.000Z");
  const asRead = (one: Session, waits = new Map<string, WaitFact>()) =>
    sessionModel(input([one], { waits }));
  const waitingRead = asRead(waiting, new Map([[waiting.id, wait]]));

  it("toasts a new wait in the focused window that is not showing it", () => {
    expect(toasts(transitions(asRead(running), waitingRead, looking))).toEqual([
      "add-rate-limit is waiting · claude needs your permission to use Bash",
    ]);
  });

  it("stays quiet in a window that is not focused, or that shows the session", () => {
    const unfocused = transitions(asRead(running), waitingRead, { ...looking, focused: false });
    expect(unfocused.map((one) => one.kind !== "withdrawn" && one.quiet)).toEqual(["unfocused"]);
    const showing = transitions(asRead(running), waitingRead, {
      ...looking,
      showing: new Set([waiting.id]),
    });
    expect(showing.map((one) => one.kind !== "withdrawn" && one.quiet)).toEqual(["showing"]);
  });

  it("raises nothing to toast on the first read", () => {
    const first = transitions(null, waitingRead, looking);
    expect(toasts(first)).toEqual([]);
    expect(first.map((one) => one.kind !== "withdrawn" && one.quiet)).toEqual(["already-there"]);
  });

  it("does not toast twice when the same wait flips waiting, running, waiting", () => {
    const raised = new Set<string>();
    const raise = (prev: WindowModel, next: WindowModel) => {
      const notified = transitions(prev, next, { ...looking, raised });
      for (const one of notified) if (one.kind !== "withdrawn") raised.add(one.key);
      return toasts(notified);
    };
    expect(raise(asRead(running), waitingRead)).toHaveLength(1);
    expect(raise(waitingRead, asRead(running))).toEqual([]);
    expect(raise(asRead(running), waitingRead)).toEqual([]);
    const nextWait = asRead(waiting, new Map([[waiting.id, waitFor("2026-10-19T09:10:00.000Z")]]));
    expect(raise(asRead(running), nextWait)).toHaveLength(1);
  });

  it("raises nothing for a wait Mend has no fact for, then one toast once it reads why", () => {
    const unknown = asRead(waiting);
    expect(transitions(asRead(running), unknown, looking)).toEqual([]);
    expect(toasts(transitions(unknown, waitingRead, looking))).toEqual([
      "add-rate-limit is waiting · claude needs your permission to use Bash",
    ]);
  });

  it("toasts no one for a finished session when Mend could not read who she is", () => {
    const unknownViewer = (one: Session) => sessionModel(input([one], { viewer: null }));
    const completed = session({
      id: "add-rate-limit",
      status: "completed",
      settledAt: NOW.toISOString(),
    });
    expect(transitions(unknownViewer(running), unknownViewer(completed), looking)).toEqual([]);
  });

  it("withdraws a wait answered elsewhere", () => {
    expect(transitions(waitingRead, asRead(running), looking)).toEqual([
      { kind: "withdrawn", key: `${waiting.id}:wait:${wait.key}`, sessionId: waiting.id },
    ]);
  });

  it("toasts a session she started that finished, not one she watched start or Ana's", () => {
    const completed = session({
      id: "add-rate-limit",
      status: "completed",
      summary: "4 files",
      settledAt: NOW.toISOString(),
    });
    expect(toasts(transitions(asRead(running), asRead(completed), looking))).toEqual([
      "add-rate-limit finished · 4 files",
    ]);
    const starting = session({ id: "add-rate-limit", status: "starting" });
    expect(transitions(null, asRead(starting), looking)).toEqual([]);
    expect(transitions(asRead(starting), asRead(running), looking)).toEqual([]);
    const anas = { ...completed, ownerUserId: "ana" };
    expect(transitions(asRead({ ...running, ownerUserId: "ana" }), asRead(anas), looking)).toEqual(
      [],
    );
    expect(transitions(asRead(completed), asRead(completed), looking)).toEqual([]);
  });
});

describe("a session's workspace window (rule 10)", () => {
  const sessions = [
    session({ id: "add-rate-limit", status: "running", summary: "editing src/auth/limit.ts" }),
    session({ id: "migrate-orders", status: "waiting" }),
    session({ id: "docs-typos", status: "running" }),
    session({ id: "old", status: "stopped" }),
  ];
  const model = sessionModel(
    input(sessions, {
      window: { kind: "workspace", sessionId: "add-rate-limit" },
      waits: new Map([["migrate-orders", waitFor(YESTERDAY)]]),
    }),
  );

  it("shows that session only, and one line for the others", () => {
    if (model.kind !== "workspace") throw new Error("expected the workspace model");
    expect(model.session?.line).toBe("running · editing src/auth/limit.ts");
    expect(othersLine(model.others)).toBe("2 other sessions · 1 needs you");
    expect(othersLine({ count: 0, needsYou: 0 })).toBe("no other sessions");
    expect(model.statusBar).toMatchObject({ text: "add-rate-limit · running", dot: "running" });
    expect("groups" in model).toBe(false);
  });
});

describe("offline (stories f and b)", () => {
  const lastHeardAt = "2026-10-19T08:58:00.000Z";
  const sessions = [
    session({ id: "add-rate-limit", status: "running", summary: "reading src/auth" }),
    session({ id: "migrate-orders", status: "waiting" }),
  ];
  const model = sessionModel(
    input(sessions, {
      connection: { state: "offline", lastHeardAt },
      waits: new Map([["migrate-orders", waitFor(lastHeardAt)]]),
    }),
  );

  it("keeps the rows Mend last reported and says when it was last heard", () => {
    expect(rowsOf(model)).toEqual([
      {
        group: "needs",
        rows: [
          `migrate-orders · waiting · claude needs your permission to use Bash · since ${clockTime(lastHeardAt)} · last seen 2 min ago`,
        ],
      },
      {
        group: "running",
        rows: ["add-rate-limit · running · reading src/auth · last seen 2 min ago"],
      },
      { group: "projects", rows: ["newsroom-api"] },
    ]);
    expect(model.message).toBe(`last heard from Mend at ${clockTime(lastHeardAt)}`);
    expect(model.statusBar.text).toBe(`Mend · last heard at ${clockTime(lastHeardAt)}`);
    expect(model.offline).toBe(true);
  });
});

describe("a session the model has not read yet (N2)", () => {
  it("reads <word> · <fact> from the session alone", () => {
    expect(ownLine(session({ id: "a", status: "completed", summary: "4 files\nmore" }))).toBe(
      "completed · observed · 4 files",
    );
    expect(ownLine(session({ id: "b", status: "completed" }))).toBe("completed · observed");
    expect(ownLine(session({ id: "c", status: "running", summary: "reading src/auth" }))).toBe(
      "running · reading src/auth",
    );
    expect(ownLine(session({ id: "d", status: "waiting" }))).toBe("waiting");
  });
});
