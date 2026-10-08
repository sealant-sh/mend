import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SealantWorkspaceId, ServiceId, SessionId, SessionProcessId } from "@mend/domain";
import { SessionProcess } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  memoryCreditorOf,
  memoryToCredit,
  notReplacedWords,
  opencodeFromSharedHomeOf,
  parseRetireCheck,
  reasonForViewer,
  refusesManualReplacement,
  retireCheckScript,
  retirementFingerprintOf,
  retirementStopsOf,
  stopsForViewer,
  stopsWithin,
} from "./pre-release.ts";

const members =
  (...ids: ReadonlyArray<string>) =>
  (id: string) =>
    ids.includes(id);

describe("whom an old shared home's memory goes to (docs/adr/0016, decision 14)", () => {
  it("goes to the person the saved home record names", () => {
    expect(
      memoryCreditorOf({
        homeRecord: "alice",
        owners: ["alice", "bob"],
        isMember: members("alice", "bob"),
      }),
    ).toEqual({ creditedTo: "alice", decidedBy: "home-record" });
  });

  it("else to the only person who had sessions there", () => {
    expect(
      memoryCreditorOf({
        homeRecord: undefined,
        owners: ["alice", "alice"],
        isMember: members("alice"),
      }),
    ).toEqual({ creditedTo: "alice", decidedBy: "only-person" });
    // A record naming nobody leaves the decision to the sessions.
    expect(
      memoryCreditorOf({ homeRecord: null, owners: ["alice"], isMember: members("alice") }),
    ).toEqual({ creditedTo: "alice", decidedBy: "only-person" });
  });

  it("credits nobody when two people shared the home and no record names one", () => {
    expect(
      memoryCreditorOf({
        homeRecord: undefined,
        owners: ["alice", "bob"],
        isMember: members("alice", "bob"),
      }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
    // A session with no owner is someone Mend cannot name.
    expect(
      memoryCreditorOf({
        homeRecord: undefined,
        owners: ["alice", null],
        isMember: members("alice"),
      }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
  });

  it("credits nobody a removed member was named for, and hands it to no one else", () => {
    expect(
      memoryCreditorOf({ homeRecord: "gone", owners: ["alice"], isMember: members("alice") }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
    expect(
      memoryCreditorOf({ homeRecord: undefined, owners: ["gone"], isMember: members("alice") }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
  });
});

const file = (at: string, digest: string) => ({ path: at, digest, contents: digest });

describe("when the server cannot say whose memory it is", () => {
  it("credits nobody with a record its own read-backs would not take", () => {
    expect(
      memoryCreditorOf({
        homeRecord: null,
        unsettledRecord: true,
        owners: ["alice"],
        isMember: members("alice"),
      }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
  });

  it("applies the only-person rule only to a complete record of every session ever", () => {
    expect(
      memoryCreditorOf({
        homeRecord: undefined,
        owners: ["alice"],
        ownersComplete: false,
        isMember: members("alice"),
      }),
    ).toEqual({ creditedTo: null, decidedBy: "nobody" });
  });
});

describe("what a run of the migration credits", () => {
  it("credits every file the first time, against what the old home says it was delivered", () => {
    const planned = memoryToCredit({
      files: [file("a.md", "a1"), file("b.md", "b1")],
      credited: {},
      homeDelivered: { "a.md": "a0", "gone.md": "g0" },
    });
    expect(planned.fresh.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    // Only the files read are planned: a delivered file the home no longer has is never deleted.
    expect(planned.base).toEqual({ "a.md": "a0" });
    expect(planned.credited).toEqual({ "a.md": "a1", "b.md": "b1" });
  });

  it("re-runs credit only what changed or appeared since, and nothing twice", () => {
    const first = memoryToCredit({
      files: [file("a.md", "a1")],
      credited: {},
      homeDelivered: {},
    });
    const second = memoryToCredit({
      files: [file("a.md", "a1"), file("b.md", "b1")],
      credited: first.credited,
      homeDelivered: {},
    });
    expect(second.fresh.map((entry) => entry.path)).toEqual(["b.md"]);
    const third = memoryToCredit({
      files: [file("a.md", "a2"), file("b.md", "b1")],
      credited: second.credited,
      homeDelivered: {},
    });
    expect(third.fresh.map((entry) => entry.path)).toEqual(["a.md"]);
    // Read back against what the earlier run credited, so a change the person made since merges.
    expect(third.base).toEqual({ "a.md": "a1" });
    const again = memoryToCredit({
      files: [file("a.md", "a2"), file("b.md", "b1")],
      credited: third.credited,
      homeDelivered: {},
    });
    expect(again.fresh).toEqual([]);
  });
});

const now = new Date("2026-10-08T10:00:00Z");
const row = (
  id: string,
  kind: SessionProcess["kind"],
  extra: Partial<{ harness: string; label: string; serviceId: string }> = {},
) =>
  new SessionProcess({
    id: SessionProcessId.make(id),
    sessionId: SessionId.make("s-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("ws-old"),
    sealantSessionId: null,
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: extra.serviceId === undefined ? null : ServiceId.make(extra.serviceId),
    attemptOrdinal: null,
    kind,
    harness: extra.harness ?? null,
    providerSessionId: null,
    protocolOptions: null,
    label: extra.label ?? null,
    argv: [],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now,
    exitedAt: null,
    updatedAt: now,
  });

describe("what would stop if a pre-release executor were replaced now", () => {
  const services = new Map([
    ["svc-hand", { name: "web", declarationSource: "explicit-run" }],
    ["svc-toml", { name: "db", declarationSource: "recipe-file" }],
  ]);

  it("lists terminals, shells, hand-started Services and turns in flight; not idle agents or mend.toml Services", () => {
    const stops = retirementStopsOf({
      processes: [
        row("p-term", "agent-pty", { harness: "claude" }),
        row("p-shell", "shell", { label: "shell 1" }),
        row("p-web", "service", { serviceId: "svc-hand" }),
        row("p-db", "service", { serviceId: "svc-toml" }),
        row("p-idle", "agent-protocol", { harness: "codex" }),
        row("p-busy", "agent-protocol", { harness: "claude" }),
      ],
      services,
      sessionLabel: () => "fix auth",
      quiescent: (id) => (id === "p-idle" ? true : id === "p-busy" ? false : null),
    });
    expect(stops).toEqual([
      { kind: "terminal", label: "fix auth · claude" },
      { kind: "shell", label: "fix auth · shell 1" },
      { kind: "service", label: "fix auth · web" },
      { kind: "turn", label: "fix auth · claude" },
    ]);
    expect(refusesManualReplacement(stops)).toBe(true);
    expect(notReplacedWords(stops)).toBe(
      "not replaced · 1 terminal session, 1 shell, 1 Service started by hand, 1 agent turn in flight",
    );
  });

  it("counts a protocol agent Mend cannot ask as in flight", () => {
    expect(
      retirementStopsOf({
        processes: [row("p-unknown", "agent-protocol", { harness: "codex" })],
        services,
        sessionLabel: () => "s",
        quiescent: () => null,
      }),
    ).toEqual([{ kind: "turn", label: "s · codex" }]);
  });
});

interface FakeProcess {
  readonly pid: number;
  readonly ppid: number;
  /** The session (setsid) the process is in. */
  readonly sid: number;
  readonly comm: string;
  readonly cmdline: string;
  /** Clock ticks after boot (`starttime`); 0 unless a test says. */
  readonly startTicks?: number;
  readonly state?: string;
}

/** The fake machine's boot, in seconds: what `/proc/stat`'s `btime` says. */
const BOOT = 1_759_900_000;

/** A /proc with the fields the check reads: comm, cmdline, stat (session id) and PID 1's environ. */
const procOf = (processes: ReadonlyArray<FakeProcess>, environ: Record<string, string> = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-proc-"));
  fs.writeFileSync(path.join(root, "stat"), `cpu 0 0 0 0\nbtime ${BOOT}\n`);
  for (const process of processes) {
    const dir = path.join(root, String(process.pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "comm"), `${process.comm}\n`);
    fs.writeFileSync(
      path.join(dir, "stat"),
      `${process.pid} (${process.comm}) ${process.state ?? "S"} ${process.ppid} ${process.sid} ${process.sid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${process.startTicks ?? 0}\n`,
    );
    fs.writeFileSync(path.join(dir, "cmdline"), process.cmdline.split(" ").join("\0"));
    if (process.pid === 1) {
      fs.writeFileSync(
        path.join(dir, "environ"),
        Object.entries(environ)
          .map(([key, value]) => `${key}=${value}`)
          .join("\0"),
      );
    }
  }
  return root;
};

/** A stand-in `docker` that prints `stdout`, `stderr` and exits with `code`, after `sleep` s. */
const dockerOf = (options: {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly sleep?: number;
}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-docker-"));
  const command = path.join(dir, "docker");
  fs.writeFileSync(path.join(dir, "out"), options.stdout ?? "");
  fs.writeFileSync(path.join(dir, "err"), options.stderr ?? "");
  fs.writeFileSync(
    command,
    [
      "#!/bin/sh",
      `[ -n "$DOCKER_HOST" ] || { echo "no DOCKER_HOST seen" >&2; exit 9; }`,
      options.sleep === undefined ? ":" : `sleep ${options.sleep}`,
      `cat '${dir}/out'`,
      `cat '${dir}/err' >&2`,
      `exit ${options.code}`,
    ].join("\n"),
  );
  fs.chmodSync(command, 0o755);
  return command;
};

const check = (proc: string, options: Partial<Parameters<typeof retireCheckScript>[0]> = {}) =>
  parseRetireCheck(
    execFileSync(
      "sh",
      [
        "-c",
        retireCheckScript({
          proc,
          known: [],
          docker: false,
          dockerSocket: path.join(os.tmpdir(), "mend-no-such-socket"),
          ...options,
        }),
      ],
      { encoding: "utf8" },
    ),
  );

/** sealantd as PID 1 (as every executor image runs it), adopting every orphan. */
const SEALANTD: FakeProcess = {
  pid: 1,
  ppid: 0,
  sid: 1,
  comm: "sealantd",
  cmdline: "sealantd boot",
};

describe("the retire check, against a /proc with sealantd as PID 1", () => {
  it("counts as Mend's only the sessions of the processes Mend recorded; detached jobs are listed", () => {
    const proc = procOf([
      SEALANTD,
      // A protocol agent Mend recorded (its pid from its record) and the tool it runs.
      { pid: 20, ppid: 1, sid: 20, comm: "claude", cmdline: "claude --print" },
      { pid: 21, ppid: 20, sid: 20, comm: "node", cmdline: "node tool.js" },
      // A shell that ended left a nohup job: reparented to sealantd, its session's leader gone.
      {
        pid: 31,
        ppid: 1,
        sid: 30,
        comm: "python",
        cmdline: "nohup python train.py --token=s3cret",
      },
      // A setsid job and a tmux server: sessions of their own, children of sealantd.
      { pid: 40, ppid: 1, sid: 40, comm: "node", cmdline: "node server.js" },
      { pid: 50, ppid: 1, sid: 50, comm: "tmux: server", cmdline: "tmux new -d" },
      // A docker exec from outside.
      { pid: 60, ppid: 0, sid: 60, comm: "bash", cmdline: "bash" },
      // A process naming itself sealantd hides nothing.
      { pid: 70, ppid: 1, sid: 70, comm: "sealantd", cmdline: "/tmp/sealantd" },
      // A kernel thread.
      { pid: 2, ppid: 0, sid: 0, comm: "kthreadd", cmdline: "" },
    ]);
    const found = check(proc, { known: [{ pid: 20, startedAt: null }] });
    expect(found.checked).toBe(true);
    expect(found.stops).toEqual([
      { kind: "process", label: "python (pid 31)" },
      { kind: "process", label: "node (pid 40)" },
      { kind: "process", label: "tmux__server (pid 50)" },
      { kind: "process", label: "bash (pid 60)" },
      { kind: "process", label: "sealantd (pid 70)" },
    ]);
    // A process is named by its command name and pid: never its arguments.
    expect(JSON.stringify(found.stops)).not.toContain("s3cret");
  });

  it("finds nothing when everything runs in the sessions Mend recorded", () => {
    const proc = procOf([
      SEALANTD,
      { pid: 9, ppid: 1, sid: 9, comm: "codex", cmdline: "codex app-server" },
      { pid: 10, ppid: 9, sid: 9, comm: "git", cmdline: "git status" },
    ]);
    expect(check(proc, { known: [{ pid: 9, startedAt: null }] })).toEqual({
      checked: true,
      stops: [],
    });
  });

  it("lists a recorded process's session once its leader is gone and nothing names it", () => {
    const proc = procOf([
      SEALANTD,
      { pid: 12, ppid: 1, sid: 11, comm: "sleep", cmdline: "sleep 600" },
    ]);
    // pid 11, the recorded one, has exited: its session no longer counts.
    expect(check(proc, { known: [{ pid: 11, startedAt: null }] }).stops).toEqual([
      { kind: "process", label: "sleep (pid 12)" },
    ]);
  });
});

describe("the retire check's recorded pids", () => {
  it("counts a recorded pid only while it is the process that started then: a reused pid hides nothing", () => {
    const proc = procOf([
      SEALANTD,
      // pid 9 started 40 s after boot (100 ticks a second): the recorded agent.
      { pid: 9, ppid: 1, sid: 9, comm: "codex", cmdline: "codex app-server", startTicks: 4000 },
      { pid: 10, ppid: 9, sid: 9, comm: "git", cmdline: "git status", startTicks: 4100 },
    ]);
    expect(check(proc, { known: [{ pid: 9, startedAt: BOOT + 40 }] }).stops).toEqual([]);
    // The record says pid 9 started at another time: the pid was reused, its session is listed.
    expect(check(proc, { known: [{ pid: 9, startedAt: BOOT + 900 }] }).stops).toEqual([
      { kind: "process", label: "git (pid 10)" },
      { kind: "process", label: "codex (pid 9)" },
    ]);
  });

  it("lists no zombie", () => {
    const proc = procOf([
      SEALANTD,
      { pid: 33, ppid: 1, sid: 30, comm: "sh", cmdline: "sh", state: "Z" },
    ]);
    expect(check(proc).stops).toEqual([]);
  });
});

/** A small image to run the check against a real `/proc`; skipped without Docker. */
const DOCKER_IMAGE = "alpine:3.20";
const dockerReady = (() => {
  try {
    execFileSync("docker", ["image", "inspect", DOCKER_IMAGE], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    try {
      execFileSync("docker", ["pull", "-q", DOCKER_IMAGE], { stdio: "ignore", timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  }
})();

const byLabel = (a: { readonly label: string }, b: { readonly label: string }) =>
  a.label.localeCompare(b.label);

const dockerRun = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });

describe.skipIf(!dockerReady)("the retire check, against a real container's /proc", () => {
  it(
    "lists a setsid job and a nohup job an ended exec left, and nothing in the session of a recorded process",
    { timeout: 60_000 },
    () => {
      const name = `mend-retire-check-${process.pid}-${Date.now()}`;
      dockerRun("run", "-d", "--rm", "--name", name, DOCKER_IMAGE, "sleep", "300");
      try {
        // Execs that end leave a setsid job and a nohup job behind, reparented to PID 1.
        dockerRun("exec", name, "sh", "-c", "setsid sleep 201 </dev/null >/dev/null 2>&1 &");
        dockerRun("exec", name, "sh", "-c", "nohup sleep 202 </dev/null >/dev/null 2>&1 &");
        // A process Mend recorded: its pid is known, and so its session is Mend's.
        dockerRun("exec", "-d", name, "sh", "-c", "exec sleep 203");
        const pidOf = (pattern: string) => {
          for (let tries = 0; tries < 50; tries++) {
            const pid = dockerRun(
              "exec",
              name,
              "sh",
              "-c",
              `pgrep -f '${pattern}' | head -n 1`,
            ).trim();
            if (pid !== "") return pid;
          }
          throw new Error(`no process ${pattern}`);
        };
        const recorded = pidOf("sleep 203");
        const script = retireCheckScript({
          known: [{ pid: Number(recorded), startedAt: null }],
          docker: false,
        });
        const found = parseRetireCheck(dockerRun("exec", name, "sh", "-c", script));
        expect(found.checked).toBe(true);
        expect(found.stops.toSorted(byLabel)).toEqual(
          [
            { kind: "process", label: `sleep (pid ${pidOf("sleep 201")})` },
            { kind: "process", label: `sleep (pid ${pidOf("sleep 202")})` },
          ].toSorted(byLabel),
        );
      } finally {
        execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      }
    },
  );
});

describe("the retire check's containers: anything but a docker ps that answers is unknown", () => {
  const proc = (environ: Record<string, string> = { DOCKER_HOST: "tcp://docker:2375" }) =>
    procOf([SEALANTD], environ);

  it("lists the running containers when docker ps answers", () => {
    const docker = dockerOf({ code: 0, stdout: "pg (postgres:17)\nredis (redis:7)\n" });
    expect(check(proc(), { docker: true, dockerCommand: docker })).toEqual({
      checked: true,
      stops: [
        { kind: "container", label: "pg (postgres:17)" },
        { kind: "container", label: "redis (redis:7)" },
      ],
    });
  });

  it("reads an unreachable daemon as unknown, never as no containers", () => {
    const docker = dockerOf({
      code: 1,
      stderr:
        "Cannot connect to the Docker daemon at tcp://docker:2375. Is the docker daemon running?",
    });
    const found = check(proc(), { docker: true, dockerCommand: docker });
    expect(found.stops).toHaveLength(1);
    expect(found.stops[0]?.kind).toBe("unchecked");
    expect(found.stops[0]?.label).toContain("running containers: docker ps failed (Cannot connect");
  });

  it("reads a missing docker command as unknown", () => {
    expect(check(proc(), { docker: true, dockerCommand: "/nonexistent/docker" }).stops).toEqual([
      { kind: "unchecked", label: "running containers: no docker command in this image" },
    ]);
  });

  it("reads a sidecar with no DOCKER_HOST and no socket as unknown", () => {
    const docker = dockerOf({ code: 0 });
    expect(check(proc({}), { docker: true, dockerCommand: docker }).stops).toEqual([
      { kind: "unchecked", label: "running containers: no Docker daemon address (DOCKER_HOST)" },
    ]);
  });

  it("reads a docker ps that does not answer in time as unknown", () => {
    const docker = dockerOf({ code: 0, stdout: "pg (postgres:17)\n", sleep: 3 });
    const found = check(proc(), { docker: true, dockerCommand: docker, dockerTimeoutSeconds: 1 });
    expect(found.stops.map((stop) => stop.kind)).toEqual(["unchecked"]);
  });

  it("checks a sidecar sealantd's environment names even when the image did not say so", () => {
    const docker = dockerOf({ code: 0, stdout: "pg (postgres:17)\n" });
    expect(check(proc(), { docker: false, dockerCommand: docker }).stops).toEqual([
      { kind: "container", label: "pg (postgres:17)" },
    ]);
    // No sidecar at all: nothing to check.
    expect(check(proc({}), { docker: false, dockerCommand: docker }).stops).toEqual([]);
  });

  it("counts a check that did not finish as not checked", () => {
    expect(parseRetireCheck("mend-retire process 4 sleep\n").checked).toBe(false);
  });
});

describe("what the owner was shown", () => {
  const shown = [
    { kind: "shell" as const, label: "auth · shell 1" },
    { kind: "container" as const, label: "pg (postgres:17)" },
  ];

  it("replaces only when nothing more would stop now", () => {
    expect(stopsWithin(shown.slice(0, 1), shown)).toBe(true);
    expect(stopsWithin([...shown, { kind: "process", label: "node (pid 40)" }], shown)).toBe(false);
    // The same things, checked again later or listed in another order: the same fingerprint.
    expect(retirementFingerprintOf({ stops: shown })).toBe(
      retirementFingerprintOf({ stops: shown.toReversed() }),
    );
    expect(retirementFingerprintOf({ stops: shown })).not.toBe(
      retirementFingerprintOf({ stops: shown.slice(1) }),
    );
    // Two things with one label are two: one shown does not cover both.
    const shell = { kind: "shell" as const, label: "auth · shell 1" };
    expect(stopsWithin([shell, shell], shown)).toBe(false);
    expect(stopsWithin([shell, shell], [shell, shell])).toBe(true);
  });

  it("never shows an error's text to anyone but the change's owner", () => {
    const stops = [
      { kind: "unchecked" as const, label: "running containers: docker ps failed (x)" },
    ];
    expect(stopsForViewer(stops, false)).toEqual([{ kind: "unchecked", label: "" }]);
    expect(
      reasonForViewer("not replaced · the replacement did not finish (Error: boom)", [], false),
    ).toBe("not replaced yet");
    expect(reasonForViewer("not replaced · 1 shell", [{ kind: "shell", label: "a" }], false)).toBe(
      "not replaced · 1 shell",
    );
    expect(reasonForViewer("x (Error: boom)", [], true)).toBe("x (Error: boom)");
  });

  it("shows a process's or a container's label to the change's owner only", () => {
    const stops = [
      { kind: "process" as const, label: "psql (pid 7)" },
      { kind: "shell" as const, label: "auth · shell 1" },
    ];
    expect(stopsForViewer(stops, false)).toEqual([
      { kind: "process", label: "" },
      { kind: "shell", label: "auth · shell 1" },
    ]);
    expect(stopsForViewer(stops, true)).toEqual(stops);
  });
});

describe("an opencode conversation from a shared home (decision 14)", () => {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  const held = (workspace: string, runsAs: string | null, minutes: number) => ({
    providerSessionId: "ses_1",
    sealantWorkspaceId: SealantWorkspaceId.make(workspace),
    runsAs,
    createdAt: at(minutes),
  });

  it("is refused per person when its last holder ran as nobody, in another executor", () => {
    expect(opencodeFromSharedHomeOf([held("ws-old", null, 0)], "ws-new", "ses_1")).toBe(true);
  });

  it("resumes as before in the executor that holds it, or once a person's process held it", () => {
    expect(opencodeFromSharedHomeOf([held("ws-old", null, 0)], "ws-old", "ses_1")).toBe(false);
    expect(
      opencodeFromSharedHomeOf(
        [held("ws-old", null, 0), held("ws-person", "alice", 5)],
        "ws-new",
        "ses_1",
      ),
    ).toBe(false);
    expect(opencodeFromSharedHomeOf([], "ws-new", "ses_1")).toBe(false);
  });
});
