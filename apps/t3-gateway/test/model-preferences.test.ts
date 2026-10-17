import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfigStreamEvent,
  type ServerSettings,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { gateDeviceCalls } from "../src/device-gate.ts";
import { makeGatewayEnvironment } from "../src/environment.ts";
import { makeFanout } from "../src/fanout.ts";
import { makePersonHub, type PersonHub, type PersonTokens } from "../src/hub.ts";
import {
  applyModelPreferencesPatch,
  boundedModelPreferences,
  MODEL_PREFERENCE_LIMITS,
  modelPreferencesUpdateOf,
  NO_MODEL_PREFERENCES,
  settingsWith,
  type KeptSettings,
  type ModelPreferences,
} from "../src/model-preferences.ts";
import { requiredScopesFor } from "../src/rpc-scopes.ts";
import { makeGatewayRpcHandlers } from "../src/rpc.ts";
import { openGatewayState } from "../src/state.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { emptyHub, testBearerSession, unreachableMend } from "./support/stubs.ts";

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

const limitOf = (preferences: ModelPreferences) => {
  const bounded = boundedModelPreferences(preferences);
  return Result.isFailure(bounded) ? bounded.failure.limit : null;
};

describe("model preferences past the gateway's limits", () => {
  const limits = MODEL_PREFERENCE_LIMITS;
  const favorites = (count: number, length: number) =>
    Array.from({ length: count }, (_, index) => ({
      provider: CLAUDE,
      model: `${index}`.padEnd(length, "m"),
    }));

  it("are named by the first limit they pass", () => {
    const opus = applyModelPreferencesPatch(NO_MODEL_PREFERENCES, star("opus").patch);
    assert.isNull(limitOf(opus));
    assert.strictEqual(
      limitOf({ ...opus, favorites: favorites(limits.favorites + 1, 8) }),
      `${limits.favorites} favorites`,
    );
    assert.strictEqual(
      limitOf({ ...opus, favorites: favorites(1, limits.modelIdLength + 1) }),
      `${limits.modelIdLength} characters per model id`,
    );
    assert.strictEqual(
      limitOf({ ...opus, favorites: favorites(limits.favorites, limits.modelIdLength) }),
      `${limits.encodedBytes} bytes stored`,
    );
    const lists = { hiddenModels: [], modelOrder: [] };
    const providers = Object.fromEntries(
      Array.from({ length: limits.providers + 1 }, (_, index) => [
        ProviderInstanceId.make(`provider-${index}`),
        lists,
      ]),
    );
    assert.strictEqual(
      limitOf({ ...opus, providerModelPreferences: providers }),
      `${limits.providers} providers`,
    );
    const order = Array.from(
      { length: limits.modelsPerProviderList + 1 },
      (_, index) => `${index}`,
    );
    assert.strictEqual(
      limitOf({
        ...opus,
        providerModelPreferences: { [CLAUDE]: { hiddenModels: [], modelOrder: order } },
      }),
      `${limits.modelsPerProviderList} hidden or ordered models per provider`,
    );
  });

  it.live("are refused with t3code's settings error, and what was kept stays", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "PREFS-LIMIT-1");
        yield* ada.rpc[WS_METHODS.serverUpdateSettings](star("opus"));

        const hideTooMany = Array.from(
          { length: limits.modelsPerProviderList + 1 },
          (_, index) => ({
            provider: CLAUDE,
            model: `model-${index}`,
            hidden: true,
          }),
        );
        const starTooLong = favorites(1, limits.modelIdLength + 1).map((favorite) => ({
          ...favorite,
          favorite: true,
        }));
        const starTooMuch = favorites(limits.favorites, limits.modelIdLength).map((favorite) => ({
          ...favorite,
          favorite: true,
        }));
        for (const patch of [
          { setModelsHidden: hideTooMany },
          { setModelFavorites: starTooLong },
          { setModelFavorites: starTooMuch },
        ]) {
          const refusal = failureOf(
            yield* Effect.exit(ada.rpc[WS_METHODS.serverUpdateSettings]({ patch })),
          );
          assert.strictEqual(refusal?._tag, "ServerSettingsError");
          assert.strictEqual(
            refusal?._tag === "ServerSettingsError" ? refusal.operation : null,
            "normalize",
          );
        }
        const after: ServerSettings = yield* ada.rpc[WS_METHODS.serverGetSettings]({});
        assert.deepStrictEqual(after.favorites, [{ provider: CLAUDE, model: "opus" }]);
        assert.isNull(after.providerModelPreferences);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePathOf())));
    }),
  );
});

describe("model preferences and the bearer's grant", () => {
  it.live("refuse a read-only bearer's write over the socket, and nothing is kept", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const reader = yield* pairAndConnect(mend, "PREFS-READ-1", PERSON, "orchestration:read");
        const refusal = failureOf(
          yield* Effect.exit(reader.rpc[WS_METHODS.serverUpdateSettings](star("opus"))),
        );
        assert.strictEqual(refusal?._tag, "EnvironmentAuthorizationError");
        assert.strictEqual(
          refusal?._tag === "EnvironmentAuthorizationError" ? refusal.requiredScope : null,
          "orchestration:operate",
        );
        const ada = yield* pairAndConnect(mend, "PREFS-READ-2");
        const settings: ServerSettings = yield* ada.rpc[WS_METHODS.serverGetSettings]({});
        assert.isNull(settings.favorites);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePathOf())));
    }),
  );
});

describe("kept model preferences that no longer decode", () => {
  it.live("are set aside: the person's config loads without them and a new star is kept", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const statePath = statePathOf();
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "PREFS-STALE-1");
        yield* ada.rpc[WS_METHODS.serverUpdateSettings](star("opus"));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      const database = new DatabaseSync(statePath);
      database.prepare("UPDATE model_preferences SET favorites = ?").run('[{"provider":"claude"}]');
      database.close();

      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "PREFS-STALE-2");
        const config = yield* ada.rpc[WS_METHODS.serverGetConfig]({});
        assert.isNull(config.settings.favorites);
        const saved = yield* ada.rpc[WS_METHODS.serverUpdateSettings](star("sonnet"));
        assert.deepStrictEqual(saved.favorites, [{ provider: CLAUDE, model: "sonnet" }]);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    }),
  );
});

const keptStarred = (version: number, ...models: ReadonlyArray<string>): KeptSettings => ({
  version,
  settings: settingsWith({
    favorites: models.map((model) => ({ provider: CLAUDE, model })),
    providerModelPreferences: null,
  }),
});

const starredIn = (event: ServerConfigStreamEvent | undefined) =>
  event?.type === "settingsUpdated"
    ? (event.payload.settings.favorites ?? []).map((favorite) => favorite.model).join(",")
    : null;

/** Three changes published at once overflow a feed with room for two. */
const FEED_ROOM = 2;

const configStreamOverSmallFeed = Effect.gen(function* () {
  const feed = makeFanout<KeptSettings>(FEED_ROOM);
  let current = keptStarred(0);
  let open = 0;
  const hub: PersonHub = {
    ...emptyHub,
    settings: () => Effect.sync(() => current),
    subscribeSettings: () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            open += 1;
          }),
          () =>
            Effect.sync(() => {
              open -= 1;
            }),
        );
        const changes = yield* feed.subscribe(() => true);
        return Stream.concat(Stream.make(current), changes);
      }),
  };
  const handlers = makeGatewayRpcHandlers({
    environment: makeGatewayEnvironment({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Mend",
      host: "127.0.0.1",
      statePath: ":memory:",
    }),
    assetUrls: {
      issue: () => Effect.succeed({ relativeUrl: "/api/assets/x/y", expiresAt: 0 }),
      resolve: () => Effect.succeedNone,
    },
    session: testBearerSession,
    hub,
  });
  const heard: Array<ServerConfigStreamEvent> = [];
  yield* handlers[WS_METHODS.subscribeServerConfig]().pipe(
    Stream.runForEach((event) => Effect.sync(() => heard.push(event))),
    Effect.forkScoped,
  );
  yield* until(() => heard.length === 1 && feed.size() === 1, "the snapshot");
  return {
    feed,
    heard,
    openSubscriptions: () => open,
    opensWith: (next: KeptSettings) => {
      current = next;
    },
  };
});

describe("the config stream after the settings feed falls behind", () => {
  it.live(
    "subscribes again with one subscription open, and hears each lost change before the next",
    () =>
      Effect.gen(function* () {
        const rig = yield* configStreamOverSmallFeed;
        for (let round = 1; round <= 50; round++) {
          const version = round * 10;
          rig.opensWith(keptStarred(version + 3, `round-${round}`));
          yield* rig.feed.publish([
            keptStarred(version + 1, "a"),
            keptStarred(version + 2, "b"),
            keptStarred(version + 3, `round-${round}`),
          ]);
          yield* until(
            () => starredIn(rig.heard.at(-1)) === `round-${round}`,
            `the change lost in overflow ${round}`,
          );
          assert.strictEqual(
            rig.openSubscriptions(),
            1,
            `subscriptions open after overflow ${round}`,
          );
          assert.strictEqual(rig.feed.size(), 1);
        }
        rig.opensWith(keptStarred(1000, "opus", "sonnet"));
        yield* rig.feed.publish([keptStarred(1000, "opus", "sonnet")]);
        yield* until(
          () => starredIn(rig.heard.at(-1)) === "opus,sonnet",
          "the change after the overflows",
        );
        assert.strictEqual(rig.openSubscriptions(), 1);
      }).pipe(Effect.scoped),
  );

  it.live("never sends settings older than what it already sent", () =>
    Effect.gen(function* () {
      const rig = yield* configStreamOverSmallFeed;
      rig.opensWith(keptStarred(2, "two"));
      yield* rig.feed.publish([keptStarred(2, "two")]);
      yield* until(() => starredIn(rig.heard.at(-1)) === "two", "version 2");
      yield* rig.feed.publish([keptStarred(1, "one, late")]);

      rig.opensWith(keptStarred(5, "five"));
      yield* rig.feed.publish([keptStarred(3, "c"), keptStarred(4, "d"), keptStarred(5, "five")]);
      yield* until(() => starredIn(rig.heard.at(-1)) === "five", "the snapshot after overflow");
      yield* rig.feed.publish([keptStarred(4, "d, late"), keptStarred(5, "five")]);
      rig.opensWith(keptStarred(6, "six"));
      yield* rig.feed.publish([keptStarred(6, "six")]);
      yield* until(() => starredIn(rig.heard.at(-1)) === "six", "version 6");

      const sent = rig.heard.flatMap((event) => {
        const starred = starredIn(event);
        return starred === null ? [] : [starred];
      });
      assert.deepStrictEqual(
        sent.filter((starred) => !["c", "d"].includes(starred)),
        ["two", "five", "six"],
      );
    }).pipe(Effect.scoped),
  );
});

const noTokens: PersonTokens = {
  current: () => null,
  live: () => [],
  refuse: () => Effect.void,
  isRefused: () => false,
  refusal: () => Effect.never,
  noneLeft: Effect.never,
};

describe("a person hub's settings feed", () => {
  it.live("opens with the settings now and hears a change written while it reads them", () =>
    Effect.gen(function* () {
      const kept = yield* openGatewayState(":memory:");
      let hub: PersonHub | undefined;
      let writeDuringRead = false;
      const state: typeof kept = {
        ...kept,
        modelPreferences: (mendUserId) =>
          kept.modelPreferences(mendUserId).pipe(
            Effect.tap(() => {
              if (!writeDuringRead || hub === undefined) return Effect.void;
              writeDuringRead = false;
              return hub.updateModelPreferences(testBearerSession, star("sonnet").patch);
            }),
            Effect.orDie,
          ),
      };
      hub = yield* makePersonHub({
        mend: gateDeviceCalls(unreachableMend, () => Effect.void),
        viewer: null,
        state,
        tokens: noTokens,
      });
      yield* hub.updateModelPreferences(testBearerSession, star("opus").patch);

      writeDuringRead = true;
      const feed = yield* hub.subscribeSettings(testBearerSession);
      const opening = yield* feed.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
      );
      assert.deepStrictEqual(
        opening.map((next) => ({
          version: next.version,
          favorites: next.settings.favorites?.map((favorite) => favorite.model),
        })),
        [
          { version: 1, favorites: ["opus"] },
          { version: 2, favorites: ["opus", "sonnet"] },
        ],
      );
    }).pipe(Effect.scoped),
  );
});
