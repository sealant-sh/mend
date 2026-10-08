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
  refusesManualReplacement,
  retireCheckScript,
  retirementStopsOf,
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

const procOf = (
  processes: ReadonlyArray<{ pid: number; ppid: number; comm: string; cmdline: string }>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-proc-"));
  for (const process of processes) {
    const dir = path.join(root, String(process.pid));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "comm"), `${process.comm}\n`);
    fs.writeFileSync(path.join(dir, "status"), `Name:\t${process.comm}\nPPid:\t${process.ppid}\n`);
    fs.writeFileSync(path.join(dir, "cmdline"), process.cmdline.split(" ").join("\0"));
  }
  return root;
};

describe("the retire check, against a /proc", () => {
  it("lists what does not descend from sealantd, and nothing that does", () => {
    const proc = procOf([
      { pid: 1, ppid: 0, comm: "tini", cmdline: "tini -- sealantd" },
      { pid: 7, ppid: 1, comm: "sealantd", cmdline: "sealantd serve" },
      { pid: 20, ppid: 7, comm: "claude", cmdline: "claude --print" },
      { pid: 21, ppid: 20, comm: "node", cmdline: "node server.js" },
      // `docker exec` from outside: its parent is not in the container.
      { pid: 30, ppid: 0, comm: "bash", cmdline: "bash" },
      { pid: 31, ppid: 30, comm: "sleep", cmdline: "sleep 600" },
      // A daemon reparented to an init that is not sealantd.
      { pid: 40, ppid: 1, comm: "redis-server", cmdline: "redis-server *:6379" },
      // A kernel thread.
      { pid: 2, ppid: 0, comm: "kthreadd", cmdline: "" },
    ]);
    const stdout = execFileSync("sh", ["-c", retireCheckScript({ proc })], { encoding: "utf8" });
    const found = parseRetireCheck(stdout);
    expect(found.checked).toBe(true);
    expect(found.stops.filter((stop) => stop.kind === "process")).toEqual([
      { kind: "process", label: "bash" },
      { kind: "process", label: "sleep 600" },
      { kind: "process", label: "redis-server *:6379" },
    ]);
  });

  it("finds nothing in an executor where everything runs under sealantd", () => {
    const proc = procOf([
      { pid: 1, ppid: 0, comm: "sealantd", cmdline: "sealantd serve" },
      { pid: 9, ppid: 1, comm: "codex", cmdline: "codex app-server" },
    ]);
    const stdout = execFileSync("sh", ["-c", retireCheckScript({ proc })], { encoding: "utf8" });
    expect(parseRetireCheck(stdout).stops.filter((stop) => stop.kind === "process")).toEqual([]);
  });

  it("reads containers, and a check that did not finish counts as not checked", () => {
    expect(
      parseRetireCheck("mend-retire container pg (postgres:17)\nmend-retire checked\n"),
    ).toEqual({ checked: true, stops: [{ kind: "container", label: "pg (postgres:17)" }] });
    expect(parseRetireCheck("mend-retire process sleep 1\n").checked).toBe(false);
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
