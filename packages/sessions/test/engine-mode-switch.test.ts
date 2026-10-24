import * as fs from "node:fs";
import * as path from "node:path";

import { composeLaunchArgv, SessionProcess } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { sessionStatePathOf } from "@mend/store";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
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
