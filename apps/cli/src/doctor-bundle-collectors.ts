import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { BundleFile, Collector } from "./doctor-bundle.ts";
import { serverComposeArgs, type ServerProcessOutput } from "./server-runtime.ts";
import type { ServerInstallationFacts } from "./server-setup.ts";

/**
 * The collectors behind `mend doctor --bundle`, each parameterised on what it reads so a test can
 * hand it a fake API, a fake process runner and a fake server store. Nothing here prints;
 * everything here returns files. Secrets are the bundle writer's problem (one redactor over every
 * file), but the collectors still keep values out where a name is enough: environment variable
 * names, `.env` keys, container `Env` names.
 */

export interface BundleDeps {
  readonly cliVersion: string;
  readonly serverUrl: string;
  readonly configuredUrl: string | null;
  readonly deviceId: string | null;
  readonly tokenSaved: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinTty: boolean;
  readonly stdoutTty: boolean;
  /** An authenticated GET that throws with the server's words on any failure. */
  readonly get: <T>(route: string) => Promise<T>;
  /** The `mend doctor` lines, unpainted. */
  readonly doctor: () => Promise<string>;
  /** The `mend accounts` lines. */
  readonly accounts: () => Promise<string>;
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    timeoutMs: number,
  ) => Promise<ServerProcessOutput>;
  /** The active server generation's non-secret facts; null when no server is installed here. */
  readonly readServer: () => Promise<ServerInstallationFacts | null>;
  /** The executable's path on PATH, or null. */
  readonly pathOf: (command: string) => string | null;
  /** Lines per log and per record. */
  readonly tail: number;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

const stringField = (value: unknown, key: string): string | null => {
  const found = field(value, key);
  return typeof found === "string" ? found : null;
};

const stringList = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The command's stdout, or its failure in words; never a throw for a missing tool. */
const outputOrFailure = (output: ServerProcessOutput): string => {
  if (output.error !== undefined) return `failed: ${output.error}`;
  if (output.status !== 0)
    return `exit ${output.status ?? "unknown"}\n${output.stderr.trim() || output.stdout.trim()}`;
  return output.stdout.trimEnd();
};

const failedOutput = (output: ServerProcessOutput, what: string): Error =>
  new Error(
    `${what}: ${output.error ?? `exit ${output.status ?? "unknown"}`}${
      output.stderr.trim() === "" ? "" : `\n${output.stderr.trim()}`
    }`,
  );

const lastLines = (text: string, count: number): string => {
  const lines = text.split("\n");
  return lines.length <= count ? text : lines.slice(lines.length - count).join("\n");
};

const mapLimit = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const results: Array<R> = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

/** The executable's path, the way `command -v` finds it. */
export const pathOf = (command: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  for (const directory of (env["PATH"] ?? "").split(path.delimiter)) {
    if (directory === "") continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
};

// ── cli.json ──────────────────────────────────────────────────────────────

export const cliCollector = (deps: BundleDeps): Collector => ({
  name: "cli",
  collect: async () => [
    {
      path: "cli.json",
      content: json({
        collectedAt: new Date().toISOString(),
        cliVersion: deps.cliVersion,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        osType: os.type(),
        osRelease: os.release(),
        hostname: os.hostname(),
        term: deps.env["TERM"] ?? null,
        shell: deps.env["SHELL"] ?? null,
        lang: deps.env["LANG"] ?? null,
        stdinTty: deps.stdinTty,
        stdoutTty: deps.stdoutTty,
        serverUrl: deps.serverUrl,
        configuredUrl: deps.configuredUrl,
        deviceId: deps.deviceId,
        tokenSaved: deps.tokenSaved,
        mendEnvNames: Object.keys(deps.env)
          .filter((name) => name.startsWith("MEND_"))
          .toSorted(),
      }),
    },
  ],
});

// ── doctor.txt ────────────────────────────────────────────────────────────

export const doctorCollector = (deps: BundleDeps): Collector => ({
  name: "doctor",
  collect: async () => [{ path: "doctor.txt", content: await deps.doctor() }],
});

// ── server-health.json ────────────────────────────────────────────────────

export const serverHealthCollector = (deps: BundleDeps): Collector => ({
  name: "server-health",
  collect: async () => [
    { path: "server-health.json", content: json(await deps.get<unknown>("/health")) },
  ],
});

// ── server-config.json + server-compose.yaml ──────────────────────────────

const NO_SERVER = "no Mend server is installed on this machine (mend server setup installs one)";

/** The server facts once, shared by the config, logs and docker collectors. */
const serverFactsOnce = (deps: BundleDeps): (() => Promise<ServerInstallationFacts | null>) => {
  let pending: Promise<ServerInstallationFacts | null> | null = null;
  return () => {
    pending ??= deps.readServer();
    return pending;
  };
};

export const serverConfigCollector = (
  facts: () => Promise<ServerInstallationFacts | null>,
): Collector => ({
  name: "server-config",
  collect: async () => {
    const server = await facts();
    if (server === null) throw new Error(NO_SERVER);
    return [
      {
        path: "server-config.json",
        content: json({
          directory: server.directory,
          config: server.config,
          envKeys: server.envKeys,
        }),
      },
      { path: "server-compose.yaml", content: server.compose },
    ];
  },
});

// ── server-logs/<service>.log ─────────────────────────────────────────────

const COMPOSE_TIMEOUT_MS = 30_000;

export const serverLogsCollector = (
  deps: BundleDeps,
  facts: () => Promise<ServerInstallationFacts | null>,
): Collector => ({
  name: "server-logs",
  collect: async () => {
    const server = await facts();
    if (server === null) throw new Error(NO_SERVER);
    const installation = {
      directory: server.directory,
      dockerContext: server.config.dockerContext,
    };
    const listed = await deps.run(
      "docker",
      serverComposeArgs(installation, ["ps", "--all", "--services"]),
      COMPOSE_TIMEOUT_MS,
    );
    if (listed.status !== 0 || listed.error !== undefined)
      throw failedOutput(listed, "docker compose ps failed");
    const services = listed.stdout.split(/\s+/).filter((name) => name !== "");
    if (services.length === 0) throw new Error("no Compose containers found (mend server start)");
    const files: Array<BundleFile> = [];
    for (const service of services) {
      const logs = await deps.run(
        "docker",
        serverComposeArgs(installation, [
          "logs",
          "--no-color",
          "--tail",
          String(deps.tail),
          service,
        ]),
        COMPOSE_TIMEOUT_MS,
      );
      const text =
        logs.error !== undefined || logs.status !== 0
          ? outputOrFailure(logs)
          : `${logs.stdout.trimEnd()}${logs.stderr.trim() === "" ? "" : `\n--- stderr ---\n${logs.stderr.trimEnd()}`}`;
      files.push({ path: `server-logs/${service}.log`, content: `${text}\n` });
    }
    return files;
  },
});

// ── docker.txt + workspace-logs/<container>.log ───────────────────────────

const DOCKER_TIMEOUT_MS = 20_000;

/** `docker ps` sees a Mend install as its Compose project plus Sealant's workspace containers. */
const CONTAINER_FILTERS: ReadonlyArray<ReadonlyArray<string>> = [
  ["--filter", "label=com.docker.compose.project=mend"],
  ["--filter", "name=sealant-"],
  ["--filter", "label=sealant.workspace"],
];

interface ContainerRow {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly labels: string;
}

interface DockerFacts {
  readonly context: ReadonlyArray<string>;
  readonly version: string;
  readonly info: string;
  readonly contexts: string;
  readonly containers: ReadonlyArray<ContainerRow>;
  /** Failures of the reads that are not the whole collector. */
  readonly notes: ReadonlyArray<string>;
}

const parseContainerRows = (stdout: string): ReadonlyArray<ContainerRow> =>
  stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return [];
      }
      const id = stringField(parsed, "ID");
      if (id === null) return [];
      return [
        {
          id,
          name: stringField(parsed, "Names") ?? id,
          image: stringField(parsed, "Image") ?? "",
          state: stringField(parsed, "State") ?? "",
          status: stringField(parsed, "Status") ?? "",
          labels: stringField(parsed, "Labels") ?? "",
        },
      ];
    });

const dockerFactsOnce = (
  deps: BundleDeps,
  facts: () => Promise<ServerInstallationFacts | null>,
): (() => Promise<DockerFacts>) => {
  let pending: Promise<DockerFacts> | null = null;
  const read = async (): Promise<DockerFacts> => {
    let context: ReadonlyArray<string> = [];
    const notes: Array<string> = [];
    try {
      const server = await facts();
      if (server !== null) context = ["--context", server.config.dockerContext];
    } catch (error) {
      notes.push(`server config: ${error instanceof Error ? error.message : String(error)}`);
    }
    const version = await deps.run("docker", [...context, "version"], DOCKER_TIMEOUT_MS);
    if (version.error !== undefined || version.status !== 0)
      throw failedOutput(version, "docker version failed");
    const info = await deps.run("docker", [...context, "info"], DOCKER_TIMEOUT_MS);
    const contexts = await deps.run("docker", ["context", "ls"], DOCKER_TIMEOUT_MS);
    const byId = new Map<string, ContainerRow>();
    for (const filter of CONTAINER_FILTERS) {
      const listed = await deps.run(
        "docker",
        [...context, "ps", "--all", "--no-trunc", "--format", "{{json .}}", ...filter],
        DOCKER_TIMEOUT_MS,
      );
      if (listed.error !== undefined || listed.status !== 0) {
        notes.push(`docker ps ${filter.join(" ")}: ${outputOrFailure(listed)}`);
        continue;
      }
      for (const row of parseContainerRows(listed.stdout)) byId.set(row.id, row);
    }
    return {
      context,
      version: outputOrFailure(version),
      info: outputOrFailure(info),
      contexts: outputOrFailure(contexts),
      containers: [...byId.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
      notes,
    };
  };
  return () => {
    pending ??= read();
    return pending;
  };
};

/** One container as `docker inspect` reports it, without its environment values. */
const summarizeInspect = (container: unknown): Record<string, unknown> => {
  const config = field(container, "Config");
  const hostConfig = field(container, "HostConfig");
  const state = field(container, "State");
  const mounts = field(container, "Mounts");
  return {
    id: stringField(container, "Id"),
    name: stringField(container, "Name"),
    created: stringField(container, "Created"),
    image: stringField(config, "Image"),
    imageId: stringField(container, "Image"),
    state: isRecord(state)
      ? {
          status: state["Status"],
          exitCode: state["ExitCode"],
          oomKilled: state["OOMKilled"],
          startedAt: state["StartedAt"],
          finishedAt: state["FinishedAt"],
          error: state["Error"],
        }
      : null,
    privileged: field(hostConfig, "Privileged"),
    runtime: field(hostConfig, "Runtime"),
    networkMode: field(hostConfig, "NetworkMode"),
    restartPolicy: field(hostConfig, "RestartPolicy"),
    portBindings: field(hostConfig, "PortBindings"),
    mounts: Array.isArray(mounts)
      ? mounts.map((mount) => ({
          type: field(mount, "Type"),
          source: field(mount, "Source"),
          destination: field(mount, "Destination"),
          mode: field(mount, "Mode"),
          rw: field(mount, "RW"),
        }))
      : null,
    envNames: stringList(field(config, "Env")).map((entry) => entry.split("=")[0] ?? entry),
    labels: field(config, "Labels"),
  };
};

export const dockerCollector = (
  deps: BundleDeps,
  docker: () => Promise<DockerFacts>,
): Collector => ({
  name: "docker",
  collect: async () => {
    const found = await docker();
    const sections: Array<string> = [
      `# docker version${found.context.length === 0 ? "" : ` (${found.context.join(" ")})`}`,
      found.version,
      "",
      "# docker info",
      found.info,
      "",
      "# docker context ls",
      found.contexts,
      "",
      "# docker ps -a (Compose project mend · names sealant-* · label sealant.workspace)",
      found.containers.length === 0
        ? "none"
        : found.containers
            .map((row) => `${row.id.slice(0, 12)}  ${row.name}  ${row.image}  ${row.status}`)
            .join("\n"),
    ];
    if (found.notes.length > 0) sections.push("", "# notes", ...found.notes);
    if (found.containers.length > 0) {
      const inspected = await deps.run(
        "docker",
        [...found.context, "inspect", ...found.containers.map((row) => row.id)],
        DOCKER_TIMEOUT_MS,
      );
      sections.push("", "# docker inspect (Env as names only)");
      if (inspected.error !== undefined || inspected.status !== 0) {
        sections.push(outputOrFailure(inspected));
      } else {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(inspected.stdout);
        } catch {
          sections.push("docker inspect returned invalid JSON");
        }
        if (Array.isArray(parsed)) sections.push(json(parsed.map(summarizeInspect)).trimEnd());
      }
    }
    return [{ path: "docker.txt", content: `${sections.join("\n")}\n` }];
  },
});

const isWorkspaceContainer = (row: ContainerRow): boolean =>
  row.name.startsWith("sealant-") || row.labels.includes("sealant.workspace=");

export const workspaceLogsCollector = (
  deps: BundleDeps,
  docker: () => Promise<DockerFacts>,
): Collector => ({
  name: "workspace-logs",
  collect: async () => {
    const found = await docker();
    const running = found.containers.filter(
      (row) => isWorkspaceContainer(row) && row.state === "running",
    );
    if (running.length === 0) {
      return [
        {
          path: "workspace-logs.txt",
          content:
            "no running workspace container observed (names sealant-* or label sealant.workspace)\n",
        },
      ];
    }
    const files: Array<BundleFile> = [];
    for (const row of running) {
      const logs = await deps.run(
        "docker",
        [...found.context, "logs", "--tail", String(deps.tail), row.id],
        DOCKER_TIMEOUT_MS,
      );
      const text =
        logs.error !== undefined || logs.status !== 0
          ? outputOrFailure(logs)
          : `${logs.stdout.trimEnd()}${logs.stderr.trim() === "" ? "" : `\n--- stderr ---\n${logs.stderr.trimEnd()}`}`;
      files.push({ path: `workspace-logs/${row.name}.log`, content: `${text}\n` });
    }
    return files;
  },
});

// ── sessions.json + sessions/<id>.json + sessions/<id>-record.txt ─────────

interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

interface SessionRowDto {
  readonly id: string;
  readonly projectId: string;
  readonly harness: string;
  readonly label: string | null;
  readonly status: string;
  readonly worktree: string;
  readonly branch: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

interface ProjectDetailDto {
  readonly project: ProjectSummary;
  readonly sessions: ReadonlyArray<SessionRowDto>;
}

interface ProcessDto {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly harness: string | null;
  readonly serviceId: string | null;
  readonly sealantSessionId: string | null;
  readonly argv: ReadonlyArray<string>;
  readonly status: string;
  readonly exitCode: number | null;
  readonly createdAt: string;
  readonly exitedAt: string | null;
}

interface SessionDetailDto {
  readonly session: SessionRowDto;
  readonly processes: ReadonlyArray<ProcessDto>;
  readonly liveServices?: number;
}

interface ProcessLogPageDto {
  readonly nextFrom: string;
  readonly status: string;
  readonly chunks: ReadonlyArray<{ readonly sequence: string; readonly dataBase64: string }>;
}

/** The API pages a record from its start, so a tail is read by walking it; this bounds the walk. */
const RECORD_PAGE_LIMIT = 1000;
const RECORD_MAX_PAGES = 200;
const RECORD_TIME_BUDGET_MS = 30_000;
const SESSION_CONCURRENCY = 4;

interface RecordTail {
  readonly text: string;
  readonly chunks: number;
  readonly pages: number;
  readonly complete: boolean;
  readonly status: string | null;
  readonly failure: string | null;
}

const readRecordTail = async (deps: BundleDeps, processId: string): Promise<RecordTail> => {
  let cursor = "0";
  let text = "";
  let chunks = 0;
  let pages = 0;
  let status: string | null = null;
  const deadline = Date.now() + RECORD_TIME_BUDGET_MS;
  try {
    for (;;) {
      const page = await deps.get<ProcessLogPageDto>(
        `/processes/${processId}/logs?from=${encodeURIComponent(cursor)}&limit=${RECORD_PAGE_LIMIT}`,
      );
      pages += 1;
      status = page.status;
      for (const chunk of page.chunks)
        text += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
      chunks += page.chunks.length;
      text = lastLines(text, deps.tail + 1);
      const advanced = page.nextFrom !== cursor;
      cursor = page.nextFrom;
      if (!advanced) return { text, chunks, pages, complete: true, status, failure: null };
      if (pages >= RECORD_MAX_PAGES || Date.now() > deadline)
        return { text, chunks, pages, complete: false, status, failure: null };
    }
  } catch (error) {
    return {
      text,
      chunks,
      pages,
      complete: false,
      status,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
};

const processLine = (row: ProcessDto): string =>
  [
    row.id,
    row.kind,
    row.label ?? row.harness ?? "",
    row.status,
    row.exitCode === null ? "" : `exit ${row.exitCode}`,
    row.argv.length === 0 ? "" : `argv: ${row.argv.join(" ")}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");

const recordFile = async (deps: BundleDeps, detail: SessionDetailDto): Promise<string | null> => {
  const recorded = detail.processes.filter((row) => row.sealantSessionId !== null);
  if (recorded.length === 0) return null;
  const sections: Array<string> = [
    `# session ${detail.session.id} · ${recorded.length} recorded process(es) · last ${deps.tail} lines of each, raw PTY output as UTF-8`,
  ];
  for (const row of recorded) {
    const tail = await readRecordTail(deps, row.id);
    const facts = [
      `${tail.chunks} chunks in ${tail.pages} page(s)`,
      tail.status === null ? null : `record ${tail.status}`,
      tail.complete
        ? null
        : `the read stopped at the page budget (${RECORD_MAX_PAGES} pages / ${RECORD_TIME_BUDGET_MS / 1000} s) before the record ended, so these are the last lines READ, not the last lines recorded`,
      tail.failure === null ? null : `read failed: ${tail.failure}`,
    ].filter((fact): fact is string => fact !== null);
    sections.push("", `== ${processLine(row)}`, `(${facts.join(" · ")})`, tail.text.trimEnd());
  }
  return `${sections.join("\n")}\n`;
};

export const sessionsCollector = (deps: BundleDeps): Collector => ({
  name: "sessions",
  collect: async () => {
    const projects = await deps.get<ReadonlyArray<ProjectSummary>>("/projects");
    const details = await mapLimit(projects, SESSION_CONCURRENCY, (project) =>
      deps.get<ProjectDetailDto>(`/projects/${project.id}?deadEnds=include`),
    );
    const rows = details
      .flatMap((detail) =>
        detail.sessions.map((session) => ({ session, projectName: detail.project.name })),
      )
      .toSorted((a, b) => b.session.createdAt.localeCompare(a.session.createdAt));
    const collected = await mapLimit(
      rows,
      SESSION_CONCURRENCY,
      async ({ session, projectName }) => {
        const files: Array<BundleFile> = [];
        let detail: SessionDetailDto;
        try {
          detail = await deps.get<SessionDetailDto>(`/sessions/${session.id}`);
        } catch (error) {
          files.push({
            path: `sessions/${session.id}.error.txt`,
            content: `${error instanceof Error ? error.message : String(error)}\n`,
          });
          return {
            files,
            summary: {
              id: session.id,
              project: projectName,
              harness: session.harness,
              label: session.label,
              status: session.status,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt ?? null,
              detail: `sessions/${session.id}.error.txt`,
            },
          };
        }
        files.push({ path: `sessions/${session.id}.json`, content: json(detail) });
        const record = await recordFile(deps, detail);
        if (record !== null)
          files.push({ path: `sessions/${session.id}-record.txt`, content: record });
        const services = new Set(
          detail.processes.flatMap((row) => (row.serviceId === null ? [] : [row.serviceId])),
        );
        return {
          files,
          summary: {
            id: session.id,
            project: projectName,
            harness: session.harness,
            label: session.label,
            status: session.status,
            worktree: session.worktree,
            branch: session.branch,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt ?? null,
            processes: detail.processes.map((row) => ({
              id: row.id,
              kind: row.kind,
              label: row.label,
              harness: row.harness,
              status: row.status,
              exitCode: row.exitCode,
              argv: row.argv,
              createdAt: row.createdAt,
              exitedAt: row.exitedAt,
              recorded: row.sealantSessionId !== null,
            })),
            services: services.size,
            liveServices: detail.liveServices ?? null,
            detail: `sessions/${session.id}.json`,
            record: record === null ? null : `sessions/${session.id}-record.txt`,
          },
        };
      },
    );
    const summaries = collected.map((item) => item.summary);
    const files = collected.flatMap((item) => item.files);
    files.unshift({
      path: "sessions.json",
      content: json({
        projects: projects.length,
        sessions: rows.length,
        recordTailLines: deps.tail,
        rows: summaries,
      }),
    });
    return files;
  },
});

// ── accounts.txt ──────────────────────────────────────────────────────────

export const accountsCollector = (deps: BundleDeps): Collector => ({
  name: "accounts",
  collect: async () => [{ path: "accounts.txt", content: await deps.accounts() }],
});

// ── tools.txt ─────────────────────────────────────────────────────────────

const TOOLS: ReadonlyArray<string> = ["claude", "codex", "gh", "git", "docker"];
const TOOL_TIMEOUT_MS = 15_000;

export const toolsCollector = (deps: BundleDeps): Collector => ({
  name: "tools",
  collect: async () => {
    const lines: Array<string> = [];
    for (const tool of TOOLS) {
      const found = deps.pathOf(tool);
      if (found === null) {
        lines.push(`${tool.padEnd(8)} not on PATH`);
        continue;
      }
      const output = await deps.run(tool, ["--version"], TOOL_TIMEOUT_MS);
      const version =
        output.error !== undefined || output.status !== 0
          ? `--version ${outputOrFailure(output).split("\n")[0] ?? ""}`
          : (output.stdout.trim().split("\n")[0] ?? "");
      lines.push(`${tool.padEnd(8)} ${found} · ${version}`);
    }
    return [{ path: "tools.txt", content: `${lines.join("\n")}\n` }];
  },
});

// ── all of them, in order ─────────────────────────────────────────────────

export const bundleCollectors = (deps: BundleDeps): ReadonlyArray<Collector> => {
  const server = serverFactsOnce(deps);
  const docker = dockerFactsOnce(deps, server);
  return [
    cliCollector(deps),
    doctorCollector(deps),
    serverHealthCollector(deps),
    serverConfigCollector(server),
    dockerCollector(deps, docker),
    serverLogsCollector(deps, server),
    workspaceLogsCollector(deps, docker),
    sessionsCollector(deps),
    accountsCollector(deps),
    toolsCollector(deps),
  ];
};
