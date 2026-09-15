import { describe, expect, it } from "vitest";

import {
  advanceFromBase,
  baseStepNotice,
  clampIndex,
  createLaunchGate,
  deriveWorktrees,
  filterBranches,
  foldGroupStatus,
  fitHints,
  groupActivityAt,
  groupBaseLabel,
  KEY_BINDINGS,
  isDeadEnd,
  liveProtocolOf,
  liveShellOf,
  markSessionStopped,
  NAV_SECTIONS,
  planAttach,
  planLayout,
  planResume,
  removeWorktreeGroup,
  sessionDisplayName,
  stepColumn,
  verbForKey,
  verbHints,
  type BranchDto,
  type Column,
  type CreatingState,
  type NavSection,
  type ProjectDetailDto,
  type SessionDto,
  type SessionProcessDto,
  type Workbench,
  type WorktreeDto,
} from "./dashboard-model.ts";

const session = (over: Partial<SessionDto> & { readonly id: string }): SessionDto => ({
  harness: "claude",
  label: null,
  branch: `mend/session/${over.id}`,
  baseSha: "abc",
  baseRef: "main",
  status: "completed",
  summary: null,
  createdAt: "2026-08-31T10:00:00.000Z",
  ...over,
});

const worktree = (over: Partial<WorktreeDto> & { readonly id: string }): WorktreeDto => ({
  name: over.id,
  directory: over.id,
  branch: `mend/${over.id}`,
  baseSha: "abc",
  baseRef: "main",
  createdAt: "2026-08-31T09:00:00.000Z",
  ...over,
});

const workbench = (detail: ProjectDetailDto): Workbench => ({
  projects: [detail.project],
  details: new Map([[detail.project.id, detail]]),
  servicesBySession: new Map(),
  processesBySession: new Map(),
});

const project = {
  id: "proj-1",
  name: "fixture",
  originUrl: null,
  storePath: "/store",
  defaultBranch: "main",
};

describe("deriveWorktrees", () => {
  it("groups sessions under their real worktrees when the server sends them", () => {
    const data = workbench({
      project,
      sessions: [
        session({ id: "a", worktreeId: "wt-1", status: "running" }),
        session({ id: "b", worktreeId: "wt-1", status: "waiting" }),
        session({ id: "c", worktreeId: "wt-2" }),
      ],
      annotations: [{ sessionId: "a", changeId: "chg-1", openComments: 2, pendingFollowUp: false }],
      worktrees: [
        worktree({ id: "wt-1", name: "fix-auth" }),
        worktree({ id: "wt-2", name: "docs" }),
      ],
    });
    const groups = deriveWorktrees(data, "proj-1");
    expect(groups.map((group) => [group.name, group.sessions.length, group.live])).toEqual([
      ["fix-auth", 2, 2],
      ["docs", 1, 0],
    ]);
    // The change facts ride the group whichever member carried them.
    expect(groups[0]?.annotation?.changeId).toBe("chg-1");
    expect(foldGroupStatus(groups[0]!)).toBe("waiting");
  });

  it("hides a settled session that never had a conversation, keeps unknown and live ones", () => {
    const data = workbench({
      project,
      sessions: [
        session({ id: "dead", worktreeId: "wt-1", status: "completed", hasTranscript: false }),
        session({ id: "unknown", worktreeId: "wt-1", status: "completed", hasTranscript: null }),
        session({ id: "live", worktreeId: "wt-1", status: "running", hasTranscript: false }),
        session({ id: "kept", worktreeId: "wt-1", status: "completed", hasTranscript: true }),
      ],
      annotations: [],
      worktrees: [worktree({ id: "wt-1", name: "fix-auth" })],
    });
    const ids = deriveWorktrees(data, "proj-1").flatMap((g) => g.sessions.map((i) => i.session.id));
    expect(ids).not.toContain("dead");
    expect(ids.toSorted()).toEqual(["kept", "live", "unknown"]);
    expect(isDeadEnd({ status: "completed", hasTranscript: false })).toBe(true);
    expect(isDeadEnd({ status: "idle", hasTranscript: false })).toBe(false);
  });

  it("degrades to one pseudo group per session against a pre-worktree server", () => {
    const data = workbench({
      project,
      sessions: [session({ id: "a", branch: "mend/fix-auth" }), session({ id: "b" })],
      annotations: [{ sessionId: "b", changeId: "chg-2", openComments: 0, pendingFollowUp: true }],
    });
    const groups = deriveWorktrees(data, "proj-1");
    expect(groups.map((group) => [group.id, group.name])).toEqual([
      [null, "fix-auth"],
      [null, "session b"],
    ]);
    // Pseudo groups keep their session's review facts.
    expect(groups[1]?.annotation?.changeId).toBe("chg-2");
  });

  it("keeps an optimistic pending session visible before its worktree exists", () => {
    const data = workbench({
      project,
      sessions: [session({ id: "pending:1", status: "starting" })],
      annotations: [],
      worktrees: [],
    });
    const groups = deriveWorktrees(data, "proj-1");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBeNull();
  });

  it("calls an anonymous worktree by its members' auto-name label", () => {
    const data = workbench({
      project,
      sessions: [
        session({ id: "a", worktreeId: "wt-9", label: "reaper retry storm", status: "running" }),
      ],
      annotations: [],
      worktrees: [worktree({ id: "wt-9", name: "wt-9", branch: "mend/wt/wt-9" })],
    });
    expect(deriveWorktrees(data, "proj-1")[0]?.name).toBe("reaper retry storm");
  });
});

describe("worktree row facts", () => {
  it("names the base it forked from and when it last saw a conversation", () => {
    const groups = deriveWorktrees(
      workbench({
        project,
        sessions: [
          session({ id: "a", worktreeId: "wt-1", createdAt: "2026-08-31T10:00:00.000Z" }),
          session({ id: "b", worktreeId: "wt-1", createdAt: "2026-08-31T12:00:00.000Z" }),
        ],
        annotations: [],
        worktrees: [worktree({ id: "wt-1", name: "fix-auth", baseRef: "release/1.2" })],
      }),
      "proj-1",
    );
    const group = groups[0]!;
    expect(groupBaseLabel(group)).toBe("release/1.2");
    // The newest conversation is the activity fact, whatever the sort order is.
    expect(groupActivityAt(group)).toBe("2026-08-31T12:00:00.000Z");
  });

  it("falls back to the base sha, and says so when there is not even one", () => {
    const groups = deriveWorktrees(
      workbench({
        project,
        sessions: [session({ id: "a", worktreeId: "wt-1", baseSha: "0123456789abcdef" })],
        annotations: [],
        worktrees: [worktree({ id: "wt-1", name: "fix-auth", baseRef: null })],
      }),
      "proj-1",
    );
    expect(groupBaseLabel(groups[0]!)).toBe("0123456");
    const empty = deriveWorktrees(
      workbench({
        project,
        sessions: [],
        annotations: [],
        worktrees: [worktree({ id: "wt-2", name: "empty", baseRef: null })],
      }),
      "proj-1",
    );
    expect(groupBaseLabel(empty[0]!)).toBe("base unknown");
  });
});

describe("sessionDisplayName", () => {
  it("leads with the label and keeps the machine id as the fallback", () => {
    expect(sessionDisplayName(session({ id: "abcdef1234", label: "rewrite the reaper" }))).toBe(
      "rewrite the reaper",
    );
    expect(sessionDisplayName(session({ id: "abcdef1234", harness: "codex" }))).toBe(
      "codex abcdef12",
    );
  });

  it("never shows a pending key as if it were a session id", () => {
    expect(sessionDisplayName(session({ id: "pending:9f2c", harness: "claude" }))).toBe(
      "claude · starting",
    );
  });
});

const proc = (over: Partial<SessionProcessDto> & { readonly id: string }): SessionProcessDto => ({
  kind: "shell",
  harness: null,
  label: null,
  status: "running",
  exitedAt: null,
  ...over,
});

describe("liveShellOf", () => {
  it("reattaches to the newest LIVE shell instead of stacking a new one", () => {
    const processes = [
      proc({
        id: "agent",
        kind: "agent-pty",
        harness: "codex",
        exitedAt: "2026-08-31T10:00:00Z",
        status: "exited",
      }),
      proc({ id: "shell-1" }),
      proc({ id: "shell-2", exitedAt: "2026-08-31T11:00:00Z", status: "exited" }),
    ];
    expect(liveShellOf(processes)?.id).toBe("shell-1");
  });

  it("answers null when nothing live is attachable — a NEW shell is then honest", () => {
    expect(
      liveShellOf([proc({ id: "s", exitedAt: "2026-08-31T11:00:00Z", status: "exited" })]),
    ).toBeNull();
    expect(liveShellOf([])).toBeNull();
  });
});

describe("liveProtocolOf", () => {
  it("finds the live protocol agent so a terminal can take the pickup over", () => {
    const processes = [
      proc({
        id: "pty",
        kind: "agent-pty",
        harness: "claude",
        exitedAt: "2026-09-01T10:39:16Z",
        status: "stopped",
      }),
      proc({ id: "protocol", kind: "agent-protocol", harness: "claude", status: "running" }),
    ];
    expect(liveProtocolOf(processes)?.id).toBe("protocol");
  });

  it("answers null when no protocol agent is live — a shell fallback stays honest", () => {
    expect(
      liveProtocolOf([
        proc({
          id: "protocol",
          kind: "agent-protocol",
          exitedAt: "2026-09-01T11:14:09Z",
          status: "stopped",
        }),
        proc({ id: "shell-1" }),
      ]),
    ).toBeNull();
    expect(liveProtocolOf([])).toBeNull();
  });
});

describe("planAttach", () => {
  it("attaches a live conversation that has a terminal", () => {
    expect(planAttach(session({ id: "a", status: "running" }))).toEqual({
      kind: "attach",
      session: session({ id: "a", status: "running" }),
    });
  });

  it("reports a starting session — the workspace has no PTY yet, so an attach would bounce", () => {
    expect(planAttach(session({ id: "boot", status: "starting" })).kind).toBe("starting");
  });

  it("NEVER resumes a settled session: attach reports it settled and leaves it alone", () => {
    expect(planAttach(session({ id: "done", status: "completed" })).kind).toBe("settled");
    expect(planAttach(session({ id: "dead", status: "failed" })).kind).toBe("settled");
  });

  it("holds off on a row the server has not answered for yet", () => {
    expect(planAttach(session({ id: "pending:1", status: "starting" })).kind).toBe("pending");
    expect(planAttach(null)).toEqual({ kind: "none" });
  });
});

describe("planResume", () => {
  it("resumes only what has settled", () => {
    expect(planResume(session({ id: "done", status: "completed" }))).toEqual({
      kind: "resume",
      session: session({ id: "done", status: "completed" }),
    });
  });

  it("refuses to restart a live conversation from under the agent working in it", () => {
    for (const status of ["starting", "running", "waiting", "idle"]) {
      expect(planResume(session({ id: "live", status })).kind).toBe("live");
    }
  });

  it("holds off on a pending row and on no selection at all", () => {
    expect(planResume(session({ id: "pending:1", status: "completed" })).kind).toBe("pending");
    expect(planResume(null)).toEqual({ kind: "none" });
  });
});

describe("createLaunchGate", () => {
  it("lets exactly one caller through per key until it is released", () => {
    const gate = createLaunchGate();
    expect(gate.take("resume:a")).toBe(true);
    // The held key repeat, the double enter: refused without a round trip.
    expect(gate.take("resume:a")).toBe(false);
    expect(gate.held("resume:a")).toBe(true);
    // A different session is unaffected — the guard is per intention.
    expect(gate.take("resume:b")).toBe(true);
    expect(gate.count()).toBe(2);
    gate.release("resume:a");
    expect(gate.held("resume:a")).toBe(false);
    expect(gate.take("resume:a")).toBe(true);
  });

  it("releasing a key nobody holds is a no-op", () => {
    const gate = createLaunchGate();
    gate.release("nothing");
    expect(gate.count()).toBe(0);
  });
});

const sidebar = (width: number, height: number, focus: Column = "sessions") =>
  planLayout(width, height, focus, "sessions");

describe("planLayout", () => {
  it("gives the session pane three quarters of a usable terminal", () => {
    for (const width of [120, 160, 200, 240]) {
      const layout = sidebar(width, 40);
      expect(layout.split).toBe(true);
      expect(layout.sidebarWidth).toBe(Math.round(width * 0.25));
      // The detail's inner width is the outer three quarters less its borders.
      expect(layout.detailWidth).toBe(width - layout.sidebarWidth - 2);
    }
  });

  it("stacks all three sections, and only the focused one is tall", () => {
    const layout = sidebar(160, 40);
    expect(layout.sections.map((entry) => entry.section)).toEqual([...NAV_SECTIONS]);
    const open = layout.sections.filter((entry) => entry.expanded);
    expect(open.map((entry) => entry.section)).toEqual(["sessions"]);
    for (const entry of layout.sections) {
      if (!entry.expanded) expect(entry.height).toBe(3);
      expect(entry.rows).toBe(entry.height - 2);
    }
    expect(open[0]?.rows).toBeGreaterThan(20);
  });

  it("spends every body row and no more — the stack matches the session pane", () => {
    for (const height of [12, 13, 20, 24, 40, 60]) {
      const layout = sidebar(160, height);
      const stacked = layout.sections.reduce((sum, entry) => sum + entry.height, 0);
      expect(stacked).toBe(layout.detailRows + 2);
      expect(stacked).toBe(height - 3);
    }
  });

  it("moves the open section with the focus", () => {
    for (const section of NAV_SECTIONS) {
      const layout = sidebar(160, 40, section);
      expect(layout.sections.find((entry) => entry.expanded)?.section).toBe(section);
    }
  });

  it("keeps the last nav section open while the keyboard reads the record", () => {
    for (const last of NAV_SECTIONS) {
      const layout = planLayout(160, 40, "detail", last);
      expect(layout.sections.find((entry) => entry.expanded)?.section).toBe(last);
      expect(layout.offscreen).toEqual([]);
    }
  });

  it("never squeezes: a narrow terminal gives the width to the side in focus", () => {
    const nav = sidebar(64, 40, "worktrees");
    expect(nav.split).toBe(false);
    expect(nav.sidebarWidth).toBe(64);
    expect(nav.detailWidth).toBe(0);
    expect(nav.offscreen).toEqual(["detail"]);
    // Still a full stack — the sections are readable, just not beside the record.
    expect(nav.sections).toHaveLength(3);

    const record = planLayout(64, 40, "detail", "sessions");
    expect(record.sidebarWidth).toBe(0);
    expect(record.sections).toEqual([]);
    expect(record.detailWidth).toBe(62);
    expect(record.offscreen).toEqual(["projects", "worktrees", "sessions"]);
  });

  it("pays for the breadcrumb out of the body, so nothing lands under it", () => {
    const wide = sidebar(160, 40);
    const narrow = sidebar(64, 40);
    expect(wide.breadcrumb).toBe(false);
    expect(wide.offscreen).toEqual([]);
    expect(narrow.breadcrumb).toBe(true);
    const stacked = narrow.sections.reduce((sum, entry) => sum + entry.height, 0);
    expect(stacked).toBe(40 - 3 - 1);
  });

  it("spends the last row on the pane, not on a breadcrumb about it", () => {
    const layout = sidebar(160, 6);
    expect(layout.offscreen).not.toEqual([]);
    expect(layout.breadcrumb).toBe(false);
    // Header, pane, status, footer — and the pane still has a row to list in.
    expect(layout.sections[0]?.height).toBe(3);
    expect(layout.sections[0]?.rows).toBe(1);
  });

  it("shows the open section alone rather than three lists nobody can navigate", () => {
    const layout = sidebar(160, 11, "worktrees");
    expect(layout.sections.map((entry) => entry.section)).toEqual(["worktrees"]);
    expect(layout.offscreen).toEqual(["projects", "sessions"]);
    // The breadcrumb it just earned is paid for, and the record still fits.
    expect(layout.sections[0]?.height).toBe(11 - 3 - 1);
    expect(layout.detailRows).toBeGreaterThanOrEqual(1);
  });

  it("stays navigable at sizes no terminal should be", () => {
    for (const width of [1, 20, 40, 71, 72]) {
      for (const height of [1, 4, 8, 12]) {
        for (const focus of [...NAV_SECTIONS, "detail"] as ReadonlyArray<Column>) {
          const layout = planLayout(width, height, focus, "sessions");
          const shown = [
            ...layout.sections.map((entry) => entry.section as Column),
            ...(layout.detailWidth > 0 ? (["detail"] as ReadonlyArray<Column>) : []),
          ];
          // Whatever the keyboard is in is on screen, and big enough to use.
          expect(shown).toContain(focus);
          for (const entry of layout.sections) expect(entry.rows).toBeGreaterThanOrEqual(1);
          if (layout.detailWidth > 0) {
            expect(layout.detailRows).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe("stepColumn", () => {
  it("walks the hierarchy and stops only at its endpoints", () => {
    expect(stepColumn("worktrees", -1)).toBe("projects");
    expect(stepColumn("worktrees", 1)).toBe("sessions");
    expect(stepColumn("sessions", 1)).toBe("detail");
    expect(stepColumn("detail", 1)).toBe("detail");
    expect(stepColumn("projects", -1)).toBe("projects");
  });
});

describe("responsive navigation", () => {
  it.each([50, 66, 72, 80, 94, 100, 115, 116, 160])(
    "can visit every pane and return to the record at %i columns",
    (width) => {
      let focus: Column = "detail";
      let lastNav: NavSection = "sessions";
      const visit = (delta: number, target: Column): void => {
        focus = stepColumn(focus, delta);
        if (focus !== "detail") lastNav = focus;
        expect(focus).toBe(target);
        const layout = planLayout(width, 30, focus, lastNav);
        const shown: ReadonlyArray<Column> = [
          ...layout.sections.map((entry) => entry.section as Column),
          ...(layout.detailWidth > 0 ? (["detail"] as ReadonlyArray<Column>) : []),
        ];
        expect(shown).toContain(target);
      };
      for (const target of ["sessions", "worktrees", "projects"] as const) visit(-1, target);
      for (const target of ["worktrees", "sessions", "detail"] as const) visit(1, target);
    },
  );
});

describe("clampIndex", () => {
  it("keeps an index inside a list that changed under it", () => {
    expect(clampIndex(3, 5)).toBe(2);
    expect(clampIndex(3, -2)).toBe(0);
    expect(clampIndex(0, 4)).toBe(0);
  });
});

describe("optimistic verbs", () => {
  const base = () =>
    workbench({
      project,
      sessions: [
        session({ id: "a", worktreeId: "wt-1", status: "running" }),
        session({ id: "b", worktreeId: "wt-2", status: "running" }),
      ],
      annotations: [],
      worktrees: [
        worktree({ id: "wt-1", name: "fix-auth" }),
        worktree({ id: "wt-2", name: "docs" }),
      ],
    });

  it("markSessionStopped settles the row AND drops its live process facts at once", () => {
    const data = {
      ...base(),
      processesBySession: new Map([
        [
          "a",
          [
            {
              id: "p1",
              kind: "agent-pty",
              harness: "codex",
              label: null,
              status: "running",
              exitedAt: null,
            },
          ],
        ],
      ]),
      servicesBySession: new Map([
        [
          "a",
          [
            {
              id: "svc",
              sessionId: "a",
              label: "web",
              status: "reachable",
              workspacePort: 5173,
              protocol: "tcp" as const,
              hostPort: 43100,
            },
          ],
        ],
      ]),
    };
    const patched = markSessionStopped(data, "a");
    const groups = deriveWorktrees(patched, "proj-1");
    const fixAuth = groups.find((group) => group.name === "fix-auth");
    expect(fixAuth?.live).toBe(0);
    expect(fixAuth?.sessions[0]?.session.status).toBe("stopped");
    // The child fact lines vanish with the stop — no stale "running" agent row.
    expect(fixAuth?.sessions[0]?.processes).toEqual([]);
    expect(fixAuth?.sessions[0]?.services).toEqual([]);
    // The other worktree is untouched.
    expect(groups.find((group) => group.name === "docs")?.live).toBe(1);
  });

  it("removeWorktreeGroup drops the group from the rows before the server answers", () => {
    const data = base();
    const groups = deriveWorktrees(data, "proj-1");
    const target = groups.find((group) => group.name === "docs");
    const patched = removeWorktreeGroup(data, "proj-1", target!);
    const names = deriveWorktrees(patched, "proj-1").map((group) => group.name);
    expect(names).toEqual(["fix-auth"]);
  });
});

const branch = (over: Partial<BranchDto> & { readonly name: string }): BranchDto => ({
  sha: "abc",
  committedAt: "2026-08-31T10:00:00.000Z",
  isDefault: false,
  ...over,
});

describe("the base picker", () => {
  it("matches subsequences, preferring consecutive and segment-start hits", () => {
    const branches = [
      branch({ name: "main", isDefault: true }),
      branch({ name: "feat/worktree-api" }),
      branch({ name: "fix/attach-shell-stacking" }),
      branch({ name: "yiannisp/wta-probe" }),
    ];
    expect(filterBranches(branches, "wta").map((b) => b.name)).toEqual([
      "yiannisp/wta-probe",
      "feat/worktree-api",
    ]);
    expect(filterBranches(branches, "fix").map((b) => b.name)).toEqual([
      "fix/attach-shell-stacking",
    ]);
    expect(filterBranches(branches, "zzz")).toEqual([]);
  });

  it("lists everything on an empty query with the default branch on top", () => {
    const branches = [
      branch({ name: "feat/newer", committedAt: "2026-08-31T12:00:00.000Z" }),
      branch({ name: "main", isDefault: true, committedAt: "2026-08-01T00:00:00.000Z" }),
      branch({ name: "feat/older", committedAt: "2026-08-30T00:00:00.000Z" }),
    ];
    expect(filterBranches(branches, "").map((b) => b.name)).toEqual([
      "main",
      "feat/newer",
      "feat/older",
    ]);
  });

  it("is case-insensitive and ranks earlier matches above later ones", () => {
    const branches = [branch({ name: "Feature/AUTH" }), branch({ name: "docs/auth-notes" })];
    expect(filterBranches(branches, "auth")[0]?.name).toBe("docs/auth-notes");
    expect(filterBranches(branches, "FEATURE")[0]?.name).toBe("Feature/AUTH");
  });
});

describe("advanceFromBase", () => {
  const creating = (over: Partial<CreatingState>): CreatingState => ({
    projectId: "proj-1",
    step: "base",
    name: "fix-auth",
    branches: [
      branch({ name: "main", isDefault: true, committedAt: "2026-08-01T00:00:00.000Z" }),
      branch({ name: "feat/api" }),
    ],
    branchError: null,
    query: "",
    baseIndex: 0,
    base: null,
    joins: false,
    harnessIndex: 0,
    ...over,
  });

  it("keeps the default branch as a null base and names anything else", () => {
    expect(advanceFromBase(creating({ baseIndex: 0 }))).toMatchObject({
      base: null,
      step: "harness",
    });
    expect(advanceFromBase(creating({ baseIndex: 1 }))).toMatchObject({
      base: "feat/api",
      step: "harness",
    });
  });

  it("an unreadable list (or no match) falls back to the default base", () => {
    expect(advanceFromBase(creating({ branches: [] }))).toMatchObject({
      base: null,
      step: "harness",
    });
    expect(advanceFromBase(creating({ query: "zzz" }))).toMatchObject({ base: null });
  });
});

describe("baseStepNotice", () => {
  const creating = (over: Partial<CreatingState>): CreatingState => ({
    projectId: "proj-1",
    step: "base",
    name: "fix-auth",
    branches: [branch({ name: "main", isDefault: true })],
    branchError: null,
    query: "",
    baseIndex: 0,
    base: null,
    joins: false,
    harnessIndex: 0,
    ...over,
  });

  it("says nothing while the list speaks for itself", () => {
    expect(baseStepNotice(creating({}))).toBeNull();
  });

  it("states that the lookup is still running", () => {
    expect(baseStepNotice(creating({ branches: null }))).toBe("reading branches…");
  });

  it("a FAILED lookup is never shown as an empty repository", () => {
    const failed = baseStepNotice(creating({ branches: [], branchError: "502 Bad Gateway" }));
    expect(failed).toContain("branches unreadable");
    expect(failed).toContain("502 Bad Gateway");
    // Same empty list, no error: a different, non-alarming sentence.
    expect(baseStepNotice(creating({ branches: [] }))).toBe(
      "no branches read — enter uses the default branch",
    );
  });

  it("distinguishes a query that matches nothing from a list that has nothing", () => {
    expect(baseStepNotice(creating({ query: "zzz" }))).toBe(
      "no branch matches — enter uses the default branch",
    );
  });
});

describe("fitHints", () => {
  it("joins everything when it all fits", () => {
    expect(fitHints(["a attach", "q quit"], 40)).toBe("a attach · q quit");
  });

  it("drops from the end and SAYS it dropped, rather than cutting mid-word", () => {
    const text = fitHints(["↑↓ move", "a attach", "q quit"], 20);
    expect(text).toBe("↑↓ move · a attach …");
    expect(text.length).toBeLessThanOrEqual(20);
  });

  it("degrades to an ellipsis rather than half a word", () => {
    expect(fitHints(["a attach", "q quit"], 3)).toBe("…");
  });
});

describe("the keymap", () => {
  it("resolves every bound key to its own verb, shift included", () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        if (binding.shift === "any") {
          expect(verbForKey(key, true), key).toBe(binding.verb);
          expect(verbForKey(key, false), key).toBe(binding.verb);
        } else {
          expect(verbForKey(key, binding.shift), key).toBe(binding.verb);
        }
      }
    }
  });

  it("never binds one keystroke to two verbs", () => {
    const seen = new Set<string>();
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        for (const shift of binding.shift === "any" ? [true, false] : [binding.shift]) {
          const stroke = `${shift ? "⇧" : ""}${key}`;
          expect(seen.has(stroke), stroke).toBe(false);
          seen.add(stroke);
        }
      }
    }
  });

  it("keeps the shifted verbs off the vim keys they share", () => {
    // ⇧K stops; k is still up. This pair is why shift is part of the lookup.
    expect(verbForKey("k", true)).toBe("stop");
    expect(verbForKey("k", false)).toBe("moveUp");
    expect(verbForKey("r", true)).toBe("refresh");
    expect(verbForKey("r", false)).toBe("resume");
    expect(verbForKey("d", true)).toBe("remove");
    expect(verbForKey("d", false)).toBeNull();
  });

  it("answers null for anything it does not bind", () => {
    expect(verbForKey("z", false)).toBeNull();
    expect(verbForKey("", false)).toBeNull();
  });

  it("names a key in every hint, and every hinted key is bound to that verb", () => {
    for (const binding of KEY_BINDINGS) {
      for (const [column, hint] of Object.entries(binding.hints)) {
        expect(hint.length, hint).toBeGreaterThan(0);
        // The hint's key token must be one this binding actually answers to,
        // or an arrow/shift form of it — the check that stops help from lying.
        const named = hint.split(" ")[0] ?? "";
        const answers =
          binding.keys.some((key) => named.toLowerCase().includes(key)) || /^[↑↓←→⇧]/u.test(named);
        expect(answers, `${column}: ${hint}`).toBe(true);
      }
    }
  });

  it("gives every column a way out and a way to move", () => {
    for (const column of ["projects", "worktrees", "sessions", "detail"] as const) {
      const hints = verbHints(column);
      expect(hints, column).toContain("q quit");
      expect(
        hints.some((hint) => hint.startsWith("↑↓")),
        column,
      ).toBe(true);
    }
  });

  it("offers the session verbs exactly where a session is named", () => {
    // No session is selectable from the project column, so no session verb is
    // advertised there; every deeper column has attach and resume.
    expect(verbHints("projects")).not.toContain("a attach");
    for (const column of ["worktrees", "sessions", "detail"] as const) {
      expect(verbHints(column), column).toContain("a attach");
      expect(verbHints(column), column).toContain("r resume");
    }
  });
});
