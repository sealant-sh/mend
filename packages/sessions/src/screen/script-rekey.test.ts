import { execFileSync, spawn } from "node:child_process";

import { DisplayNumber } from "@mend/domain/workbench";
import { it } from "@mend/test-ci/effect-vitest";
import { Effect, Redacted } from "effect";
import { describe, expect } from "vitest";

import {
  BASELINE,
  FULL,
  VIEW_ONLY,
  docker,
  useScreenScript,
} from "../../test/screen-script-fixture.ts";
import { connectInside, dockerReady } from "../../test/xvnc.ts";
import { planActions } from "./hand-steps.ts";
import { openHand } from "./hand.ts";
import { SCREEN_WORKER, screenWorkersLayer } from "./screen-workers.ts";
import { SCREEN_REKEYED, screenPort, screenRekeyArgv, screenStartOfArgv } from "./script.ts";

const REKEYED_FULL = "newfull1";
const REKEYED_VIEW_ONLY = "newview1";

describe.skipIf(!dockerReady)("screen script password rekeying", () => {
  const { container, inside, asPerson, settled, xvncPid, start, stageHelper } = useScreenScript();

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

        const started = screenStartOfArgv(screen.argv);
        if (started === null) throw new Error("a screen's argv names its start");
        const { dir } = started;
        stageHelper(REKEYED_FULL, REKEYED_VIEW_ONLY);
        const said = yield* Effect.ensuring(
          Effect.sync(() => docker("exec", "-u", "person", container, ...screenRekeyArgv(started))),
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

  /**
   * The staged helper answering whatever pair `/tmp/rekey-pair` holds, and saying `fetched`. While
   * `/tmp/rekey-hold` exists, the next answer is held: the helper keeps running until a line is
   * written to `/tmp/rekey-go`, as a rekey Mend gave up on can outlive it.
   */
  const stagePairHelper = () => {
    inside("mkfifo -m 666 /tmp/rekey-go");
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        "cat > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend",
      ],
      {
        input: `#!/bin/sh
cat /tmp/rekey-pair
echo fetched >&2
[ -e /tmp/rekey-hold ] || exit 0
rm -f /tmp/rekey-hold
exec >&-
read go < /tmp/rekey-go
`,
        timeout: 30_000,
      },
    );
  };
  const answerWith = (full: string, viewOnly: string) =>
    inside(
      `printf '%s\\n%s\\n' ${full} ${viewOnly} > /tmp/rekey-pair && chmod 644 /tmp/rekey-pair`,
    );
  const unstagePairHelper = () => {
    inside("rm -f /tmp/rekey-go /tmp/rekey-pair /tmp/rekey-hold");
    stageHelper(FULL, VIEW_ONLY);
  };

  /** A process run as the person in the background: what it said on either stream, and its exit. */
  const background = (argv: ReadonlyArray<string>) => {
    const child = spawn("docker", ["exec", "-u", "person", container, ...argv]);
    let output = "";
    const waiters: Array<() => void> = [];
    const heard = (chunk: unknown) => {
      output += String(chunk);
      for (const wake of waiters.splice(0)) wake();
    };
    child.stdout.on("data", heard);
    child.stderr.on("data", heard);
    const said = (line: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${line}" in ${output}`)), 60_000);
        const check = () => {
          if (output.split("\n").includes(line)) {
            clearTimeout(timer);
            resolve();
          } else waiters.push(check);
        };
        check();
      });
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
    return { said, exited, output: () => output };
  };

  /** What Xvnc answers a sign-in with `password` on `display`; the hand is let go at once. */
  const signInOn = (display: number, password: string) =>
    Effect.scoped(
      openHand({
        bytes: connectInside(container, screenPort(DisplayNumber.make(display))).bytes,
        password: Redacted.make(password),
        currentEpoch: Effect.succeed(1),
      }),
    ).pipe(Effect.match({ onFailure: (ended) => ended.reason, onSuccess: () => "signed in" }));

  it.live(
    "keeps an abandoned rekey, still running with its pair, from writing over the passwords of the screen that replaced its own",
    () =>
      Effect.gen(function* () {
        stagePairHelper();
        answerWith(FULL, VIEW_ONLY);
        const first = start(17);
        yield* Effect.promise(() => first.said("mend-screen ready"));

        answerWith("rekeyed1", "rekeyed2");
        inside("touch /tmp/rekey-hold", "person");
        const asked = screenStartOfArgv(first.argv);
        if (asked === null) throw new Error("a screen's argv names its start");
        const abandoned = background(screenRekeyArgv(asked));
        yield* Effect.promise(() => abandoned.said("fetched"));

        inside(`kill ${xvncPid(17)}`);
        yield* Effect.promise(() => first.exited);
        answerWith("replace1", "replace2");
        const replacement = start(17);
        yield* Effect.promise(() => replacement.said("mend-screen ready"));
        expect(yield* signInOn(17, "replace1")).toBe("signed in");

        inside("echo go > /tmp/rekey-go");
        const code = yield* Effect.promise(() => abandoned.exited);
        expect(yield* signInOn(17, "rekeyed1")).toBe("auth-failed");
        expect(yield* signInOn(17, "replace1")).toBe("signed in");
        expect(abandoned.output()).not.toContain(SCREEN_REKEYED);
        expect(code).not.toBe(0);

        inside(`kill ${xvncPid(17)}`);
        yield* Effect.promise(() => replacement.exited);
        expect(yield* settled).toEqual(BASELINE);
      }).pipe(
        Effect.ensuring(Effect.sync(unstagePairHelper)),
        Effect.scoped,
        Effect.provide(screenWorkersLayer(SCREEN_WORKER)),
      ),
    { timeout: 180_000 },
  );

  it.live(
    "refuses a rekey opened late, for a start a later one replaced, before it fetches anything",
    () =>
      Effect.gen(function* () {
        stagePairHelper();
        answerWith(FULL, VIEW_ONLY);
        const first = start(18);
        yield* Effect.promise(() => first.said("mend-screen ready"));
        inside(`kill ${xvncPid(18)}`);
        yield* Effect.promise(() => first.exited);
        answerWith("replace1", "replace2");
        const replacement = start(18);
        yield* Effect.promise(() => replacement.said("mend-screen ready"));

        answerWith("rekeyed1", "rekeyed2");
        const asked = screenStartOfArgv(first.argv);
        if (asked === null) throw new Error("a screen's argv names its start");
        const late = background(screenRekeyArgv(asked));
        const code = yield* Effect.promise(() => late.exited);
        expect(yield* signInOn(18, "rekeyed1")).toBe("auth-failed");
        expect(yield* signInOn(18, "replace1")).toBe("signed in");
        expect(late.output()).not.toContain("fetched");
        expect(code).not.toBe(0);

        inside(`kill ${xvncPid(18)}`);
        yield* Effect.promise(() => replacement.exited);
        expect(yield* settled).toEqual(BASELINE);
      }).pipe(
        Effect.ensuring(Effect.sync(unstagePairHelper)),
        Effect.scoped,
        Effect.provide(screenWorkersLayer(SCREEN_WORKER)),
      ),
    { timeout: 180_000 },
  );
});
