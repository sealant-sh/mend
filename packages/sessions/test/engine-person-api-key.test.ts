// Claude on a person's own API key (docs/adr/0018, decisions 1 and 4): the key Core placed in a
// person's home is read through `apiKeyHelper` in every Claude launch, and never reaches argv,
// the environment or a record.

import { linuxLoginNameOf } from "@mend/db";
import { PersonLayoutPlatform, type PersonSessionOptions, type PlacedLogin } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import type { SessionOptions, Workspace } from "@sealant/sdk";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { CLAUDE_AGENT_HOOKS } from "../src/claude-settings.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { LAYOUT_READY, MARIA, answerLayout, personPlatform } from "./engine/person-fixture.ts";

const FAKE_KEY = "sk-ant-api03-FAKE-not-a-real-key-0000000000a1b2";
const keyPathOf = (accountId: string) =>
  `/home/${linuxLoginNameOf(accountId)}/.sealant/keys/plc_${accountId}`;
const keyLoginIn = (accountId: string): PlacedLogin => ({
  kind: "api-key",
  suffix: FAKE_KEY.slice(-4),
  keyPath: keyPathOf(accountId),
});

/** The person platform, with Core answering that `keyHolders`' Claude logins it placed are keys. */
const placingKeysFor = (calls: Array<string>, keyHolders: ReadonlySet<string>) =>
  Layer.effect(
    PersonLayoutPlatform,
    Effect.map(PersonLayoutPlatform, (inner) => ({
      ...inner,
      postCredentials: (workspace: Workspace, input: Parameters<typeof inner.postCredentials>[1]) =>
        inner.postCredentials(workspace, input).pipe(
          Effect.as({
            skipped: [],
            placed:
              keyHolders.has(input.onBehalfOf) && input.logins.claude === true
                ? { claude: keyLoginIn(input.onBehalfOf) }
                : {},
          }),
        ),
    })),
  ).pipe(Layer.provide(personPlatform(calls, { person: true })));

const settingsOf = (argv: ReadonlyArray<string> | undefined): unknown =>
  JSON.parse(argv?.[argv.indexOf("--settings") + 1] ?? "null");

/** Nothing of the key's value in what a launch ran with: its argv and environment. */
const expectNoKeyIn = (
  spawned: ReadonlyArray<ReadonlyArray<string>>,
  opened: ReadonlyArray<SessionOptions | PersonSessionOptions>,
) => {
  const built = JSON.stringify({ spawned, env: opened.map((options) => options.env ?? {}) });
  expect(built).not.toContain(FAKE_KEY);
  expect(built).not.toContain("ANTHROPIC_API_KEY");
};

describe("Claude on a person's placed API key (docs/adr/0018, decision 1)", () => {
  it("a joiner's terminal and conversation Claude read her key through apiKeyHelper; the launcher's subscription Claude keeps its settings", async () => {
    const spawned: Array<ReadonlyArray<string>> = [];
    const opened: Array<SessionOptions | PersonSessionOptions> = [];
    const attached: Parameters<typeof recordingProtocolHostLayer>[0] = [];
    await withEngine(
      (world, tmp) =>
        Effect.gen(function* () {
          const project = yield* setup(tmp, world);
          const engine = yield* SessionEngine;
          const holder = yield* engine.provision({
            projectId: project.id,
            harness: "claude",
            label: null,
            name: "shared",
            ownerUserId: "user-fixture",
            start: { kind: "base", base: null },
          });
          yield* engine.launch(holder.id, ["claude"]);
          const terminal = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launch(terminal.id, ["claude"]);
          const conversation = yield* engine.provisionSessionIn(holder.worktreeId, {
            harness: "claude",
            label: null,
            ownerUserId: MARIA,
          });
          yield* engine.launchProtocol(conversation.id, { mode: "protocol" }, MARIA);
        }),
      {
        captured: makeMemoryCaptureStore(),
        prepareWorld: (world) => world.members.set(MARIA, "member"),
        protocolHostLayer: recordingProtocolHostLayer(attached, []),
        sealantLayer: sealantLaunchLayer(
          [],
          undefined,
          undefined,
          spawned,
          undefined,
          undefined,
          undefined,
          opened,
          undefined,
          [],
          undefined,
          { exec: answerLayout(LAYOUT_READY) },
        ),
        harnessLayout: { flag: "person", platform: placingKeysFor([], new Set([MARIA])) },
      },
    );
    const claudes = spawned.filter((argv) => argv.includes("--settings"));
    const [launcher, joiner] = claudes.filter((argv) => !argv.includes("--print"));
    expect(settingsOf(launcher)).toEqual({
      env: { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      hooks: CLAUDE_AGENT_HOOKS,
    });
    const keyPath = keyPathOf(MARIA);
    expect(settingsOf(joiner)).toEqual({
      env: {
        CLAUDE_CODE_DISABLE_CRON: "1",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      },
      apiKeyHelper: `cat '${keyPath}'`,
      hooks: CLAUDE_AGENT_HOOKS,
    });
    // The conversation's process is hers, and the pipe it opened carries the same settings.
    expect(attached.at(-1)?.process.runsAs).toBe(MARIA);
    const protocol = claudes.find((argv) => argv.includes("--print"));
    expect(settingsOf(protocol)).toEqual({
      env: {
        CLAUDE_CODE_DISABLE_CRON: "1",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      },
      apiKeyHelper: `cat '${keyPath}'`,
    });
    expectNoKeyIn([...spawned, ...attached.map((entry) => entry.process.argv)], opened);
  }, 30_000);
});
