import { JOIN_SHARED_HOME_LINE, joinWorktreeLine } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  advanceFromBase,
  baseStepNotice,
  clampIndex,
  createLaunchGate,
  deriveProjects,
  deriveWorktrees,
  elapsedWords,
  fetchWorkbench,
  fetchWorkspaceFacts,
  filterBranches,
  backFrom,
  COLUMNS,
  cyclePane,
  deriveHarnesses,
  footerHints,
  foldGroupStatus,
  fitHints,
  gameSwallows,
  HELP_HINT,
  helpSections,
  groupActivityAt,
  groupBaseLabel,
  KEY_BINDINGS,
  isDeadEnd,
  liveCountWords,
  liveProtocolOf,
  liveShellOf,
  markServicesStopped,
  markSessionStopped,
  matchesFilter,
  NAV_SECTIONS,
  numberedTitle,
  PANE_NUMBER,
  paneForDigit,
  planAttach,
  planLayout,
  planResume,
  removeWorktreeGroup,
  sessionDisplayName,
  sessionHold,
  sessionRowFacts,
  sessionTimeWords,
  startingExplanationOf,
  startingWordsOf,
  stepColumn,
  stepScreenMode,
  strokeName,
  verbForKey,
  verbHints,
  viewerNeeded,
  workspaceFactRows,
  worktreeJoinRows,
  type BranchDto,
  type Column,
  type CreatingState,
  type DashboardVerb,
  type NavSection,
  type ProjectDetailDto,
  type SessionDto,
  type SessionProcessDto,
  type Workbench,
  type WorktreeDto,
} from "./dashboard-model.ts";
import { snakeKey } from "./snake-play.ts";

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

  it("reports a stopped session whose workspace is still saving as stopping, never settled", () => {
    expect(planAttach(session({ id: "saving", status: "stopping" })).kind).toBe("stopping");
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

describe("the numbered panes", () => {
  it("numbers the sidebar from 1 and the session pane 0, each digit once", () => {
    expect(COLUMNS.map((column) => PANE_NUMBER[column])).toEqual(["1", "2", "3", "0"]);
    for (const column of COLUMNS) expect(paneForDigit(PANE_NUMBER[column])).toBe(column);
    for (const digit of ["4", "5", "9", "a", ""]) expect(paneForDigit(digit)).toBeNull();
  });

  it("binds each pane's digit to a jump verb, so the number on screen is the key", () => {
    const jump: Readonly<Record<Column, DashboardVerb>> = {
      projects: "jumpProjects",
      worktrees: "jumpWorktrees",
      sessions: "jumpSessions",
      detail: "jumpDetail",
    };
    for (const column of COLUMNS) {
      expect(verbForKey(PANE_NUMBER[column], false)).toBe(jump[column]);
    }
  });

  it("writes the number in front of the title", () => {
    expect(numberedTitle("sessions", "sessions · 2")).toBe("[3] sessions · 2");
    expect(numberedTitle("detail", "session")).toBe("[0] session");
  });
});

describe("cyclePane", () => {
  it("visits every pane and comes back round, both ways", () => {
    let focus: Column = "projects";
    const seen: Array<Column> = [];
    for (let step = 0; step < COLUMNS.length; step += 1) {
      seen.push(focus);
      focus = cyclePane(focus, 1);
    }
    expect(seen).toEqual([...COLUMNS]);
    expect(focus).toBe("projects");
    expect(cyclePane("projects", -1)).toBe("detail");
    expect(cyclePane("detail", 1)).toBe("projects");
  });
});

describe("backFrom", () => {
  it("returns the session pane to the list it was read from", () => {
    for (const last of NAV_SECTIONS) expect(backFrom("detail", last)).toBe(last);
  });

  it("returns a list to the one above it, and stops at projects", () => {
    expect(backFrom("sessions", "sessions")).toBe("worktrees");
    expect(backFrom("worktrees", "sessions")).toBe("projects");
    expect(backFrom("projects", "sessions")).toBe("projects");
  });
});

describe("screen modes", () => {
  it("cycles normal, half, full and back, both ways", () => {
    expect(stepScreenMode("normal", 1)).toBe("half");
    expect(stepScreenMode("half", 1)).toBe("full");
    expect(stepScreenMode("full", 1)).toBe("normal");
    expect(stepScreenMode("normal", -1)).toBe("full");
  });

  it("gives the sidebar half the width in half mode, and the record keeps the rest", () => {
    const layout = planLayout(160, 40, "sessions", "sessions", "half");
    expect(layout.split).toBe(true);
    expect(layout.sidebarWidth).toBe(80);
    expect(layout.detailWidth).toBe(160 - 80 - 2);
  });

  it("gives the whole screen to the side in focus in full mode", () => {
    const record = planLayout(160, 40, "detail", "worktrees", "full");
    expect(record.sidebarWidth).toBe(0);
    expect(record.detailWidth).toBe(158);
    expect(record.offscreen).toEqual(["projects", "worktrees", "sessions"]);
    const list = planLayout(160, 40, "worktrees", "worktrees", "full");
    expect(list.sidebarWidth).toBe(160);
    expect(list.detailWidth).toBe(0);
    expect(list.sections.find((entry) => entry.expanded)?.section).toBe("worktrees");
  });
});

describe("strokeName", () => {
  it("reads ? + _ off the typed character, whatever the terminal named the key", () => {
    // The kitty protocol: the base key, shift held, the character in the sequence.
    expect(strokeName({ name: "/", sequence: "?" })).toBe("?");
    expect(strokeName({ name: "=", sequence: "+" })).toBe("+");
    expect(strokeName({ name: "-", sequence: "_" })).toBe("_");
    // A legacy terminal names the character itself.
    expect(strokeName({ name: "?", sequence: "?" })).toBe("?");
    expect(verbForKey(strokeName({ name: "/", sequence: "?" }), true)).toBe("help");
  });

  it("keeps / the filter and - a step back", () => {
    expect(verbForKey(strokeName({ name: "/", sequence: "/" }), false)).toBe("filter");
    expect(verbForKey(strokeName({ name: "-", sequence: "-" }), false)).toBe("columnLeft");
    expect(strokeName({ name: "escape", sequence: "\u001b" })).toBe("escape");
  });
});

describe("a game with the keyboard", () => {
  it("reads its own keys first: steering, pausing, and esc or q to leave", () => {
    // The handler asks the game (snakeKey) before the dashboard; these never reach a verb.
    const own: ReadonlyArray<readonly [string, string]> = [
      ["up", "steer"],
      ["down", "steer"],
      ["left", "steer"],
      ["right", "steer"],
      ["h", "steer"],
      ["j", "steer"],
      ["k", "steer"],
      ["l", "steer"],
      ["space", "togglePause"],
      ["p", "togglePause"],
      ["escape", "leave"],
      ["q", "leave"],
    ];
    for (const [key, type] of own) expect(snakeKey(key)?.type, key).toBe(type);
  });

  it("keeps the numbered panes' keys from the dashboard: digits, tab, ?, / and the screen modes", () => {
    for (const [key, shift] of [
      ["1", false],
      ["2", false],
      ["3", false],
      ["0", false],
      ["tab", false],
      ["tab", true],
      ["backtab", true],
      ["?", true],
      ["/", false],
      ["+", true],
      ["_", true],
    ] as const) {
      expect(snakeKey(key), key).toBeNull();
      expect(gameSwallows(verbForKey(key, shift)), key).toBe(true);
    }
  });
});

const helpRowsOf = (focus: Column) => helpSections(focus).flatMap((section) => section.rows);

describe("the ? overlay", () => {
  it("lists every verb in the keymap exactly once, with words for what it does", () => {
    for (const focus of COLUMNS) {
      const listed = helpRowsOf(focus).map((row) => row.verb);
      expect(new Set(listed).size).toBe(listed.length);
      expect(new Set(listed)).toEqual(new Set(KEY_BINDINGS.map((binding) => binding.verb)));
      for (const row of helpRowsOf(focus)) expect(row.help.length, row.verb).toBeGreaterThan(0);
    }
  });

  it("names every key that reaches a verb", () => {
    const keysOf = new Map(helpRowsOf("sessions").map((row) => [row.verb, row.keys.split(" ")]));
    for (const binding of KEY_BINDINGS) {
      const listed = keysOf.get(binding.verb) ?? [];
      for (const key of binding.keys) {
        if (key === "linefeed") continue;
        // The label may draw the key (↑, enter, ⇧K) rather than spell its opentui name.
        const drawn = listed.some(
          (label) =>
            label === key ||
            label.toLowerCase() === `⇧${key}` ||
            (
              {
                up: "↑",
                down: "↓",
                left: "←",
                right: "→",
                return: "enter",
                escape: "esc",
                backspace: "⌫",
                pageup: "PgUp",
                pagedown: "PgDn",
                backtab: "⇧tab",
              } as Readonly<Record<string, string>>
            )[key] === label,
        );
        expect(drawn, `${binding.verb}: ${key} in ${listed.join(" ")}`).toBe(true);
      }
    }
  });

  it("keeps the keymap's order, and marks what this pane's footer names", () => {
    const order = [...new Set(KEY_BINDINGS.map((binding) => binding.verb))];
    for (const focus of COLUMNS) {
      for (const section of helpSections(focus)) {
        const at = section.rows.map((row) => order.indexOf(row.verb));
        expect(at, section.title).toEqual(at.toSorted((left, right) => left - right));
      }
      const here = new Set(
        helpRowsOf(focus)
          .filter((row) => row.here)
          .map((row) => row.verb),
      );
      expect(here).toEqual(
        new Set(
          KEY_BINDINGS.filter((binding) => binding.hints[focus] !== undefined).map(
            (binding) => binding.verb,
          ),
        ),
      );
    }
  });

  it("writes shifted letters the way the footer does", () => {
    const keys = new Map(helpRowsOf("sessions").map((row) => [row.verb, row.keys]));
    expect(keys.get("stop")).toBe("⇧K x");
    expect(keys.get("remove")).toBe("⇧D");
    expect(keys.get("prevPane")).toBe("⇧tab");
  });
});

describe("footerHints", () => {
  it("always ends with ? keys, however little room there is", () => {
    for (const focus of COLUMNS) {
      for (const width of [12, 30, 60, 200]) {
        expect(footerHints(focus, width).endsWith(` · ${HELP_HINT}`)).toBe(true);
      }
    }
  });

  it("keeps the pane's own hints first when they fit", () => {
    expect(footerHints("sessions", 200).startsWith("↑↓ move · ←→ panes · a attach")).toBe(true);
  });
});

describe("matchesFilter", () => {
  it("matches a case-insensitive substring of any field, and keeps everything when empty", () => {
    expect(matchesFilter("", "anything")).toBe(true);
    expect(matchesFilter("  ", "anything")).toBe(true);
    expect(matchesFilter("SNAKE", "tui-snake-countdown")).toBe(true);
    expect(matchesFilter("codex", "docs pass", null, "codex")).toBe(true);
    expect(matchesFilter("zzz", "docs pass", null)).toBe(false);
  });
});

describe("the verbs that were here before", () => {
  it("still answer to the keys they always had", () => {
    // Every base-layer key the dashboard bound before the numbered panes, and what it meant.
    // Tab is the one that moved: it cycles the panes now (lazygit's nextBlock).
    const before: ReadonlyArray<readonly [string, boolean, DashboardVerb]> = [
      ["up", false, "moveUp"],
      ["k", false, "moveUp"],
      ["down", false, "moveDown"],
      ["j", false, "moveDown"],
      ["pageup", false, "pageUp"],
      ["pagedown", false, "pageDown"],
      ["return", false, "columnRight"],
      ["linefeed", false, "columnRight"],
      ["l", false, "columnRight"],
      ["right", false, "columnRight"],
      ["left", false, "columnLeft"],
      ["h", false, "columnLeft"],
      ["-", false, "columnLeft"],
      ["backspace", false, "columnLeft"],
      ["a", false, "attach"],
      ["r", false, "resume"],
      ["n", false, "newSession"],
      ["w", false, "newWorktree"],
      ["k", true, "stop"],
      ["x", false, "stop"],
      ["d", true, "remove"],
      ["v", false, "review"],
      ["e", false, "rename"],
      ["o", false, "openWeb"],
      ["r", true, "refresh"],
      ["q", false, "quit"],
    ];
    for (const [key, shift, verb] of before) {
      expect(verbForKey(key, shift), `${shift ? "⇧" : ""}${key}`).toBe(verb);
    }
    expect(verbForKey("tab", false)).toBe("nextPane");
    expect(verbForKey("tab", true)).toBe("prevPane");
    expect(verbForKey("backtab", true)).toBe("prevPane");
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
    // The agent's fact line vanishes with the stop — no stale "running" agent row. Services
    // keep running: a stop leaves them, and they keep the workspace up.
    expect(fixAuth?.sessions[0]?.processes).toEqual([]);
    expect(fixAuth?.sessions[0]?.services.map((service) => service.label)).toEqual(["web"]);
    const item = fixAuth?.sessions[0];
    expect(item === undefined ? null : sessionHold(item)).toBe("1 service keeps the workspace up");
    const cleared = markServicesStopped(patched, "a");
    expect(
      deriveWorktrees(cleared, "proj-1").find((group) => group.name === "fix-auth")?.sessions[0]
        ?.services,
    ).toEqual([]);
    // The other worktree is untouched.
    expect(groups.find((group) => group.name === "docs")?.live).toBe(1);
    // With no Service, a stop is asked, not observed: the row reads stopping (story S28).
    const bare = markSessionStopped({ ...data, servicesBySession: new Map() }, "a");
    expect(
      deriveWorktrees(bare, "proj-1").find((group) => group.name === "fix-auth")?.sessions[0]
        ?.session.status,
    ).toBe("stopping");
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
      "no branches read · enter uses the default branch",
    );
  });

  it("distinguishes a query that matches nothing from a list that has nothing", () => {
    expect(baseStepNotice(creating({ query: "zzz" }))).toBe(
      "no branch matches · enter uses the default branch",
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

describe("sessionHold", () => {
  const stoppedAgent = {
    status: "stopped",
    exitCode: null,
    exitedAt: "2026-08-31T11:00:00.000Z",
    harness: "claude",
    sealantSessionId: "pty-1",
    kind: "agent-pty",
  };

  it("reads the agent's outcome and the Services that keep the workspace up", () => {
    const item = {
      session: session({ id: "held", status: "idle" }),
      annotation: {
        sessionId: "held",
        changeId: null,
        openComments: 0,
        pendingFollowUp: false,
        currentAgent: stoppedAgent,
        liveServices: 3,
      },
      services: [],
      processes: [],
    };
    expect(sessionHold(item)).toBe("agent stopped · 3 services keep the workspace up");
  });

  it("says nothing while the agent works or no Service holds the workspace", () => {
    const running = {
      session: session({ id: "busy", status: "running" }),
      annotation: undefined,
      services: [],
      processes: [
        {
          id: "p1",
          kind: "agent-pty",
          harness: "claude",
          label: null,
          status: "running",
          exitedAt: null,
        },
      ],
    };
    expect(sessionHold(running)).toBeNull();
    const quiet = {
      session: session({ id: "done", status: "stopped" }),
      annotation: {
        sessionId: "done",
        changeId: null,
        openComments: 0,
        pendingFollowUp: false,
        currentAgent: stoppedAgent,
        liveServices: 0,
      },
      services: [],
      processes: [],
    };
    expect(sessionHold(quiet)).toBeNull();
  });
});

// docs/dashboard-status-stories.md: each test names the story it checks.
describe("dashboard status stories", () => {
  const NOW = Date.parse("2026-10-02T08:30:00.000Z");
  const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const itemOf = (
    over: Partial<SessionDto> & { readonly id: string },
    agentCreatedAt?: string,
  ) => ({
    session: session(over),
    annotation:
      agentCreatedAt === undefined
        ? undefined
        : {
            sessionId: over.id,
            changeId: null,
            openComments: 0,
            pendingFollowUp: false,
            currentAgent: {
              status: "running",
              exitCode: null,
              exitedAt: null,
              harness: "claude",
              sealantSessionId: "pty-1",
              kind: "agent-pty",
              createdAt: agentCreatedAt,
            },
            liveServices: 0,
          },
    services: [],
    processes: [],
  });
  const groupOf = (statuses: ReadonlyArray<string>) => {
    const detail: ProjectDetailDto = {
      project: {
        id: "p",
        name: "p",
        originUrl: null,
        storePath: "/s",
        defaultBranch: "main",
      },
      sessions: statuses.map((status, index) =>
        session({ id: `s${index}`, status, worktreeId: "wt" }),
      ),
      annotations: [],
      worktrees: [worktree({ id: "wt" })],
    };
    const data: Workbench = {
      projects: [detail.project],
      details: new Map([["p", detail]]),
      servicesBySession: new Map(),
      processesBySession: new Map(),
    };
    return { group: deriveWorktrees(data, "p")[0]!, project: deriveProjects(data)[0]! };
  };

  it("S1: a launch the server has not answered says it is launching", () => {
    const pending = session({ id: "pending-1", status: "starting" });
    expect(startingWordsOf(pending)).toBe("launching");
    expect(startingExplanationOf(pending)).toBe("launching");
  });

  it("S2: a starting session names its launch phase, never its age or an image build it cannot see", () => {
    const at = (summary: string | null) =>
      session({ id: "s", status: "starting", summary, createdAt: minutesAgo(21) });
    expect(startingWordsOf(at(null))).toBe("launching");
    expect(startingWordsOf(at("booting"))).toBe("booting");
    expect(
      startingWordsOf(
        at(
          "preparing the workspace · no runtime yet · after an update, building the image takes about 8 minutes",
        ),
      ),
    ).toBe("preparing the workspace");
    // Stored before 2026-10-02: the old words still read as the same phase.
    expect(
      startingWordsOf(at("building the workspace image (first launch after an update, ~8 min)")),
    ).toBe("preparing the workspace");
    expect(startingWordsOf(at("waiting · the previous session in this worktree is saving"))).toBe(
      "waiting for the previous save",
    );
    expect(
      startingWordsOf(at("waiting · the previous session in this worktree is not answering")),
    ).toBe("waiting for the previous session");
    // Words in front of the phase stay the summary's; the phase is still read from the end.
    expect(startingWordsOf(at("dotfiles not applied · booting"))).toBe("booting");
    expect(startingExplanationOf(at("booting"))).toBe(
      "the workspace is booting · the agent starts when it is up",
    );
    expect(
      startingExplanationOf(at("waiting · the previous session in this worktree is saving")),
    ).toBe("the previous session in this worktree is still saving · this one starts from its save");
    // A resume is a start too: no time fact while it starts, however old the session.
    expect(
      sessionTimeWords(itemOf({ id: "s", status: "starting", createdAt: minutesAgo(21) }), NOW),
    ).toBeNull();
  });

  it("S2/S7/S24: a resume waiting on the previous save says what is left, and never claims it uploaded", () => {
    const draining = (over: Partial<SessionDto>) =>
      itemOf({ id: "s", status: "starting", captureDrain: "relaunch", ...over });
    expect(sessionHold(draining({ capturePending: 3, capturePendingBytes: 12_000_000 }))).toBe(
      "saving · 12 MB left",
    );
    expect(sessionHold(draining({ capturePending: 0, capturePendingBytes: 0 }))).toBe(
      "saving · no uploads pending",
    );
    expect(sessionHold(draining({ capturePending: 0, capturePendingBytes: null }))).toBe(
      "saving · no uploads pending",
    );
    expect(sessionHold(draining({ capturePending: null, capturePendingBytes: null }))).toBe(
      "saving",
    );
  });

  it("S3/S16-S18: a live session reads how long its own agent has been up, or what it knows", () => {
    const resumed = itemOf(
      { id: "s", status: "running", createdAt: minutesAgo(120) },
      minutesAgo(4),
    );
    expect(sessionTimeWords(resumed, NOW)).toBe("up 4m");
    // No agent on the wire (an older server): only what it knows, the creation.
    expect(
      sessionTimeWords(itemOf({ id: "s", status: "idle", createdAt: minutesAgo(9) }), NOW),
    ).toBe("created 9m ago");
    // The agent exited and something else holds the session live: when it ended.
    const ended = itemOf({ id: "s", status: "idle", createdAt: minutesAgo(120) }, minutesAgo(30));
    const endedItem = {
      ...ended,
      annotation: {
        ...ended.annotation!,
        currentAgent: { ...ended.annotation!.currentAgent!, exitedAt: minutesAgo(5) },
      },
    };
    expect(sessionTimeWords(endedItem, NOW)).toBe("agent ended 5m ago");
    // A shell session's uptime is the shell's; an observed agent's is only activity seen.
    expect(
      sessionTimeWords(
        itemOf({ id: "s", status: "running", harness: "shell" }, minutesAgo(4)),
        NOW,
      ),
    ).toBe("shell up 4m");
    const observed = itemOf({ id: "s", status: "running" }, minutesAgo(4));
    expect(
      sessionTimeWords(
        {
          ...observed,
          annotation: {
            ...observed.annotation!,
            currentAgent: { ...observed.annotation!.currentAgent!, kind: "agent-external" },
          },
        },
        NOW,
      ),
    ).toBe("activity seen 4m ago");
  });

  it("S5/S20-S22: stopping with no save to report: the workspace end is not confirmed", () => {
    // No agent row: nothing says an agent ran (an interrupted launch, story S22).
    expect(sessionHold(itemOf({ id: "s", status: "stopping" }))).toBe(
      "workspace end not confirmed",
    );
    const exited = itemOf({ id: "s", status: "stopping" }, minutesAgo(10));
    expect(
      sessionHold({
        ...exited,
        annotation: {
          ...exited.annotation!,
          currentAgent: { ...exited.annotation!.currentAgent!, exitedAt: minutesAgo(1) },
        },
      }),
    ).toBe("agent ended · workspace end not confirmed");
    expect(sessionTimeWords(itemOf({ id: "s", status: "stopping" }), NOW)).toBeNull();
  });

  it("S6/S8: a stop drain says what is left, or why it stalled", () => {
    expect(
      sessionHold(itemOf({ id: "s", status: "stopping", captureDrain: "stop", capturePending: 3 })),
    ).toBe("saving · 3 left");
    expect(
      sessionHold(
        itemOf({
          id: "s",
          status: "stopping",
          captureDrain: "stop",
          capturePending: 3,
          captureNotSavedAt: minutesAgo(1),
          captureIncompleteReason: "ship-failed",
        }),
      ),
    ).toBe("not saved · upload failed · 3 pending · workspace kept");
  });

  it("S9: a settled session reads when it ended", () => {
    expect(
      sessionTimeWords(
        itemOf({
          id: "s",
          status: "completed",
          settledAt: minutesAgo(5),
          createdAt: minutesAgo(60),
        }),
        NOW,
      ),
    ).toBe("ended 5m ago");
    expect(
      sessionTimeWords(itemOf({ id: "s", status: "failed", settledAt: minutesAgo(0) }), NOW),
    ).toBe("ended just now");
    // An older server sends no settledAt: when it was created, not a guess at when it ended.
    expect(
      sessionTimeWords(itemOf({ id: "s", status: "completed", createdAt: minutesAgo(120) }), NOW),
    ).toBe("created 2h ago");
  });

  it("worktree states: the most pressing session word, starting and stopping included", () => {
    expect(foldGroupStatus(groupOf(["starting"]).group)).toBe("starting");
    expect(foldGroupStatus(groupOf(["starting", "idle"]).group)).toBe("starting");
    expect(foldGroupStatus(groupOf(["running", "starting"]).group)).toBe("running");
    expect(foldGroupStatus(groupOf(["idle", "waiting"]).group)).toBe("waiting");
    expect(foldGroupStatus(groupOf(["stopping", "completed"]).group)).toBe("stopping");
    expect(foldGroupStatus(groupOf(["idle", "stopping"]).group)).toBe("stopping");
    expect(foldGroupStatus(groupOf(["completed", "failed"]).group)).toBe("settled");
  });

  it("project states: live and stopping counted apart, settled only when neither", () => {
    expect(groupOf(["running", "stopping", "completed"]).project).toMatchObject({
      live: 1,
      stopping: 1,
      total: 3,
    });
    expect(liveCountWords(1, 0)).toBe("1 live");
    expect(liveCountWords(1, 1)).toBe("1 live · 1 stopping");
    expect(liveCountWords(0, 2)).toBe("2 stopping");
    expect(liveCountWords(0, 0)).toBe("settled");
  });

  it("S31: a narrow column cuts the state and keeps it first; the harness drops before it", () => {
    const stopping = itemOf({ id: "s", status: "stopping" });
    // 120 columns leave about 25 for a session's facts.
    expect(sessionRowFacts(stopping, 25, NOW)).toBe("workspace end not conf… …");
    expect(sessionRowFacts(stopping, 60, NOW)).toBe("workspace end not confirmed · claude");
    const preparing = itemOf({
      id: "s",
      status: "starting",
      summary:
        "preparing the workspace · no runtime yet · after an update, building the image takes about 8 minutes",
    });
    expect(sessionRowFacts(preparing, 40, NOW)).toBe("preparing the workspace · claude");
    expect(sessionRowFacts(preparing, 20, NOW)).toBe("preparing the wor… …");
  });

  it("rule 1: a number always says what it counts", () => {
    expect(elapsedWords(minutesAgo(0), NOW)).toBe("<1m");
    expect(elapsedWords(minutesAgo(59), NOW)).toBe("59m");
    expect(elapsedWords(minutesAgo(61), NOW)).toBe("1h");
    expect(elapsedWords(minutesAgo(60 * 49), NOW)).toBe("2d");
    expect(elapsedWords(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
  });
});

/** A fake server through JSON, as the wire carries it; a route it lacks answers 404. */
const fakeApi =
  (routes: Readonly<Record<string, unknown>>) =>
  async <T>(_method: string, route: string): Promise<T> => {
    if (!(route in routes)) throw new Error(`GET ${route} → 404`);
    return JSON.parse(JSON.stringify(routes[route]));
  };

describe("deriveHarnesses", () => {
  it("says a new session starts a new worktree", () => {
    for (const item of deriveHarnesses(null)) expect(item.hint).toContain("new worktree");
  });

  it("says a session started inside a worktree joins it, never a new one", () => {
    const rows = deriveHarnesses(null, "fix-auth");
    expect(rows.map((item) => item.harness)).toEqual(
      deriveHarnesses(null).map((item) => item.harness),
    );
    for (const item of rows) {
      expect(item.hint).toContain("joins fix-auth");
      expect(item.hint).not.toContain("new worktree");
    }
  });
});

describe("the Services the session pane names", () => {
  it("reads GET /services as the server answers it, one view per Service", async () => {
    const routes: Readonly<Record<string, unknown>> = {
      "/projects": [project],
      "/services": [
        {
          service: {
            id: "svc-1",
            sessionId: "a",
            name: "web",
            workspacePort: 5173,
            transport: "tcp",
            browserScheme: "http",
            currentAttemptId: "att-1",
          },
          attempts: [{ id: "att-1", status: "running", argv: ["pnpm", "dev"], exitCode: null }],
          currentForward: { id: "fwd-2", hostPort: 41873, state: "bound" },
          latestObservation: { forwardId: "fwd-2", state: "reachable", lastObservedAt: "now" },
          endpoints: [
            { authority: "127.0.0.1:41000", hostPort: 41000, scope: "loopback" },
            { authority: "box:41873", hostPort: 41873, scope: "private" },
          ],
          workspaceExpiresAt: null,
        },
        {
          service: {
            id: "svc-2",
            sessionId: "a",
            name: "db",
            workspacePort: 5432,
            transport: "udp",
            currentAttemptId: "att-2",
          },
          attempts: [{ id: "att-2", status: "running" }],
          // The observation is of an older forward: it says nothing about this one.
          currentForward: { id: "fwd-3", state: "binding" },
          latestObservation: { forwardId: "fwd-1", state: "reachable" },
          endpoints: [],
        },
      ],
      [`/projects/${project.id}`]: {
        project,
        sessions: [session({ id: "a", worktreeId: "wt-1", status: "running" })],
        annotations: [],
        worktrees: [worktree({ id: "wt-1" })],
      },
      "/sessions/a": { session: session({ id: "a", status: "running" }), processes: [] },
    };
    const data = await fetchWorkbench({ api: fakeApi(routes) });
    expect(data.servicesBySession.get("a")).toEqual([
      {
        id: "svc-1",
        sessionId: "a",
        label: "web",
        status: "reachable",
        workspacePort: 5173,
        protocol: "tcp",
        hostPort: 41873,
      },
      {
        id: "svc-2",
        sessionId: "a",
        label: "db",
        status: "binding",
        workspacePort: 5432,
        protocol: "udp",
        hostPort: null,
      },
    ]);
  });
});

describe("people in a workspace (docs/adr/0016, decisions 13 and 14)", () => {
  const anna = { accountId: "anna", name: "Anna" };
  const bob = { accountId: "bob", name: "Bob" };

  it("fetchWorkbench reads who is live from the project view, and asks for no viewer with nobody listed", async () => {
    const asked: Array<string> = [];
    const routes: Readonly<Record<string, unknown>> = {
      "/projects": [project],
      "/services": [],
      [`/projects/${project.id}`]: {
        project,
        // Per-person homes off: the project view lists nobody and no retirement.
        sessions: [
          session({
            id: "a",
            worktreeId: "wt-1",
            status: "running",
            livePeople: [],
            workspaceRetirement: null,
          }),
        ],
        annotations: [],
        worktrees: [worktree({ id: "wt-1" })],
      },
      "/sessions/a": { session: session({ id: "a", status: "running" }), processes: [] },
    };
    const api = async <T>(method: string, route: string): Promise<T> => {
      asked.push(route);
      return fakeApi(routes)<T>(method, route);
    };
    const data = await fetchWorkbench({ api });
    expect(viewerNeeded(data)).toBe(false);
    expect(asked.filter((route) => route.startsWith("/organization"))).toEqual([]);
    expect(asked.filter((route) => route === "/sessions")).toEqual([]);
    expect(asked.filter((route) => route.endsWith("/waiting"))).toEqual([]);
    expect(asked.filter((route) => route.endsWith("/workspace-retirement"))).toEqual([]);
  });

  it("asks for the viewer once a row lists someone live or a retirement", () => {
    const withRow = (row: Partial<SessionDto>) =>
      workbench({
        project,
        sessions: [session({ id: "a", worktreeId: "wt-1", status: "running", ...row })],
        annotations: [],
        worktrees: [worktree({ id: "wt-1" })],
      });
    expect(viewerNeeded(undefined)).toBe(false);
    expect(viewerNeeded(withRow({ livePeople: [anna] }))).toBe(true);
    expect(viewerNeeded(withRow({ workspaceRetirement: "marked" }))).toBe(true);
    expect(viewerNeeded(withRow({ livePeople: [], workspaceRetirement: null }))).toBe(false);
  });

  it("says the join line where another person's session runs, wrapped to the modal", () => {
    const data = workbench({
      project,
      sessions: [session({ id: "a", worktreeId: "wt-1", status: "running", livePeople: [anna] })],
      annotations: [],
      worktrees: [worktree({ id: "wt-1", name: "fix-auth" })],
    });
    const byId = worktreeJoinRows(data, project.id, { id: "wt-1" }, "bob", 60);
    expect(byId.join(" ")).toBe(joinWorktreeLine(["Anna"]));
    expect(worktreeJoinRows(data, project.id, { name: "fix-auth" }, "bob", 60)).toEqual(byId);
    // Your own session is not another person's.
    expect(worktreeJoinRows(data, project.id, { id: "wt-1" }, "anna", 60)).toEqual([]);
    expect(worktreeJoinRows(data, project.id, { name: "new-one" }, "bob", 60)).toEqual([]);
  });

  it("says the shared-home line where another person's session is live and nobody is listed", () => {
    const data = workbench({
      project,
      sessions: [
        session({
          id: "a",
          worktreeId: "wt-1",
          status: "running",
          ownerUserId: "anna",
          livePeople: [],
        }),
      ],
      annotations: [],
      worktrees: [worktree({ id: "wt-1", name: "fix-auth" })],
    });
    expect(worktreeJoinRows(data, project.id, { id: "wt-1" }, "bob", 60).join(" ")).toBe(
      JOIN_SHARED_HOME_LINE,
    );
    // Not without a known viewer, and not in your own session's worktree.
    expect(worktreeJoinRows(data, project.id, { id: "wt-1" }, null, 60)).toEqual([]);
    expect(worktreeJoinRows(data, project.id, { id: "wt-1" }, "anna", 60)).toEqual([]);
  });

  it("reads the waiting line and the retirement, and nothing from an older server", async () => {
    const both = { waiting: true, retirement: true };
    expect(await fetchWorkspaceFacts(fakeApi({}), "a", both)).toEqual({
      wait: null,
      retirement: null,
    });
    const facts = await fetchWorkspaceFacts(
      fakeApi({
        "/sessions/a/waiting": {
          line: "Waits for Anna's background task before Bob's turn starts.",
        },
        "/sessions/a/workspace-retirement": null,
      }),
      "a",
      both,
    );
    expect(facts.wait?.line).toBe("Waits for Anna's background task before Bob's turn starts.");
  });

  it("asks only for the reads the row says are worth a request", async () => {
    const asked: Array<string> = [];
    const api = async <T>(_method: string, route: string): Promise<T> => {
      asked.push(route);
      return JSON.parse("null");
    };
    await fetchWorkspaceFacts(api, "a", { waiting: false, retirement: false });
    expect(asked).toEqual([]);
    await fetchWorkspaceFacts(api, "a", { waiting: false, retirement: true });
    expect(asked).toEqual(["/sessions/a/workspace-retirement"]);
    await fetchWorkspaceFacts(api, "b", { waiting: true, retirement: false });
    expect(asked).toEqual(["/sessions/a/workspace-retirement", "/sessions/b/waiting"]);
  });

  it("wraps the session's workspace lines to the pane, stop lines indented", () => {
    const rows = workspaceFactRows(
      { id: "3f2a0001", livePeople: [anna, bob] },
      { userId: "bob", members: [] },
      {
        wait: null,
        retirement: {
          state: "marked",
          preRelease: true,
          launcher: "anna",
          stops: [{ kind: "service", label: "storybook started by hand in the workspace" }],
          reason: null,
          checkedAt: "2026-10-08T12:05:00.000Z",
          fingerprint: "fp-1",
          canReplace: true,
        },
      },
      40,
    );
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(40);
    expect(rows[0]).toBe("Shared workspace with Anna · each of you");
    expect(rows.some((row) => row.startsWith("  Service started by hand"))).toBe(true);
    expect(rows.join(" ")).toContain("mend workspace replace 3f2a0001");
  });

  it("says nothing with one person live and nothing waiting", () => {
    expect(
      workspaceFactRows(
        { id: "a", livePeople: [bob] },
        { userId: "bob", members: [] },
        undefined,
        80,
      ),
    ).toEqual([]);
  });
});

describe("gameSwallows", () => {
  it("keeps every dashboard verb from acting behind a game with the keyboard", () => {
    for (const binding of KEY_BINDINGS) {
      for (const key of binding.keys) {
        const verb = verbForKey(key, binding.shift === true);
        expect(gameSwallows(verb), `${key} → ${verb}`).toBe(true);
      }
    }
  });

  it("has nothing to keep for a key bound to nothing", () => {
    expect(gameSwallows(verbForKey("z", false))).toBe(false);
    expect(gameSwallows(null)).toBe(false);
  });
});
