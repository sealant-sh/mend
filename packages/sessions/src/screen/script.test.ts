import { type ChildProcess, execFileSync, spawn } from "node:child_process";

import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Redacted } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { connectInside, dockerReady, fixtureImage } from "../../test/xvnc.ts";
import { planActions } from "./hand-steps.ts";
import { openHand } from "./hand.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";
import { screenArgv, screenPort, screenReapArgv, screenReportOf } from "./script.ts";

const FULL = "fullpass";
const VIEW_ONLY = "viewpass";
const RUNTIME = "/run/user/40001";

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });
const fails = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

describe("screenReportOf", () => {
  it("reads the script's two status lines and nothing else", () => {
    expect(screenReportOf("mend-screen ready\r")).toEqual({ _tag: "Ready" });
    expect(screenReportOf("mend-screen degraded openbox")).toEqual({
      _tag: "Degraded",
      reason: "client-failed",
    });
    expect(screenReportOf(" vncext: Listening for VNC connections")).toBeNull();
  });
});

describe.skipIf(!dockerReady)("the screen's script, against TigerVNC Xvnc in a container", () => {
  const container = `mend-screen-script-${process.pid}-${Date.now()}`;
  const inside = (command: string, user = "root") =>
    docker("exec", "-u", user, container, "sh", "-c", command);
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
  const xvncPid = (display: number) => inside(`tr -d ' ' < /tmp/.X${display}-lock`).trim();

  interface Screen {
    readonly child: ChildProcess;
    readonly lines: Array<string>;
    readonly said: (line: string) => Promise<void>;
    readonly exited: Promise<number | null>;
  }

  const start = (display: number): Screen => {
    const [, , script, ...args] = screenArgv(DisplayNumber.make(display), { uid: 40001 });
    const child = spawn("docker", [
      "exec",
      "-u",
      "person",
      container,
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
          15_000,
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

  beforeAll(() => {
    const image = fixtureImage("screen");
    docker(
      "run",
      "-d",
      "--init",
      "--network",
      "none",
      "--name",
      container,
      image,
      "sleep",
      "infinity",
    );
    inside(
      `mkdir -p /run/mend/bin && printf '#!/bin/sh\\nprintf "%s\\\\n%s\\\\n"\\n' ${FULL} ${VIEW_ONLY} > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend`,
    );
  }, 660_000);

  afterAll(() => void execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" }));

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
    { timeout: 60_000 },
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
        for (let tries = 0; processes().length > 3 && tries < 50; tries++) {
          yield* Effect.sleep("100 millis");
        }
        expect(processes()).toEqual(["docker-init", "ps", "sleep"]);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "ends everything it started when its terminal hangs up",
    () =>
      Effect.gen(function* () {
        const screen = start(11);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        inside(`kill -HUP -${xvncPid(11)}`);
        yield* Effect.promise(() => screen.exited);
        expect(processes()).toEqual(["docker-init", "ps", "sleep"]);
      }),
    { timeout: 60_000 },
  );

  it.live(
    "a lost start's reap, as the person, ends the screen on its display and nothing else",
    () =>
      Effect.gen(function* () {
        const screen = start(13);
        yield* Effect.promise(() => screen.said("mend-screen ready"));
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
        yield* Effect.promise(() => screen.exited);
        expect(processes()).toEqual(["docker-init", "ps", "sleep"]);
        docker("exec", "-u", "person", container, ...screenReapArgv(DisplayNumber.make(13)));
      }),
    { timeout: 60_000 },
  );
});
