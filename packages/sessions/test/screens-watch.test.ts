import { ViewerConnectionId, type SessionId } from "@mend/domain";
import { it } from "@mend/test-ci/effect-vitest";
import { Deferred, Effect, Fiber } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vitest";

import type { Input } from "../src/screen/rfb-client.ts";
import { Screens } from "../src/screen/screens.ts";
import { VIEWER_UNSENT_CEILING } from "../src/screen/viewer.ts";
import { makeTestViewer } from "./rfb-test-viewer.ts";
import { eventually, OWNER } from "./screen-world.ts";
import {
  agentOf,
  answered,
  asProcess,
  logOf,
  postgres,
  rowOf,
  sessionWithScreen,
  useXvnc,
} from "./screens-fixture.ts";
import { dockerReady } from "./xvnc.ts";

/** A watcher on the session's screen through the relay, signed in through ServerInit. */
const watching = (sessionId: SessionId, mayTakeInput: boolean, drains = true) =>
  Effect.gen(function* () {
    const screens = yield* Screens;
    const viewer = yield* makeTestViewer({ drains });
    const connection = ViewerConnectionId.make(`viewer-${crypto.randomUUID()}`);
    const relay = yield* Effect.forkChild(
      screens.watch({ sessionId, connection, mayTakeInput }, viewer.bytes),
    );
    return { ...viewer, connection, relay };
  });

describe.skipIf(postgres.skip || !dockerReady)("watching a screen, against TigerVNC Xvnc", () => {
  const { x, keysDown, pointer, start } = useXvnc();

  const pointerSettlesAt = (at: ReadonlyArray<number>) =>
    eventually(
      () => Effect.sync(() => JSON.stringify(pointer()) === JSON.stringify(at)),
      `the pointer never reached ${JSON.stringify(at)}`,
    );

  it.live(
    "relays the screen's frames to a viewer that signs in with no password of its own",
    () =>
      asProcess(
        Effect.gen(function* () {
          const { sessionId } = yield* sessionWithScreen;
          answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
          x("xsetroot -solid '#3366cc'");
          const viewer = yield* watching(sessionId, false);
          expect(yield* viewer.hello).toEqual({ width: 1280, height: 800 });
          expect(yield* viewer.colourAt({ x: 640, y: 400 })).toEqual([0x33, 0x66, 0xcc]);
          x("xsetroot -solid '#cc3300'");
          expect(yield* viewer.colourAt({ x: 640, y: 400 })).toEqual([0xcc, 0x33, 0x00]);
          yield* viewer.leave;
          expect(yield* Fiber.join(viewer.relay)).toEqual({ _tag: "ViewerLeft" });
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "moves nothing for a watcher's keys and pointer, nor for the owner's before they take over",
    () =>
      asProcess(
        Effect.gen(function* () {
          const { sessionId } = yield* sessionWithScreen;
          answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
          x("xdotool mousemove 17 19");
          for (const mayTakeInput of [false, true]) {
            const viewer = yield* watching(sessionId, mayTakeInput);
            yield* viewer.hello;
            yield* viewer.input(
              { _tag: "Pointer", buttons: 1, x: 700, y: 500 },
              { _tag: "Key", down: true, keysym: 0xffe1 },
            );
            yield* viewer.settled;
            expect(pointer()).toEqual([17, 19]);
            expect(keysDown()).toBe(0);
            yield* viewer.leave;
          }
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "puts only the owner's input on the screen once they take over, and none after they hand back",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          answered(yield* screens.look(agentOf(sessionId).call()));
          const owner = yield* watching(sessionId, true);
          const watcher = yield* watching(sessionId, false);
          yield* owner.hello;
          yield* watcher.hello;
          yield* screens.take(sessionId, OWNER, owner.connection);
          expect((yield* rowOf(screen.id)).input).toMatchObject({
            _tag: "Person",
            connection: owner.connection,
          });
          yield* owner.input({ _tag: "Pointer", buttons: 0, x: 321, y: 123 });
          yield* pointerSettlesAt([321, 123]);
          yield* watcher.input({ _tag: "Pointer", buttons: 0, x: 5, y: 5 });
          yield* watcher.settled;
          expect(pointer()).toEqual([321, 123]);
          yield* screens.handBack(sessionId, OWNER);
          yield* owner.input({ _tag: "Pointer", buttons: 0, x: 400, y: 300 });
          yield* owner.settled;
          expect(pointer()).toEqual([321, 123]);
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "puts the holder's paste on the screen's clipboard through the hand, and logs it as a count",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const { sessionId, screen } = yield* sessionWithScreen;
          answered(yield* screens.look(agentOf(sessionId).call()));
          x("rm -f /tmp/pasted");
          start("xterm", "-geometry", "40x10+0+0", "-e", "sh", "-c", "cat > /tmp/pasted");
          yield* eventually(
            () => Effect.sync(() => x("xdotool search --class xterm || true").trim() !== ""),
            "no xterm",
          );
          const owner = yield* watching(sessionId, true);
          yield* owner.hello;
          yield* screens.take(sessionId, OWNER, owner.connection);
          yield* owner.input({ _tag: "Pointer", buttons: 0, x: 60, y: 40 });
          yield* owner.paste("mend-paste");
          yield* owner.input(
            { _tag: "Key", down: true, keysym: 0xffe1 },
            { _tag: "Key", down: true, keysym: 0xff63 },
            { _tag: "Key", down: false, keysym: 0xff63 },
            { _tag: "Key", down: false, keysym: 0xffe1 },
          );
          // xterm asks for the selection and types it once Xvnc answers; Return ends the line after.
          yield* eventually(
            () =>
              Effect.gen(function* () {
                if (x("cat /tmp/pasted 2>/dev/null || true").includes("mend-paste")) return true;
                yield* Effect.sleep("100 millis");
                yield* owner.input(
                  { _tag: "Key", down: true, keysym: 0xff0d },
                  { _tag: "Key", down: false, keysym: 0xff0d },
                );
                return false;
              }),
            "the paste never reached the xterm",
          );
          const pasted = (yield* logOf(screen.id)).filter(
            (entry) => entry.body._tag === "PersonInput",
          );
          expect(pasted.map(({ actor, body }) => ({ actor, body }))).toEqual([
            {
              actor: { _tag: "Person", userId: OWNER },
              body: { _tag: "PersonInput", clicks: 0, keys: 0, pastes: 1 },
            },
          ]);
          x("xdotool search --class xterm | xargs -r -n1 xdotool windowkill || true");
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "counts a paste already on the screen once, though its viewer left while the log waited for the row",
    () =>
      asProcess(
        Effect.gen(function* () {
          const screens = yield* Screens;
          const sql = yield* SqlClient.SqlClient;
          const { sessionId, screen } = yield* sessionWithScreen;
          answered(yield* screens.look(agentOf(sessionId).call()));
          x("rm -f /tmp/pasted");
          start("xterm", "-geometry", "40x10+0+0", "-e", "sh", "-c", "cat > /tmp/pasted");
          yield* eventually(
            () => Effect.sync(() => x("xdotool search --class xterm || true").trim() !== ""),
            "no xterm",
          );
          const owner = yield* watching(sessionId, true);
          yield* owner.hello;
          yield* screens.take(sessionId, OWNER, owner.connection);
          yield* owner.input({ _tag: "Pointer", buttons: 0, x: 60, y: 40 });
          const locked = yield* Deferred.make<void>();
          const unlock = yield* Deferred.make<void>();
          const locker = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT id FROM screens WHERE id = ${screen.id} FOR UPDATE`;
                yield* Deferred.succeed(locked, undefined);
                yield* Deferred.await(unlock);
              }),
            ),
          );
          yield* Deferred.await(locked);
          yield* owner.paste("mend-paste-kept");
          yield* eventually(
            () =>
              Effect.map(
                sql<{ readonly waiting: number }>`SELECT count(*)::int AS waiting
                  FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'`,
                (rows) => (rows[0]?.waiting ?? 0) > 0,
              ).pipe(Effect.orDie),
            "the paste's log entry never waited for the screen's row",
          );
          yield* owner.leave;
          yield* Effect.timeoutOption(Fiber.await(owner.relay), "1 second");
          yield* Deferred.succeed(unlock, undefined);
          yield* Fiber.join(locker);
          expect(yield* Fiber.join(owner.relay)).toEqual({ _tag: "ViewerLeft" });
          const press = (...inputs: ReadonlyArray<Input>) =>
            screens.input(sessionId, owner.connection, inputs);
          yield* press(
            { _tag: "Key", down: true, keysym: 0xffe1 },
            { _tag: "Key", down: true, keysym: 0xff63 },
            { _tag: "Key", down: false, keysym: 0xff63 },
            { _tag: "Key", down: false, keysym: 0xffe1 },
          );
          yield* eventually(
            () =>
              Effect.gen(function* () {
                if (x("cat /tmp/pasted 2>/dev/null || true").includes("mend-paste-kept")) {
                  return true;
                }
                yield* Effect.sleep("100 millis");
                yield* press(
                  { _tag: "Key", down: true, keysym: 0xff0d },
                  { _tag: "Key", down: false, keysym: 0xff0d },
                );
                return false;
              }),
            "the paste never reached the xterm",
          );
          const pasted = (yield* logOf(screen.id)).filter(
            (entry) => entry.body._tag === "PersonInput",
          );
          expect(pasted.map(({ body }) => body)).toEqual([
            { _tag: "PersonInput", clicks: 0, keys: 0, pastes: 1 },
          ]);
          x("xdotool search --class xterm | xargs -r -n1 xdotool windowkill || true");
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "ends a viewer that sends a message outside the allow-list",
    () =>
      asProcess(
        Effect.gen(function* () {
          const { sessionId } = yield* sessionWithScreen;
          answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
          const viewer = yield* watching(sessionId, true);
          yield* viewer.hello;
          yield* viewer.send(Uint8Array.of(250, 0, 0, 0));
          expect(yield* Fiber.join(viewer.relay)).toEqual({
            _tag: "ViewerRefused",
            reason: "unknown-type",
          });
        }),
      ),
    { timeout: 60_000 },
  );

  it.live(
    "ends a viewer that leaves more than the ceiling unsent",
    () =>
      asProcess(
        Effect.gen(function* () {
          const { sessionId } = yield* sessionWithScreen;
          answered(yield* (yield* Screens).look(agentOf(sessionId).call()));
          const viewer = yield* watching(sessionId, false, false);
          yield* viewer.hello;
          // Xvnc answers requests one frame at a time, so they are asked for one after another.
          yield* eventually(
            () =>
              Effect.gen(function* () {
                if (viewer.relay.pollUnsafe() !== undefined) return true;
                yield* viewer.askFullFrame;
                yield* Effect.sleep("100 millis");
                return false;
              }),
            "the relay never closed the viewer",
          );
          const ended = yield* Fiber.join(viewer.relay);
          expect(ended._tag).toBe("FellBehind");
          expect(ended._tag === "FellBehind" && ended.unsent).toBeGreaterThan(
            VIEWER_UNSENT_CEILING,
          );
        }),
      ),
    { timeout: 60_000 },
  );
});
