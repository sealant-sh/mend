import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfigStreamEvent,
  type ServerSettings,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  applyModelPreferencesPatch,
  modelPreferencesUpdateOf,
  NO_MODEL_PREFERENCES,
} from "../src/model-preferences.ts";
import { requiredScopesFor } from "../src/rpc-scopes.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const CLAUDE = ProviderInstanceId.make("claude");
const CODEX = ProviderInstanceId.make("codex");
const BOB = { id: "user-2", name: "Bob", email: "bob@example.com" } as const;

const star = (model: string, favorite = true) => ({
  patch: { setModelFavorites: [{ provider: CLAUDE, model, favorite }] },
});

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const until = (ready: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (ready()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const statePathOf = () =>
  join(mkdtempSync(join(tmpdir(), "t3-gateway-model-preferences-")), "state.sqlite");

describe("a model preferences patch", () => {
  it("is one that sets model preference keys and nothing else", () => {
    assert.isNotNull(modelPreferencesUpdateOf(star("opus")));
    assert.isNotNull(
      modelPreferencesUpdateOf({
        patch: { migrateModelPreferences: { favorites: [] }, favorites: [] },
      }),
    );
    assert.isNull(modelPreferencesUpdateOf({ patch: {} }));
    assert.isNull(
      modelPreferencesUpdateOf({ patch: { ...star("opus").patch, worktreesDirectory: "/tmp" } }),
    );
    assert.isNull(
      modelPreferencesUpdateOf({
        ...star("opus"),
        providerInstanceMutation: { operation: "remove", instanceId: CLAUDE },
      }),
    );
  });

  it("applies as t3code's server applies it", () => {
    const starred = applyModelPreferencesPatch(NO_MODEL_PREFERENCES, star("opus").patch);
    assert.deepStrictEqual(starred.favorites, [{ provider: CLAUDE, model: "opus" }]);
    assert.isNull(starred.providerModelPreferences);

    const migrated = applyModelPreferencesPatch(starred, {
      migrateModelPreferences: {
        favorites: [{ provider: CODEX, model: "gpt" }],
        providerModelPreferences: { [CODEX]: { hiddenModels: ["mini"], modelOrder: [] } },
      },
    });
    assert.deepStrictEqual(migrated.favorites, [{ provider: CLAUDE, model: "opus" }]);
    assert.deepStrictEqual(migrated.providerModelPreferences, {
      [CODEX]: { hiddenModels: ["mini"], modelOrder: [] },
    });

    const arranged = applyModelPreferencesPatch(migrated, {
      setModelsHidden: [{ provider: CLAUDE, model: "haiku", hidden: true }],
      setProviderModelOrder: { provider: CLAUDE, modelOrder: ["sonnet", "opus"] },
    });
    assert.deepStrictEqual(arranged.providerModelPreferences?.[CLAUDE], {
      hiddenModels: ["haiku"],
      modelOrder: ["sonnet", "opus"],
    });

    const unstarred = applyModelPreferencesPatch(arranged, star("opus", false).patch);
    assert.deepStrictEqual(unstarred.favorites, []);
  });

  it("needs orchestration:operate; any other setting beside it still needs settings:write", () => {
    assert.deepStrictEqual(requiredScopesFor(WS_METHODS.serverUpdateSettings, star("opus")), [
      "orchestration:operate",
    ]);
    assert.deepStrictEqual(
      requiredScopesFor(WS_METHODS.serverUpdateSettings, {
        patch: { ...star("opus").patch, worktreesDirectory: "/tmp" },
      }),
      ["settings:write"],
    );
    assert.deepStrictEqual(
      requiredScopesFor(WS_METHODS.serverUpdateSettings, {
        ...star("opus"),
        providerInstanceMutation: { operation: "remove", instanceId: CLAUDE },
      }),
      ["settings:write", "providers:manage"],
    );
  });
});

describe("model preferences over the wire", () => {
  it.live("are kept per person, heard by their other clients, and survive a gateway restart", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const statePath = statePathOf();

      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "PREFS-ADA-1");
        const adaElsewhere = yield* pairAndConnect(mend, "PREFS-ADA-2");
        const bob = yield* pairAndConnect(mend, "PREFS-BOB-1", BOB);

        const heard: Array<ServerConfigStreamEvent> = [];
        yield* adaElsewhere.rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
          Stream.runForEach((event) => Effect.sync(() => heard.push(event))),
          Effect.forkScoped,
        );
        const bobHeard: Array<ServerConfigStreamEvent> = [];
        yield* bob.rpc[WS_METHODS.subscribeServerConfig]({}).pipe(
          Stream.runForEach((event) => Effect.sync(() => bobHeard.push(event))),
          Effect.forkScoped,
        );
        yield* until(() => heard.length > 0 && bobHeard.length > 0, "both snapshots");
        const opening = heard[0];
        assert.strictEqual(opening?.type, "snapshot");
        assert.isNull(opening?.type === "snapshot" ? opening.config.settings.favorites : 0);

        const saved = yield* ada.rpc[WS_METHODS.serverUpdateSettings](star("opus"));
        assert.deepStrictEqual(saved.favorites, [{ provider: CLAUDE, model: "opus" }]);

        yield* until(() => heard.length > 1, "the settings update");
        const update = heard[1];
        assert.strictEqual(update?.type, "settingsUpdated");
        assert.deepStrictEqual(
          update?.type === "settingsUpdated" ? update.payload.settings.favorites : null,
          [{ provider: CLAUDE, model: "opus" }],
        );

        const bobConfig = yield* bob.rpc[WS_METHODS.serverGetConfig]({});
        assert.isNull(bobConfig.settings.favorites);
        yield* Effect.sleep("200 millis");
        assert.deepStrictEqual(
          bobHeard.map((event) => event.type),
          ["snapshot"],
        );

        const refused = failureOf(
          yield* Effect.exit(
            ada.rpc[WS_METHODS.serverUpdateSettings]({
              patch: { ...star("sonnet").patch, worktreesDirectory: "/tmp" },
            }),
          ),
        );
        assert.strictEqual(refused?._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(
          refused?._tag === "EnvironmentAuthorizationError" ? refused.requiredPermission : null,
          "settings:write",
        );
        const settings: ServerSettings = yield* ada.rpc[WS_METHODS.serverGetSettings]({});
        assert.deepStrictEqual(settings.favorites, [{ provider: CLAUDE, model: "opus" }]);
        assert.strictEqual(settings.worktreesDirectory, "");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PREFS-ADA-3");
        const config = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.deepStrictEqual(config.settings.favorites, [{ provider: CLAUDE, model: "opus" }]);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    }),
  );
});
