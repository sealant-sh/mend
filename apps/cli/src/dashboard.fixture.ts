/**
 * A small machine for the dashboard to read without a server: two projects, a handful of
 * worktrees and sessions in every state the rows draw, and a short record for whichever session
 * is selected. The rendered dashboard tests and the PR captures both read it.
 */
import type {
  BranchDto,
  ProjectDetailDto,
  ProjectDto,
  ServiceViewDto,
  SessionDetailDto,
  SessionDto,
  WorktreeDto,
} from "./dashboard-model.ts";
import type { SessionTranscriptDto } from "./dashboard-preview.ts";
import type { DashboardContext } from "./dashboard.tsx";

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const project = (id: string, name: string): ProjectDto => ({
  id,
  name,
  originUrl: `git@github.com:sealant-sh/${name}.git`,
  storePath: `/store/${name}`,
  defaultBranch: "main",
});

const worktree = (id: string, name: string, createdMinutes: number): WorktreeDto => ({
  id,
  name,
  directory: `/store/worktrees/${name}`,
  branch: `mend/${name}`,
  baseSha: "2745723c3a1b",
  baseRef: "main",
  createdAt: minutesAgo(createdMinutes),
});

const session = (
  over: Partial<SessionDto> & { readonly id: string; readonly worktreeId: string },
): SessionDto => ({
  harness: "claude",
  label: null,
  branch: "mend/branch",
  baseSha: "2745723c3a1b",
  baseRef: "main",
  status: "completed",
  summary: null,
  hasTranscript: true,
  createdAt: minutesAgo(30),
  ...over,
});

const PROJECTS: ReadonlyArray<ProjectDto> = [
  project("p-mend", "mend"),
  project("p-core", "sealant"),
];

const MEND_WORKTREES: ReadonlyArray<WorktreeDto> = [
  worktree("w-panels", "tui-numbered-panels", 50),
  worktree("w-snake", "tui-snake-countdown", 90),
  worktree("w-docs", "docs-pass", 600),
];

const MEND_SESSIONS: ReadonlyArray<SessionDto> = [
  session({
    id: "s-panels-claude",
    worktreeId: "w-panels",
    branch: "mend/tui-numbered-panels",
    status: "running",
    label: "lazygit panels",
    summary: "Numbering the dashboard's panes and adding the ? overlay.",
    createdAt: minutesAgo(12),
  }),
  session({
    id: "s-panels-codex",
    worktreeId: "w-panels",
    harness: "codex",
    branch: "mend/tui-numbered-panels",
    status: "completed",
    label: "review the keymap",
    summary: "Read the keymap table; two hints named keys nothing bound.",
    createdAt: minutesAgo(45),
  }),
  session({
    id: "s-snake",
    worktreeId: "w-snake",
    branch: "mend/tui-snake-countdown",
    status: "waiting",
    label: "snake countdown",
    createdAt: minutesAgo(80),
  }),
  session({
    id: "s-docs",
    worktreeId: "w-docs",
    harness: "codex",
    branch: "mend/docs-pass",
    status: "completed",
    label: "docs pass",
    summary: "Re-verified every page against the CLI.",
    createdAt: minutesAgo(590),
  }),
];

const CORE_WORKTREES: ReadonlyArray<WorktreeDto> = [
  worktree("w-gc", "image-gc", 300),
  worktree("w-boot", "first-boot", 2),
];

const CORE_SESSIONS: ReadonlyArray<SessionDto> = [
  session({
    id: "s-gc",
    worktreeId: "w-gc",
    branch: "mend/image-gc",
    status: "stopped",
    label: "buildkit gc",
    createdAt: minutesAgo(290),
  }),
  // A first session on a new setup: its image builds, and the session pane offers snake.
  session({
    id: "s-boot",
    worktreeId: "w-boot",
    branch: "mend/first-boot",
    status: "starting",
    hasTranscript: false,
    createdAt: minutesAgo(1),
  }),
];

const DETAILS: ReadonlyMap<string, ProjectDetailDto> = new Map([
  [
    "p-mend",
    {
      project: PROJECTS[0] ?? project("p-mend", "mend"),
      sessions: MEND_SESSIONS,
      annotations: [
        {
          sessionId: "s-panels-claude",
          changeId: "c-panels",
          openComments: 2,
          pendingFollowUp: false,
        },
      ],
      worktrees: MEND_WORKTREES,
    },
  ],
  [
    "p-core",
    {
      project: PROJECTS[1] ?? project("p-core", "sealant"),
      sessions: CORE_SESSIONS,
      annotations: [],
      worktrees: CORE_WORKTREES,
    },
  ],
]);

// As `GET /services` answers: one view per Service, the Service nested under `service`.
const SERVICES: ReadonlyArray<ServiceViewDto> = [
  {
    service: {
      id: "svc-web",
      sessionId: "s-panels-claude",
      name: "web",
      workspacePort: 5173,
      transport: "tcp",
      currentAttemptId: "att-web",
    },
    attempts: [{ id: "att-web", status: "running" }],
    currentForward: { id: "fwd-web", state: "bound" },
    latestObservation: { forwardId: "fwd-web", state: "reachable" },
    endpoints: [{ scope: "private", hostPort: 41873 }],
  },
];

const TRANSCRIPT: SessionTranscriptDto = {
  sourceHarness: "claude",
  events: [
    {
      kind: "user",
      text: "Give the dashboard lazygit-style numbered panels.",
      name: null,
      command: null,
      output: null,
    },
    {
      kind: "assistant",
      text: "Reading lazygit's pkg/gui first: jumpToBlock binds 1-5 and the main view is 0.",
      name: null,
      command: null,
      output: null,
    },
    {
      kind: "tool",
      text: null,
      name: "bash",
      command: "pnpm exec vitest run src/dashboard.test.tsx",
      output: "Test Files  1 passed (1)",
    },
  ],
};

const BRANCHES: ReadonlyArray<BranchDto> = [
  { name: "main", sha: "2745723c3a1b9f0e", committedAt: minutesAgo(40), isDefault: true },
  {
    name: "fix/tui-snake-countdown-focus",
    sha: "9c27b093f1d2e3a4",
    committedAt: minutesAgo(70),
    isDefault: false,
  },
  {
    name: "feat/guided-server-setup",
    sha: "3b17bf6914c5d6e7",
    committedAt: minutesAgo(130),
    isDefault: false,
  },
];

/** Answers the routes the dashboard reads; anything else is refused, as a server would. */
export const fixtureApi: DashboardContext["api"] = <T>(
  method: "GET" | "POST" | "DELETE",
  route: string,
): Promise<T> => {
  // The fixture stands in for JSON off the wire, as untyped here as it is there.
  const answer = (value: unknown): Promise<T> => Promise.resolve(value as T);
  if (method !== "GET")
    return Promise.reject(new Error(`${method} ${route}: fixture is read-only`));
  if (route === "/projects") return answer(PROJECTS);
  if (route === "/services") return answer(SERVICES);
  const detail = /^\/projects\/([^/]+)$/u.exec(route);
  if (detail?.[1] !== undefined) return answer(DETAILS.get(detail[1]));
  if (route.endsWith("/transcript")) return answer(TRANSCRIPT);
  if (route.endsWith("/branches")) return answer(BRANCHES);
  const sessionDetail = /^\/sessions\/([^/]+)$/u.exec(route);
  if (sessionDetail?.[1] !== undefined) {
    const found = [...MEND_SESSIONS, ...CORE_SESSIONS].find(
      (candidate) => candidate.id === sessionDetail[1],
    );
    const reply: SessionDetailDto | undefined =
      found === undefined ? undefined : { session: found, processes: [] };
    return answer(reply);
  }
  return Promise.reject(new Error(`GET ${route}: not in the fixture`));
};

/** A dashboard context reading the fixture, opened in the mend project's checkout. */
export const fixtureContext = (over: Partial<DashboardContext> = {}): DashboardContext => ({
  config: { url: "http://127.0.0.1:8787", token: null },
  cwd: "/home/dev/mend",
  cwdBranch: "main",
  api: fixtureApi,
  attachTty: () => Promise.resolve("detached"),
  agentShare: null,
  tunnels: null,
  ...over,
});
