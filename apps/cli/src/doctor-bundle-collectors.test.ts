import { describe, expect, it } from "vitest";

import {
  type BundleDeps,
  bundleCollectors,
  cliCollector,
  serverConfigCollector,
  serverLogsCollector,
  sessionsCollector,
  toolsCollector,
  workspaceLogsCollector,
} from "./doctor-bundle-collectors.ts";
import type { ServerProcessOutput } from "./server-runtime.ts";
import type { ServerInstallationFacts } from "./server-setup.ts";

const ok = (stdout: string): ServerProcessOutput => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): ServerProcessOutput => ({ status: 1, stdout: "", stderr });

const server: ServerInstallationFacts = {
  directory: "/home/u/.config/mend/generations/gen-1",
  config: {
    schemaVersion: 2,
    assetContract: "v2",
    serverVersion: "0.31.0",
    dockerContext: "orbstack",
    dockerEndpoint: "unix:///Users/u/.orbstack/run/docker.sock",
    dockerSocket: "/var/run/docker.sock",
    dockerSocketSource: "detected",
    bind: "0.0.0.0",
    appUrl: "http://100.70.80.90:3105",
    allowedOrigins: [],
    appPort: 3105,
    sshPort: 2222,
    bucket: "garage",
  },
  compose: "services:\n  mend:\n    image: ghcr.io/sealant-sh/mend:${MEND_VERSION}\n",
  envKeys: ["MEND_VERSION", "POSTGRES_PASSWORD", "APP_URL"],
};

type Runner = BundleDeps["run"];

/** A runner that answers by the joined argv, and records what was asked. */
const runner = (
  answers: Readonly<Record<string, ServerProcessOutput>>,
): { readonly run: Runner; readonly calls: Array<string> } => {
  const calls: Array<string> = [];
  return {
    calls,
    run: async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
      return match === undefined ? failed(`no answer for ${key}`) : match[1];
    },
  };
};

const deps = (overrides: Partial<BundleDeps> = {}): BundleDeps => ({
  cliVersion: "0.31.0",
  serverUrl: "https://mend.example",
  configuredUrl: "https://mend.example",
  deviceId: "device-1",
  tokenSaved: true,
  env: {
    PATH: "/usr/bin",
    TERM: "xterm-256color",
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    MEND_TOKEN: "secret",
    MEND_URL: "x",
    HOME: "/h",
  },
  stdinTty: true,
  stdoutTty: false,
  get: async () => {
    throw new Error("no fake route");
  },
  doctor: async () => "✓ server ok\n",
  accounts: async () => "platform user u1\n",
  run: async (command, args) => failed(`${command} ${args.join(" ")}: not faked`),
  readServer: async () => server,
  pathOf: () => null,
  tail: 3,
  ...overrides,
});

describe("cliCollector", () => {
  it("records the environment as names only, never the token", async () => {
    const [file] = await cliCollector(deps()).collect();
    const parsed = JSON.parse(file?.content ?? "{}");
    expect(parsed.cliVersion).toBe("0.31.0");
    expect(parsed.mendEnvNames).toEqual(["MEND_TOKEN", "MEND_URL"]);
    expect(parsed.deviceId).toBe("device-1");
    expect(parsed.tokenSaved).toBe(true);
    expect(parsed.term).toBe("xterm-256color");
    expect(parsed.stdinTty).toBe(true);
    expect(parsed.stdoutTty).toBe(false);
    expect(file?.content).not.toContain("secret");
  });
});

describe("serverConfigCollector", () => {
  it("writes the config with the .env keys and the compose file, or the no-server fact", async () => {
    const files = await serverConfigCollector(async () => server).collect();
    expect(files.map((file) => file.path)).toEqual(["server-config.json", "server-compose.yaml"]);
    const parsed = JSON.parse(files[0]?.content ?? "{}");
    expect(parsed.config.dockerContext).toBe("orbstack");
    expect(parsed.envKeys).toEqual(["MEND_VERSION", "POSTGRES_PASSWORD", "APP_URL"]);
    expect(files[1]?.content).toContain("ghcr.io/sealant-sh/mend");
    await expect(serverConfigCollector(async () => null).collect()).rejects.toThrow(
      "no Mend server is installed",
    );
  });
});

describe("serverLogsCollector", () => {
  it("reads each Compose service's tail through the generation's compose file", async () => {
    const { run, calls } = runner({
      "docker --context orbstack compose --project-name mend --project-directory /home/u/.config/mend/generations/gen-1 --env-file /home/u/.config/mend/generations/gen-1/server.env -f /home/u/.config/mend/generations/gen-1/compose.yaml ps --all --services":
        ok("mend\npostgres\n"),
      "docker --context orbstack compose --project-name mend --project-directory /home/u/.config/mend/generations/gen-1 --env-file /home/u/.config/mend/generations/gen-1/server.env -f /home/u/.config/mend/generations/gen-1/compose.yaml logs --no-color --tail 3 mend":
        ok("mend-1  | listening\n"),
      "docker --context orbstack compose --project-name mend --project-directory /home/u/.config/mend/generations/gen-1 --env-file /home/u/.config/mend/generations/gen-1/server.env -f /home/u/.config/mend/generations/gen-1/compose.yaml logs --no-color --tail 3 postgres":
        { status: 0, stdout: "pg ready\n", stderr: "warning\n" },
    });
    const files = await serverLogsCollector(deps({ run }), async () => server).collect();
    expect(files).toEqual([
      { path: "server-logs/mend.log", content: "mend-1  | listening\n" },
      { path: "server-logs/postgres.log", content: "pg ready\n--- stderr ---\nwarning\n" },
    ]);
    expect(calls).toHaveLength(3);
  });

  it("fails as a whole when there is no server or no containers", async () => {
    await expect(serverLogsCollector(deps(), async () => null).collect()).rejects.toThrow(
      "no Mend server is installed",
    );
    const { run } = runner({ "docker --context orbstack compose": ok("\n") });
    await expect(serverLogsCollector(deps({ run }), async () => server).collect()).rejects.toThrow(
      "no Compose containers found",
    );
  });
});

const psRow = (row: Record<string, string>): string => `${JSON.stringify(row)}\n`;

const dockerAnswers = {
  "docker --context orbstack version": ok("Client: 29.0\nServer: 29.0\n"),
  "docker --context orbstack info": ok("Kernel Version: 6.1\nCgroup Driver: cgroupfs\n"),
  "docker context ls": ok("NAME  DESCRIPTION\norbstack  OrbStack\n"),
  "docker --context orbstack ps --all --no-trunc --format {{json .}} --filter label=com.docker.compose.project=mend":
    ok(
      psRow({
        ID: "aaa",
        Names: "mend-mend-1",
        Image: "ghcr.io/sealant-sh/mend:0.31.0",
        State: "running",
        Status: "Up 2 hours",
        Labels: "com.docker.compose.project=mend",
      }),
    ),
  "docker --context orbstack ps --all --no-trunc --format {{json .}} --filter name=sealant-": ok(
    psRow({
      ID: "bbb",
      Names: "sealant-run1",
      Image: "wt:1",
      State: "running",
      Status: "Up 1 minute",
      Labels: "",
    }) +
      psRow({
        ID: "ccc",
        Names: "sealant-run0",
        Image: "wt:1",
        State: "exited",
        Status: "Exited (1) 3 hours ago",
        Labels: "",
      }),
  ),
  "docker --context orbstack ps --all --no-trunc --format {{json .}} --filter label=sealant.workspace":
    ok(
      psRow({
        ID: "bbb",
        Names: "sealant-run1",
        Image: "wt:1",
        State: "running",
        Status: "Up 1 minute",
        Labels: "",
      }),
    ),
  "docker --context orbstack inspect aaa ccc bbb": ok(
    JSON.stringify([
      {
        Id: "aaa",
        Name: "/mend-mend-1",
        Image: "sha256:img",
        Config: {
          Image: "ghcr.io/sealant-sh/mend:0.31.0",
          Env: ["DATABASE_URL=postgres://u:p@h/db", "MEND_PORT=3105"],
          Labels: { a: "b" },
        },
        HostConfig: { Privileged: true, Runtime: "runc", Mounts: [] },
        State: { Status: "running", ExitCode: 0 },
        Mounts: [
          {
            Type: "bind",
            Source: "/var/run/docker.sock",
            Destination: "/var/run/docker.sock",
            Mode: "",
            RW: true,
          },
        ],
      },
    ]),
  ),
  "docker --context orbstack logs --tail 3 bbb": {
    status: 0,
    stdout: "sealantd: pty open\n",
    stderr: "dotfiles: none\n",
  },
};

describe("dockerCollector", () => {
  it("reports version, info, contexts, the Mend and workspace containers, and inspect with Env names only", async () => {
    const { run } = runner(dockerAnswers);
    const [docker] = bundleCollectors(deps({ run })).filter((c) => c.name === "docker");
    const [file] = await docker!.collect();
    const text = file?.content ?? "";
    expect(file?.path).toBe("docker.txt");
    expect(text).toContain("# docker version (--context orbstack)");
    expect(text).toContain("Cgroup Driver: cgroupfs");
    expect(text).toContain("orbstack  OrbStack");
    expect(text).toContain("aaa  mend-mend-1");
    expect(text).toContain("bbb  sealant-run1");
    expect(text).toContain("ccc  sealant-run0");
    expect(text).toContain('"privileged": true');
    expect(text).toContain('"envNames": [\n      "DATABASE_URL",\n      "MEND_PORT"\n    ]');
    expect(text).not.toContain("postgres://u:p@h/db");
    expect(text).toContain('"source": "/var/run/docker.sock"');
  });

  it("fails as a whole when docker itself does not answer", async () => {
    const { run } = runner({
      "docker --context orbstack version": failed("Cannot connect to the Docker daemon"),
    });
    const [docker] = bundleCollectors(deps({ run })).filter((c) => c.name === "docker");
    await expect(docker!.collect()).rejects.toThrow("Cannot connect to the Docker daemon");
  });

  it("runs without a server config, against the default context", async () => {
    const { run, calls } = runner({
      "docker version": ok("Client: 29.0\n"),
      "docker info": ok("x"),
      "docker context ls": ok("y"),
      "docker ps": ok(""),
    });
    const [docker] = bundleCollectors(deps({ run, readServer: async () => null })).filter(
      (c) => c.name === "docker",
    );
    const [file] = await docker!.collect();
    expect(file?.content).toContain("# docker version\n");
    expect(calls[0]).toBe("docker version");
  });
});

describe("workspaceLogsCollector", () => {
  it("tails only the running workspace containers", async () => {
    const { run } = runner(dockerAnswers);
    const [workspace] = bundleCollectors(deps({ run })).filter((c) => c.name === "workspace-logs");
    expect(await workspace!.collect()).toEqual([
      {
        path: "workspace-logs/sealant-run1.log",
        content: "sealantd: pty open\n--- stderr ---\ndotfiles: none\n",
      },
    ]);
  });

  it("says so when none is running", async () => {
    const { run } = runner({
      "docker version": ok("x"),
      "docker info": ok("x"),
      "docker context ls": ok("y"),
      "docker ps": ok(""),
    });
    const [workspace] = bundleCollectors(deps({ run, readServer: async () => null })).filter(
      (c) => c.name === "workspace-logs",
    );
    const files = await workspace!.collect();
    expect(files[0]?.path).toBe("workspace-logs.txt");
    expect(files[0]?.content).toContain("no running workspace container observed");
  });

  it("is the docker collector's failure too", async () => {
    const { run } = runner({});
    expect(workspaceLogsCollector).toBeTypeOf("function");
    const [workspace] = bundleCollectors(deps({ run })).filter((c) => c.name === "workspace-logs");
    await expect(workspace!.collect()).rejects.toThrow("docker version failed");
  });
});

const process1 = {
  id: "proc-1",
  kind: "agent-pty",
  label: "claude",
  harness: "claude",
  serviceId: null,
  sealantSessionId: "is-1",
  argv: ["claude", "--print"],
  status: "exited",
  exitCode: 1,
  createdAt: "2026-09-26T09:00:00Z",
  exitedAt: "2026-09-26T09:00:05Z",
};
const process2 = {
  ...process1,
  id: "proc-2",
  kind: "service",
  label: "web",
  harness: null,
  serviceId: "svc-1",
  sealantSessionId: null,
  argv: ["pnpm", "dev"],
  status: "stopped",
  exitCode: null,
};

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

describe("sessionsCollector", () => {
  it("lists every session of every project, writes each detail, and tails each record", async () => {
    const routes: Record<string, unknown> = {
      "/projects": [
        { id: "p1", name: "api" },
        { id: "p2", name: "web" },
      ],
      "/projects/p1?deadEnds=include": {
        project: { id: "p1", name: "api" },
        sessions: [
          {
            id: "s-old",
            projectId: "p1",
            harness: "claude",
            label: null,
            status: "exited",
            worktree: "/w/old",
            branch: "mend/old",
            createdAt: "2026-09-25T00:00:00Z",
          },
          {
            id: "s-new",
            projectId: "p1",
            harness: "claude",
            label: "fix",
            status: "running",
            worktree: "/w/new",
            branch: "mend/new",
            createdAt: "2026-09-26T00:00:00Z",
          },
        ],
      },
      "/projects/p2?deadEnds=include": {
        project: { id: "p2", name: "web" },
        sessions: [
          {
            id: "s-web",
            projectId: "p2",
            harness: "codex",
            label: null,
            status: "idle",
            worktree: "/w/web",
            branch: "mend/web",
            createdAt: "2026-09-24T00:00:00Z",
          },
        ],
      },
      "/sessions/s-new": {
        session: { id: "s-new" },
        processes: [process1, process2],
        liveServices: 1,
      },
      "/sessions/s-old": { session: { id: "s-old" }, processes: [], liveServices: 0 },
      "/processes/proc-1/logs?from=0&limit=1000": {
        nextFrom: "2",
        status: "exited",
        chunks: [
          { sequence: "0", dataBase64: b64("line1\nline2\n") },
          { sequence: "1", dataBase64: b64("line3\n") },
        ],
      },
      "/processes/proc-1/logs?from=2&limit=1000": {
        nextFrom: "3",
        status: "exited",
        chunks: [
          {
            sequence: "2",
            dataBase64: b64(
              "line4\nInput must be provided either through stdin or as a prompt argument when using --print\n",
            ),
          },
        ],
      },
      "/processes/proc-1/logs?from=3&limit=1000": { nextFrom: "3", status: "exited", chunks: [] },
    };
    const get = async <T>(route: string): Promise<T> => {
      if (route === "/sessions/s-web") throw new Error("GET /sessions/s-web → 500");
      const value = routes[route];
      if (value === undefined) throw new Error(`no fake route ${route}`);
      return value as T;
    };
    const files = await sessionsCollector(deps({ get })).collect();
    expect(files.map((file) => file.path)).toEqual([
      "sessions.json",
      "sessions/s-new.json",
      "sessions/s-new-record.txt",
      "sessions/s-old.json",
      "sessions/s-web.error.txt",
    ]);
    const summary = JSON.parse(files[0]?.content ?? "{}");
    expect(summary.projects).toBe(2);
    expect(summary.sessions).toBe(3);
    expect(summary.recordTailLines).toBe(3);
    expect(summary.rows.map((row: { id: string }) => row.id)).toEqual(["s-new", "s-old", "s-web"]);
    const newest = summary.rows[0];
    expect(newest.project).toBe("api");
    expect(newest.processes).toEqual([
      expect.objectContaining({
        id: "proc-1",
        kind: "agent-pty",
        exitCode: 1,
        argv: ["claude", "--print"],
        recorded: true,
      }),
      expect.objectContaining({ id: "proc-2", kind: "service", recorded: false }),
    ]);
    expect(newest.services).toBe(1);
    expect(newest.liveServices).toBe(1);
    expect(newest.record).toBe("sessions/s-new-record.txt");
    expect(summary.rows[1].record).toBeNull();
    expect(summary.rows[2].detail).toBe("sessions/s-web.error.txt");
    const record = files.find((file) => file.path === "sessions/s-new-record.txt")?.content ?? "";
    expect(record).toContain("last 3 lines of each");
    expect(record).toContain(
      "== proc-1 · agent-pty · claude · exited · exit 1 · argv: claude --print",
    );
    expect(record).toContain("(3 chunks in 3 page(s) · record exited)");
    expect(record).not.toContain("line1");
    expect(record).toContain("line3\nline4\nInput must be provided");
    expect(record).not.toContain("proc-2");
  });

  it("writes the read failure into the record instead of failing the session", async () => {
    const get = async <T>(route: string): Promise<T> => {
      const routes: Record<string, unknown> = {
        "/projects": [{ id: "p1", name: "api" }],
        "/projects/p1?deadEnds=include": {
          project: { id: "p1", name: "api" },
          sessions: [
            {
              id: "s1",
              projectId: "p1",
              harness: "claude",
              label: null,
              status: "exited",
              worktree: "/w",
              branch: "b",
              createdAt: "2026-09-26T00:00:00Z",
            },
          ],
        },
        "/sessions/s1": { session: { id: "s1" }, processes: [process1] },
      };
      const value = routes[route];
      if (value === undefined) throw new Error("This process has no interactive-session pointer");
      return value as T;
    };
    const files = await sessionsCollector(deps({ get })).collect();
    const record = files.find((file) => file.path === "sessions/s1-record.txt")?.content ?? "";
    expect(record).toContain("read failed: This process has no interactive-session pointer");
  });
});

const fakePathOf = (command: string): string | null =>
  command === "codex" || command === "docker" ? null : `/usr/local/bin/${command}`;

describe("toolsCollector", () => {
  it("prints each tool's path and version, or that it is not on PATH", async () => {
    const { run } = runner({
      "claude --version": ok("2.1.0 (Claude Code)\n"),
      "gh --version": ok(
        "gh version 2.80.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.80.0\n",
      ),
      "git --version": failed("boom"),
    });
    const [file] = await toolsCollector(deps({ run, pathOf: fakePathOf })).collect();
    expect(file?.content).toBe(
      [
        "claude   /usr/local/bin/claude · 2.1.0 (Claude Code)",
        "codex    not on PATH",
        "gh       /usr/local/bin/gh · gh version 2.80.0 (2026-09-01)",
        "git      /usr/local/bin/git · --version exit 1",
        "docker   not on PATH",
        "",
      ].join("\n"),
    );
  });
});

describe("bundleCollectors", () => {
  it("runs the ten collectors in the documented order", () => {
    expect(bundleCollectors(deps()).map((collector) => collector.name)).toEqual([
      "cli",
      "doctor",
      "server-health",
      "server-config",
      "docker",
      "server-logs",
      "workspace-logs",
      "sessions",
      "accounts",
      "tools",
    ]);
  });
});
