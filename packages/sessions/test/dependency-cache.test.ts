import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { CaptureStoreRepo } from "@mend/db";
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  BlobStore,
  BlobStoreFsLive,
  captureKeys,
  decodeDirObject,
  keysNeededBy,
  materialize,
} from "@mend/store";
import { buildManifest, sectionOf, snapshotDirectory, uploadObjects } from "@mend/store/testing";
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import {
  CaptureChannel,
  CaptureChannelLive,
  CaptureUploadPolicyDefault,
  planForPlatform,
} from "../src/capture-channel.ts";
import { CaptureRemotesOff } from "../src/capture-remotes.ts";
import { CaptureSourcesOff } from "../src/capture-sources.ts";
import { CaptureGitVerifierOff } from "../src/capture-verify.ts";
import {
  bulkSectionOfCache,
  countFetchRetries,
  dependencyCachePrefix,
  dependencyInstallDoneLine,
  detectInstall,
  detectInstallCommand,
  INSTALL_FETCH_RETRY_MAXTIMEOUT_MS,
  INSTALL_FETCH_RETRY_MINTIMEOUT_MS,
  INSTALL_FETCH_TIMEOUT_MS,
  type InstallExecResult,
  installScript,
  platformKeyOf,
  promoteBulkToCache,
  readDependencyCache,
  runInstallCommand,
} from "../src/dependency-cache.ts";
import { makeMemoryCaptureStore } from "./capture-store-memory.ts";

describe("detectInstallCommand", () => {
  it("names the frozen install for the lockfile at the root, or nothing", () => {
    expect(detectInstallCommand(["package.json", "pnpm-lock.yaml"])).toBe(
      "pnpm install --frozen-lockfile",
    );
    expect(detectInstallCommand(["package.json", "yarn.lock"])).toBe("yarn install --immutable");
    expect(detectInstallCommand(["package.json", "package-lock.json"])).toBe("npm ci");
    expect(detectInstallCommand(["package.json"])).toBe("npm install");
    expect(detectInstallCommand(["Cargo.toml", "Cargo.lock"])).toBe("cargo fetch --locked");
    expect(detectInstallCommand(["pyproject.toml", "uv.lock"])).toBe("uv sync --frozen");
    expect(detectInstallCommand(["README.md"])).toBeNull();
  });

  it("keeps the order every launch has used: the first match wins, the rest are never asked", () => {
    expect(detectInstallCommand(["bun.lockb", "package-lock.json"])).toBe(
      "bun install --frozen-lockfile",
    );
    expect(detectInstallCommand(["npm-shrinkwrap.json"])).toBe("npm ci");
    expect(detectInstallCommand(["Cargo.toml"])).toBe("cargo fetch");
    expect(detectInstallCommand(["poetry.lock"])).toBe("poetry install");
    expect(detectInstallCommand(["go.mod"])).toBe("go mod download");
    expect(detectInstallCommand(["package.json", "Cargo.lock"])).toBe("npm install");
  });
});

describe("detectInstall", () => {
  it("names the file that decided the command, for the setup page", () => {
    expect(detectInstall(["package.json", "pnpm-lock.yaml"])).toEqual({
      command: "pnpm install --frozen-lockfile",
      from: "pnpm-lock.yaml",
    });
    expect(detectInstall(["bun.lock"])).toEqual({
      command: "bun install --frozen-lockfile",
      from: "bun.lock",
    });
    expect(detectInstall(["go.sum", "go.mod"])).toEqual({
      command: "go mod download",
      from: "go.sum",
    });
    expect(detectInstall(["README.md", "src/"])).toBeNull();
  });
});

const writeFiles = (base: string, files: Readonly<Record<string, string>> | undefined) => {
  for (const [name, text] of Object.entries(files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(base, name)), { recursive: true });
    fs.writeFileSync(path.join(base, name), text);
  }
};

describe("installScript", () => {
  const PNPM = "pnpm install --frozen-lockfile";

  it("runs every command but a plain one-line pnpm install exactly as written", () => {
    for (const command of [
      "npm ci",
      "npm install",
      "yarn install --immutable",
      "bun install --frozen-lockfile",
      "cargo fetch --locked",
      "pnpm install && pnpm build",
      "pnpm install | tee install.log",
      "pnpm install --filter '@mend/*'",
      "pnpm run build",
      "cd app && pnpm install",
      "pnpm install\npnpm build",
      "pnpm install\r\npnpm build",
      "pnpm\ninstall",
    ]) {
      expect(installScript(command)).toBe(command);
    }
    expect(installScript(PNPM)).not.toBe(PNPM);
    expect(installScript("pnpm i")).toContain("\npnpm i $mend_fetch_timeout");
    expect(installScript(` ${PNPM} `)).toContain(`\n${PNPM} $mend_fetch_timeout`);
    expect(installScript("pnpm\tinstall")).toContain("\npnpm\tinstall $mend_fetch_timeout");
  });

  it("carries no secret: only fixed setting names and numbers", () => {
    const script = installScript(PNPM);
    expect(script).toContain(`--fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}`);
    expect(script).toContain(
      `export npm_config_fetch_retry_mintimeout=${INSTALL_FETCH_RETRY_MINTIMEOUT_MS} pnpm_config_fetch_retry_mintimeout=${INSTALL_FETCH_RETRY_MINTIMEOUT_MS}`,
    );
    expect(script).toContain(
      `export npm_config_fetch_retry_maxtimeout=${INSTALL_FETCH_RETRY_MAXTIMEOUT_MS} pnpm_config_fetch_retry_maxtimeout=${INSTALL_FETCH_RETRY_MAXTIMEOUT_MS}`,
    );
    // The timeout itself never goes in the environment: pnpm 10 reads it as a string and drops it.
    expect(script).not.toMatch(/export [^\n]*fetch_timeout=/);
  });

  // The script, run by a real `sh` against a stand-in `pnpm` that writes down its argv and the
  // fetch settings it was handed, and exits with `$STAND_IN_EXIT` (0 when unset). Whatever the
  // command, the project, the person, the image or the environment set wins.
  describe("run by sh", () => {
    const run = (setup: {
      readonly command?: string;
      readonly files?: Readonly<Record<string, string>>;
      readonly home?: Readonly<Record<string, string>>;
      /** Files under the temporary root, for config paths the environment points at. */
      readonly root?: Readonly<Record<string, string>>;
      readonly env?: (root: string) => Readonly<Record<string, string>>;
      readonly status?: number;
    }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-install-script-"));
      try {
        const repo = path.join(root, "repo");
        const home = path.join(root, "home");
        const bin = path.join(root, "bin");
        for (const dir of [repo, home, bin]) fs.mkdirSync(dir, { recursive: true });
        writeFiles(repo, setup.files);
        writeFiles(home, setup.home);
        writeFiles(root, setup.root);
        const out = path.join(root, "pnpm.out");
        fs.writeFileSync(
          path.join(bin, "pnpm"),
          [
            "#!/bin/sh",
            `printf 'argv %s\\n' "$*" > "${out}"`,
            "for name in npm_config_fetch_timeout npm_config_update_notifier npm_config_fetch_retry_mintimeout npm_config_fetch_retry_maxtimeout pnpm_config_fetch_retry_mintimeout pnpm_config_fetch_retry_maxtimeout; do",
            `  printf '%s=%s\\n' "$name" "$(printenv "$name")" >> "${out}"`,
            "done",
            'exit "${STAND_IN_EXIT:-0}"',
          ].join("\n"),
          { mode: 0o755 },
        );
        // A stand-in `node` too, so the script reads node's global npmrc under this root
        // (`<root>/etc/npmrc`) and never the test machine's.
        fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const ran = spawnSync("sh", ["-c", installScript(setup.command ?? PNPM)], {
          cwd: repo,
          // A clean environment: a test run under pnpm carries npm_config_* of its own.
          env: {
            PATH: `${bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
            HOME: home,
            ...setup.env?.(root),
          },
          encoding: "utf8",
        });
        expect(ran.stderr).toBe("");
        expect(ran.status).toBe(setup.status ?? 0);
        return Object.fromEntries(
          fs
            .readFileSync(out, "utf8")
            .trim()
            .split("\n")
            .map((line) => {
              const at = line.startsWith("argv ") ? 4 : line.indexOf("=");
              return [line.slice(0, at), line.slice(at + 1)];
            }),
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    };
    const MIN = String(INSTALL_FETCH_RETRY_MINTIMEOUT_MS);
    const MAX = String(INSTALL_FETCH_RETRY_MAXTIMEOUT_MS);
    const WITH_FLAG = `install --frozen-lockfile --fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}`;

    it("sets the timeout on the command line and the retry waits in the environment when nobody did", () => {
      expect(run({})).toEqual({
        argv: WITH_FLAG,
        npm_config_fetch_timeout: "",
        npm_config_update_notifier: "false",
        npm_config_fetch_retry_mintimeout: MIN,
        npm_config_fetch_retry_maxtimeout: MAX,
        pnpm_config_fetch_retry_mintimeout: MIN,
        pnpm_config_fetch_retry_maxtimeout: MAX,
      });
    });

    it("keeps the install's exit status, whatever it is", () => {
      for (const status of [1, 137]) {
        const seen = run({ env: () => ({ STAND_IN_EXIT: String(status) }), status });
        expect(seen.argv).toBe(WITH_FLAG);
      }
    });

    it("leaves the timeout to a project's .npmrc that sets it", () => {
      const seen = run({
        files: { ".npmrc": "registry=https://example.test/\n fetch-timeout = 120000\n" },
      });
      expect(seen.argv).toBe("install --frozen-lockfile");
      expect(seen.npm_config_fetch_retry_mintimeout).toBe(MIN);
    });

    it("leaves a retry wait to a project's pnpm-workspace.yaml that sets it", () => {
      const seen = run({
        files: { "pnpm-workspace.yaml": "packages:\n  - apps/*\nfetchRetryMintimeout: 5000\n" },
      });
      expect(seen.argv).toBe(WITH_FLAG);
      expect(seen.npm_config_fetch_retry_mintimeout).toBe("");
      expect(seen.pnpm_config_fetch_retry_mintimeout).toBe("");
      expect(seen.pnpm_config_fetch_retry_maxtimeout).toBe(MAX);
    });

    it("leaves a setting to the person's ~/.npmrc or pnpm rc", () => {
      const seen = run({
        home: {
          ".npmrc": "fetch-retry-maxtimeout=30000\n",
          ".config/pnpm/rc": "fetch-timeout=90000\n",
        },
      });
      expect(seen.argv).toBe("install --frozen-lockfile");
      expect(seen.npm_config_fetch_retry_maxtimeout).toBe("");
      expect(seen.npm_config_fetch_retry_mintimeout).toBe(MIN);
    });

    it("leaves a setting to the user config NPM_CONFIG_USERCONFIG points at, in either case", () => {
      for (const name of ["NPM_CONFIG_USERCONFIG", "npm_config_userconfig"]) {
        const seen = run({
          root: { "elsewhere/npmrc": "fetch-timeout=120000\n" },
          // The default ~/.npmrc is not read when another user config is named.
          home: { ".npmrc": "fetch-retry-mintimeout=5000\n" },
          env: (root) => ({ [name]: path.join(root, "elsewhere/npmrc") }),
        });
        expect(seen.argv).toBe("install --frozen-lockfile");
        expect(seen.npm_config_fetch_retry_mintimeout).toBe(MIN);
      }
    });

    it("leaves a setting to the global npmrc: the one named, the npm prefix's, or node's prefix's", () => {
      const named = run({
        root: { "global/npmrc": "fetch-timeout=120000\n" },
        env: (root) => ({ NPM_CONFIG_GLOBALCONFIG: path.join(root, "global/npmrc") }),
      });
      expect(named.argv).toBe("install --frozen-lockfile");
      const prefix = run({
        root: { "npm-global/etc/npmrc": "fetch-retry-maxtimeout=30000\n" },
        env: (root) => ({ npm_config_prefix: path.join(root, "npm-global") }),
      });
      expect(prefix.argv).toBe(WITH_FLAG);
      expect(prefix.npm_config_fetch_retry_maxtimeout).toBe("");
      // The stand-in node is `<root>/bin/node`: its prefix's etc/npmrc is `<root>/etc/npmrc`.
      const node = run({ root: { "etc/npmrc": "update-notifier=true\n" } });
      expect(node.argv).toBe(WITH_FLAG);
      expect(node.npm_config_update_notifier).toBe("");
    });

    it("leaves a setting the command already passes", () => {
      const flag = run({ command: "pnpm install --frozen-lockfile --fetch-timeout=60000" });
      expect(flag.argv).toBe("install --frozen-lockfile --fetch-timeout=60000");
      expect(flag.npm_config_fetch_retry_mintimeout).toBe(MIN);
      const config = run({ command: "pnpm install --config.fetch-retry-mintimeout=9000" });
      expect(config.argv).toBe(
        `install --config.fetch-retry-mintimeout=9000 --fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}`,
      );
      expect(config.npm_config_fetch_retry_mintimeout).toBe("");
      expect(config.pnpm_config_fetch_retry_maxtimeout).toBe(MAX);
    });

    it("leaves a setting the environment already carries, under either prefix and either case", () => {
      const seen = run({
        env: () => ({
          npm_config_fetch_timeout: "90000",
          PNPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: "30000",
        }),
      });
      expect(seen.argv).toBe("install --frozen-lockfile");
      expect(seen.npm_config_fetch_timeout).toBe("90000");
      expect(seen.npm_config_fetch_retry_maxtimeout).toBe("");
      expect(seen.pnpm_config_fetch_retry_maxtimeout).toBe("");
      expect(seen.pnpm_config_fetch_retry_mintimeout).toBe(MIN);
    });
  });
});

/** Run `body` with an exec that runs a script by `sh` beside a stand-in `pnpm` of these lines. */
const withStandIn = async <A>(
  pnpm: ReadonlyArray<string>,
  body: (
    exec: (script: string) => Effect.Effect<InstallExecResult>,
    seen: string[],
  ) => Effect.Effect<A>,
): Promise<A> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-install-rerun-"));
  try {
    const repo = path.join(root, "repo");
    const bin = path.join(root, "bin");
    for (const dir of [repo, bin]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(bin, "pnpm"), ["#!/bin/sh", ...pnpm].join("\n"), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const seen: string[] = [];
    const exec = (script: string) =>
      Effect.sync(() => {
        seen.push(script);
        const ran = spawnSync("sh", ["-c", script], {
          cwd: repo,
          env: { PATH: `${bin}:/usr/bin:/bin:${process.env.PATH ?? ""}`, HOME: root },
          encoding: "utf8",
        });
        return { exitCode: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
      });
    return await Effect.runPromise(body(exec, seen));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

// The rerun with pnpm's defaults, through a real `sh` and a stand-in `pnpm` that, like a registry
// slower than 15 s to answer every time, fails with timeouts under Mend's flag and succeeds
// without it.
describe("runInstallCommand", () => {
  const RETRY = ` WARN  GET https://registry.example/a/-/a-1.0.0.tgz error (ERR_SOCKET_TIMEOUT). Will retry in 2 seconds. 2 retries left.`;
  const GIVE_UP = ` ERR_SOCKET_TIMEOUT  request to https://registry.example/a/-/a-1.0.0.tgz failed, reason: Socket timeout`;
  // Fails with two retries and pnpm's give-up line under Mend's timeout; succeeds without it.
  const SLOW_PROXY = [
    `case "$*" in *--fetch-timeout=${INSTALL_FETCH_TIMEOUT_MS}*)`,
    `  printf '%s\\n%s\\n' '${RETRY}' '${RETRY}'; printf '%s\\n' '${GIVE_UP}' >&2; exit 1;;`,
    "esac",
    "echo 'Done in 20.2s using pnpm v10.32.1'",
  ];

  it("a shortened install that failed on fetch timeouts runs once more with pnpm's defaults, and succeeds", async () => {
    const PNPM = "pnpm install --frozen-lockfile";
    await withStandIn(SLOW_PROXY, (exec, seen) =>
      Effect.gen(function* () {
        const outcome = yield* runInstallCommand(PNPM, exec);
        expect(outcome).toEqual({
          exitCode: 0,
          fetchRetries: 2,
          retriedWithDefaults: true,
          stderr: "",
        });
        expect(seen).toEqual([installScript(PNPM), PNPM]);
      }),
    );
  });

  it("the rerun's failure is the outcome, with the retries of both runs", async () => {
    const PNPM = "pnpm install";
    await withStandIn(
      [`printf '%s\\n' '${RETRY}'`, `printf '%s\\n' '${GIVE_UP}' >&2`, "exit 1"],
      (exec, seen) =>
        Effect.gen(function* () {
          const outcome = yield* runInstallCommand(PNPM, exec);
          expect(outcome.exitCode).toBe(1);
          expect(outcome.fetchRetries).toBe(2);
          expect(outcome.retriedWithDefaults).toBe(true);
          expect(seen).toEqual([installScript(PNPM), PNPM]);
        }),
    );
  });

  it("runs once when the install succeeded, failed without fetch retries, or was left as written", async () => {
    for (const [command, pnpm, exitCode, fetchRetries] of [
      ["pnpm install", [`printf '%s\\n' '${RETRY}'`, "exit 0"], 0, 1],
      [
        "pnpm install",
        ["echo ' ERR_PNPM_FETCH_404  GET https://registry.example/x: Not Found'", "exit 1"],
        1,
        0,
      ],
      ["pnpm install && true", [`printf '%s\\n' '${RETRY}'`, "exit 1"], 1, 1],
    ] as const) {
      await withStandIn(pnpm, (exec, seen) =>
        Effect.gen(function* () {
          const outcome = yield* runInstallCommand(command, exec);
          expect(outcome).toMatchObject({ exitCode, fetchRetries, retriedWithDefaults: false });
          expect(seen).toHaveLength(1);
        }),
      );
    }
  });
});

describe("countFetchRetries", () => {
  it("counts the lines that report a download about to be retried, once per line", () => {
    const stdout = [
      "Packages: +2024",
      "Progress: resolved 2024, reused 1, downloaded 2002, added 2023",
      // pnpm 10
      " WARN  GET https://registry.npmjs.org/@expo/ui/-/ui-0.2.0.tgz error (ERR_SOCKET_TIMEOUT). Will retry in 10 seconds. 2 retries left.",
      // pnpm 11
      "[WARN] GET https://registry.npmjs.org/a/-/a-1.0.0.tgz error (ERR_PNPM_FETCH_TIMEOUT). Will retry in 1 second. 2 retries left.",
      // pnpm 12: the error and the retry on two lines; the retry line counts
      "[WARN] GET https://registry.npmjs.org/b/-/b-1.0.0.tgz error (Failed to fetch: operation timed out) — 1",
      "Will retry in 10s. 1 retries left.",
      // a reset connection, warned about and retried
      " WARN  GET https://registry.npmjs.org/@vitest/spy/-/spy-3.2.7.tgz error (ECONNRESET). Will retry in 10 seconds. 2 retries left.",
      " WARN  Tarball download average speed 31 KiB/s (size 1024 KiB) is below 50 KiB/s",
      "Done in 14.2s using pnpm v10.32.1",
    ].join("\n");
    expect(countFetchRetries(stdout, "")).toBe(4);
    expect(countFetchRetries("Done in 9.8s using pnpm v10.32.1\n", "")).toBe(0);
    expect(countFetchRetries("", "")).toBe(0);
  });

  it("does not count a give-up line, an HTTP refusal, or a script printing a socket error", () => {
    const stderr = [
      // pnpm 10 once its retries ran out
      " ERR_SOCKET_TIMEOUT  request to https://registry.npmjs.org/a/-/a-1.0.0.tgz failed, reason: Socket timeout",
      "FetchError: request to https://registry.npmjs.org/a/-/a-1.0.0.tgz failed, reason: Socket timeout",
      // pnpm 11 refused
      " ERR_PNPM_FETCH_401  GET https://npm.example/@corp%2Fui: Unauthorized - 401",
      " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404",
      // npm
      "npm error code EIDLETIMEOUT",
      "npm error Idle timeout reached for host `registry.npmjs.org:443`",
      // a postinstall
      "Error: read ECONNRESET",
      "request to https://example.test failed, reason: connect ETIMEDOUT 10.0.0.1:443",
    ].join("\n");
    expect(countFetchRetries("", stderr)).toBe(0);
  });
});

describe("dependencyInstallDoneLine", () => {
  it("says the exit and the fetch retries in a fixed, parseable shape", () => {
    expect(dependencyInstallDoneLine(0, 2)).toBe(
      "session engine: dependency install · completed · exit 0 · fetch retries 2",
    );
    expect(dependencyInstallDoneLine(0, 0)).toBe(
      "session engine: dependency install · completed · exit 0 · fetch retries 0",
    );
    expect(dependencyInstallDoneLine(1, 3)).toBe(
      "session engine: dependency install · exited · exit 1 · fetch retries 3",
    );
    expect(dependencyInstallDoneLine(0, 2)).toMatch(
      /^session engine: dependency install · (completed|exited) · exit (-?\d+) · fetch retries (\d+)$/,
    );
  });
});

describe("platformKeyOf", () => {
  it("reads the probe into sealantd's <os>-<arch>-<libc>", () => {
    expect(platformKeyOf("Linux\nx86_64\nldd (GNU libc) 2.39\n")).toBe("linux-x86_64-gnu");
    expect(platformKeyOf("Linux\naarch64\nmusl libc (aarch64)\nVersion 1.2.5\n")).toBe(
      "linux-aarch64-musl",
    );
    expect(platformKeyOf("Darwin\narm64\n")).toBe("macos-aarch64-system");
    expect(platformKeyOf("")).toBeNull();
  });
});

describe("planForPlatform", () => {
  it("leaves the bulk section for the capturing platform and withholds it from another", () => {
    const manifest = buildManifest({
      worktreeId: "wt-x",
      n: 1,
      parent: null,
      epoch: 1,
      seq: 1,
      kind: "turn",
      bulk: {
        root: "captures/wt-x/1/trees/aa",
        packs: ["captures/wt-x/1/packs/bb"],
        platform: "linux-x86_64-gnu",
      },
    }).manifest;
    expect(planForPlatform(manifest, undefined)).toBe(manifest);
    expect(planForPlatform(manifest, "linux-x86_64-gnu")).toBe(manifest);
    expect(planForPlatform(manifest, "linux-aarch64-musl").sections.bulk).toBe("pending");
  });

  it("answers another platform its own tree from other_bulk, as stored, and pending when it has none", () => {
    const x86 = {
      root: "captures/wt-x/2/trees/aa",
      packs: ["captures/wt-x/2/packs/bb"],
      platform: "linux-x86_64-gnu",
    };
    const arm = {
      root: "c".repeat(64),
      packs: ["captures/wt-x/1/packs/dd"],
      platform: "linux-aarch64-gnu",
      format: 2 as const,
      dir_packs: ["captures/wt-x/1/packs/ee"],
    };
    const manifest = buildManifest({
      worktreeId: "wt-x",
      n: 2,
      parent: null,
      epoch: 2,
      kind: "turn",
      bulk: x86,
      otherBulk: { "linux-aarch64-gnu": arm },
    }).manifest;
    const forArm = planForPlatform(manifest, "linux-aarch64-gnu");
    expect(forArm.sections.bulk).toEqual(arm);
    // What the head carries is left as stored; only the answered section moves into `bulk`.
    expect(forArm.sections.other_bulk).toEqual({ "linux-aarch64-gnu": arm });
    expect(planForPlatform(manifest, "linux-x86_64-gnu")).toBe(manifest);
    expect(planForPlatform(manifest, "linux-aarch64-musl").sections.bulk).toBe("pending");
    // A head still pending on its own platform answers the platform other_bulk carries.
    const pendingHere = buildManifest({
      worktreeId: "wt-x",
      n: 3,
      parent: null,
      epoch: 3,
      otherBulk: { "linux-x86_64-gnu": x86 },
    }).manifest;
    expect(planForPlatform(pendingHere, "linux-x86_64-gnu").sections.bulk).toEqual(x86);
    expect(planForPlatform(pendingHere, "linux-aarch64-gnu")).toBe(pendingHere);
  });
});

describe("the shared dependency cache", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-dependency-cache-"));
  const blobRoot = path.join(scratch, "blobs");
  const memory = makeMemoryCaptureStore();
  const blobs = BlobStoreFsLive(blobRoot);
  const layer = Layer.mergeAll(
    CaptureChannelLive.pipe(
      Layer.provide(CaptureGitVerifierOff),
      Layer.provide(CaptureSourcesOff),
      Layer.provide(CaptureRemotesOff),
      Layer.provide(memory.layer),
      Layer.provide(blobs),
      Layer.provide(CaptureUploadPolicyDefault),
    ),
    blobs,
    memory.layer,
  );
  const run = <A, E>(effect: Effect.Effect<A, E, BlobStore | CaptureStoreRepo | CaptureChannel>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer)));
  afterAll(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  const PROJECT = ProjectId.make("proj-cache");
  const PLATFORM = "linux-x86_64-gnu";

  /** An executor's capture with a dependency tree: `node_modules/pkg/index.js` in the bulk class. */
  const bulkCapture = (worktreeId: WorktreeId, epoch: number, n: number, parent: string | null) => {
    const tree = path.join(scratch, `bulk-${worktreeId}-${n}`);
    fs.mkdirSync(path.join(tree, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tree, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, epoch), { chunkSize: 64 });
    const built = buildManifest({
      worktreeId,
      n,
      parent,
      epoch,
      seq: 10 * n,
      kind: "checkpoint",
      bulk: { root: snapshot.root, packs: snapshot.packs, platform: PLATFORM },
    });
    return { snapshot, built };
  };

  it("a session's registered bulk capture writes nothing under the cache prefix; the install job's promotion does, re-keyed, and is readable", async () => {
    const worktreeId = WorktreeId.make("wt-session");
    const { snapshot, built } = bulkCapture(worktreeId, 1, 0, null);
    const cachePrefix = dependencyCachePrefix(PROJECT, PLATFORM);
    const listCache = Effect.gen(function* () {
      const store = yield* BlobStore;
      return (yield* store.list(cachePrefix)).map((entry) => entry.key);
    });
    const registered = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const repo = yield* CaptureStoreRepo;
        yield* repo.init(worktreeId);
        const claimed = yield* repo.claim(worktreeId, "executor-1");
        const channel = yield* CaptureChannel;
        const api = channel.apiFor({
          worktreeId,
          projectId: PROJECT,
          executorId: "executor-1",
          footprintBytes: 0,
        });
        // The executor registers its capture through the channel, exactly as sealantd does.
        yield* api.register({
          worktree_id: worktreeId,
          epoch: claimed.epoch,
          n: 0,
          parent: null,
          capture_id: built.id,
          manifest_key: built.key,
          manifest: built.manifest,
        });
        return {
          cacheKeys: yield* listCache,
          cache: yield* readDependencyCache(PROJECT, PLATFORM),
        };
      }),
    );
    // Policy: a session capture never promotes.
    expect(registered.cacheKeys).toEqual([]);
    expect(registered.cache).toBeNull();
    const bulkPacks = [...memory.packs.values()].filter((pack) => pack.class === "bulk");
    expect(bulkPacks.every((pack) => pack.worktreeId === worktreeId)).toBe(true);

    // The install job promotes: packs copied by digest, trees re-keyed under the prefix.
    const promoted = await run(
      Effect.gen(function* () {
        const record = yield* promoteBulkToCache(PROJECT, built.id, built.manifest);
        const cache = yield* readDependencyCache(PROJECT, PLATFORM);
        const store = yield* BlobStore;
        const rootBytes = yield* store.get(record?.root ?? "");
        const root = yield* decodeDirObject(record?.root ?? "", rootBytes);
        const nodeModules = root.find((entry) => entry.name === "node_modules");
        const childKeys: Array<string> = [];
        let key = nodeModules?.child;
        while (key !== undefined) {
          childKeys.push(key);
          const entries = yield* decodeDirObject(key, yield* store.get(key));
          key = entries.find((entry) => entry.kind === "dir")?.child;
        }
        return { record, cache, cacheKeys: yield* listCache, childKeys };
      }),
    );
    expect(promoted.record?.platform).toBe(PLATFORM);
    expect(promoted.record?.capture_id).toBe(built.id);
    expect(promoted.cache).toEqual(promoted.record);
    expect(promoted.record?.root.startsWith(`${cachePrefix}trees/`)).toBe(true);
    expect(promoted.record?.packs.every((key) => key.startsWith(`${cachePrefix}packs/`))).toBe(
      true,
    );
    expect(promoted.record?.packs.length).toBe(snapshot.packs.length);
    // Every child a promoted tree names lives under the cache too — nothing points back into
    // the session's epoch prefix.
    expect(promoted.childKeys.length).toBeGreaterThan(0);
    expect(promoted.childKeys.every((key) => key.startsWith(`${cachePrefix}trees/`))).toBe(true);
    expect(promoted.cacheKeys).toEqual(
      expect.arrayContaining([`${cachePrefix}root.json`, ...(promoted.record?.packs ?? [])]),
    );
    // The cache is named by its record, not by pack rows: the session's rows are untouched and
    // none points into the cache.
    const rows = [...memory.packs.values()];
    expect(rows.filter((pack) => pack.class === "bulk").length).toBe(snapshot.packs.length);
    expect(rows.every((pack) => !pack.key.startsWith(cachePrefix))).toBe(true);
    // No cache for another platform.
    expect(await run(readDependencyCache(PROJECT, "linux-aarch64-musl"))).toBeNull();
    // A record written before dir packs reads as format 1, and splices as it always did.
    expect(promoted.record?.format).toBeUndefined();
    if (promoted.record === null || promoted.record === undefined) throw new Error("no record");
    expect(bulkSectionOfCache(promoted.record)).toEqual({
      root: promoted.record.root,
      packs: promoted.record.packs,
      platform: PLATFORM,
    });
  });

  it("serves a platform only a record of its own platform, and promotes a head's own bulk section, never one other_bulk carries", async () => {
    const x86 = "linux-x86_64-gnu";
    const arm = "linux-aarch64-gnu";
    const project = ProjectId.make("proj-cache-platforms");
    // A record naming x86's tree, found under the arm prefix, is not arm's cache.
    const misplaced = {
      root: "captures/w/1/trees/aa",
      packs: [],
      platform: x86,
      capture_id: "c".repeat(64),
      promoted_at: new Date(0).toISOString(),
    };
    const read = await run(
      Effect.gen(function* () {
        const store = yield* BlobStore;
        yield* store.put(
          `${dependencyCachePrefix(project, arm)}root.json`,
          new Uint8Array(Buffer.from(JSON.stringify(misplaced), "utf8")),
        );
        yield* store.put(
          `${dependencyCachePrefix(project, x86)}root.json`,
          new Uint8Array(Buffer.from("{not json", "utf8")),
        );
        return {
          arm: yield* readDependencyCache(project, arm),
          x86: yield* readDependencyCache(project, x86),
        };
      }),
    );
    expect(read).toEqual({ arm: null, x86: null });

    // An install session's head built x86 and carries an arm tree from elsewhere: only x86 is
    // promoted, into x86's prefix; the arm prefix keeps what it had.
    const worktreeId = WorktreeId.make("wt-install-platforms");
    const { snapshot, built } = bulkCapture(worktreeId, 5, 0, null);
    const carrying = buildManifest({
      worktreeId,
      n: 0,
      parent: null,
      epoch: 5,
      kind: "final",
      bulk: { ...sectionOf(snapshot), platform: x86 },
      otherBulk: {
        [arm]: { root: "captures/w/1/trees/bb", packs: ["captures/w/1/packs/cc"], platform: arm },
      },
    });
    const promoted = await run(
      Effect.gen(function* () {
        yield* uploadObjects(new Map([...snapshot.objects, [built.key, built.bytes]]));
        const record = yield* promoteBulkToCache(project, carrying.id, carrying.manifest);
        const store = yield* BlobStore;
        return {
          record,
          x86: yield* readDependencyCache(project, x86),
          armKeys: (yield* store.list(dependencyCachePrefix(project, arm))).map(
            (entry) => entry.key,
          ),
        };
      }),
    );
    expect(promoted.record?.platform).toBe(x86);
    expect(promoted.x86).toEqual(promoted.record);
    expect(promoted.armKeys).toEqual([`${dependencyCachePrefix(project, arm)}root.json`]);

    // A head with no tree of its own promotes nothing, whatever other_bulk carries.
    const onlyCarried = buildManifest({
      worktreeId,
      n: 1,
      parent: carrying.id,
      epoch: 5,
      otherBulk: { [x86]: { ...sectionOf(snapshot), platform: x86 } },
    });
    expect(await run(promoteBulkToCache(project, onlyCarried.id, onlyCarried.manifest))).toBeNull();
  });

  it("a format-2 bulk section promotes by copying its dir packs, keeps its root digest, and restores from the cache alone", async () => {
    const platform = "linux-aarch64-gnu";
    const worktreeId = WorktreeId.make("wt-install-v2");
    const tree = path.join(scratch, "bulk-v2");
    fs.mkdirSync(path.join(tree, "node_modules", "pkg", "lib"), { recursive: true });
    fs.writeFileSync(path.join(tree, "node_modules", "pkg", "lib", "index.js"), "exports.v = 2;\n");
    fs.symlinkSync("pkg/lib/index.js", path.join(tree, "node_modules", "entry.js"));
    const sessionBlobs = path.join(scratch, "session-v2-blobs");
    const snapshot = snapshotDirectory(tree, captureKeys(worktreeId, 4), {
      chunkSize: 64,
      format: 2,
      dirPackBudget: 2,
    });
    expect(snapshot.dirPacks.length).toBeGreaterThan(1);
    const built = buildManifest({
      worktreeId,
      n: 3,
      parent: null,
      epoch: 4,
      kind: "final",
      bulk: { ...sectionOf(snapshot), platform },
    });
    const cachePrefix = dependencyCachePrefix(PROJECT, platform);
    const promoted = await run(
      Effect.gen(function* () {
        yield* uploadObjects(snapshot.objects);
        const record = yield* promoteBulkToCache(PROJECT, built.id, built.manifest);
        return { record, cache: yield* readDependencyCache(PROJECT, platform) };
      }),
    );
    const record = promoted.record;
    if (record === null) throw new Error("nothing promoted");
    expect(promoted.cache).toEqual(record);
    expect(record.format).toBe(2);
    expect(record.root).toBe(snapshot.root);
    expect(record.dir_packs?.length).toBe(snapshot.dirPacks.length);
    for (const key of [...record.packs, ...(record.dir_packs ?? [])]) {
      expect(key.startsWith(`${cachePrefix}packs/`)).toBe(true);
    }
    // No dir object was re-keyed or written on its own: the cache holds packs and its record.
    const cacheKeys = await run(
      Effect.flatMap(BlobStore, (store) => store.list(cachePrefix)).pipe(
        Effect.map((entries) => entries.map((entry) => entry.key)),
      ),
    );
    expect(cacheKeys.some((key) => key.includes("/trees/"))).toBe(false);
    // The plan splice carries the format and the dir packs; a standby's plan presigns them.
    const section = bulkSectionOfCache(record);
    expect(section).toEqual({
      root: snapshot.root,
      packs: record.packs,
      platform,
      format: 2,
      dir_packs: record.dir_packs,
    });
    const standby = buildManifest({
      worktreeId: "standby",
      n: 0,
      parent: null,
      epoch: 9,
      bulk: section,
    }).manifest;
    const keys = await run(keysNeededBy(standby));
    expect(keys.toSorted()).toEqual([...record.packs, ...(record.dir_packs ?? [])].toSorted());
    // The cache restores without the session's objects: copy only the cache prefix elsewhere.
    fs.mkdirSync(path.join(sessionBlobs, path.dirname(cachePrefix)), { recursive: true });
    fs.cpSync(path.join(blobRoot, cachePrefix), path.join(sessionBlobs, cachePrefix), {
      recursive: true,
    });
    const target = path.join(scratch, "restored-v2");
    await Effect.runPromise(
      materialize(standby, "bulk", target).pipe(Effect.provide(BlobStoreFsLive(sessionBlobs))),
    );
    expect(
      fs.readFileSync(path.join(target, "node_modules", "pkg", "lib", "index.js"), "utf8"),
    ).toBe("exports.v = 2;\n");
    expect(fs.readlinkSync(path.join(target, "node_modules", "entry.js"))).toBe("pkg/lib/index.js");
  });
});
