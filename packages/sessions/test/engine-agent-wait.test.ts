import { SessionId } from "@mend/domain";
import {
  AgentHookReport,
  type HookedHarness,
  SessionProcess,
  agentWaitLine,
  currentAgentProcess,
} from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import type { CreateOptions } from "@sealant/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  CHANNEL_NOT_STARTED_HERE,
  CONTAINER_TOKEN_REFUSED,
  containerTokenRefused,
  pickupOnly,
} from "../src/channel-identity.ts";
import { CLAUDE_AGENT_HOOKS } from "../src/claude-settings.ts";
import {
  sealantLaunchLayer,
  servedSocketApis,
  setup,
  withEngine,
  type World,
} from "./engine/fixture.ts";

const report = (
  event: string,
  fields: {
    readonly harness?: HookedHarness;
    readonly tool?: string;
    readonly providerSessionId?: string | null;
  } = {},
) =>
  new AgentHookReport({
    harness: fields.harness ?? "claude",
    event,
    notificationType: null,
    tool: fields.tool ?? null,
    providerSessionId: fields.providerSessionId ?? null,
  });

const hookOf = (sessionId: SessionId) => {
  const api = servedSocketApis.get(sessionId);
  if (api === undefined) throw new Error("the session serves no channel");
  return api.agentHook;
};

const agentOf = (world: World, sessionId: SessionId) =>
  currentAgentProcess([...world.processes.values()].filter((row) => row.sessionId === sessionId));

const statusOf = (world: World, sessionId: SessionId) => world.sessions.get(sessionId)?.status;

const own = (
  world: World,
  sessionId: SessionId,
  event: string,
  fields: { readonly harness?: HookedHarness; readonly tool?: string } = {},
) =>
  report(event, {
    ...fields,
    providerSessionId: agentOf(world, sessionId)?.providerSessionId ?? null,
  });

const withTerminalSession = <A, E>(
  harness: HookedHarness,
  work: (world: World, sessionId: SessionId) => Effect.Effect<A, E, SessionEngine>,
  spawned: Array<ReadonlyArray<string>> = [],
) => {
  const created: Array<CreateOptions> = [];
  return withEngine(
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
          base: null,
        });
        yield* engine.launch(session.id, [harness]);
        expect(agentOf(world, session.id)?.kind).toBe("agent-pty");
        return yield* work(world, session.id);
      }),
    { sealantLayer: sealantLaunchLayer(created, undefined, undefined, spawned) },
  );
};

const withClaudeSession = <A, E>(
  work: (world: World, sessionId: SessionId) => Effect.Effect<A, E, SessionEngine>,
  spawned: Array<ReadonlyArray<string>> = [],
) => withTerminalSession("claude", work, spawned);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANOTHER_CONVERSATION = "7d1e6f0a-2b3c-4d5e-8f90-a1b2c3d4e5f6";

describe("a terminal agent's hooks (G4)", () => {
  it("starts a terminal claude in the shared layout pinned to a session id, with Mend's hooks and nothing else", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const recorded = await withClaudeSession(
      (world, sessionId) => Effect.succeed(agentOf(world, sessionId)?.providerSessionId),
      spawned,
    );
    const claude = spawned.find((argv) => argv.includes("claude")) ?? [];
    const [flag, pinned, ...rest] = claude.slice(-4);
    expect(flag).toBe("--session-id");
    expect(pinned).toMatch(UUID);
    expect(rest).toEqual(["--settings", JSON.stringify({ hooks: CLAUDE_AGENT_HOOKS })]);
    expect(recorded).toBe(pinned);
  });

  it("changes nothing for a report from another claude in the same session", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        expect(
          yield* hook(
            report("PermissionRequest", { tool: "Bash", providerSessionId: ANOTHER_CONVERSATION }),
          ),
        ).toBe("other-process");
        expect(yield* hook(report("Stop", { providerSessionId: ANOTHER_CONVERSATION }))).toBe(
          "other-process",
        );
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
        expect(yield* hook(report("Stop"))).toBe("unidentified");
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });

  it("names a codex by its first session start, and nothing after it", async () => {
    await withTerminalSession("codex", (world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        const THREAD = "019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b";
        const codex = (event: string, providerSessionId: string) =>
          hook(report(event, { harness: "codex", providerSessionId }));
        expect(agentOf(world, sessionId)?.providerSessionId).toBeNull();
        expect(yield* codex("Stop", THREAD)).toBe("other-process");
        expect(statusOf(world, sessionId)).toBe("running");

        expect(yield* codex("SessionStart", THREAD)).toBe("ignored");
        expect(agentOf(world, sessionId)?.providerSessionId).toBe(THREAD);
        expect(yield* codex("SessionStart", ANOTHER_CONVERSATION)).toBe("other-process");
        expect(agentOf(world, sessionId)?.providerSessionId).toBe(THREAD);

        expect(yield* codex("Stop", THREAD)).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("waiting");
      }),
    );
  });

  it("reads waiting while claude asks, and running once the tool ran or a prompt arrived", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        expect(statusOf(world, sessionId)).toBe("running");

        expect(yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }))).toBe(
          "applied",
        );
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe(
          "waiting · claude needs your permission to use Bash",
        );
        expect(
          yield* hook(
            new AgentHookReport({
              harness: "claude",
              event: "Notification",
              notificationType: "permission_prompt",
              tool: null,
              providerSessionId: agentOf(world, sessionId)?.providerSessionId ?? null,
            }),
          ),
        ).toBe("unchanged");

        expect(yield* hook(own(world, sessionId, "PostToolUse", { tool: "Bash" }))).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();

        expect(yield* hook(own(world, sessionId, "Stop"))).toBe("applied");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe("waiting · claude finished its turn");
        expect(yield* hook(own(world, sessionId, "UserPromptSubmit"))).toBe("applied");
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });

  it("keeps the wait across a reconcile some other process start runs", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* hookOf(sessionId)(own(world, sessionId, "PermissionRequest", { tool: "Bash" }));
        yield* engine.openShell(sessionId);
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentOf(world, sessionId)?.waiting?.tool).toBe("Bash");
      }),
    );
  });

  it("clears the wait when the person types in the agent's terminal, not in a shell beside it", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* hookOf(sessionId)(own(world, sessionId, "PermissionRequest", { tool: "Bash" }));
        const shell = yield* engine.openShell(sessionId);
        expect(yield* engine.personTyped(shell.id, new Date())).toBe(false);
        expect(statusOf(world, sessionId)).toBe("waiting");
        const agent = agentOf(world, sessionId);
        if (agent === null) throw new Error("no agent");
        expect(yield* engine.personTyped(agent.id, new Date())).toBe(true);
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
        expect(yield* engine.personTyped(agent.id, new Date())).toBe(false);
      }),
    );
  });

  it("keeps a wait that opened after the key", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* hookOf(sessionId)(own(world, sessionId, "PermissionRequest", { tool: "Bash" }));
        const asked = agentOf(world, sessionId);
        const wait = asked?.waiting ?? null;
        if (asked === null || wait === null) throw new Error("no wait");
        expect(yield* engine.personTyped(asked.id, new Date(wait.since.getTime() - 1))).toBe(false);
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentOf(world, sessionId)?.waiting).toEqual(wait);
      }),
    );
  });

  it("keeps a finished turn waiting through keys, until a prompt is submitted", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        yield* hookOf(sessionId)(own(world, sessionId, "Stop"));
        const agent = agentOf(world, sessionId);
        if (agent === null) throw new Error("no agent");
        expect(yield* engine.personTyped(agent.id, new Date())).toBe(false);
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe("waiting · claude finished its turn");
        yield* hookOf(sessionId)(own(world, sessionId, "UserPromptSubmit"));
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });

  it("brings no wait back from a report that arrives after the agent ended", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const engine = yield* SessionEngine;
        const hook = hookOf(sessionId);
        yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }));
        yield* engine.stop(sessionId);
        const ended = agentOf(world, sessionId);
        expect(ended?.exitedAt).not.toBeNull();
        expect(ended?.waiting).toBeNull();
        const statusAfterStop = statusOf(world, sessionId);
        expect(statusAfterStop).not.toBe("waiting");

        expect(yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }))).toBe(
          "no-live-agent",
        );
        expect(statusOf(world, sessionId)).toBe(statusAfterStop);
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
      }),
    );
  });

  it("answers no live agent when the session's live agent is not a terminal agent of that harness", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        expect(
          yield* hook(
            own(world, sessionId, "PermissionRequest", { harness: "codex", tool: "shell" }),
          ),
        ).toBe("no-live-agent");
        const agent = agentOf(world, sessionId);
        if (agent === null) throw new Error("no agent");
        world.processes.set(agent.id, new SessionProcess({ ...agent, kind: "agent-protocol" }));
        expect(yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }))).toBe(
          "no-live-agent",
        );
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
      }),
    );
  });

  it("ignores an event outside the table without touching the session", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        expect(
          yield* hookOf(sessionId)(own(world, sessionId, "PreToolUse", { tool: "Bash" })),
        ).toBe("ignored");
        expect(statusOf(world, sessionId)).toBe("running");
      }),
    );
  });

  it("reads waiting on a PermissionRequest that follows 70 PostToolUse reports in a minute", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        for (let sent = 0; sent < 70; sent++) {
          expect(yield* hook(own(world, sessionId, "PostToolUse", { tool: "Bash" }))).toBe(
            "unchanged",
          );
        }
        expect(yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }))).toBe(
          "applied",
        );
        expect(statusOf(world, sessionId)).toBe("waiting");
        expect(agentWaitLine(agentOf(world, sessionId))).toBe(
          "waiting · claude needs your permission to use Bash",
        );
      }),
    );
  });

  it("refuses the 61st change a session's agent makes to its wait in a minute", async () => {
    await withClaudeSession((world, sessionId) =>
      Effect.gen(function* () {
        const hook = hookOf(sessionId);
        for (let flip = 0; flip < 30; flip++) {
          expect(yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }))).toBe(
            "applied",
          );
          expect(yield* hook(own(world, sessionId, "PostToolUse", { tool: "Bash" }))).toBe(
            "applied",
          );
        }
        expect(yield* hook(own(world, sessionId, "PostToolUse", { tool: "Bash" }))).toBe(
          "unchanged",
        );
        const refused = yield* hook(own(world, sessionId, "PermissionRequest", { tool: "Bash" }));
        expect(refused).toMatchObject({ _tag: "too-many" });
        expect(typeof refused === "object" ? refused.retryAfterSeconds : 0).toBeGreaterThan(0);
        expect(statusOf(world, sessionId)).toBe("running");
        expect(agentOf(world, sessionId)?.waiting).toBeNull();
      }),
    );
  });
});

const refusalOf = <A, E>(effect: Effect.Effect<A, E>) => {
  const exit = Effect.runSync(Effect.exit(effect));
  return Exit.isFailure(exit) ? String(exit.cause) : "";
};

describe("who may report a wait over the session channel", () => {
  it("refuses the workspace's own token in a person executor, and a token whose process has not started", () => {
    const asContainer = containerTokenRefused(undefined, undefined);
    expect(
      refusalOf(asContainer.agentHook(report("PermissionRequest", { tool: "Bash" }))),
    ).toContain(CONTAINER_TOKEN_REFUSED);
    expect(refusalOf(pickupOnly(undefined).agentHook(report("Stop")))).toContain(
      CHANNEL_NOT_STARTED_HERE,
    );
  });
});
