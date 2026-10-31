import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { BASELINE, docker, useScreenScript } from "../../test/screen-script-fixture.ts";
import { dockerReady } from "../../test/xvnc.ts";
import { screenReapArgv } from "./script.ts";

describe.skipIf(!dockerReady)("screen script process lifecycle", () => {
  const { container, inside, asPerson, settled, xvncPid, start } = useScreenScript();

  // A running xfwm4 process has not necessarily published or managed its first window yet.
  const activeWindow = (display: number) =>
    Effect.promise(() =>
      expect
        .poll(() => asPerson(display, "xprop -root _NET_ACTIVE_WINDOW"), { timeout: 10_000 })
        .toMatch(/window id # 0x[1-9a-f][0-9a-f]*/i),
    );

  it.live(
    "says degraded when the window manager dies, and leaves nothing once Xvnc ends",
    () =>
      Effect.gen(function* () {
        const other = start(10);
        yield* Effect.promise(() => other.said("mend-screen ready"));
        yield* activeWindow(10);
        const screen = start(12);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        yield* activeWindow(12);
        inside("pkill -STOP -x xfce4-session");
        const wm = asPerson(
          12,
          "xdotool getwindowpid $(xprop -root _NET_SUPPORTING_WM_CHECK | awk '{print $NF}')",
        ).trim();
        inside(`kill ${wm}`);
        yield* Effect.promise(() => screen.said("mend-screen degraded xfwm4"));
        inside("pkill -CONT -x xfce4-session");
        inside(`kill ${xvncPid(12)}`);
        yield* Effect.promise(() => screen.exited);
        inside(`kill ${xvncPid(10)}`);
        expect(yield* settled).toEqual(BASELINE);
      }),
    { timeout: 240_000 },
  );

  it.live(
    "waits for a slow window manager before starting either encoder",
    () =>
      Effect.gen(function* () {
        inside(
          "mv /usr/bin/startxfce4 /usr/bin/startxfce4.real; " +
            "printf '#!/bin/sh\nwhile [ ! -e /run/user/40001/start-xfce ]; do sleep 0.1; done\nexec /usr/bin/startxfce4.real\n' " +
            "> /usr/bin/startxfce4; chmod 755 /usr/bin/startxfce4",
        );
        const screen = start(19);
        yield* Effect.promise(() => screen.said("mend-screen degraded xfwm4"));
        expect(inside("ps -eo comm=").split("\n")).not.toContain("ffmpeg");
        inside("touch /run/user/40001/start-xfce", "person");
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        yield* Effect.promise(() =>
          expect
            .poll(
              () =>
                inside("ps -eo comm=")
                  .split("\n")
                  .filter((name) => name === "ffmpeg"),
              {
                timeout: 10_000,
              },
            )
            .toHaveLength(2),
        );
      }),
    { timeout: 30_000 },
  );

  it(
    "waits for the initial browser window before reporting ready",
    { timeout: 30_000 },
    async () => {
      inside(
        "mv /run/mend/bin/chromium /run/mend/bin/chromium.real; " +
          "printf '#!/bin/sh\\nwhile [ ! -e /run/user/40001/start-browser ]; do sleep 0.1; done\\nexec /run/mend/bin/chromium.real \"$@\"\\n' " +
          "> /run/mend/bin/chromium; chmod 755 /run/mend/bin/chromium",
      );
      const screen = start(18);
      await expect.poll(() => inside("pgrep -x xfwm4").trim(), { timeout: 10_000 }).not.toBe("");
      // Let the status loop run while the browser is deliberately held before its first window.
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(screen.lines).not.toContain("mend-screen ready");
      expect(inside("ps -eo comm=").split("\n")).not.toContain("ffmpeg");
      inside("touch /run/user/40001/start-browser", "person");
      await screen.said("mend-screen ready");
      expect(asPerson(18, "xdotool search --onlyvisible --class Chromium").trim()).not.toBe("");
    },
  );

  it.live(
    "ends everything it started when its terminal hangs up",
    () =>
      Effect.gen(function* () {
        const screen = start(11);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        yield* activeWindow(11);
        inside(`kill -HUP -${xvncPid(11)}`);
        yield* Effect.promise(() => screen.exited);
        expect(yield* settled).toEqual(BASELINE);
      }),
    { timeout: 180_000 },
  );

  it.live(
    "a lost start's reap, as the person, ends the screen on its display and nothing else",
    () =>
      Effect.gen(function* () {
        const screen = start(13);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        yield* activeWindow(13);
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
        yield* Effect.promise(() => screen.exited);
        expect(yield* settled).toEqual(BASELINE);
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
      }),
    { timeout: 180_000 },
  );
});
