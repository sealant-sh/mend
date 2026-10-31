import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  BASELINE,
  RUNTIME,
  PERSON,
  docker,
  useScreenScript,
} from "../../test/screen-script-fixture.ts";
import { dockerReady } from "../../test/xvnc.ts";
import { onScreenPath, screenEnvOf } from "./script.ts";

describe.skipIf(!dockerReady)("screen script browsers and sandbox", () => {
  const { container, confined, inside, settled, xvncPid, start } = useScreenScript(true);

  const asSession = (display: number, argv: ReadonlyArray<string>, on?: string) =>
    docker(
      "exec",
      "-u",
      "person",
      ...Object.entries(screenEnvOf(DisplayNumber.make(display), PERSON)).flatMap(
        ([name, value]) => ["-e", `${name}=${value}`],
      ),
      on ?? container,
      ...onScreenPath(argv),
    );
  const windowsNamed = (display: number, name: string, on = container) => {
    try {
      return asSession(display, ["xdotool", "search", "--name", name], on).trim().split("\n");
    } catch {
      return [];
    }
  };
  const shown = (display: number, name: string, on = container) =>
    Effect.gen(function* () {
      for (let tries = 0; windowsNamed(display, name, on).length === 0; tries++) {
        if (tries === 100) throw new Error(`no window "${name}" on :${display}`);
        yield* Effect.sleep("150 millis");
      }
    });
  const browsersOf = (display: number, on = container) =>
    inside("ps -eo args=", "root", on)
      .split("\n")
      .filter(
        (args) =>
          args.includes(`--user-data-dir=${RUNTIME}/mend-screen-${display}/chromium`) &&
          !args.includes("--type="),
      );
  const serve = (port: number, title: string, on = container) => {
    inside(
      `printf 'HTTP/1.0 200 OK\\r\\nContent-Type: text/html\\r\\n\\r\\n<title>${title}</title>' > /tmp/page-${port}`,
      "root",
      on,
    );
    docker(
      "exec",
      "-d",
      on,
      "socat",
      `TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr`,
      `EXEC:cat /tmp/page-${port}`,
    );
  };

  it.live(
    "opens the agent's chromium <url> on its own screen, in that screen's one browser and profile",
    () =>
      Effect.gen(function* () {
        const screens = [start(14), start(15)];
        yield* Effect.promise(() =>
          Promise.all(screens.map((screen) => screen.said("mend-screen ready"))),
        );
        serve(8014, "page-fourteen");
        serve(8015, "page-fifteen");
        serve(8016, "page-again");
        for (const display of [14, 15]) {
          yield* shown(display, "about:blank");
          expect(browsersOf(display)).toHaveLength(1);
          const [window] = windowsNamed(display, "about:blank");
          if (window === undefined) throw new Error("the browser has a window");
          const state = asSession(display, ["xprop", "-id", window, "_NET_WM_STATE"]);
          expect(state).toContain("_NET_WM_STATE_MAXIMIZED_VERT");
          expect(state).toContain("_NET_WM_STATE_MAXIMIZED_HORZ");
        }

        asSession(14, ["chromium", "http://127.0.0.1:8014/"]);
        asSession(15, ["chromium", "http://127.0.0.1:8015/"]);
        yield* shown(14, "page-fourteen");
        yield* shown(15, "page-fifteen");
        expect(windowsNamed(14, "page-fifteen")).toEqual([]);
        expect(windowsNamed(15, "page-fourteen")).toEqual([]);

        asSession(14, ["chromium", "http://127.0.0.1:8016/"]);
        yield* shown(14, "page-again");
        expect(browsersOf(14)).toHaveLength(1);
        expect(browsersOf(15)).toHaveLength(1);
        for (const display of [14, 15]) {
          expect(inside(`ls ${RUNTIME}/mend-screen-${display}/chromium`)).toContain("Default");
          expect(inside(`cat ${RUNTIME}/mend-screen-${display}/browser-sandbox`).trim()).toBe("on");
          expect(browsersOf(display)[0]).not.toContain("--no-sandbox");
        }
        expect(screens.flatMap((screen) => screen.lines)).not.toContain(
          "mend-screen browser sandbox off",
        );

        for (const display of [14, 15]) inside(`kill ${xvncPid(display)}`);
        yield* Effect.promise(() => Promise.all(screens.map((screen) => screen.exited)));
        inside("pkill -x socat");
        expect(yield* settled).toEqual(BASELINE);
      }),
    { timeout: 240_000 },
  );

  it.live(
    "falls back to --no-sandbox where Chromium's sandbox cannot start, and says so",
    () =>
      Effect.gen(function* () {
        const screen = start(10, confined);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        yield* Effect.promise(() => screen.said("mend-screen browser sandbox off"));
        expect(
          inside(`cat ${RUNTIME}/mend-screen-10/browser-sandbox`, "root", confined).trim(),
        ).toBe("off");
        yield* shown(10, "about:blank", confined);
        serve(8010, "page-unsandboxed", confined);
        asSession(10, ["chromium", "http://127.0.0.1:8010/"], confined);
        yield* shown(10, "page-unsandboxed", confined);
        const [browser, ...others] = browsersOf(10, confined);
        expect(others).toEqual([]);
        expect(browser).toContain("--no-sandbox");
        inside(`kill ${xvncPid(10, confined)}`, "root", confined);
        yield* Effect.promise(() => screen.exited);
      }),
    { timeout: 240_000 },
  );
});
