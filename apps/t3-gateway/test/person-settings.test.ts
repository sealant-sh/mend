import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProviderInstanceId,
  ProjectId,
  WS_METHODS,
  type ServerConfigStreamEvent,
} from "@mend/t3-contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@mend/t3-contracts/keybindings";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const BOB = { id: "user-2", name: "Bob", email: "bob@example.com" } as const;
const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
const until = (ready: () => boolean, what = "personal configuration") =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ready()) return;
      yield* Effect.sleep("20 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });
const binding = {
  key: "ctrl+shift+y",
  command: "terminal.toggle",
  when: "!terminalFocus",
} as const;
const replacement = { ...binding, key: "ctrl+shift+u" };

// People edit these preferences and shortcuts in ordinary T3 Settings use, across devices.
describe("personal settings and keybindings over the gateway", () => {
  it.live("persist, notify the person's other devices, and keep other people separate", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const statePath = join(
        mkdtempSync(join(tmpdir(), "t3-gateway-person-settings-")),
        "state.sqlite",
      );
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "SETTINGS-ADA-1");
        const other = yield* pairAndConnect(mend, "SETTINGS-ADA-2");
        const bob = yield* pairAndConnect(mend, "SETTINGS-BOB-1", BOB);
        const heard: Array<ServerConfigStreamEvent> = [];
        const bobHeard: Array<ServerConfigStreamEvent> = [];
        for (const [client, events] of [
          [other, heard],
          [bob, bobHeard],
        ] as const) {
          yield* client.rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkScoped,
          );
        }
        yield* until(() => heard.length > 0 && bobHeard.length > 0);
        assert.isFalse(
          (yield* ada.rpc[WS_METHODS.serverGetConfig]({})).settings.removeAgentCreditsOnMerge,
        );
        const saved = yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: {
            reviewGuidesEnabled: true,
            removeAgentCreditsOnMerge: true,
            sourceControlWriterModelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
              options: [{ id: "effort", value: "high" }],
            },
            sourceControlWritingStyle: {
              mode: "custom",
              customInstructions: "Use concise subject lines",
              followChangeRequestTemplates: false,
            },
            textGenerationModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4-mini",
            },
            responseStreamingMode: "turn",
            environmentIcon: "laptop",
            defaultRuntimeMode: "approval-required",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
            },
          },
        });
        assert.isTrue(saved.reviewGuidesEnabled);
        assert.isTrue(saved.removeAgentCreditsOnMerge);
        assert.strictEqual(saved.sourceControlWriterModelSelection?.instanceId, "claudeAgent");
        assert.strictEqual(
          saved.sourceControlWritingStyle.customInstructions,
          "Use concise subject lines",
        );
        const restyled = yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: { sourceControlWritingStyle: { followChangeRequestTemplates: true } },
        });
        assert.strictEqual(
          restyled.sourceControlWritingStyle.customInstructions,
          "Use concise subject lines",
        );
        assert.isTrue(restyled.sourceControlWritingStyle.followChangeRequestTemplates);
        assert.strictEqual(saved.defaultRuntimeMode, "approval-required");
        yield* until(() =>
          heard.some(
            (event) =>
              event.type === "settingsUpdated" && event.payload.settings.reviewGuidesEnabled,
          ),
        );
        yield* until(() =>
          heard.some(
            (event) =>
              event.type === "settingsUpdated" && event.payload.settings.removeAgentCreditsOnMerge,
          ),
        );
        const projectId = ProjectId.make("project-defaults");
        const projectSettings = yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: {
            projectSettingsOverrides: {
              [projectId]: {
                removeAgentCreditsOnMerge: false,
                defaultRuntimeMode: "approval-required",
                responseStreamingMode: "turn",
              },
            },
          },
        });
        assert.strictEqual(
          projectSettings.projectSettingsOverrides[projectId]?.defaultRuntimeMode,
          "approval-required",
        );
        assert.isFalse(
          projectSettings.projectSettingsOverrides[projectId]?.removeAgentCreditsOnMerge,
        );
        const first = yield* ada.rpc[WS_METHODS.serverUpsertKeybinding](binding);
        assert.notDeepEqual(first.keybindings, DEFAULT_RESOLVED_KEYBINDINGS);
        const changed = yield* ada.rpc[WS_METHODS.serverUpsertKeybinding]({
          ...replacement,
          replace: binding,
        });
        yield* until(
          () => heard.filter((event) => event.type === "keybindingsUpdated").length === 2,
          "two keybinding updates",
        );
        const current = yield* other.rpc[WS_METHODS.serverGetConfig]({});
        assert.deepStrictEqual(current.keybindings, changed.keybindings);
        assert.isTrue(current.settings.reviewGuidesEnabled);
        assert.isTrue(current.settings.removeAgentCreditsOnMerge);
        assert.isTrue(current.environment.capabilities?.environmentIcon);
        assert.isTrue(current.environment.capabilities?.projectSettingsOverrides);
        const beforeModel = heard.filter((event) => event.type === "keybindingsUpdated").length;
        yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: {
            setModelFavorites: [
              { provider: ProviderInstanceId.make("codex"), model: "gpt-5.4", favorite: true },
            ],
          },
        });
        yield* until(() =>
          heard.some(
            (event) =>
              event.type === "settingsUpdated" && event.payload.settings.favorites?.length === 1,
          ),
        );
        assert.strictEqual(
          heard.filter((event) => event.type === "keybindingsUpdated").length,
          beforeModel,
        );
        const bobConfig = yield* bob.rpc[WS_METHODS.serverGetConfig]({});
        assert.isFalse(bobConfig.settings.reviewGuidesEnabled);
        assert.isFalse(bobConfig.settings.removeAgentCreditsOnMerge);
        assert.isUndefined(bobConfig.settings.projectSettingsOverrides[projectId]);
        assert.deepStrictEqual(bobConfig.keybindings, DEFAULT_RESOLVED_KEYBINDINGS);
        yield* Effect.sleep("100 millis");
        assert.deepStrictEqual(
          bobHeard.map((event) => event.type),
          ["snapshot"],
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "SETTINGS-ADA-3");
        const current = yield* ada.rpc[WS_METHODS.serverGetConfig]({});
        assert.isTrue(current.settings.reviewGuidesEnabled);
        assert.isTrue(current.settings.removeAgentCreditsOnMerge);
        assert.isFalse(
          current.settings.projectSettingsOverrides[ProjectId.make("project-defaults")]
            ?.removeAgentCreditsOnMerge,
        );
        assert.strictEqual(current.settings.responseStreamingMode, "turn");
        assert.strictEqual(current.settings.environmentIcon, "laptop");
        assert.strictEqual(
          current.settings.sourceControlWriterModelSelection?.model,
          "claude-sonnet-4-6",
        );
        assert.strictEqual(
          current.settings.sourceControlWritingStyle.customInstructions,
          "Use concise subject lines",
        );
        assert.strictEqual(current.settings.textGenerationModelSelection.model, "gpt-5.4-mini");
        assert.strictEqual(current.settings.defaultModelSelection?.model, "gpt-5.4");
        assert.strictEqual(
          current.settings.projectSettingsOverrides[ProjectId.make("project-defaults")]
            ?.responseStreamingMode,
          "turn",
        );
        const inherited = yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: { projectSettingsOverrides: { [ProjectId.make("project-defaults")]: null } },
        });
        assert.isUndefined(inherited.projectSettingsOverrides[ProjectId.make("project-defaults")]);
        assert.notDeepEqual(current.keybindings, DEFAULT_RESOLVED_KEYBINDINGS);
        const removed = yield* ada.rpc[WS_METHODS.serverRemoveKeybinding](replacement);
        assert.deepStrictEqual(removed.keybindings, DEFAULT_RESOLVED_KEYBINDINGS);
        const reset = yield* ada.rpc[WS_METHODS.serverUpdateSettings]({
          patch: {
            reviewGuidesEnabled: false,
            removeAgentCreditsOnMerge: false,
            defaultModelSelection: null,
          },
        });
        assert.isFalse(reset.reviewGuidesEnabled);
        assert.isFalse(reset.removeAgentCreditsOnMerge);
        assert.isNull(reset.defaultModelSelection);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    }),
  );

  it.live(
    "refuses narrow grants, invalid bindings and unsupported settings without partial writes",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const statePath = join(
          mkdtempSync(join(tmpdir(), "t3-gateway-person-refusals-")),
          "state.sqlite",
        );
        yield* Effect.gen(function* () {
          const reader = yield* pairAndConnect(
            mend,
            "SETTINGS-READER",
            PERSON,
            "orchestration:read orchestration:operate",
          );
          const refusal = failureOf(
            yield* Effect.exit(
              reader.rpc[WS_METHODS.serverUpdateSettings]({ patch: { reviewGuidesEnabled: true } }),
            ),
          );
          assert.strictEqual(refusal?._tag, "EnvironmentAuthorizationError");
          const bindingRefusal = failureOf(
            yield* Effect.exit(reader.rpc[WS_METHODS.serverUpsertKeybinding](binding)),
          );
          assert.strictEqual(bindingRefusal?._tag, "EnvironmentAuthorizationError");
          const ada = yield* pairAndConnect(mend, "SETTINGS-WRITER");
          for (const patch of [
            { reviewGuidesEnabled: true, reviewGuideInstructions: "custom" },
            { defaultRuntimeMode: "auto" as const },
            {
              projectSettingsOverrides: {
                [ProjectId.make("project-defaults")]: { defaultRuntimeMode: "auto" as const },
              },
            },
            {
              projectSettingsOverrides: {
                [ProjectId.make("project-defaults")]: { reviewGuideInstructions: "custom" },
              },
            },
          ]) {
            const unsupported = failureOf(
              yield* Effect.exit(ada.rpc[WS_METHODS.serverUpdateSettings]({ patch })),
            );
            assert.strictEqual(unsupported?._tag, "EnvironmentAuthorizationError");
          }
          for (const invalid of [
            { ...binding, key: "ctrl+y+z" },
            { ...binding, when: "terminalFocus &&" },
          ]) {
            const bad = failureOf(
              yield* Effect.exit(ada.rpc[WS_METHODS.serverUpsertKeybinding](invalid)),
            );
            assert.strictEqual(bad?._tag, "KeybindingsConfigParseError");
          }
          const oversized = failureOf(
            yield* Effect.exit(
              ada.rpc[WS_METHODS.serverUpdateSettings]({
                patch: {
                  defaultModelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "m".repeat(65 * 1024),
                  },
                },
              }),
            ),
          );
          assert.strictEqual(oversized?._tag, "ServerSettingsError");
          const config = yield* ada.rpc[WS_METHODS.serverGetConfig]({});
          assert.isFalse(config.settings.reviewGuidesEnabled);
          assert.deepStrictEqual(config.keybindings, DEFAULT_RESOLVED_KEYBINDINGS);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      }),
  );
});
