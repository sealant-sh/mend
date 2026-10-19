import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { expect, it } from "@mend/test-ci/effect-vitest";
import { Effect, Layer } from "effect";

import { AgentBridgeLive } from "../src/agent-bridge.ts";
import { MendKeysConfig, MendKeysLive } from "../src/git-auth.ts";
import { preparedRemoteEnvironment } from "../src/remote-operation-env.ts";
import { makeSourcePolicy } from "../src/source-policy.ts";
import { Store, StoreConfig } from "../src/store.ts";

const withRepository = async <A, E>(
  work: (fixture: {
    readonly tmp: string;
    readonly origin: string;
    readonly repository: string;
    readonly env: Record<string, string>;
    readonly head: string;
  }) => Effect.Effect<A, E, Store>,
): Promise<A> => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-base-observation-"));
  const origin = path.join(tmp, "origin");
  const repository = path.join(tmp, "repository.git");
  const env = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: tmp,
    XDG_CONFIG_HOME: tmp,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_TEMPLATE_DIR: "",
    GIT_AUTHOR_NAME: "synthetic",
    GIT_AUTHOR_EMAIL: "synthetic@invalid",
    GIT_COMMITTER_NAME: "synthetic",
    GIT_COMMITTER_EMAIL: "synthetic@invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: ReadonlyArray<string>, cwd = tmp) =>
    execFileSync("git", [...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  try {
    git(["init", "-b", "main", "--template=", origin]);
    fs.writeFileSync(path.join(origin, "README.md"), "synthetic fixture\n");
    git(["add", "README.md"], origin);
    git(["commit", "-m", "fixture"], origin);
    const head = git(["rev-parse", "HEAD"], origin);
    // Fixture setup may use its owned local path; the production adoption policy is not exercised.
    git(["clone", "--bare", "--template=", origin, repository]);
    git(["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"], repository);
    const layer = Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.join(tmp, "store"))));
    return await Effect.runPromise(
      work({ tmp, origin, repository, env, head }).pipe(Effect.provide(layer)),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

const refusedSsh = (tmp: string) => {
  const helper = path.join(tmp, "refuse-ssh");
  const log = path.join(tmp, "ssh-invocations");
  fs.writeFileSync(
    helper,
    `#!/bin/sh\nprintf 'refused\\n' >> '${log}'\nprintf 'synthetic transport refused before network\\n' >&2\nexit 255\n`,
    { mode: 0o755 },
  );
  return { helper, log };
};

it("reports the failed origin fetch instead of claiming an unknown base was fetched", async () => {
  await withRepository(({ tmp, repository, env, head }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const { helper, log } = refusedSsh(tmp);
      execFileSync("git", ["remote", "set-url", "origin", "ssh://git@127.0.0.1/refused.git"], {
        cwd: repository,
        env,
      });
      const error = yield* store
        .resolveBase(repository, "missing-base", {
          ...env,
          GIT_SSH_COMMAND: helper,
          GIT_SSH_VARIANT: "ssh",
        })
        .pipe(Effect.flip);
      expect(error.args).toEqual(["fetch", "origin"]);
      expect(error.stderr).toContain("synthetic transport refused before network");
      expect(error.stderr).not.toContain("origin was fetched");
      expect(error.unknownBase).toBeUndefined();
      expect(error.exitCode).toBe(128);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
      expect(
        execFileSync("git", ["rev-parse", "main"], {
          cwd: repository,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe(head);
    }),
  );
});

it("reports an unknown base after a successful origin fetch and retains its fetched refs", async () => {
  await withRepository(({ origin, repository, env }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      fs.writeFileSync(path.join(origin, "README.md"), "advanced synthetic fixture\n");
      execFileSync("git", ["commit", "-am", "advance"], { cwd: origin, env });
      const current = execFileSync("git", ["rev-parse", "main"], {
        cwd: origin,
        env,
        encoding: "utf8",
      }).trim();
      const error = yield* store.resolveBase(repository, "missing-base", env).pipe(Effect.flip);
      expect(error.args).toEqual(["rev-parse", "missing-base^{commit}"]);
      expect(error.stderr).toContain('base "missing-base" is not a branch, tag, or commit');
      expect(error.stderr).toContain("origin was fetched and it is still unknown");
      expect(error.unknownBase).toBe("missing-base");
      expect(
        execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], {
          cwd: repository,
          env,
          encoding: "utf8",
        }).trim(),
      ).toBe(current);
      expect(fs.readFileSync(path.join(repository, "FETCH_HEAD"), "utf8")).toContain(current);
    }),
  );
});

it("preserves a credential refusal without transport or credential disclosure", async () => {
  await withRepository(({ tmp, repository, env }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const { helper, log } = refusedSsh(tmp);
      execFileSync(
        "git",
        [
          "remote",
          "set-url",
          "origin",
          "ssh://synthetic-user:synthetic-secret@127.0.0.1/private.git",
        ],
        {
          cwd: repository,
          env,
        },
      );
      const config = fs.readFileSync(path.join(repository, "config"));
      const error = yield* store
        .resolveBase(repository, "missing-base", {
          ...env,
          GIT_SSH_COMMAND: helper,
          GIT_SSH_VARIANT: "ssh",
        })
        .pipe(Effect.flip);
      expect(error.args).toEqual(["mend", "remote-credentials"]);
      expect(error.stderr).toContain("Mend does not fetch");
      expect(error.stderr).toContain("until an operator removes");
      expect(error.stderr).not.toContain("origin was fetched");
      expect(error.stderr).not.toContain("synthetic-user");
      expect(error.stderr).not.toContain("synthetic-secret");
      expect(error.args.join(" ")).not.toContain("synthetic-secret");
      expect(fs.existsSync(log)).toBe(false);
      expect(fs.readFileSync(path.join(repository, "config"))).toEqual(config);
    }),
  );
});

it("continues from the known local base after a refused best-effort refresh", async () => {
  await withRepository(({ tmp, repository, env, head }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const { helper, log } = refusedSsh(tmp);
      execFileSync("git", ["remote", "set-url", "origin", "ssh://git@127.0.0.1/refused.git"], {
        cwd: repository,
        env,
      });
      const base = yield* store.resolveBase(repository, "main", {
        ...env,
        GIT_SSH_COMMAND: helper,
        GIT_SSH_VARIANT: "ssh",
      });
      expect(base.baseRef).toBe("main");
      expect(base.baseSha).toBe(head);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    }),
  );
});

it("resolves a ref that appears locally during the failed fallback fetch", async () => {
  await withRepository(({ tmp, repository, env, head }) =>
    Effect.gen(function* () {
      const store = yield* Store;
      const helper = path.join(tmp, "publish-local-ref");
      const log = path.join(tmp, "ssh-invocations");
      fs.writeFileSync(
        helper,
        `#!/bin/sh\nprintf 'refused\\n' >> '${log}'\nif [ "$(wc -l < '${log}')" -eq 2 ]; then git --git-dir='${repository}' update-ref refs/heads/arrived-locally '${head}'; fi\nprintf 'synthetic transport refused before network\\n' >&2\nexit 255\n`,
        { mode: 0o755 },
      );
      execFileSync("git", ["remote", "set-url", "origin", "ssh://git@127.0.0.1/refused.git"], {
        cwd: repository,
        env,
      });
      const base = yield* store.resolveBase(repository, "arrived-locally", {
        ...env,
        GIT_SSH_COMMAND: helper,
        GIT_SSH_VARIANT: "ssh",
      });
      expect(base.baseRef).toBe("arrived-locally");
      expect(base.baseSha).toBe(head);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    }),
  );
});

it("preserves the actual source-policy refusal for an unchecked rewritten origin without dialing it", async () => {
  const requests: string[] = [];
  const recorder = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    recorder.once("error", reject);
    recorder.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = recorder.address();
    if (address === null || typeof address === "string") throw new Error("Recorder not listening.");
    await withRepository(({ tmp, repository, env, head }) =>
      Effect.gen(function* () {
        const store = yield* Store;
        const source = "http://140.82.112.3/public.git";
        execFileSync("git", ["remote", "set-url", "origin", source], { cwd: repository, env });
        execFileSync(
          "git",
          ["config", `url.http://127.0.0.1:${address.port}/private.git.insteadOf`, source],
          {
            cwd: repository,
            env,
          },
        );
        const config = fs.readFileSync(path.join(repository, "config"));
        const provider = yield* preparedRemoteEnvironment({
          policy: makeSourcePolicy({
            profile: "operator",
            allowedHosts: [],
            resolve: async () => [],
          }),
          source,
          actor: { isOperator: false },
          mode: "bridge",
          userId: null,
          env,
        });
        const error = yield* store
          .resolveBase(repository, "missing-base", provider)
          .pipe(Effect.flip);
        expect(error.args).toEqual(["remote", "prepare"]);
        expect(error.exitCode).toBeNull();
        expect(error.stderr).toContain("only the operator");
        expect(error.stderr).not.toContain("origin was fetched");
        expect(requests).toEqual([]);
        expect(fs.readFileSync(path.join(repository, "config"))).toEqual(config);
        const base = yield* store.resolveBase(repository, "main", provider);
        expect(base.baseSha).toBe(head);
        expect(requests).toEqual([]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(MendKeysLive, AgentBridgeLive).pipe(
            Layer.provide(MendKeysConfig.layerFor(path.join(tmp, "keys"))),
          ),
        ),
      ),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      recorder.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
