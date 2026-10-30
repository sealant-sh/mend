import { type ChildProcess, execFileSync, spawn } from "node:child_process";

import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { connectInside, dockerReady, fixtureImage } from "../../test/xvnc.ts";
import { CHROMIUM_WRAPPER_SCRIPT } from "./chromium.ts";
import { planActions } from "./hand-steps.ts";
import { openHand } from "./hand.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";
import {
  SCREEN_REKEYED,
  onScreenPath,
  screenArgv,
  screenDirOfArgv,
  screenEnvOf,
  screenPort,
  screenReapArgv,
  screenRekeyArgv,
  screenReportOf,
} from "./script.ts";

const FULL = "fullpass";
const VIEW_ONLY = "viewpass";
const REKEYED_FULL = "newfull1";
const REKEYED_VIEW_ONLY = "newview1";
const RUNTIME = "/run/user/40001";

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });
const PERSON = { uid: 40001 };
const fails = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

describe("screenReportOf", () => {
  it("reads the script's status lines and nothing else", () => {
    expect(screenReportOf("mend-screen ready\r")).toEqual({ _tag: "Ready" });
    expect(screenReportOf("mend-screen degraded openbox")).toEqual({
      _tag: "Degraded",
      reason: "client-failed",
    });
    expect(screenReportOf("mend-screen browser sandbox off")).toEqual({
      _tag: "BrowserSandboxOff",
    });
    expect(screenReportOf(" vncext: Listening for VNC connections")).toBeNull();
  });
});

describe.skipIf(!dockerReady)("the screen's script, against TigerVNC Xvnc in a container", () => {
  const container = `mend-screen-script-${process.pid}-${Date.now()}`;
  const confined = `${container}-confined`;
  const inside = (command: string, user = "root", on = container) =>
    docker("exec", "-u", user, on, "sh", "-c", command);
  const asPerson = (
    display: number,
    command: string,
    auth = `${RUNTIME}/mend-screen-${display}/auth`,
  ) =>
    docker(
      "exec",
      "-u",
      "person",
      "-e",
      `DISPLAY=:${display}`,
      "-e",
      `XAUTHORITY=${auth}`,
      container,
      "sh",
      "-c",
      command,
    );
  const processes = () =>
    docker("exec", container, "ps", "-e", "-o", "comm=").trim().split("\n").toSorted();
  const BASELINE = ["docker-init", "ps", "sleep"];
  /**
   * The container's processes once only the baseline is left, or as they stand at the deadline.
   * Chromium's crashpad handlers run in a session of their own under init, out of the screen's
   * process group, and end once the browser that holds them has: a moment after Xvnc, longer
   * under load.
   */
  const settled = Effect.gen(function* () {
    const deadline = Date.now() + 60_000;
    while (processes().join() !== BASELINE.join() && Date.now() < deadline) {
      yield* Effect.sleep("100 millis");
    }
    return processes();
  });
  const xvncPid = (display: number, on = container) =>
    inside(`tr -d ' ' < /tmp/.X${display}-lock`, "root", on).trim();

  interface Screen {
    readonly child: ChildProcess;
    readonly lines: Array<string>;
    readonly said: (line: string) => Promise<void>;
    readonly exited: Promise<number | null>;
  }

  const start = (display: number, on = container): Screen => {
    const [, , script, ...args] = screenArgv(DisplayNumber.make(display), PERSON);
    const child = spawn("docker", [
      "exec",
      "-u",
      "person",
      on,
      "setsid",
      "-w",
      "sh",
      "-c",
      script ?? "",
      ...args,
    ]);
    const lines: Array<string> = [];
    const waiters: Array<() => void> = [];
    let partial = "";
    child.stdout.on("data", (chunk) => {
      partial += String(chunk);
      const complete = partial.split("\n");
      partial = complete.pop() ?? "";
      lines.push(...complete);
      for (const wake of waiters.splice(0)) wake();
    });
    const said = (line: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no "${line}" in ${lines.join(" | ")}`)),
          60_000,
        );
        const check = () => {
          if (lines.includes(line)) {
            clearTimeout(timer);
            resolve();
          } else waiters.push(check);
        };
        check();
      });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    return { child, lines, said, exited };
  };

  /** The staged helper, answering `screen-secret` with these two passwords. */
  const stageHelper = (full: string, viewOnly: string, on = container) =>
    inside(
      `mkdir -p /run/mend/bin && printf '#!/bin/sh\\nprintf "%s\\\\n%s\\\\n"\\n' ${full} ${viewOnly} > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend`,
      "root",
      on,
    );

  beforeAll(() => {
    const image = fixtureImage("screen");
    for (const [name, privileges] of [
      [container, ["--security-opt", "seccomp=unconfined"]],
      [confined, []],
    ] as const) {
      docker(
        "run",
        "-d",
        "--init",
        "--network",
        "none",
        ...privileges,
        "--name",
        name,
        image,
        "sleep",
        "infinity",
      );
      stageHelper(FULL, VIEW_ONLY, name);
      execFileSync(
        "docker",
        [
          "exec",
          "-i",
          name,
          "sh",
          "-c",
          "cat > /run/mend/bin/chromium && chmod 755 /run/mend/bin/chromium",
        ],
        { input: CHROMIUM_WRAPPER_SCRIPT, timeout: 30_000 },
      );
    }
  }, 660_000);

  // Removing both containers has taken longer than vitest's default 10 s hook timeout.
  afterAll(
    () => void execFileSync("docker", ["rm", "-f", container, confined], { stdio: "ignore" }),
    60_000,
  );

  it.live(
    "listens on loopback only, behind its passwords and its cookie, with neither in argv",
    () =>
      Effect.gen(function* () {
        const screen = start(10);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        const port = screenPort(DisplayNumber.make(10)).toString(16).toUpperCase().padStart(4, "0");
        const listening = inside(
          "cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == \"0A\" { print $2 }'",
        )
          .trim()
          .split("\n");
        expect(listening.toSorted()).toEqual([
          `00000000000000000000000001000000:${port}`,
          `0100007F:${port}`,
        ]);
        expect(asPerson(10, "xdpyinfo | head -1")).toContain(":10");
        expect(fails(() => asPerson(10, "xdpyinfo", "/nonexistent"))).toBe(true);
        expect(fails(() => inside("DISPLAY=:10 xdpyinfo"))).toBe(true);
        expect(inside(`stat -c '%a %U %s' ${RUNTIME}/mend-screen-10/passwd`).trim()).toBe(
          "600 person 16",
        );
        const argv = inside("cat /proc/[0-9]*/cmdline | tr '\\0' ' '");
        expect(argv).toContain("Xvnc :10");
        expect(argv).not.toContain(FULL);
        expect(argv).not.toContain(VIEW_ONLY);
        expect(inside(`cat /proc/${xvncPid(10)}/environ | tr '\\0' '\\n'`)).not.toMatch(
          /fullpass|viewpass/,
        );
      }),
    { timeout: 120_000 },
  );

  it.live(
    "lets the full password move the pointer, the view-only one move nothing, and refuses any other",
    () =>
      Effect.gen(function* () {
        const pointer = () =>
          asPerson(10, "xdotool getmouselocation").match(/x:(\d+) y:(\d+)/)?.[0];
        const signIn = (password: string) =>
          openHand({
            bytes: connectInside(container, screenPort(DisplayNumber.make(10))).bytes,
            password: Redacted.make(password),
            currentEpoch: Effect.succeed(1),
          });
        const plan = planActions([{ kind: "move", to: { x: 321, y: 123 } }]);
        if (plan._tag === "Unsupported") throw new Error("a move is always planned");

        const full = yield* signIn(FULL);
        yield* full.act(plan.steps, 1);
        expect(pointer()).toBe("x:321 y:123");

        const viewer = yield* signIn(VIEW_ONLY);
        expect((yield* viewer.look).length).toBeGreaterThan(0);
        yield* viewer.relay([{ _tag: "Pointer", buttons: 0, x: 900, y: 700 }], 1);
        yield* Effect.sleep("500 millis");
        expect(pointer()).toBe("x:321 y:123");

        const refused = yield* signIn("guessed!").pipe(Effect.flip);
        expect(refused.reason).toBe("auth-failed");
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
    { timeout: 60_000 },
  );

  it.live(
    "says degraded when the window manager dies, and leaves nothing once Xvnc ends",
    () =>
      Effect.gen(function* () {
        const screen = start(12);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        inside("pkill -x openbox");
        yield* Effect.promise(() => screen.said("mend-screen degraded openbox"));
        inside(`kill ${xvncPid(12)}`);
        yield* Effect.promise(() => screen.exited);
        inside(`kill ${xvncPid(10)}`);
        expect(yield* settled).toEqual(BASELINE);
      }),
    { timeout: 240_000 },
  );

  it.live(
    "ends everything it started when its terminal hangs up",
    () =>
      Effect.gen(function* () {
        const screen = start(11);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
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
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
        yield* Effect.promise(() => screen.exited);
        expect(yield* settled).toEqual(BASELINE);
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
      }),
    { timeout: 180_000 },
  );

  it.live(
    "signs a running screen for again with its person's fresh passwords, Xvnc and its apps left running",
    () =>
      Effect.gen(function* () {
        const screen = start(16);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        const pid = xvncPid(16);
        const pointer = () =>
          asPerson(16, "xdotool getmouselocation").match(/x:(\d+) y:(\d+)/)?.[0];
        const signIn = (password: string) =>
          openHand({
            bytes: connectInside(container, screenPort(DisplayNumber.make(16))).bytes,
            password: Redacted.make(password),
            currentEpoch: Effect.succeed(1),
          });
        yield* signIn(FULL);

        const dir = screenDirOfArgv(screenArgv(DisplayNumber.make(16), PERSON));
        if (dir === null) throw new Error("a screen's argv names its directory");
        stageHelper(REKEYED_FULL, REKEYED_VIEW_ONLY);
        const said = yield* Effect.ensuring(
          Effect.sync(() => docker("exec", "-u", "person", container, ...screenRekeyArgv(dir))),
          Effect.sync(() => stageHelper(FULL, VIEW_ONLY)),
        );
        expect(said.trim()).toBe(SCREEN_REKEYED);
        expect(xvncPid(16)).toBe(pid);
        expect(inside(`stat -c '%a %U %s' ${dir}/passwd`).trim()).toBe("600 person 16");
        expect(inside(`ls ${dir}`)).not.toContain("passwd.next");

        const plan = planActions([{ kind: "move", to: { x: 222, y: 111 } }]);
        if (plan._tag === "Unsupported") throw new Error("a move is always planned");
        yield* (yield* signIn(REKEYED_FULL)).act(plan.steps, 1);
        expect(pointer()).toBe("x:222 y:111");
        expect((yield* signIn(FULL).pipe(Effect.flip)).reason).toBe("auth-failed");
        const argv = inside("cat /proc/[0-9]*/cmdline | tr '\\0' ' '");
        expect(argv).not.toContain(REKEYED_FULL);
        expect(argv).not.toContain(REKEYED_VIEW_ONLY);

        inside(`kill ${pid}`);
        yield* Effect.promise(() => screen.exited);
        expect(yield* settled).toEqual(BASELINE);
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
    { timeout: 180_000 },
  );

  const asSession = (display: number, argv: ReadonlyArray<string>, on = container) =>
    docker(
      "exec",
      "-u",
      "person",
      ...Object.entries(screenEnvOf(DisplayNumber.make(display), PERSON)).flatMap(
        ([name, value]) => ["-e", `${name}=${value}`],
      ),
      on,
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
