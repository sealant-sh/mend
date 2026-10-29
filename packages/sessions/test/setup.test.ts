import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  outputTailOf,
  parseMendToml,
  readWorktreeFile,
  SETUP_OUTPUT_TAIL_BYTES,
  setupFingerprint,
  setupStepArgv,
  setupStopArgv,
} from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const LOCK = new TextEncoder().encode("lockfileVersion: '9.0'\n");
const RUN = ["pnpm install --frozen-lockfile"];
const LOCKFILE = { path: "pnpm-lock.yaml", bytes: LOCK };
const MISSING = { path: "missing.txt", bytes: null };
const INPUTS = [LOCKFILE, MISSING];

describe("setupFingerprint", () => {
  it("matches the golden vector, with and without an executor's platform", () => {
    // Pre-images built by hand from the format, hashed with sha256sum:
    // "mend-setup/v1\0" '["pnpm install --frozen-lockfile"]' "pnpm-lock.yaml\0" sha256(LOCK) "\0"
    // "missing.txt\0absent\0" [then "platform\0linux-x86_64-gnu\0"].
    expect(setupFingerprint({ run: RUN, inputs: INPUTS, platform: null })).toBe(
      "073546273869e23b00bc193b39f73bcea2415bda0aea4fc8f2d12abb053e76eb",
    );
    expect(setupFingerprint({ run: RUN, inputs: INPUTS, platform: "linux-x86_64-gnu" })).toBe(
      "d669a47c0e6c3a43f847a879da726e743874d125810ae5e0f8852fff5586871c",
    );
  });

  it("changes with a step, an input's bytes, or an input appearing or going", () => {
    const base = setupFingerprint({ run: RUN, inputs: INPUTS, platform: null });
    const variants = [
      { run: ["pnpm install"], inputs: INPUTS },
      { run: [...RUN, "pnpm build"], inputs: INPUTS },
      { run: RUN, inputs: [{ ...LOCKFILE, bytes: new TextEncoder().encode("x") }, MISSING] },
      { run: RUN, inputs: [LOCKFILE, { ...MISSING, bytes: new Uint8Array() }] },
      { run: RUN, inputs: [{ ...LOCKFILE, bytes: null }, MISSING] },
      { run: RUN, inputs: [{ path: "missing.txt", bytes: new TextEncoder().encode("absent") }] },
      { run: RUN, inputs: [{ path: "missing.txt", bytes: null }] },
    ].map((variant) => setupFingerprint({ ...variant, platform: null }));
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("is the same however the [setup] table orders its keys", () => {
    const read = (toml: string) => {
      const setup = Effect.runSync(parseMendToml(toml, "mend.toml")).setup;
      if (setup === null) throw new Error("no [setup]");
      return setupFingerprint({
        run: setup.run,
        inputs: setup.inputs.map((input) => ({ path: input, bytes: LOCK })),
        platform: null,
      });
    };
    expect(read('[setup]\nrun = ["pnpm i"]\ninputs = ["pnpm-lock.yaml"]')).toBe(
      read('[setup]\ninputs = ["pnpm-lock.yaml"]\nrun = ["pnpm i"]'),
    );
  });
});

describe("readWorktreeFile", () => {
  it("reads a file's bytes, answers null for none, and never reads through a link out", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-outside-"));
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-worktree-"));
    fs.writeFileSync(path.join(outside, "secret"), "not the worktree's");
    fs.writeFileSync(path.join(worktree, "pnpm-lock.yaml"), LOCK);
    fs.symlinkSync(path.join(outside, "secret"), path.join(worktree, "lock-link"));
    const read = (relative: string) =>
      Effect.runPromise(readWorktreeFile(worktree, relative).pipe(Effect.result));

    const found = await read("pnpm-lock.yaml");
    expect(found._tag === "Success" ? found.success : null).toEqual(LOCK);
    const absent = await read("nothing/here.lock");
    expect(absent._tag === "Success" ? absent.success : "failed").toBeNull();
    const linked = await read("lock-link");
    expect(linked._tag).toBe("Failure");
  });
});

describe("outputTailOf", () => {
  it("keeps all of a short output and only the last few KiB of a long one", () => {
    expect(outputTailOf("added 3 packages", "")).toBe("added 3 packages");
    const long = Array.from({ length: 2000 }, (_, line) => `line ${line}`).join("\n");
    const tail = outputTailOf(long, "ERR_PNPM_OUTDATED_LOCKFILE");
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(SETUP_OUTPUT_TAIL_BYTES);
    expect(tail.endsWith("line 1999\nERR_PNPM_OUTDATED_LOCKFILE")).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
  });
});

describe("a setup step and its Stop, in a real shell", () => {
  it("ends the step and every process it started", { timeout: 15_000 }, async () => {
    const runId = crypto.randomUUID();
    const [command = "sh", ...args] = setupStepArgv(runId, "sleep 30 & sleep 30; wait");
    const step = spawn(command, args, { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    const exited = new Promise<number | null>((resolve) => step.once("exit", resolve));
    const marked = () =>
      fs
        .readdirSync("/proc")
        .filter((entry) => /^\d+$/.test(entry))
        .filter((pid) => {
          try {
            return fs
              .readFileSync(`/proc/${pid}/environ`, "utf8")
              .split("\0")
              .includes(`MEND_SETUP_RUN=${runId}`);
          } catch {
            return false;
          }
        });
    for (let waited = 0; marked().length < 3 && waited < 5000; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(marked().length, "the step's shell and both sleeps").toBeGreaterThanOrEqual(3);

    const [stopCommand = "sh", ...stopArgs] = setupStopArgv(runId);
    expect(spawnSync(stopCommand, stopArgs).status).toBe(0);

    expect(await exited).not.toBe(0);
    expect(marked()).toEqual([]);
  });
});
