import * as fs from "node:fs";
import * as path from "node:path";

import type { SessionId } from "@mend/domain";
import { composeLaunchArgv, Session, SessionProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  now,
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

const BYPASS_FLAGS = [
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
];

const ASK_FLAGS = {
  claude: ["--permission-mode", "auto"],
  codex: ["--sandbox", "danger-full-access", "--ask-for-approval", "on-request"],
} as const;

const askFlags = (harness: "claude" | "codex") => ASK_FLAGS[harness];

const liveAgent = (processes: Iterable<SessionProcess>, kind: "agent-pty" | "agent-protocol") =>
  [...processes].find((process) => process.kind === kind && process.exitedAt === null);

const ranFrom = (spawned: ReadonlyArray<ReadonlyArray<string>>, harness: string) => {
  const argv = spawned.at(-1) ?? [];
  return argv.slice(argv.indexOf(harness));
};

describe("a mode switch keeps the session's permission mode (SLNT-147)", () => {
  it.each(["claude", "codex"] as const)(
    "a %s conversation launched with ask still asks once switched to the terminal",
    async (harness) => {
      const created: CreateOptions[] = [];
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const providerSessionId = "8f14e45f-ceea-4e7a-9c2b-1f0a7e3d2c11";
      const terminal = await withEngine(
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
            yield* engine.launchProtocol(
              session.id,
              { mode: "protocol", prompt: "say hi", permissionMode: "ask" },
              "user-fixture",
            );
            const conversation = attached.at(-1)?.process;
            if (conversation === undefined) return yield* Effect.die("no conversation");
            expect(conversation.protocolOptions?.permissionMode).toBe("ask");
            world.processes.set(
              conversation.id,
              new SessionProcess({ ...conversation, providerSessionId }),
            );
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({ harness, providerSessionId, capturedAt: new Date().toISOString() }),
            );
            yield* engine.switchMode(session.id, "pty", { mode: "pty" }, null);
            return liveAgent(world.processes.values(), "agent-pty");
          }),
        {
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          protocolHostLayer: recordingProtocolHostLayer(attached, []),
        },
      );
      expect(terminal, "a live terminal agent after the switch").toBeDefined();
      const ran = ranFrom(spawned, harness);
      for (const flag of BYPASS_FLAGS) expect(ran).not.toContain(flag);
      expect(ran.join(" ")).toContain(askFlags(harness).join(" "));
    },
    30_000,
  );

  it.each(["claude", "codex"] as const)(
    "a %s terminal launched with ask still asks once switched to a conversation",
    async (harness) => {
      const created: CreateOptions[] = [];
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const permissionModes: Array<"bypass" | "ask"> = [];
      const conversation = await withEngine(
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
              composeLaunchArgv(harness, { mode: "pty", permissionMode: "ask" }),
            );
            const pty = liveAgent(world.processes.values(), "agent-pty");
            expect(pty?.argv.join(" ")).toContain(askFlags(harness).join(" "));
            yield* engine.switchMode(session.id, "protocol", { mode: "protocol" }, null);
            return liveAgent(world.processes.values(), "agent-protocol");
          }),
        {
          sealantLayer: sealantLaunchLayer(created),
          protocolHostLayer: recordingProtocolHostLayer(attached, [], [], permissionModes),
        },
      );
      expect(conversation, "a live conversation after the switch").toBeDefined();
      expect(conversation?.protocolOptions?.permissionMode).toBe("ask");
      expect(permissionModes).toEqual(["ask"]);
    },
    30_000,
  );
});

const resumingLayer = (created: CreateOptions[], spawned: Array<ReadonlyArray<string>>) =>
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

const stopped = (world: World, sessionId: SessionId) => {
  for (const process of world.processes.values()) {
    if (process.sessionId !== sessionId || process.exitedAt !== null) continue;
    world.processes.set(
      process.id,
      new SessionProcess({ ...process, status: "exited", exitCode: 0, exitedAt: now() }),
    );
  }
  const session = world.sessions.get(sessionId);
  if (session === undefined) throw new Error("no session to stop");
  world.sessions.set(
    sessionId,
    new Session({ ...session, status: "stopped", settledAt: now(), updatedAt: now() }),
  );
};

const claudeTranscript = [
  JSON.stringify({ type: "user", message: { role: "user", content: "add a health endpoint" } }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "Added it." }] },
  }),
].join("\n");

describe("a Resume keeps the session's permission mode (SLNT-147)", () => {
  it.each(["claude", "codex"] as const)(
    "a stopped %s terminal launched with ask still asks once resumed",
    async (harness) => {
      const created: CreateOptions[] = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const resumed = await withEngine(
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
              composeLaunchArgv(harness, { mode: "pty", permissionMode: "ask" }),
            );
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness,
                providerSessionId: "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10",
                capturedAt: new Date().toISOString(),
              }),
            );
            fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
            stopped(world, session.id);
            yield* engine.resumeSession(session.id, null);
            return liveAgent(world.processes.values(), "agent-pty");
          }),
        { sealantLayer: resumingLayer(created, spawned) },
      );
      expect(resumed?.argv.join(" ")).toContain(askFlags(harness).join(" "));
      const ran = ranFrom(spawned, harness);
      expect(ran.join(" ")).toContain("0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10");
      for (const flag of BYPASS_FLAGS) expect(ran).not.toContain(flag);
      expect(ran.join(" ")).toContain(askFlags(harness).join(" "));
    },
    30_000,
  );

  it("a claude terminal launched with ask resumed as codex asks in codex's own flags", async () => {
    const created: CreateOptions[] = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const resumed = await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(
            session.id,
            composeLaunchArgv("claude", { mode: "pty", permissionMode: "ask" }),
          );
          const stateDir = sessionStatePathOf(project.storePath, session.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10",
              capturedAt: new Date().toISOString(),
            }),
          );
          fs.writeFileSync(path.join(stateDir, "transcript.native"), claudeTranscript);
          fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
          stopped(world, session.id);
          yield* engine.resumeSession(session.id, "codex");
          return liveAgent(world.processes.values(), "agent-pty");
        }),
      { sealantLayer: resumingLayer(created, spawned) },
    );
    expect(resumed?.harness).toBe("codex");
    expect(resumed?.argv.slice(0, 2)).toEqual(["codex", "resume"]);
    const ran = ranFrom(spawned, "codex");
    for (const flag of BYPASS_FLAGS) expect(ran).not.toContain(flag);
    expect(ran.join(" ")).toContain(askFlags("codex").join(" "));
  }, 30_000);

  it("a claude terminal launched with ask resumed as opencode opens it asking", async () => {
    const created: CreateOptions[] = [];
    const spawned: Array<ReadonlyArray<string>> = [];
    const resumed = await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: null,
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(
            session.id,
            composeLaunchArgv("claude", { mode: "pty", permissionMode: "ask" }),
          );
          const stateDir = sessionStatePathOf(project.storePath, session.id);
          fs.mkdirSync(stateDir, { recursive: true });
          fs.writeFileSync(
            path.join(stateDir, "manifest.json"),
            JSON.stringify({
              harness: "claude",
              providerSessionId: "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10",
              capturedAt: new Date().toISOString(),
            }),
          );
          fs.writeFileSync(path.join(stateDir, "transcript.native"), claudeTranscript);
          fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
          stopped(world, session.id);
          yield* engine.resumeSession(session.id, "opencode");
          return liveAgent(world.processes.values(), "agent-pty");
        }),
      { sealantLayer: resumingLayer(created, spawned) },
    );
    expect(resumed?.harness).toBe("opencode");
    const script = resumed?.argv[2] ?? "";
    expect(script).toContain(`exec env 'OPENCODE_PERMISSION={"*":"ask"}' opencode`);
    expect(script).not.toContain('"allow"');
  }, 30_000);

  it.each(["claude", "codex"] as const)(
    "a %s session on bypass stays on bypass through a Resume and both switches",
    async (harness) => {
      const created: CreateOptions[] = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const permissionModes: Array<"bypass" | "ask"> = [];
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
            yield* engine.launch(session.id, composeLaunchArgv(harness, { mode: "pty" }));
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness,
                providerSessionId: "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10",
                capturedAt: new Date().toISOString(),
              }),
            );
            fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
            stopped(world, session.id);
            yield* engine.resumeSession(session.id, null);
            expect(ranFrom(spawned, harness)).toContain(BYPASS_FLAGS[harness === "claude" ? 0 : 1]);
            yield* engine.switchMode(session.id, "protocol", { mode: "protocol" }, null);
            const conversation = liveAgent(world.processes.values(), "agent-protocol");
            expect(conversation?.protocolOptions?.permissionMode).toBe("bypass");
            yield* engine.switchMode(session.id, "pty", { mode: "pty" }, null);
            expect(liveAgent(world.processes.values(), "agent-pty")).toBeDefined();
            expect(ranFrom(spawned, harness)).toContain(BYPASS_FLAGS[harness === "claude" ? 0 : 1]);
          }),
        {
          sealantLayer: resumingLayer(created, spawned),
          protocolHostLayer: recordingProtocolHostLayer([], [], [], permissionModes),
        },
      );
      expect(permissionModes).toEqual(["bypass"]);
    },
    30_000,
  );

  it.each(["claude", "codex"] as const)(
    "a %s terminal launched with ask still asks after switching to a conversation and back",
    async (harness) => {
      const created: CreateOptions[] = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      const permissionModes: Array<"bypass" | "ask"> = [];
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
              composeLaunchArgv(harness, { mode: "pty", permissionMode: "ask" }),
            );
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness,
                providerSessionId: "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10",
                capturedAt: new Date().toISOString(),
              }),
            );
            for (let round = 0; round < 2; round += 1) {
              yield* engine.switchMode(session.id, "protocol", { mode: "protocol" }, null);
              yield* engine.switchMode(session.id, "pty", { mode: "pty" }, null);
              const ran = ranFrom(spawned, harness);
              for (const flag of BYPASS_FLAGS) expect(ran).not.toContain(flag);
              expect(ran.join(" ")).toContain(askFlags(harness).join(" "));
            }
          }),
        {
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          protocolHostLayer: recordingProtocolHostLayer([], [], [], permissionModes),
        },
      );
      expect(permissionModes).toEqual(["ask", "ask"]);
    },
    30_000,
  );
});

const providerSessionId = "0d5c3c1e-7a51-4f0e-9c69-6a1d2b7e4f10";

describe("a mode switch to the terminal takes the permission mode it names (SLNT-147 review)", () => {
  it.each([
    ["ask", "bypass"],
    ["bypass", "ask"],
  ] as const)(
    "a claude conversation on %s switched to the terminal with %s runs it",
    async (ran, requested) => {
      const created: CreateOptions[] = [];
      const attached: Array<{ readonly process: SessionProcess; readonly mode: string }> = [];
      const spawned: Array<ReadonlyArray<string>> = [];
      await withEngine(
        (world, tmp) =>
          Effect.gen(function* () {
            const project = yield* setup(tmp, world);
            const engine = yield* SessionEngine;
            const session = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: null,
              name: null,
              ownerUserId: "user-fixture",
              start: { kind: "base", base: null },
            });
            yield* engine.launchProtocol(
              session.id,
              { mode: "protocol", prompt: "say hi", permissionMode: ran },
              "user-fixture",
            );
            const conversation = attached.at(-1)?.process;
            if (conversation === undefined) return yield* Effect.die("no conversation");
            world.processes.set(
              conversation.id,
              new SessionProcess({ ...conversation, providerSessionId }),
            );
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({
                harness: "claude",
                providerSessionId,
                capturedAt: new Date().toISOString(),
              }),
            );
            yield* engine.switchMode(
              session.id,
              "pty",
              { mode: "pty", permissionMode: requested },
              null,
            );
          }),
        {
          sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned),
          protocolHostLayer: recordingProtocolHostLayer(attached, []),
        },
      );
      const terminal = ranFrom(spawned, "claude");
      if (requested === "bypass") {
        expect(terminal).toContain("--dangerously-skip-permissions");
        expect(terminal).not.toContain("--permission-mode");
      } else {
        expect(terminal).not.toContain("--dangerously-skip-permissions");
        expect(terminal.join(" ")).toContain(askFlags("claude").join(" "));
      }
    },
    30_000,
  );
});

describe("a Resume on the same harness keeps the permission the terminal ran with (SLNT-147 review)", () => {
  it.each<readonly ["claude" | "codex", ReadonlyArray<string>]>([
    ["claude", ["--permission-mode", "plan"]],
    ["codex", ["--sandbox", "read-only", "-a", "never"]],
  ])(
    "a stopped %s terminal launched with %j resumes with it",
    async (harness, permission) => {
      const created: CreateOptions[] = [];
      const spawned: Array<ReadonlyArray<string>> = [];
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
            yield* engine.launch(session.id, [harness, ...permission]);
            const stateDir = sessionStatePathOf(project.storePath, session.id);
            fs.mkdirSync(stateDir, { recursive: true });
            fs.writeFileSync(
              path.join(stateDir, "manifest.json"),
              JSON.stringify({ harness, providerSessionId, capturedAt: new Date().toISOString() }),
            );
            fs.writeFileSync(path.join(stateDir, "harness-state.tar.gz"), "fake-archive");
            stopped(world, session.id);
            yield* engine.resumeSession(session.id, null);
          }),
        { sealantLayer: resumingLayer(created, spawned) },
      );
      const ran = ranFrom(spawned, harness);
      expect(ran.join(" ")).toContain(providerSessionId);
      expect(ran.join(" ")).toContain(permission.join(" "));
      const composedAsk = askFlags(harness).filter((token) => !permission.includes(token));
      for (const token of [...BYPASS_FLAGS, ...composedAsk]) expect(ran).not.toContain(token);
    },
    30_000,
  );
});
