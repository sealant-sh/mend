import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { ServerResponse } from "node:http";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { COMMANDS } from "./help.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";
import { encodeReceipt, turnReceipt } from "./message-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();
export const skill = fs.readFileSync(new URL("./agent-skill.md", import.meta.url), "utf8");
const scratch = execFileSync("mktemp", ["-d", "-t", "mend-skill-contract.XXXXXX"], {
  encoding: "utf8",
}).trim();
afterAll(() => {
  console.info("Removing skill contract fixtures", scratch, fs.readdirSync(scratch));
  fs.rmSync(scratch, { recursive: true });
});

// The catalog supplies command grammar, never evidence that a command satisfies the contract.
const groups = new Set([
  "projects",
  ...COMMANDS.filter((command) => command.name.includes(" ")).map(
    (command) => command.name.split(" ")[0],
  ),
]);
export const skillCommands = (markdown: string): ReadonlyArray<string> => {
  const fragments: string[] = [];
  const prose = markdown.replace(
    /(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:`{3,}|~{3,})/g,
    (_fence, body: string) => {
      fragments.push(body);
      return "";
    },
  );
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) fragments.push(match[1] ?? "");
  fragments.push(prose.replace(/`[^`\n]+`/g, ""));
  const commands = new Set<string>();
  for (const fragment of fragments) {
    for (const match of fragment.matchAll(
      /(?<![\w/.-])mend[ \t]+([a-z][a-z0-9-]*)(?:[ \t]+([a-z][a-z0-9-]*))?/g,
    )) {
      const [, head, next] = match;
      if (head === undefined || !/^[a-z][a-z0-9-]*$/.test(head)) continue;
      commands.add(
        groups.has(head) && next !== undefined && /^[a-z][a-z0-9-]*$/.test(next)
          ? `${head} ${next}`
          : head,
      );
    }
  }
  return [...commands].toSorted();
};

export const personOnly = new Map([
  ["attach", "The skill hands an interactive terminal to the person; an agent must not attach."],
]);
const id = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const worktreeId = "33333333-3333-4333-8333-333333333333";
const observedAt = "2026-11-04T00:00:00Z";
const privateValue = "skill-contract-private-sentinel";
const image = {
  mode: "family",
  os: "arch",
  packages: ["git", "ripgrep"],
  shell: "zsh",
  services: { docker: true },
  screen: false,
};
const project = {
  id: projectId,
  name: "fixture",
  organizationId: "org",
  visibility: "private",
  createdByUserId: "person",
  originUrl: "https://github.com/acme/fixture.git",
  storePath: "/fixture/repo.git",
  defaultBranch: "main",
  adoptedSha: null,
  autoTour: "inherit",
  autoSuggest: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: true,
  hotSessions: 0,
  createdAt: observedAt,
  updatedAt: observedAt,
};
const session = {
  id,
  projectId,
  worktreeId,
  worktree: "fix-login",
  branch: "mend/fix-login",
  harness: "codex",
  status: "completed",
  label: null,
  baseSha: "abc123",
  baseRef: null,
  summary: null,
  createdAt: observedAt,
};
const turn = {
  id: "turn-1",
  sessionId: id,
  ordinal: 1,
  input: "Fix login",
  status: "completed",
  createdAt: observedAt,
  startedAt: null,
  endedAt: null,
};
const request = {
  id: "request-1",
  sessionId: id,
  turnId: turn.id,
  kind: "command-approval",
  status: "pending",
  title: "Run tests",
  questions: null,
  detail: { command: "pnpm test" },
  createdAt: observedAt,
};
const change = { id: "change", projectId, worktreeId, sessionId: id, branch: session.branch };
const checkpoint = (name: string, ordinal: number) => ({
  id: name,
  ordinal,
  sha: `sha-${ordinal}`,
  sessionId: id,
  sealantRunId: "run",
  seq: "12",
  trigger: "turn-boundary",
  createdAt: observedAt,
});
const checkpointA = checkpoint("base", 0);
const checkpointB = checkpoint("end", 1);
const slice = {
  id: "slice",
  checkpointAId: "base",
  checkpointBId: "end",
  diffDigest: "digest",
  createdAt: observedAt,
};
const file = {
  oldPath: "src/auth.ts",
  newPath: "src/auth.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  binary: false,
  hunks: [{ oldStart: 40, oldLines: 3, newStart: 40, newLines: 4, contextHash: "hunk" }],
};
const pinned = {
  change,
  slice,
  checkpointA,
  checkpointB,
  files: [file],
  anchorFiles: [file],
  patch: "diff --git a/src/auth.ts b/src/auth.ts\n",
  worktreeChangedSinceSnapshot: false,
};
const comment = {
  id: "comment",
  changeId: "change",
  file: "src/auth.ts",
  line: 42,
  endLine: 42,
  authorKind: "reviewer",
  authorName: "Person",
  body: "Cover Safari",
  kind: "note",
  suggestion: null,
  state: "open",
  evidence: [],
  sentToSessionId: null,
  anchor: null,
  createdAt: observedAt,
  updatedAt: observedAt,
};
const png = Buffer.from("89504e470d0a1a0a01020304", "hex");
const proof = {
  artifact: {
    id: "proof",
    changeId: "change",
    sessionId: id,
    worktreeId,
    turnId: null,
    title: "Observed login",
    caption: null,
    source: { _tag: "Unknown", reason: "No checkpoint recorded" },
    observedFrom: observedAt,
    observedTo: observedAt,
    launch: null,
    differences: [],
    capture: {
      _tag: "Screenshot",
      media: {
        mimeType: "image/png",
        bytes: png.length,
        sha256: createHash("sha256").update(png).digest("hex"),
        blobKey: privateValue,
      },
    },
  },
  label: "Screenshot",
  mediaPath: "/proof-artifacts/proof/media",
};
const accounts = ["claude", "codex", "github"].map((provider) => ({
  id: provider,
  provider,
  name: "fixture",
  isDefault: true,
  status: "active",
  metadata: {},
}));

type Call = { readonly method: string; readonly url: string; readonly body: unknown };
type Route = {
  readonly method: string;
  readonly url: string | RegExp;
  readonly answer: unknown;
};
type Context = {
  readonly root: string;
  readonly env: Record<string, string>;
  readonly calls: Call[];
};
type Scenario = {
  readonly name: string;
  readonly args: ReadonlyArray<string> | ((context: Context, url: string) => ReadonlyArray<string>);
  readonly routes?: ReadonlyArray<Route>;
  readonly stdin?: string;
  readonly output?: string;
  readonly exit?: 0 | 1 | 2 | 3 | 4 | 124;
  readonly status?: string;
  readonly event?: string;
  readonly expected?: Record<string, unknown>;
  readonly refused?: boolean;
  readonly handle?: (call: Call, response: ServerResponse, context: Context) => boolean;
  readonly prepare?: (context: Context, url: string) => Promise<void> | void;
  readonly verify?: (events: ReadonlyArray<Record<string, unknown>>, context: Context) => void;
};
type CommandCase = {
  readonly success: ReadonlyArray<Scenario>;
  readonly error: ReadonlyArray<Scenario>;
};
const route = (method: string, url: string | RegExp, answer: unknown): Route => ({
  method,
  url,
  answer,
});
const get = (url: string | RegExp, answer: unknown) => route("GET", url, answer);
const post = (url: string | RegExp, answer: unknown) => route("POST", url, answer);
const commonRoutes = [
  get("/api/projects", [project]),
  get("/api/sessions", [session]),
  get(`/api/sessions/${id}`, { session, change, checkpoints: [checkpointA, checkpointB] }),
  get(`/api/projects/${projectId}/worktrees`, {
    worktrees: [{ id: worktreeId, name: "fix-login" }],
  }),
];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const send = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

let fixtureNumber = 0;
const observe = async (scenario: Scenario) => {
  const root = path.join(scratch, String(fixtureNumber++));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  const context: Context = {
    root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_STATE_HOME: path.join(root, "state"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      MEND_STORE_ROOT: path.join(root, "store"),
      CODEX_HOME: path.join(root, ".codex"),
      CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
      MEND_TOKEN: privateValue,
      // An isolated PATH prevents an onboarding test from reaching a real provider or daemon.
      PATH: bin,
    },
    calls: [],
  };
  const unexpected: string[] = [];
  const fake = await startFakeMend(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "";
    let text = "";
    for await (const chunk of req) text += String(chunk);
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // Media uploads intentionally are not JSON.
    }
    context.calls.push({ method, url, body });
    if (scenario.refused) return send(res, 403, { _tag: "Forbidden", message: "Not allowed" });
    if (scenario.handle?.({ method, url, body }, res, context)) return;
    if (url.endsWith("/screen/look") || url.endsWith("/media")) {
      res.writeHead(200, {
        "content-type": "image/png",
        "x-mend-screen-id": "screen",
        "x-mend-observed-at": observedAt,
      });
      res.end(png);
      return;
    }
    const match = [...(scenario.routes ?? []), ...commonRoutes].find(
      (entry) =>
        entry.method === method &&
        (typeof entry.url === "string" ? url === entry.url : entry.url.test(url)),
    );
    if (match !== undefined) return json(res, match.answer);
    unexpected.push(`${method} ${url}`);
    send(res, 500, { _tag: "UnexpectedFixtureRequest", message: "No fixture route" });
  });
  try {
    await scenario.prepare?.(context, fake.url);
    const args =
      typeof scenario.args === "function" ? scenario.args(context, fake.url) : scenario.args;
    const cli = startCli(
      fake.url,
      [
        ...args,
        ...(scenario.output === undefined ? [] : ["--out", path.join(root, scenario.output)]),
      ],
      context.env,
      root,
      scenario.stdin,
    );
    const exit = await cli.exited;
    await cli.closed;
    expect(exit, cli.stdout() + cli.stderr()).toEqual({ kind: "exit", code: scenario.exit ?? 0 });
    const lines = cli.stdout().trim().split("\n");
    expect(cli.stdout().trim(), "command must emit at least one JSON observation").not.toBe("");
    const events = lines.map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error(`Expected a JSON object, received ${line}`);
      expect(value).toMatchObject({ v: 1 });
      return value;
    });
    const last = events.at(-1);
    expect(last).toMatchObject(
      scenario.event === undefined
        ? { status: scenario.status ?? "done" }
        : { event: scenario.event },
    );
    if ((scenario.exit ?? 0) !== 0) {
      expect(last).toMatchObject({
        error: {
          code: expect.stringMatching(/\S/),
          message: expect.stringMatching(/\S/),
          fix: expect.stringMatching(/\S/),
        },
      });
    }
    if (scenario.expected !== undefined) expect(last).toMatchObject(scenario.expected);
    expect(cli.stdout() + cli.stderr()).not.toContain(privateValue);
    expect(unexpected).toEqual([]);
    expect(fake.upgradeCount(), "agent commands must not attach to an interactive terminal").toBe(
      0,
    );
    scenario.verify?.(events, context);
    expect(cli.stderr(), "--json must not print plain errors, progress, or prompts").toBe("");
    return events;
  } finally {
    await fake.close();
  }
};

export const registry = new Map<string, CommandCase>();
const register = (
  name: string,
  successes: ReadonlyArray<Scenario>,
  errors?: ReadonlyArray<Scenario>,
) => {
  if (successes.length === 0) throw new Error(`No success scenario for ${name}`);
  if (registry.has(name)) throw new Error(`Duplicate command scenarios for ${name}`);
  registry.set(name, {
    success: successes,
    error: [
      ...(errors ??
        successes.map((scenario) => ({
          ...scenario,
          name: `${scenario.name}, refused by the server`,
          exit: 1,
          status: "failed",
          expected: { error: { code: expect.any(String) } },
          refused: true,
          verify: (_events, context) => expect(context.calls.length).toBeGreaterThan(0),
        }))),
      usage([...name.split(" "), "--contract-unknown-flag"]),
    ],
  });
};
const success = (
  args: ReadonlyArray<string>,
  routes: ReadonlyArray<Route>,
  expected: Record<string, unknown>,
): Scenario => ({
  name: args.join(" "),
  args: [...args, "--json"],
  routes,
  expected,
});
const usage = (args: ReadonlyArray<string>): Scenario => ({
  name: `${args.join(" ")} needs explicit input without a TTY`,
  args: [...args, "--json"],
  exit: 2,
  status: "usage",
  expected: { error: { code: expect.any(String) } },
  verify: (_events, context) => expect(context.calls).toEqual([]),
});

register(
  "help",
  [success(["help", "resource", "start"], [], { data: expect.any(Object) })],
  [usage(["help", "no-such-command"])],
);
register(
  "agent install",
  [
    {
      ...success(["agent", "install"], [], {
        data: { installs: [{ agent: "codex", state: "installed" }] },
      }),
      prepare: ({ root }) => {
        fs.mkdirSync(path.join(root, ".codex"));
      },
      verify: (_events, { root }) => {
        expect(fs.readFileSync(path.join(root, ".codex/skills/mend/SKILL.md"), "utf8")).toBe(skill);
      },
    },
  ],
  [usage(["agent", "install"])],
);

const setupArgs = (context: Context, url: string) => [
  "server",
  "setup",
  "--yes",
  "--context",
  "saved-local",
  // The fake HTTP listener owns 127.0.0.1; setup checks a separate loopback bind before starting.
  "--bind",
  "127.0.0.2",
  "--version",
  "0.23.0",
  "--url",
  url,
  "--port",
  new URL(url).port,
  "--ssh-port",
  "65530",
  "--assets-dir",
  path.join(context.root, "assets"),
  "--offline",
  "--account-email",
  "person@example.invalid",
  "--account-name",
  "Person",
  "--json",
];
const prepareServer = ({ root }: Context) => {
  const bin = path.join(root, "bin");
  for (const [source, destination] of [
    ["lifecycle-docker.mjs", "docker"],
    ["docker-protocol.ts", "docker-protocol.ts"],
  ] as const) {
    fs.copyFileSync(
      new URL(`../test-fixtures/${source}`, import.meta.url),
      path.join(bin, destination),
    );
  }
  fs.chmodSync(path.join(bin, "docker"), 0o700);
  fs.writeFileSync(
    path.join(bin, "daemon.json"),
    JSON.stringify({
      appRunning: false,
      postgresRunning: false,
      version: "",
      fail: "",
      images: { "0.23.0": "0.23.0" },
      healthVersion: null,
    }),
  );
  fs.mkdirSync(path.join(root, "assets"));
  for (const name of ["compose.v2.yaml", "postgres-init.sh"]) {
    fs.copyFileSync(
      new URL(`../test-fixtures/docker/${name}`, import.meta.url),
      path.join(root, "assets", name),
    );
  }
};
const serverRoutes = [
  get("/api/instance", { users: "none" }),
  post("/api/auth/sign-up/email", {
    token: privateValue,
    user: { id: "person", email: "person@example.invalid", name: "Person" },
  }),
  get("/api/organization", { organization: { id: "org", name: "Fixture" } }),
  post("/api/me/devices", { token: privateValue, device: { id: "device" } }),
  post("/api/operator/password-resets", { path: "/reset#one-time-link", expiresAt: observedAt }),
  get("/api/operator/gate", [
    { id: "operator-present", ok: true, detail: "1 operator", fix: null },
  ]),
  get("/api/operator/exposure", { declared: "loopback", items: [] }),
];
const serverHealth: NonNullable<Scenario["handle"]> = (call, response, { root }) => {
  if (call.url !== "/api/health") return false;
  const state: unknown = JSON.parse(fs.readFileSync(path.join(root, "bin/daemon.json"), "utf8"));
  send(response, isRecord(state) && state.appRunning === true ? 200 : 503, {
    status: "ok",
    version: "0.23.0",
  });
  return true;
};
register(
  "server setup",
  [
    {
      name: "fresh setup and first account with the existing fake Docker protocol",
      args: setupArgs,
      prepare: prepareServer,
      routes: serverRoutes,
      handle: serverHealth,
      expected: { data: { version: "0.23.0", firstAccount: { signedIn: true } } },
      verify: (_events, { root }) => {
        expect(fs.existsSync(path.join(root, "config/mend/active"))).toBe(true);
        expect(fs.statSync(path.join(root, "config/mend/cli.json")).mode & 0o777).toBe(0o600);
      },
    },
  ],
  [usage(["server", "setup"])],
);
register(
  "server status",
  [
    {
      ...success(["server", "status"], serverRoutes, { data: { version: "0.23.0" } }),
      handle: serverHealth,
      prepare: async (context, url) => {
        prepareServer(context);
        const setup = startCli(url, setupArgs(context, url), context.env, context.root);
        expect(await setup.exited, setup.stdout() + setup.stderr()).toEqual({
          kind: "exit",
          code: 0,
        });
        await setup.closed;
      },
    },
  ],
  [
    {
      name: "status before setup",
      args: ["server", "status", "--json"],
      exit: 4,
      status: "not_ready",
    },
  ],
);

register(
  "login",
  [
    {
      ...success(
        ["login", "--timeout", "5s"],
        [
          post("/api/cli/auth", {
            deviceCode: privateValue,
            code: "ABCDEFGH",
            verifyPath: "/authorize?code=ABCDEFGH",
            expiresAt: "2099-01-01T00:00:00Z",
            expiresIn: 600,
            intervalSeconds: 1,
          }),
          post("/api/cli/auth/token", {
            status: "approved",
            token: privateValue,
            user: { id: "person", email: "person@example.invalid", name: "Person" },
            device: { id: "device", name: "shell" },
          }),
          get("/api/organization", { organization: { id: "org", name: "Fixture" } }),
        ],
        { account: { id: "person" } },
      ),
      event: "signed-in",
      verify: (events, { root }) => {
        expect(events[0]).toMatchObject({ v: 1, event: "authorize", code: "ABCDEFGH" });
        expect(fs.statSync(path.join(root, "config/mend/cli.json")).mode & 0o777).toBe(0o600);
      },
    },
  ],
  [{ ...success(["login", "--timeout", "5s"], [], {}), refused: true, exit: 1, status: "failed" }],
);

register(
  "logout",
  [
    {
      ...success(["logout"], [route("DELETE", "/api/me/devices/device", {})], {
        data: expect.any(Object),
      }),
      prepare: ({ root }, url) => {
        fs.mkdirSync(path.join(root, "config/mend"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "config/mend/cli.json"),
          JSON.stringify({ url, token: privateValue, deviceId: "device" }),
        );
      },
      verify: (_events, { root, calls }) => {
        expect(calls).toContainEqual({
          method: "DELETE",
          url: "/api/me/devices/device",
          body: null,
        });
        expect(fs.readFileSync(path.join(root, "config/mend/cli.json"), "utf8")).not.toContain(
          privateValue,
        );
      },
    },
  ],
  [usage(["logout", "unexpected"])],
);

register("adopt", [
  success(["adopt", "https://github.com/acme/fixture.git"], [post("/api/projects", project)], {
    data: { project: { id: projectId, name: "fixture" } },
  }),
]);
register("git check", [
  success(
    ["git", "check", "--project", projectId],
    [
      post(`/api/projects/${projectId}/git/check`, {
        read: { state: "ok", detail: "Refs readable" },
        push: { state: "ok", detail: "Dry run accepted" },
        observedAt,
      }),
    ],
    { data: { project: { id: projectId } } },
  ),
]);
register("connect status", [
  success(
    ["connect", "status"],
    [get("/api/me/sealant", { accounts }), get("/api/me/pi-profile", { profile: { revision: 1 } })],
    {
      data: {
        providers: expect.arrayContaining([
          expect.objectContaining({ provider: "codex", connected: true, selection: "chosen" }),
        ]),
      },
    },
  ),
]);

for (const provider of ["claude", "codex"]) {
  register(`connect ${provider}`, [
    {
      ...success(
        ["connect", provider, "--timeout", "5s"],
        [
          post("/api/me/sealant/accounts", {
            id: "account",
            provider,
            name: "fixture",
            status: "active",
          }),
        ],
        { data: { provider, account: { id: "account" } } },
      ),
      prepare: ({ root, env }) => {
        const executable = path.join(root, "bin", provider);
        const authorize =
          provider === "claude"
            ? "https://claude.ai/oauth/authorize?code_challenge=public"
            : "https://auth.openai.com/codex/device";
        const credential =
          provider === "claude"
            ? `printf '%s' '{"claudeAiOauth":{"refreshToken":"${privateValue}"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"`
            : `printf '%s' '{"tokens":{"refresh_token":"${privateValue}"}}' > "$CODEX_HOME/auth.json"`;
        fs.writeFileSync(
          executable,
          `#!/bin/sh\nprintf '%s\\n' '${authorize}' 'ABCD-EFGHJ'\n${credential}\n`,
          { mode: 0o700 },
        );
        env[provider === "claude" ? "MEND_CLAUDE_BIN" : "MEND_CODEX_BIN"] = executable;
      },
      verify: (events, { calls }) => {
        expect(events[0]).toMatchObject({ event: "authorize", provider });
        expect(calls).toContainEqual(
          expect.objectContaining({ method: "POST", url: "/api/me/sealant/accounts" }),
        );
      },
    },
  ]);
}
register("connect pi", [
  {
    ...success(
      ["connect", "pi"],
      [route("PUT", "/api/me/pi-profile", { profile: { revision: 1 }, changed: true })],
      { data: expect.any(Object) },
    ),
    prepare: ({ root }) => {
      fs.mkdirSync(path.join(root, ".pi/agent"), { recursive: true });
      fs.writeFileSync(path.join(root, ".pi/agent/settings.json"), "{}");
    },
  },
]);

register(
  "doctor",
  [
    success(
      ["doctor", "--harness", "codex", "--project", projectId],
      [
        get("/api/health", { status: "ok", version: "0.36.0" }),
        get("/api/sealant/connection", { status: "connected", baseUrl: "http://platform.invalid" }),
        get("/api/me/sealant", { accounts }),
        get("/api/removed-projects/disk", { projects: 0, bytes: 0, sharedBytes: 0 }),
        get("/api/machine", {
          exposure: {
            declared: "loopback",
            originScheme: "http",
            originOnMachine: true,
            arrivedVia: "direct",
            addressKinds: ["loopback"],
            gateOpen: 0,
          },
        }),
        post(`/api/projects/${projectId}/git/check`, {
          read: { state: "ok", detail: "Refs readable" },
          push: { state: "ok", detail: "Dry run accepted" },
          observedAt,
        }),
      ],
      { data: { items: expect.any(Array) } },
    ),
  ],
  [usage(["doctor", "--harness", "unknown", "--project", projectId])],
);

register("claude", [
  success(
    ["claude", "--detach", "--conversation", "--project", projectId, "Fix login"],
    [
      post(`/api/projects/${projectId}/sessions`, session),
      post(`/api/sessions/${id}/launch`, session),
    ],
    { data: { sessionId: id, worktree: "fix-login" } },
  ),
]);
register("wait", [
  success(
    ["wait", id, "--turn", "--timeout", "5s"],
    [
      get(`/api/sessions/${id}/turns`, [turn]),
      get(new RegExp(`/api/sessions/${id}/requests\\?`), []),
    ],
    { data: { turn: { id: turn.id, status: "completed" } } },
  ),
]);
register("history", [
  success(
    ["history", id],
    [
      get(new RegExp(`/api/sessions/${id}/history/turns\\?`), { turns: [turn], next: null }),
      get(new RegExp(`/api/sessions/${id}/history/items\\?`), { items: [], next: null }),
      get(new RegExp(`/api/sessions/${id}/history/requests\\?`), { requests: [], next: null }),
    ],
    { data: { turns: [{ id: turn.id }] } },
  ),
]);
register("respond", [
  success(
    ["respond", request.id, "--decision", "accept"],
    [post(`/api/requests/${request.id}/respond`, { ...request, status: "resolved" })],
    { data: expect.any(Object) },
  ),
  success(
    ["respond", request.id, "--answers", '{"question":["Safari"]}'],
    [post(`/api/requests/${request.id}/respond`, { ...request, status: "resolved" })],
    { data: expect.any(Object) },
  ),
]);
register(
  "message",
  [false, true].map((resume) =>
    success(
      ["message", id, "Cover Safari", ...(resume ? ["--resume"] : [])],
      [post(`/api/sessions/${id}/messages`, encodeReceipt(turnReceipt()))],
      { data: { result: { _tag: "Turn" } } },
    ),
  ),
);
register("interrupt", [
  success(
    ["interrupt", id],
    [
      get(`/api/sessions/${id}/turns`, [{ ...turn, status: "running" }]),
      post(`/api/turns/${turn.id}/interrupt`, {}),
    ],
    { data: { turnId: turn.id, interruptRequested: true } },
  ),
]);
register(
  "stop",
  [false, true].map((services) =>
    success(
      ["stop", id, ...(services ? ["--services"] : [])],
      [
        services
          ? post(`/api/sessions/${id}/services/stop`, { stopped: 2 })
          : post(`/api/sessions/${id}/stop`, { ...session, status: "stopped" }),
      ],
      { data: services ? { sessionId: id, stopped: 2 } : { sessionId: id, status: "stopped" } },
    ),
  ),
);
register("sessions", [success(["sessions"], [], { data: { sessions: [{ id }] } })]);
register("status", [success(["status"], [], { data: expect.any(Object) })]);

const reviewRoutes = [
  post("/api/changes/change/reviews/open", { slice, checkpointA, checkpointB }),
  get("/api/changes/change/reviews/slice/diff", pinned),
  get("/api/changes/change/comments", [comment]),
  get("/api/changes/change/passes", []),
  get("/api/changes/change/tour", null),
];
register("change", [
  success(["change", id], reviewRoutes, { data: { changeId: "change", slice: { id: "slice" } } }),
]);
register("diff", [
  success(["diff", id, "--slice", "slice"], reviewRoutes, { data: { patch: pinned.patch } }),
  success(
    ["diff", id, "--from", "base", "--to", "end"],
    [
      get(new RegExp(`/api/worktrees/${worktreeId}/diff\\?`), {
        worktreeId,
        from: checkpointA,
        to: checkpointB,
        fromSha: "sha-0",
        diff: pinned.patch,
        files: [file],
        truncated: false,
        omitted: [],
        listingCut: false,
      }),
    ],
    { data: { patch: pinned.patch } },
  ),
]);
register("comment add", [
  success(
    ["comment", "add", id, "src/auth.ts:42", "Cover Safari", "--slice", "slice"],
    [...reviewRoutes, post("/api/changes/change/reviews/slice/comments", comment)],
    { data: { comment: { id: "comment" } } },
  ),
]);
register("comment send", [
  success(
    ["comment", "send", id, "--slice", "slice"],
    [
      ...reviewRoutes,
      get(`/api/sessions/${id}/follow-up`, null),
      post(`/api/sessions/${id}/follow-up/deliver`, {
        id: "follow-up",
        reviewSliceId: "slice",
        checkpointAId: "base",
        checkpointBId: "end",
        diffDigest: "digest",
        commentIds: ["comment"],
        instruction: "Cover Safari",
        idempotencyKey: "saved-key",
        status: "delivered",
        deliveryProcessId: "process",
        deliverySealantRunId: "run",
        deliveryError: null,
        deliveredAt: observedAt,
      }),
    ],
    { data: { status: "delivered", requestKey: "saved-key" } },
  ),
]);
register("land", [
  success(
    ["land", id],
    [
      post(`/api/sessions/${id}/land`, {
        landing: {
          remoteBranch: session.branch,
          pushedSha: "pushed",
          commitSha: null,
          checkpointSha: "checkpoint",
          outcome: "pull-request",
          message: null,
          pullRequest: {
            number: 412,
            url: "https://github.com/acme/fixture/pull/412",
            state: "open",
            observedAt,
          },
        },
        pullRequest: { _tag: "off" },
      }),
    ],
    { data: { landing: { pushedSha: "pushed" } } },
  ),
]);

register("service list", [
  success(
    ["service", "list", id],
    [
      get("/api/services", [
        {
          service: {
            id: "service",
            sessionId: id,
            name: "web",
            workspacePort: 3000,
            transport: "tcp",
            currentAttemptId: "attempt",
          },
          attempts: [{ id: "attempt", status: "running" }],
          currentForward: { state: "running" },
          latestObservation: { state: "ready", lastObservedAt: observedAt, error: null },
          endpoints: [],
        },
      ]),
    ],
    { data: { services: [{ id: "service" }] } },
  ),
]);
register("preview", [
  success(
    ["preview", id],
    [
      get(`/api/worktrees/${worktreeId}/previews`, {
        starting: false,
        routing: "ready",
        unprepared: null,
        previews: [
          {
            preview: { id: "preview", label: "web", serviceName: "web", state: "kept" },
            status: "Ready",
            binding: { _tag: "Bound", serviceId: "service", attemptId: "attempt" },
            open: { url: `https://fixture.invalid/?ticket=${privateValue}` },
          },
        ],
      }),
    ],
    { data: { sessionId: id, previews: [{ id: "preview" }] } },
  ),
]);
register("screen look", [
  {
    name: "save an observed screen",
    args: ["screen", "look", id, "--json"],
    output: "screen.png",
    expected: { data: { screenId: "screen", bytes: png.length } },
    verify: (_events, { root }) =>
      expect(fs.readFileSync(path.join(root, "screen.png"))).toEqual(png),
  },
]);
register("proof list", [
  success(["proof", "list", id], [get("/api/changes/change/proof-artifacts", [proof])], {
    data: { artifacts: [{ id: "proof" }] },
  }),
]);
register("proof get", [
  {
    ...success(["proof", "get", "proof"], [get("/api/proof-artifacts/proof", proof)], {
      data: { artifact: { id: "proof" }, bytes: png.length },
    }),
    output: "proof.png",
    verify: (_events, { root }) =>
      expect(fs.readFileSync(path.join(root, "proof.png"))).toEqual(png),
  },
]);

const resourceContext = ["--project-id", projectId, "--worktree-id", worktreeId];
register("resource list", [
  success(
    ["resource", "list", ...resourceContext],
    [
      get(/\/api\/projects\/[^/]+\/resources\?/, {
        settings: [],
        file: { kind: "absent", worktreeId, observed: "observed at capture 1" },
      }),
    ],
    { data: { settings: [] } },
  ),
]);
register("resource add", [
  success(
    ["resource", "add", "db", "--preset", "postgres", "--version", "17", ...resourceContext],
    [
      post(`/api/projects/${projectId}/worktrees/resources`, {
        kind: "written",
        path: ".mend/mend.toml",
        worktree: "fix-login",
        table: "[resource.db]\npreset = 'postgres'",
        statusLine: "@db declared",
      }),
    ],
    { data: { kind: "written" } },
  ),
]);
register("resource start", [
  success(
    ["resource", "start", "db", "--project", ...resourceContext, "--wait", "--timeout", "5s"],
    [
      post(/\/api\/projects\/[^/]+\/resources\/db\/start\?/, {
        kind: "started",
        instance: "running",
        statusLine: "@db running",
        message: "Started",
      }),
    ],
    { data: { instance: "running" } },
  ),
]);
register("resource stop", [
  success(
    ["resource", "stop", "db", "--project", ...resourceContext],
    [
      post(/\/api\/projects\/[^/]+\/resources\/db\/stop\?/, {
        statusLine: "@db stopped",
        message: null,
      }),
    ],
    { data: { statusLine: "@db stopped" } },
  ),
]);
register("resource env", [
  success(
    ["resource", "env", ...resourceContext],
    [
      get(/\/api\/projects\/[^/]+\/worktrees\/[^/]+\/resources\/env\?/, {
        env: { DATABASE_URL: `postgresql://person:${privateValue}@db/app` },
        exports: [`export DATABASE_URL='postgresql://person:${privateValue}@db/app'`],
        statusLines: ["@db project database"],
      }),
    ],
    { data: { names: ["DATABASE_URL"], statusLines: ["@db project database"] } },
  ),
]);
register("resource load", [
  success(
    [
      "resource",
      "load",
      "db",
      ...resourceContext,
      "--pull",
      "postgresql://fixture.invalid/app",
      "--timeout",
      "5s",
    ],
    [
      post(/\/api\/projects\/[^/]+\/resource-loads\?/, {
        id: "load",
        phase: "done",
        bytesDone: 9,
        bytesTotal: 9,
        statusLine: "@db loaded",
      }),
    ],
    { data: { projectId, worktreeId, load: { id: "load", phase: "done" } } },
  ),
]);
register("resource use", [
  success(
    ["resource", "use", "db", "project", ...resourceContext],
    [
      route("PUT", /\/resources\/db\/selection\?/, {
        statusLine: "@db uses project",
        message: null,
      }),
    ],
    { data: { statusLine: "@db uses project" } },
  ),
]);
register("resource remove", [
  success(
    ["resource", "remove", "db", "--project", ...resourceContext],
    [route("DELETE", `/api/projects/${projectId}/resources/db`, { statusLine: "@db removed" })],
    { data: { statusLine: "@db removed" } },
  ),
]);
register("resource reset", [
  success(
    ["resource", "reset", "db", ...resourceContext],
    [post(/\/resources\/db\/reset\?/, { statusLine: "@db reset" })],
    { data: { statusLine: "@db reset" } },
  ),
]);

register("projects", [success(["projects"], [], { data: { projects: [{ id: projectId }] } })]);
register("projects rm", [
  success(
    ["projects", "rm", projectId],
    [
      route("DELETE", `/api/projects/${projectId}`, {
        removed: true,
        leftover: null,
        retained: true,
        message: "Removed, files retained",
      }),
    ],
    { data: { removed: true, retained: true } },
  ),
]);
register("projects removed", [
  success(
    ["projects", "removed"],
    [
      get("/api/removed-projects", [
        {
          id: projectId,
          name: project.name,
          organizationId: "org",
          visibility: "private",
          createdByUserId: "person",
          removedAt: observedAt,
          removedByUserId: "person",
          state: "removed",
          rights: { restore: true, purge: true },
        },
      ]),
    ],
    { data: { removed: [{ id: projectId }] } },
  ),
]);
register("projects restore", [
  success(
    ["projects", "restore", projectId],
    [post(`/api/removed-projects/${projectId}/restore`, project)],
    { data: expect.any(Object) },
  ),
]);
register("projects purge", [
  success(
    ["projects", "purge", projectId, "--confirm", "fixture"],
    [
      post(`/api/removed-projects/${projectId}/purge`, {
        id: projectId,
        purged: true,
        alreadyPurged: false,
        message: "Purged",
      }),
    ],
    { data: { purged: true } },
  ),
]);
register(
  "projects image",
  [undefined, "on", "off"].map((screen) =>
    success(
      ["projects", "image", projectId, ...(screen === undefined ? [] : ["--screen", screen])],
      [
        get("/api/organization/settings", { effective: { workspaceImage: image } }),
        route("PUT", `/api/projects/${projectId}/workspace-image`, {
          saved: true,
          project: { ...project, workspaceImage: { ...image, screen: screen === "on" } },
          resolutions: [],
        }),
      ],
      { data: expect.any(Object) },
    ),
  ),
);

export const commandSuites = {
  onboarding: [
    "help",
    "agent install",
    "server setup",
    "server status",
    "login",
    "logout",
    "adopt",
    "git check",
    "connect status",
    "connect claude",
    "connect codex",
    "connect pi",
    "doctor",
  ],
  conversation: [
    "claude",
    "wait",
    "history",
    "respond",
    "message",
    "interrupt",
    "stop",
    "sessions",
    "status",
  ],
  review: ["change", "diff", "comment add", "comment send", "land"],
  observation: ["service list", "preview", "screen look", "proof list", "proof get"],
  resources: [
    "resource list",
    "resource add",
    "resource start",
    "resource stop",
    "resource env",
    "resource load",
    "resource use",
    "resource remove",
    "resource reset",
  ],
  projects: [
    "projects",
    "projects rm",
    "projects removed",
    "projects restore",
    "projects purge",
    "projects image",
  ],
};
const assignedCommands = Object.values(commandSuites).flat();
export const uncoveredCommands = (markdown: string) =>
  skillCommands(markdown).filter(
    (name) => !personOnly.has(name) && (!registry.has(name) || !assignedCommands.includes(name)),
  );
export const mentioned = skillCommands(skill);

export const runSkillContractSuite = (suite: keyof typeof commandSuites) => {
  describe(`the bundled skill's ${suite} JSON v1 contract`, spawning, () => {
    for (const name of commandSuites[suite]) {
      const entry = registry.get(name);
      if (entry === undefined) throw new Error(`No command scenarios for ${name}`);
      describe(`mend ${name}`, () => {
        for (const [outcome, scenarios] of [
          ["success", entry.success],
          ["error", entry.error],
        ] as const) {
          for (const scenario of scenarios) {
            it(`${outcome}: ${scenario.name}`, async () => {
              await observe(scenario);
            });
          }
        }
      });
    }
  });
};
