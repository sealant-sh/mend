import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect } from "vitest";

import {
  FULL,
  VIEW_ONLY,
  RUNTIME,
  docker,
  useScreenScript,
} from "../../test/screen-script-fixture.ts";
import { connectInside, dockerReady } from "../../test/xvnc.ts";
import { planActions } from "./hand-steps.ts";
import { openHand } from "./hand.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";
import { screenPort } from "./script.ts";

const fails = (run: () => unknown) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

describe.skipIf(!dockerReady)("screen script access and input", () => {
  const { container, inside, asPerson, xvncPid, start } = useScreenScript();

  // Observing LISTEN does not connect and consume ffmpeg's one-viewer socket.
  const encoderReady = (encoderPort: number) =>
    Effect.gen(function* () {
      const address = `0100007F:${encoderPort.toString(16).toUpperCase()}`;
      const deadline = Date.now() + 10_000;
      for (;;) {
        const listening = inside("cat /proc/net/tcp | awk '$4 == \"0A\" { print $2 }'")
          .trim()
          .split("\n");
        if (listening.includes(address)) return;
        if (Date.now() >= deadline) {
          throw new Error(
            `encoder did not listen: ${inside(`cat ${RUNTIME}/mend-screen-10/stream-*.log`)}`,
          );
        }
        yield* Effect.sleep("50 millis");
      }
    });

  beforeEach(async () => {
    const screen = start(10);
    await screen.said("mend-screen ready");
  }, 60_000);

  it.live(
    "listens on loopback only, behind its passwords and its cookie, with neither in argv",
    () =>
      Effect.gen(function* () {
        yield* encoderReady(7910);
        yield* encoderReady(8110);
        const port = screenPort(DisplayNumber.make(10)).toString(16).toUpperCase().padStart(4, "0");
        const listening = inside(
          "cat /proc/net/tcp /proc/net/tcp6 | awk '$4 == \"0A\" { print $2 }'",
        )
          .trim()
          .split("\n");
        expect(listening.toSorted()).toEqual(
          [
            `00000000000000000000000001000000:${port}`,
            `0100007F:${port}`,
            `0100007F:${(7910).toString(16).toUpperCase()}`,
            `0100007F:${(8110).toString(16).toUpperCase()}`,
          ].toSorted(),
        );
        const encoders = inside("ps -eo args= | grep '^ffmpeg '").trim().split("\n");
        expect(encoders).toHaveLength(2);
        expect(encoders.find((line) => line.includes("-draw_mouse 1 "))).toContain(
          "tcp://127.0.0.1:7910?listen=1",
        );
        expect(encoders.find((line) => line.includes("-draw_mouse 0 "))).toContain(
          "tcp://127.0.0.1:8110?listen=1",
        );
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
    "starts each encoder on connection and listens again when its last viewer leaves",
    () =>
      Effect.gen(function* () {
        for (const encoderPort of [7910, 8110]) {
          const receive = () =>
            inside(`socat -u TCP:127.0.0.1:${encoderPort} STDOUT | head -c6 | od -An -tx1`).replace(
              /\s/g,
              "",
            );
          yield* encoderReady(encoderPort);
          expect(receive()).toBe("000000010910");
          yield* encoderReady(encoderPort);
          expect(receive()).toBe("000000010910");
        }
      }),
    { timeout: 20_000 },
  );

  it.live(
    "discards probe frames captured before an encoder viewer connects",
    () =>
      Effect.gen(function* () {
        for (const port of [7910, 8110]) yield* encoderReady(port);
        docker(
          "exec",
          "-d",
          "-u",
          "person",
          "-e",
          "DISPLAY=:10",
          "-e",
          `XAUTHORITY=${RUNTIME}/mend-screen-10/auth`,
          container,
          "xterm",
          "-title",
          "handback-live",
          "-geometry",
          "200x60+0+0",
          "-bg",
          "#20d040",
          "-e",
          "sleep",
          "30",
        );
        for (let tries = 0; ; tries++) {
          if (!fails(() => asPerson(10, "xdotool search --onlyvisible --name '^handback-live$'")))
            break;
          if (tries === 50) throw new Error("live colour window did not open");
          yield* Effect.sleep("50 millis");
        }
        yield* Effect.sleep("100 millis");
        for (const port of [7910, 8110]) {
          const pixels = asPerson(
            10,
            `ffmpeg -nostdin -loglevel error -i tcp://127.0.0.1:${port} -frames:v 6 -vf crop=2:2:100:100,scale=1:1 -f rawvideo -pix_fmt rgb24 pipe:1 | od -An -tu1`,
          )
            .trim()
            .split(/\s+/)
            .map(Number);
          expect(pixels).toHaveLength(18);
          expect(
            pixels.every((value, i) => Math.abs(value - ([32, 208, 64][i % 3] ?? 0)) < 25),
            "every decoded frame must show the live window, including the first IDR",
          ).toBe(true);
        }
        asPerson(10, "xdotool search --name '^handback-live$' windowclose");
      }),
    { timeout: 20_000 },
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
    "keeps the hand's keys and Unicode typing working with xfsettingsd running",
    () =>
      Effect.gen(function* () {
        expect(asPerson(10, "pgrep -x xfsettingsd").trim()).not.toBe("");
        docker(
          "exec",
          "-d",
          "-u",
          "person",
          "-e",
          "DISPLAY=:10",
          "-e",
          `XAUTHORITY=${RUNTIME}/mend-screen-10/auth`,
          container,
          "xterm",
          "-title",
          "mend-hand-keyboard",
          "-e",
          "sh",
          "-c",
          `cat > ${RUNTIME}/mend-screen-10/typed`,
        );
        for (let tries = 0; ; tries++) {
          try {
            asPerson(
              10,
              "xdotool windowfocus --sync $(xdotool search --name '^mend-hand-keyboard$' | head -1)",
            );
            break;
          } catch (error) {
            if (tries === 50) throw error;
            yield* Effect.sleep("100 millis");
          }
        }
        const hand = yield* openHand({
          bytes: connectInside(container, screenPort(DisplayNumber.make(10))).bytes,
          password: Redacted.make(FULL),
          currentEpoch: Effect.succeed(1),
        });
        const plan = planActions([
          { kind: "type", text: "discard" },
          { kind: "key", combo: "ctrl+u" },
          { kind: "type", text: "é€あ" },
          { kind: "key", combo: "Return" },
        ]);
        if (plan._tag === "Unsupported") throw new Error(`unsupported ${plan.key}`);
        expect((yield* hand.act(plan.steps, 1)).results).toEqual(["done", "done", "done", "done"]);
        yield* Effect.sleep("200 millis");
        expect(asPerson(10, `cat ${RUNTIME}/mend-screen-10/typed`)).toBe("é€あ\n");
        asPerson(10, "pkill -x xterm");
      }).pipe(Effect.scoped, Effect.provide(screenWorkersLayer(SCREEN_WORKER))),
    { timeout: 60_000 },
  );
});
