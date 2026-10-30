import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  digestWorktreeFile,
  outputTailOf,
  parseMendToml,
  parseSetupInputs,
  readWorktreeFile,
  SETUP_OUTPUT_TAIL_BYTES,
  setupFingerprint,
  setupInputsArgv,
  setupStepArgv,
  setupStopArgv,
  sha256Hex,
} from "@mend/sessions";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const LOCK = new TextEncoder().encode("lockfileVersion: '9.0'\n");
const RUN = ["pnpm install --frozen-lockfile"];
const LOCKFILE = { path: "pnpm-lock.yaml", digest: sha256Hex(LOCK) };
const MISSING = { path: "missing.txt", digest: null };
const INPUTS = [LOCKFILE, MISSING];
const bare = { platform: null, image: null };

describe("setupFingerprint", () => {
  it("matches the golden vector, with and without an executor's platform and an image", () => {
    // Pre-images built by hand from the format, hashed with sha256sum:
    // "mend-setup/v1\0" '["pnpm install --frozen-lockfile"]' "pnpm-lock.yaml\0" sha256(LOCK) "\0"
    // "missing.txt\0absent\0" [then "platform\0linux-x86_64-gnu\0"] [then "image\0sha256:feed\0"].
    expect(setupFingerprint({ run: RUN, inputs: INPUTS, ...bare })).toBe(
      "073546273869e23b00bc193b39f73bcea2415bda0aea4fc8f2d12abb053e76eb",
    );
    expect(
      setupFingerprint({ run: RUN, inputs: INPUTS, platform: "linux-x86_64-gnu", image: null }),
    ).toBe("d669a47c0e6c3a43f847a879da726e743874d125810ae5e0f8852fff5586871c");
    expect(
      setupFingerprint({
        run: RUN,
        inputs: INPUTS,
        platform: "linux-x86_64-gnu",
        image: "sha256:feed",
      }),
    ).toBe("b4f520fb201af9c2ef4ab6c9b7f3f8738c554925ae48f39cbb053fcf342e1f7a");
  });

  it("changes with a step, an input's bytes, or an input appearing or going", () => {
    const base = setupFingerprint({ run: RUN, inputs: INPUTS, ...bare });
    const variants = [
      { run: ["pnpm install"], inputs: INPUTS },
      { run: [...RUN, "pnpm build"], inputs: INPUTS },
      { run: RUN, inputs: [{ ...LOCKFILE, digest: sha256Hex("x") }, MISSING] },
      { run: RUN, inputs: [LOCKFILE, { ...MISSING, digest: sha256Hex(new Uint8Array()) }] },
      { run: RUN, inputs: [{ ...LOCKFILE, digest: null }, MISSING] },
      { run: RUN, inputs: [{ path: "missing.txt", digest: sha256Hex("absent") }] },
      { run: RUN, inputs: [{ path: "missing.txt", digest: null }] },
    ].map((variant) => setupFingerprint({ ...variant, ...bare }));
    const image = setupFingerprint({ run: RUN, inputs: INPUTS, platform: null, image: "sha256:a" });
    expect(new Set([base, ...variants, image]).size).toBe(variants.length + 2);
  });

  it("is the same however the [setup] table orders its keys", () => {
    const read = (toml: string) => {
      const setup = Effect.runSync(parseMendToml(toml, "mend.toml")).setup;
      if (setup === null) throw new Error("no [setup]");
      return setupFingerprint({
        run: setup.run,
        inputs: setup.inputs.map((input) => ({ path: input, digest: sha256Hex(LOCK) })),
        ...bare,
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

  it("refuses a FIFO, a directory and a file over its limit, and digests the bytes it reads", async () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-kinds-"));
    spawnSync("mkfifo", [path.join(worktree, "pipe")]);
    fs.mkdirSync(path.join(worktree, "patches"));
    fs.writeFileSync(path.join(worktree, "big"), Buffer.alloc(16 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(worktree, "bun.lockb"), Uint8Array.of(0x62, 0x80));
    const refusal = async (relative: string) => {
      const read = await Effect.runPromise(readWorktreeFile(worktree, relative).pipe(Effect.flip));
      return read.message;
    };

    expect(await refusal("pipe")).toBe("pipe is not a regular file");
    expect(await refusal("patches")).toBe("patches is a directory; name a file");
    expect(await refusal("big")).toBe("big is over the 16 MiB Mend reads");
    expect(await Effect.runPromise(digestWorktreeFile(worktree, "bun.lockb"))).toBe(
      sha256Hex(Uint8Array.of(0x62, 0x80)),
    );
    expect(await Effect.runPromise(digestWorktreeFile(worktree, "absent"))).toBeNull();
    const pipeDigest = await Effect.runPromise(
      digestWorktreeFile(worktree, "pipe").pipe(Effect.flip),
    );
    expect(pipeDigest.message).toBe("pipe is not a regular file");
    fs.rmSync(worktree, { recursive: true });
  });
});

const inWorkspace = (
  repository: string,
  inputs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const [command = "sh", ...args] = setupInputsArgv(repository, inputs, "read-1");
  const ran = spawnSync(command, args, { env });
  // The platform hands an exec's output back decoded as UTF-8.
  return parseSetupInputs(ran.stdout.toString("utf8"), inputs);
};

describe("setup's inputs read in a workspace, in a real shell", () => {
  it("prints each input's digest, never its bytes, so a binary input's every byte counts", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-inputs-"));
    fs.writeFileSync(path.join(repository, "bun.lockb"), Uint8Array.of(0x62, 0x80));
    const first = inWorkspace(repository, ["bun.lockb", "missing.lock"]);
    fs.writeFileSync(path.join(repository, "bun.lockb"), Uint8Array.of(0x62, 0x81));
    const second = inWorkspace(repository, ["bun.lockb", "missing.lock"]);

    expect(first).toMatchObject({
      _tag: "Read",
      inputs: [
        { path: "bun.lockb", digest: sha256Hex(Uint8Array.of(0x62, 0x80)) },
        { path: "missing.lock", digest: null },
      ],
    });
    expect(second).toMatchObject({
      _tag: "Read",
      inputs: [{ digest: sha256Hex(Uint8Array.of(0x62, 0x81)) }, { digest: null }],
    });
    expect(first._tag === "Read" ? first.platform : null).toMatch(/^linux-/u);
  });

  it("refuses an input that resolves outside the repository, a directory and a FIFO", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-private-"));
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-inputs-"));
    fs.writeFileSync(path.join(outside, "credentials.json"), "a person's token");
    fs.symlinkSync(path.join(outside, "credentials.json"), path.join(repository, "lock"));
    fs.mkdirSync(path.join(repository, "patches"));
    spawnSync("mkfifo", [path.join(repository, "pipe")]);

    expect(inWorkspace(repository, ["lock"])).toEqual({
      _tag: "Refused",
      path: "lock",
      reason: "resolves outside the repository",
    });
    expect(inWorkspace(repository, ["patches"])).toMatchObject({
      reason: "is a directory; name a file",
    });
    expect(inWorkspace(repository, ["pipe"])).toMatchObject({ reason: "is not a regular file" });
  });
});

describe("setup's inputs read in a workspace, while an agent swaps them", () => {
  it("refuses an input swapped for a link out of the repository between its check and its read", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-private-"));
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-inputs-"));
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-shims-"));
    fs.writeFileSync(path.join(outside, "credentials.json"), "a person's token");
    fs.writeFileSync(path.join(repository, "lock"), "lockfile");
    // `realpath` answers for the file that is there, then the file becomes a link out: the window
    // an agent rewriting the worktree races for.
    fs.writeFileSync(
      path.join(shims, "realpath"),
      [
        "#!/bin/sh",
        "here=$(pwd -P)",
        `rm -f "$here/lock" && ln -s ${JSON.stringify(path.join(outside, "credentials.json"))} "$here/lock"`,
        'echo "$here/lock"',
      ].join("\n"),
      { mode: 0o755 },
    );

    const read = inWorkspace(repository, ["lock"], {
      ...process.env,
      PATH: `${shims}:${process.env["PATH"] ?? ""}`,
    });

    expect(read).toEqual({
      _tag: "Refused",
      path: "lock",
      reason: "resolves outside the repository",
    });
    for (const directory of [outside, repository, shims]) fs.rmSync(directory, { recursive: true });
  });

  it("refuses an input swapped for a FIFO between its check and its read, without waiting on it", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-inputs-"));
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), "mend-setup-shims-"));
    const realpath = spawnSync("sh", ["-c", "command -v realpath"]).stdout.toString().trim();
    fs.writeFileSync(path.join(repository, "lock.real"), "lockfile");
    fs.symlinkSync("lock.real", path.join(repository, "lock"));
    spawnSync("mkfifo", [path.join(repository, "pipe")]);
    // `realpath` answers for the regular file the link names, then the link names a FIFO no
    // one writes: opening it waits for a writer that never comes.
    fs.writeFileSync(
      path.join(shims, "realpath"),
      [
        "#!/bin/sh",
        `answer=$(${JSON.stringify(realpath)} "$@")`,
        "here=$(pwd -P)",
        'rm -f "$here/lock" && ln -s pipe "$here/lock"',
        'echo "$answer"',
      ].join("\n"),
      { mode: 0o755 },
    );

    const [command = "sh", ...args] = setupInputsArgv(repository, ["lock"], "read-1", 2);
    const ran = spawnSync(command, args, {
      env: { ...process.env, PATH: `${shims}:${process.env["PATH"] ?? ""}` },
      timeout: 15_000,
    });

    expect(ran.error, "the read ends on its own").toBeUndefined();
    expect(parseSetupInputs(ran.stdout.toString("utf8"), ["lock"])).toEqual({
      _tag: "Refused",
      path: "lock",
      reason: "could not be read within 2 seconds",
    });
    for (const directory of [repository, shims]) fs.rmSync(directory, { recursive: true });
  });
});

describe("outputTailOf", () => {
  it("keeps all of a short output and only the last few KiB of a long one", () => {
    expect(outputTailOf("added 3 packages")).toBe("added 3 packages");
    const long = Array.from({ length: 2000 }, (_, line) => `line ${line}`).join("\n");
    const tail = outputTailOf(`${long}\nERR_PNPM_OUTDATED_LOCKFILE`);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(SETUP_OUTPUT_TAIL_BYTES);
    expect(tail.endsWith("line 1999\nERR_PNPM_OUTDATED_LOCKFILE")).toBe(true);
    expect(tail.startsWith("line ")).toBe(true);
  });

  it("reads a step's two streams in the order the step wrote them", () => {
    const warnings = Array.from({ length: 400 }, (_, line) => `WARN deprecated ${line}`);
    const [command = "env", ...args] = setupStepArgv(
      crypto.randomUUID(),
      `for w in ${warnings.map((w) => `'${w}'`).join(" ")}; do echo "$w" >&2; done; echo 'ERR_PNPM_OUTDATED_LOCKFILE'; exit 1`,
      {},
    );
    const ran = spawnSync(command, args, { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    expect(ran.status).toBe(1);
    expect(ran.stderr.toString()).toBe("");
    expect(outputTailOf(ran.stdout.toString()).endsWith("ERR_PNPM_OUTDATED_LOCKFILE\n")).toBe(true);
  });
});

describe("a setup step and its Stop, in a real shell", () => {
  it("ends the step and every process it started", { timeout: 15_000 }, async () => {
    const runId = crypto.randomUUID();
    const [command = "env", ...args] = setupStepArgv(runId, "sleep 30 & sleep 30; wait", {
      MEND_SESSION_ID: "session-1",
    });
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
