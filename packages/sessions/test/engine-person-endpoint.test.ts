// A key with an endpoint (docs/adr/0018, decision 11): every Claude and Codex launch on it sends
// its requests to the endpoint, and nothing else in the launch carries the endpoint.

import { linuxLoginNameOf } from "@mend/db";
import { EndpointUrl } from "@mend/domain/endpoint-url";
import { PersonLayoutPlatform, type PersonSessionOptions, type PlacedLogin } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import type { SessionOptions, Workspace } from "@sealant/sdk";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import {
  recordingProtocolHostLayer,
  sealantLaunchLayer,
  setup,
  withEngine,
} from "./engine/fixture.ts";
import { LAYOUT_READY, MARIA, answerLayout, personPlatform } from "./engine/person-fixture.ts";

const CLAUDE_ENDPOINT = "https://gateway.example.com/anthropic";
const CODEX_ENDPOINT = "http://10.0.0.5:4000/v1";
const keyPathOf = (accountId: string) =>
  `/home/${linuxLoginNameOf(accountId)}/.sealant/keys/plc_${accountId}`;

/** The person platform, with Core placing `holder`'s Claude and Codex keys, each with an endpoint. */
const placingEndpointKeysFor = (holder: string) =>
  Layer.effect(
    PersonLayoutPlatform,
    Effect.map(PersonLayoutPlatform, (inner) => ({
      ...inner,
      postCredentials: (workspace: Workspace, input: Parameters<typeof inner.postCredentials>[1]) =>
        inner.postCredentials(workspace, input).pipe(
          Effect.as({
            skipped: [],
            placed:
              input.onBehalfOf !== holder
                ? {}
                : {
                    ...(input.logins.claude === true
                      ? {
                          claude: {
                            kind: "api-key",
                            suffix: "a1b2",
                            keyPath: keyPathOf(holder),
                            baseUrl: Schema.decodeSync(EndpointUrl)(CLAUDE_ENDPOINT),
                          } satisfies PlacedLogin,
                        }
                      : {}),
                    ...(input.logins.codex === true
                      ? {
                          codex: {
                            kind: "api-key",
                            suffix: "c3d4",
                            baseUrl: Schema.decodeSync(EndpointUrl)(CODEX_ENDPOINT),
                          } satisfies PlacedLogin,
                        }
                      : {}),
                  },
          }),
        ),
    })),
  ).pipe(Layer.provide(personPlatform([], { person: true })));

const settingsOf = (argv: ReadonlyArray<string> | undefined): unknown =>
  JSON.parse(argv?.[argv.indexOf("--settings") + 1] ?? "null");

/** The harness's own command line inside a launch's bootstrap wrapper (`sh -c … sh claude …`). */
const harnessArgvs = (
  spawned: ReadonlyArray<ReadonlyArray<string>>,
  harness: string,
): ReadonlyArray<ReadonlyArray<string>> =>
  spawned.flatMap((argv) => {
    const at = argv.indexOf(harness);
    return at === -1 ? [] : [argv.slice(at)];
  });

/** A launcher's session on a subscription, then Maria's terminal and conversation beside it. */
const launchBeside = (harness: "claude" | "codex") => {
  const spawned: Array<ReadonlyArray<string>> = [];
  const opened: Array<SessionOptions | PersonSessionOptions> = [];
  const execs: Array<ReadonlyArray<string>> = [];
  const attached: Parameters<typeof recordingProtocolHostLayer>[0] = [];
  const run = withEngine(
    (world, tmp) =>
      Effect.gen(function* () {
        const project = yield* setup(tmp, world);
        const engine = yield* SessionEngine;
        const holder = yield* engine.provision({
          projectId: project.id,
          harness,
          label: null,
          name: "shared",
          ownerUserId: "user-fixture",
          start: { kind: "base", base: null },
        });
        yield* engine.launch(holder.id, [harness]);
        const terminal = yield* engine.provisionSessionIn(holder.worktreeId, {
          harness,
          label: null,
          ownerUserId: MARIA,
        });
        yield* engine.launch(terminal.id, [harness]);
        const conversation = yield* engine.provisionSessionIn(holder.worktreeId, {
          harness,
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
        execs,
        undefined,
        { exec: answerLayout(LAYOUT_READY) },
      ),
      harnessLayout: { flag: "person", platform: placingEndpointKeysFor(MARIA) },
    },
  );
  return run.then(() => ({ spawned, opened, execs, attached }));
};

describe("a key with an endpoint, at launch (docs/adr/0018, decision 11)", () => {
  it("Maria's terminal and conversation Claude send her key's requests to its endpoint; the launcher's do not", async () => {
    const { spawned, opened, execs } = await launchBeside("claude");
    const claudes = harnessArgvs(spawned, "claude");
    const [launcher, terminal] = claudes.filter((argv) => !argv.includes("--print"));
    const protocol = claudes.find((argv) => argv.includes("--print"));
    expect(JSON.stringify(settingsOf(launcher))).not.toContain("ANTHROPIC_BASE_URL");
    for (const argv of [terminal, protocol]) {
      expect(settingsOf(argv)).toMatchObject({
        apiKeyHelper: `cat '${keyPathOf(MARIA)}'`,
        env: {
          ANTHROPIC_BASE_URL: CLAUDE_ENDPOINT,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          CLAUDE_CODE_MAX_RETRIES: "3",
          CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
        },
      });
    }
    const elsewhere = JSON.stringify({ env: opened.map((options) => options.env ?? {}), execs });
    expect(elsewhere).not.toContain("gateway.example.com");
  }, 30_000);

  it("Maria's terminal and app-server Codex select Mend's provider on the command line; the launcher's do not", async () => {
    const { spawned, opened, execs } = await launchBeside("codex");
    const codexes = harnessArgvs(spawned, "codex");
    const overrides = [
      "-c",
      'model_provider="mend-endpoint"',
      "-c",
      'model_providers.mend-endpoint.name="Custom endpoint"',
      "-c",
      `model_providers.mend-endpoint.base_url="${CODEX_ENDPOINT}"`,
      "-c",
      'model_providers.mend-endpoint.wire_api="responses"',
      "-c",
      "model_providers.mend-endpoint.requires_openai_auth=true",
      "-c",
      "features.unbounded_connection_retries=false",
      "-c",
      "analytics.enabled=false",
    ];
    /** Where the overrides start, as one run, in a command line; -1 when they are not there. */
    const runAt = (argv: ReadonlyArray<string>) =>
      argv.findIndex((_, at) => overrides.every((word, offset) => argv[at + offset] === word));
    const carries = (argv: ReadonlyArray<string>) => runAt(argv) > 0;
    const [launcher, terminal] = codexes.filter((argv) => !argv.includes("app-server"));
    const appServer = codexes.find((argv) => argv.includes("app-server"));
    expect(launcher !== undefined && carries(launcher)).toBe(false);
    expect(terminal !== undefined && carries(terminal)).toBe(true);
    expect(appServer !== undefined && carries(appServer)).toBe(true);
    expect(appServer?.at(-1)).toBe("app-server");
    expect(runAt(appServer ?? [])).toBeLessThan(appServer?.indexOf("app-server") ?? -1);
    const elsewhere = JSON.stringify({ env: opened.map((options) => options.env ?? {}), execs });
    expect(elsewhere).not.toContain("10.0.0.5");
  }, 30_000);
});
