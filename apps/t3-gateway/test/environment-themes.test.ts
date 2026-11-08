import { EnvironmentTheme, WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("environment themes", () => {
  // Someone opens Appearance on a Mend environment. Every visit currently lacks its palette.
  it.live("publishes Mend's light and dark palettes and gates theme events on the subscriber", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ENVIRONMENT-THEMES");
        const legacy = yield* feed(rpc[WS_METHODS.subscribeServerConfig]({}));
        const opted = yield* feed(
          rpc[WS_METHODS.subscribeServerConfig]({ environmentThemes: true }),
        );
        const opening = yield* opted.next((event) => event.type === "snapshot");
        assert.isTrue(opening.config.environment.capabilities?.environmentThemes);
        const themes = opening.config.environmentThemes ?? [];
        assert.deepStrictEqual(
          themes.map(({ id, name, appearance }) => ({ id, name, appearance })),
          [
            { id: "mend-light", name: "Mend light", appearance: "light" },
            { id: "mend-dark", name: "Mend dark", appearance: "dark" },
          ],
        );
        assert.isTrue(themes.every(Schema.is(EnvironmentTheme)));
        assert.strictEqual(themes[0]?.colors?.["surface"], "#faf9f7");
        assert.strictEqual(themes[0]?.colors?.["accent"], "#2052cc");
        assert.strictEqual(themes[1]?.colors?.["surface"], "#14161b");
        assert.strictEqual(themes[1]?.colors?.["accent"], "#5781ea");
        const update = yield* opted.next((event) => event.type === "environmentThemesUpdated");
        assert.deepStrictEqual(update.payload.themes, themes);
        const ordinary = yield* legacy.next((event) => event.type === "snapshot");
        assert.deepStrictEqual(ordinary.config.environmentThemes, themes);
        assert.isTrue(
          yield* legacy.quiet((event) => event.type === "environmentThemesUpdated", "200 millis"),
        );
        assert.deepStrictEqual(
          (yield* rpc[WS_METHODS.serverGetConfig]({})).environmentThemes,
          themes,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(Effect.scoped),
  );
});
