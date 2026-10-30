import { type ChildProcess, execFileSync, spawn } from "node:child_process";

import type { PersonExecOptions, PersonSessionOptions } from "@mend/sealant";
import { it } from "@mend/test-ci/effect-vitest";
import type { SessionOptions } from "@sealant/sdk";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect } from "vitest";

import {
  type ExecAnswer,
  LAUNCHER,
  launched,
  lostReap,
  lostStart,
  withScreens,
} from "./engine/screen-fixture.ts";
import { dockerReady, fixtureImage } from "./xvnc.ts";

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });

describe.skipIf(!dockerReady)("a screen's lost start, against TigerVNC Xvnc in a container", () => {
  const container = `mend-screen-lost-${process.pid}-${Date.now()}`;
  const running = () =>
    docker("exec", container, "ps", "-e", "-o", "comm=").trim().split("\n").toSorted();
  const IDLE = ["docker-init", "ps", "sleep"];
  const opened: Array<ChildProcess> = [];

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
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        "mkdir -p /run/mend/bin && cat > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend",
      ],
      { input: '#!/bin/sh\nprintf "%s\\n%s\\n" fullpass viewpass\n', timeout: 30_000 },
    );
  }, 660_000);

  afterEach(() => {
    docker(
      "exec",
      container,
      "sh",
      "-c",
      "pkill -KILL -u person; rm -f /tmp/.X10-lock /tmp/.X11-unix/X10",
    );
  });

  afterAll(() => {
    for (const child of opened) child.kill();
    execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  });

  /** The platform starts the screen as the container's person, and its answer is still to come. */
  const xvncStarts = (
    argv: ReadonlyArray<string>,
    options: SessionOptions | PersonSessionOptions | undefined,
  ) =>
    argv[3] !== "mend-screen"
      ? Effect.void
      : Effect.callback<void>((resume) => {
          const user = options?.user;
          expect(typeof user === "string" ? user : user?.name).toBe(LAUNCHER);
          const child = spawn("docker", [
            "exec",
            "-u",
            "person",
            "-e",
            "XDG_RUNTIME_DIR=/run/user/40001",
            container,
            "setsid",
            "-w",
            ...argv,
          ]);
          opened.push(child);
          let printed = "";
          child.stdout.on("data", (chunk) => {
            printed += String(chunk);
            if (printed.includes("mend-screen ready")) resume(Effect.void);
          });
          child.once("close", () => resume(Effect.die(new Error(`no ready line: ${printed}`))));
        });

  const reapsInside = (argv: ReadonlyArray<string>, options: PersonExecOptions | undefined) =>
    Effect.sync((): ExecAnswer => {
      expect(options?.user?.name).toBe(LAUNCHER);
      return {
        exitCode: 0,
        stdout: docker("exec", "-u", "person", container, ...argv),
        stderr: "",
      };
    });

  const settled = Effect.promise(async () => {
    for (let tries = 0; tries < 50 && running().join() !== IDLE.join(); tries++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return running();
  });

  it.live(
    "two lost answers leave nothing on the display once the screen reads ended",
    () => {
      const lost = lostStart(2);
      return withScreens(
        (world) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launched(world);
            lost.arm();
            yield* Effect.flip(engine.startScreen(session.id));
            expect((yield* world.screens.ofSession(session.id))?.life).toEqual({
              _tag: "Ended",
              reason: "process-exited",
            });
            expect(yield* settled).toEqual(IDLE);
          }),
        { openFails: lost.openFails, aroundOpen: xvncStarts, reap: reapsInside },
      );
    },
    { timeout: 120_000 },
  );

  it.live(
    "a Stop reaps a lost start whose own reap was lost",
    () => {
      const lost = lostStart(2);
      let reapFails = false;
      return withScreens(
        (world) =>
          Effect.gen(function* () {
            const { engine, session } = yield* launched(world);
            lost.arm();
            reapFails = true;
            yield* Effect.flip(engine.startScreen(session.id));
            expect(running()).toContain("Xvnc");
            reapFails = false;
            yield* engine.stopScreen(session.id, "idle");
            expect((yield* world.screens.ofSession(session.id))?.life).toEqual({
              _tag: "Ended",
              reason: "idle",
            });
            expect(yield* settled).toEqual(IDLE);
          }),
        {
          openFails: lost.openFails,
          aroundOpen: xvncStarts,
          reap: (argv, options) => (reapFails ? Effect.fail(lostReap) : reapsInside(argv, options)),
        },
      );
    },
    { timeout: 120_000 },
  );
});
