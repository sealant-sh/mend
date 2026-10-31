/** Each script test file owns its containers and waits for the real script's status. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";

import { DisplayNumber } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterEach, beforeAll, beforeEach } from "vitest";

import { CHROMIUM_WRAPPER_SCRIPT } from "../src/screen/chromium.ts";
import { screenArgv } from "../src/screen/script.ts";
import { fixtureImage } from "./xvnc.ts";

export const FULL = "fullpass";
export const VIEW_ONLY = "viewpass";
export const RUNTIME = "/run/user/40001";
export const PERSON = { uid: 40001 };
export const BASELINE = ["docker-init", "ps", "sleep"];
export const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 30_000 });

/** Registers setup and cleanup in the calling file's suite. */
export const useScreenScript = (includeConfined = false) => {
  const container = `ci-load-screen-script-${process.pid}-${Date.now()}`;
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
    readonly argv: ReadonlyArray<string>;
    readonly child: ChildProcess;
    readonly lines: Array<string>;
    readonly said: (line: string) => Promise<void>;
    readonly exited: Promise<number | null>;
  }

  const start = (display: number, on = container): Screen => {
    const argv = screenArgv(DisplayNumber.make(display), PERSON, crypto.randomUUID());
    const [, , script, ...args] = argv;
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
    return { argv, child, lines, said, exited };
  };

  /** The staged helper, answering `screen-secret` with these two passwords. */
  const stageHelper = (full: string, viewOnly: string, on = container) =>
    inside(
      `mkdir -p /run/mend/bin && printf '#!/bin/sh\\nprintf "%s\\\\n%s\\\\n"\\n' ${full} ${viewOnly} > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend`,
      "root",
      on,
    );

  let image: string;
  beforeAll(() => {
    image = fixtureImage("screen");
  }, 660_000);

  beforeEach(() => {
    const containers = [
      [container, ["--security-opt", "seccomp=unconfined"]],
      ...(includeConfined ? [[confined, []] as const] : []),
    ] as const;
    for (const [name, privileges] of containers) {
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
  }, 60_000);

  // Removing both containers has taken longer than vitest's default 10 s hook timeout.
  afterEach(
    () =>
      void execFileSync("docker", ["rm", "-f", container, ...(includeConfined ? [confined] : [])], {
        stdio: "ignore",
      }),
    60_000,
  );

  return { container, confined, inside, asPerson, settled, xvncPid, start, stageHelper };
};
