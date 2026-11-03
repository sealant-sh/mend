/**
 * What an idle screen costs its workspace in memory (ADR 0020, D7): the real screen script, as a
 * person, in the fixtures' Debian container (TigerVNC Xvnc, XFCE, ffmpeg, Chromium), left alone
 * once it says ready. Prints one JSON line per run with the person's processes by group, then the
 * same after the agent's first `chromium about:blank`:
 *
 *   pss   resident memory, each shared page split among the processes mapping it: the most a
 *         screen costs, when no other process on the machine maps its libraries
 *   anon  anonymous memory: what every screen pays for itself, whoever else maps the libraries
 *   cgroup  the container's memory.current, page cache included as far as it was charged here
 *
 *   node packages/sessions/test/screen-memory-bench.ts [--runs 3] [--idle-seconds 30]
 */
import { execFileSync, spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { DisplayNumber } from "@mend/domain/workbench";

import { CHROMIUM_WRAPPER_SCRIPT } from "../src/screen/chromium.ts";
import { screenArgv } from "../src/screen/script.ts";
import { fixtureImage } from "./xvnc.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "idle-seconds": { type: "string", default: "30" },
  },
});
const runs = Number(values.runs);
const idleMs = Number(values["idle-seconds"]) * 1000;

const docker = (...args: ReadonlyArray<string>) =>
  execFileSync("docker", [...args], { encoding: "utf8", timeout: 60_000 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const GROUPS: ReadonlyArray<readonly [string, RegExp]> = [
  ["xvnc", /^Xvnc$/],
  ["ffmpeg", /^ffmpeg$/],
  ["chromium", /^(chromium|chrome)/i],
  ["window manager and desktop", /^(xf|Thunar|dbus|at-spi|gvfs|tumbler|xdg)/i],
  ["script", /^(sh|sleep|setsid|cat|tr|grep|pgrep)$/],
];

const mb = (kb: number) => Math.round(kb / 102.4) / 10;

/**
 * PSS of every process the person runs, by group, from each one's smaps_rollup: read as the person,
 * since the container's root has no ptrace capability to read another user's.
 */
const pssByGroup = (container: string) => {
  const out = docker(
    "exec",
    "-u",
    "person",
    container,
    "sh",
    "-c",
    `for p in $(pgrep -u 40001); do
       c=$(cat /proc/$p/comm 2>/dev/null) || continue
       r=$(awk '/^Pss:/ {p=$2} /^Anonymous:/ {a=$2} END {print p, a}' /proc/$p/smaps_rollup 2>/dev/null) || continue
       [ -n "$r" ] && echo "$c $r"
     done`,
  );
  const pss: Record<string, number> = {};
  const anon: Record<string, number> = {};
  for (const line of out.trim().split("\n")) {
    const [comm = "", pssKb = "0", anonKb = "0"] = line.split(" ");
    const group = GROUPS.find(([, pattern]) => pattern.test(comm))?.[0] ?? `other:${comm}`;
    pss[group] = (pss[group] ?? 0) + Number(pssKb);
    anon[group] = (anon[group] ?? 0) + Number(anonKb);
  }
  const summed = (kbs: Record<string, number>) => ({
    totalMb: mb(Object.values(kbs).reduce((sum, kb) => sum + kb, 0)),
    byGroupMb: Object.fromEntries(Object.entries(kbs).map(([group, kb]) => [group, mb(kb)])),
  });
  return { pss: summed(pss), anon: summed(anon) };
};

/** The container's cgroup memory, page cache included, in MB. */
const cgroupMb = (container: string) =>
  Math.round(Number(docker("exec", container, "cat", "/sys/fs/cgroup/memory.current")) / 104857.6) /
  10;

const measure = async (run: number, image: string) => {
  const container = `mend-screen-memory-bench-${process.pid}-${run}`;
  docker(
    "run",
    "-d",
    "--init",
    "--network",
    "none",
    "--security-opt",
    "seccomp=unconfined",
    "--name",
    container,
    image,
    "sleep",
    "infinity",
  );
  try {
    docker(
      "exec",
      container,
      "sh",
      "-c",
      `mkdir -p /run/mend/bin && printf '#!/bin/sh\\nprintf "%s\\\\n%s\\\\n"\\n' fullpass viewpass > /run/mend/bin/mend && chmod 755 /run/mend/bin/mend`,
    );
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        container,
        "sh",
        "-c",
        "cat > /run/mend/bin/chromium && chmod 755 /run/mend/bin/chromium",
      ],
      { input: CHROMIUM_WRAPPER_SCRIPT, timeout: 30_000 },
    );
    const before = cgroupMb(container);
    const [, , script, ...args] = screenArgv(DisplayNumber.make(10), { uid: 40001 }, "bench");
    const screen = spawn("docker", [
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
    const startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the screen never said ready")), 60_000);
      screen.stdout.on("data", (chunk) => {
        if (String(chunk).includes("mend-screen ready")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const readyMs = Date.now() - startedAt;
    await sleep(idleMs);
    const idle = { ...pssByGroup(container), cgroupMb: cgroupMb(container) };
    docker(
      "exec",
      "-d",
      "-u",
      "person",
      "-e",
      "DISPLAY=:10",
      "-e",
      "XAUTHORITY=/run/user/40001/mend-screen-10/auth",
      container,
      "/run/mend/bin/chromium",
      "about:blank",
    );
    await sleep(idleMs);
    const browser = { ...pssByGroup(container), cgroupMb: cgroupMb(container) };
    screen.kill();
    console.log(
      JSON.stringify({
        run,
        readyMs,
        idleSeconds: idleMs / 1000,
        cgroupBeforeMb: before,
        idle,
        browser,
      }),
    );
  } finally {
    docker("rm", "-f", container);
  }
};

const image = fixtureImage("screen");
for (let run = 1; run <= runs; run++) await measure(run, image);
