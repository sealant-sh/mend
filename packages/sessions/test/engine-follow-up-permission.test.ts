import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SealantWorkspaceId, SessionProcessId, type SessionId } from "@mend/domain";
import { composeLaunchArgv, Session, SessionProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { PROMPT_SCRIPT, promptCommandOf } from "../src/agent-command.ts";
import { mendMcpFlags } from "../src/mend-mcp/launch.ts";
import { now, sealantLaunchLayer, setup, withEngine, type World } from "./engine/fixture.ts";
import { observeOpencodePrompt } from "./engine/opencode-launch.ts";

const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
];

const ASK_FLAGS = {
  claude: "--permission-mode auto",
  codex: "--sandbox danger-full-access --ask-for-approval on-request",
} as const;

type Harness = "claude" | "codex" | "opencode";

const providerSessionId = "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10";

const launchLayer = (created: CreateOptions[], spawned: Array<ReadonlyArray<string>>) =>
  sealantLaunchLayer(
    created,
    undefined,
    undefined,
    spawned,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    [],
  );

/** The command a follow-up's prompt wrapper runs, as one string. */
const followUpCommand = (
  spawned: ReadonlyArray<ReadonlyArray<string>>,
  harness: Harness,
): string => {
  const command = spawned
    .map((argv) => {
      const script = argv.indexOf(PROMPT_SCRIPT);
      return script < 2 ? null : promptCommandOf(argv.slice(script - 2));
    })
    .findLast((found) => found !== null && found[0] === harness);
  if (command == null) throw new Error(`no follow-up exec of ${harness} was spawned`);
  return command.join(" ");
};

const ranFrom = (spawned: ReadonlyArray<ReadonlyArray<string>>, harness: string) => {
  const argv = spawned.at(-1) ?? [];
  return argv.slice(argv.indexOf(harness));
};

const stopped = (
  world: World,
  sessionId: SessionId,
  keep?: (process: SessionProcess) => boolean,
) => {
  for (const process of world.processes.values()) {
    if (process.sessionId !== sessionId || process.exitedAt !== null) continue;
    if (keep?.(process) === true) continue;
    world.processes.set(
      process.id,
      new SessionProcess({
        ...process,
        status: "exited",
        exitCode: 0,
        exitedAt: now(),
      }),
    );
  }
  const session = world.sessions.get(sessionId);
  if (session === undefined) throw new Error("no session to stop");
  world.sessions.set(
    sessionId,
    new Session({
      ...session,
      status: "stopped",
      settledAt: now(),
      updatedAt: now(),
    }),
  );
};

const openShell = (world: World, sessionId: SessionId) => {
  const workspaceId = world.sessions.get(sessionId)?.sealantWorkspaceId;
  if (workspaceId === null || workspaceId === undefined) throw new Error("no workspace");
  const shell = new SessionProcess({
    id: SessionProcessId.make(`shell-${sessionId}`),
    sessionId,
    sealantWorkspaceId: SealantWorkspaceId.make(workspaceId),
    sealantSessionId: "pty-shell",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "shell",
    harness: null,
    providerSessionId: null,
    protocolOptions: null,
    label: "shell",
    argv: ["bash", "-i"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: now(),
    exitedAt: null,
    updatedAt: now(),
  });
  world.processes.set(shell.id, shell);
};

const keepState = (storePath: string, sessionId: SessionId, harness: Harness) => {
  const stateDir = sessionStatePathOf(storePath, sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "manifest.json"),
    JSON.stringify({
      harness,
      providerSessionId,
      capturedAt: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
};

type Workspace = "a new workspace" | "the workspace a shell kept";

const followUpAfter = async (
  harness: Harness,
  argv: ReadonlyArray<string>,
  workspace: Workspace,
) => {
  const created: CreateOptions[] = [];
  const spawned: Array<ReadonlyArray<string>> = [];
  const opencode = await withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const session = yield* engine.provision({
          projectId: project.id,
          harness,
          label: null,
          name: null,
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        yield* engine.launch(session.id, argv);
        if (workspace === "the workspace a shell kept") openShell(world, session.id);
        keepState(project.storePath, session.id, harness);
        stopped(world, session.id, (process) => process.kind === "shell");
        yield* engine.launchFollowUp(
          session.id,
          "Address the review comments.",
          "follow-up:review-1",
          "user-fixture",
        );
        return harness === "opencode" ? observeOpencodePrompt(spawned.at(-1) ?? [], tmp) : null;
      }),
    { sealantLayer: launchLayer(created, spawned) },
  );
  return { created, spawned, opencode };
};

const cases = (["claude", "codex"] as const).flatMap((harness) =>
  (["a new workspace", "the workspace a shell kept"] as const).map(
    (workspace) => [harness, workspace] as const,
  ),
);

describe("a follow-up into a terminal session keeps its permission mode (SLNT-238)", () => {
  it.each(cases)(
    "a %s terminal launched with ask still asks when a follow-up starts it in %s",
    async (harness, workspace) => {
      const { created, spawned } = await followUpAfter(
        harness,
        composeLaunchArgv(harness, { mode: "pty", permissionMode: "ask" }),
        workspace,
      );
      expect(created).toHaveLength(workspace === "a new workspace" ? 2 : 1);
      const command = followUpCommand(spawned, harness);
      for (const flag of BYPASS_FLAGS) expect(command).not.toContain(flag);
      expect(command).toContain(ASK_FLAGS[harness]);
    },
    30_000,
  );

  it.each(cases)(
    "a %s terminal launched in bypass still runs bypass when a follow-up starts it in %s",
    async (harness, workspace) => {
      const { spawned } = await followUpAfter(harness, [harness], workspace);
      const command = followUpCommand(spawned, harness);
      expect(command).toContain(harness === "claude" ? BYPASS_FLAGS[0] : BYPASS_FLAGS[1]);
      expect(command).not.toContain(ASK_FLAGS[harness]);
    },
    30_000,
  );

  it.each(["a new workspace", "the workspace a shell kept"] as const)(
    "an opencode terminal launched with ask still asks when a follow-up starts it in %s",
    async (workspace) => {
      const { opencode } = await followUpAfter(
        "opencode",
        composeLaunchArgv("opencode", { mode: "pty", permissionMode: "ask" }),
        workspace,
      );
      expect(opencode).toMatchObject({
        args: ["--prompt", "Address the review comments."],
        permission: { "*": "ask" },
        mcp: { command: ["/run/mend/bin/mend", "mcp"], enabled: true },
      });
    },
    30_000,
  );

  it.each(["a new workspace", "the workspace a shell kept"] as const)(
    "an opencode terminal launched in bypass still allows when a follow-up starts it in %s",
    async (workspace) => {
      const { opencode } = await followUpAfter("opencode", ["opencode"], workspace);
      expect(opencode).toMatchObject({
        args: ["--prompt", "Address the review comments."],
        permission: { "*": "allow" },
        mcp: { command: ["/run/mend/bin/mend", "mcp"], enabled: true },
      });
    },
    30_000,
  );

  it.each<readonly ["claude" | "codex", ReadonlyArray<string>]>([
    ["claude", ["--permission-mode", "plan"]],
    ["codex", ["--sandbox", "read-only", "-a", "never"]],
    ["codex", ["--sandbox", "read-only"]],
    ["codex", ["-sread-only"]],
    ["codex", ["-s=read-only", "-anever"]],
  ])(
    "a %s terminal launched with %j keeps it when a follow-up starts it",
    async (harness, permission) => {
      const { spawned } = await followUpAfter(
        harness,
        [harness, ...permission],
        "the workspace a shell kept",
      );
      const command = followUpCommand(spawned, harness);
      expect(command).toContain(permission.join(" "));
      for (const flag of BYPASS_FLAGS) expect(command).not.toContain(flag);
      expect(command).not.toContain(ASK_FLAGS[harness]);
    },
    30_000,
  );

  it.each(["claude", "codex"] as const)(
    "a %s terminal launched with ask asks through a follow-up and the Resume after it",
    async (harness) => {
      const created: CreateOptions[] = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      let followUp = "";
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness,
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launch(
              session.id,
              composeLaunchArgv(harness, {
                mode: "pty",
                permissionMode: "ask",
              }),
            );
            keepState(project.storePath, session.id, harness);
            stopped(world, session.id);
            yield* engine.launchFollowUp(
              session.id,
              "Address the review comments.",
              "follow-up:review-1",
              "user-fixture",
            );
            followUp = followUpCommand(spawned, harness);
            stopped(world, session.id);
            yield* engine.resumeSession(session.id, null);
          }),
        { sealantLayer: launchLayer(created, spawned) },
      );
      for (const flag of BYPASS_FLAGS) expect(followUp).not.toContain(flag);
      expect(followUp).toContain(ASK_FLAGS[harness]);
      const resumed = ranFrom(spawned, harness);
      expect(resumed.join(" ")).toContain(providerSessionId);
      for (const flag of BYPASS_FLAGS) expect(resumed).not.toContain(flag);
      expect(resumed.join(" ")).toContain(ASK_FLAGS[harness]);
    },
    30_000,
  );

  it("runs a follow-up with the copied flags as the very words the terminal had", async () => {
    const values = ["$(touch pwned)", "a b", "'", "*", "~", "", "x\ny", "`id`", ";", "\\"];
    const permission = values.flatMap((value) => ["--permission-mode", value]);
    const { spawned } = await followUpAfter(
      "claude",
      ["claude", ...permission],
      "the workspace a shell kept",
    );
    const argv = spawned.find((tokens) => tokens.includes(PROMPT_SCRIPT));
    if (argv === undefined) throw new Error("no follow-up exec of claude was spawned");
    const script = argv.indexOf(PROMPT_SCRIPT);
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mend-follow-up-words-"));
    fs.writeFileSync(
      path.join(bin, "claude"),
      "#!/bin/sh\nfor arg; do printf '%s\\0' \"$arg\"; done\n",
      {
        mode: 0o755,
      },
    );
    const printed = execFileSync("sh", argv.slice(script - 1), {
      cwd: bin,
      env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
      encoding: "utf8",
    });
    expect(printed.split("\0").slice(0, -1)).toEqual([
      ...mendMcpFlags("claude"),
      ...permission,
      "Address the review comments.",
    ]);
    expect(fs.existsSync(path.join(bin, "pwned"))).toBe(false);
  }, 30_000);
});
