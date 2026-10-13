import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Scope, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { AgentBridge } from "../src/agent-bridge.ts";
import { noSignerGitEnv } from "../src/git-auth.ts";
import { MendKeys } from "../src/git-auth.ts";
import { resolveGitRemote } from "../src/git-remote-operation.ts";
import { preparedRemoteEnvironment } from "../src/remote-operation-env.ts";
import { makeSourcePolicy } from "../src/source-policy.ts";
import { Store, StoreConfig } from "../src/store.ts";

const source = "http://140.82.112.3/source.git";
const target = "http://140.82.114.3/target.git";
const other = "http://140.82.116.3/other.git";

const fixture = async () => {
  const scope = Effect.runSync(Scope.make());
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Effect.provideService(effect, Scope.Scope, scope));
  const home = await mkdtemp(join(tmpdir(), "mend-operation-test-"));
  const repositoryPath = join(home, "repo");
  const global = join(home, "global");
  await writeFile(global, "");
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "",
    GIT_AUTHOR_NAME: "synthetic",
    GIT_AUTHOR_EMAIL: "synthetic@invalid",
    GIT_COMMITTER_NAME: "synthetic",
    GIT_COMMITTER_EMAIL: "synthetic@invalid",
    GIT_TERMINAL_PROMPT: "0",
    NO_PROXY: "",
    no_proxy: "",
  };
  execFileSync("git", ["init", "-q", "--template=", repositoryPath], { env });
  const git = (...args: ReadonlyArray<string>) =>
    execFileSync("git", [...args], { cwd: repositoryPath, env, encoding: "utf8" });
  const tree = git("hash-object", "-t", "tree", "--stdin").trim();
  const head = git("commit-tree", tree, "-m", "synthetic fixture").trim();
  git("update-ref", "refs/heads/main", head);
  git("symbolic-ref", "HEAD", "refs/heads/main");
  return {
    home,
    repositoryPath,
    global,
    env,
    git,
    run,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(home, { recursive: true, force: true });
    },
  };
};

const recorder = async () => {
  const requests: string[] = [];
  const redirected = "http://127.0.0.1:1/unchecked.git/info/refs?service=git-upload-pack";
  let redirect = false;
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (redirect && request.url !== redirected)
      response.writeHead(302, { Location: redirected }).end();
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("recorder did not listen");
  return {
    requests,
    redirected,
    redirect: () => {
      redirect = true;
    },
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.proxy",
      GIT_CONFIG_VALUE_0: `http://127.0.0.1:${address.port}`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const transport = (args: ReadonlyArray<string>, cwd: string, env: Record<string, string>) =>
  new Promise<void>((resolve, reject) =>
    execFile("git", [...args], { cwd, env, timeout: 5_000 }, (error) => {
      if (error?.killed) reject(error);
      else resolve();
    }),
  );

const noSignerServices = Layer.mergeAll(
  Layer.mock(MendKeys, {}),
  Layer.mock(AgentBridge, { socketPath: () => "/unused-synthetic-socket" }),
);

describe("Store checked remote operations", () => {
  it("refuses a local-config rewrite before the real refresh transports, without changing config", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      f.git("remote", "add", "origin", source);
      f.git("config", "url.http://127.0.0.1/private.git.insteadOf", source);
      const before = await readFile(join(f.repositoryPath, ".git/config"), "utf8");
      const error = await f.run(
        Effect.gen(function* () {
          const env = yield* preparedRemoteEnvironment({
            policy: makeSourcePolicy({
              profile: "tenant",
              allowedHosts: [],
              resolve: async () => ["140.82.112.3"],
            }),
            source,
            actor: { isOperator: false },
            mode: "bridge",
            userId: "synthetic-owner",
            env: { ...f.env, ...proxy.env },
          });
          return yield* (yield* Store).refreshFromOrigin(f.repositoryPath, env).pipe(Effect.flip);
        }).pipe(
          Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(f.home)))),
          Effect.provide(noSignerServices),
        ),
      );
      expect(error.stderr).toContain("private or reserved network");
      expect(proxy.requests).toEqual([]);
      expect(await readFile(join(f.repositoryPath, ".git/config"), "utf8")).toBe(before);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("the real refresh checks the rewritten public destination and refuses its redirect", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      f.git("remote", "add", "origin", source);
      f.git("config", `url.${target}.insteadOf`, source);
      f.git("config", `http.${target}.followRedirects`, "true");
      proxy.redirect();
      const checked: string[] = [];
      await f.run(
        Effect.gen(function* () {
          const env = yield* preparedRemoteEnvironment({
            policy: makeSourcePolicy({
              profile: "tenant",
              allowedHosts: [],
              resolve: async (host) => {
                checked.push(host);
                return ["140.82.114.3"];
              },
            }),
            source,
            actor: { isOperator: false },
            mode: "bridge",
            userId: null,
            env: { ...f.env, ...proxy.env },
          });
          yield* (yield* Store).refreshFromOrigin(f.repositoryPath, env).pipe(Effect.flip);
        }).pipe(
          Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(f.home)))),
          Effect.provide(noSignerServices),
        ),
      );
      // IP literals need no DNS callback; transport is recorded by a local nonforwarding proxy.
      expect(checked).toEqual([]);
      expect(proxy.requests).toEqual([`${target}/info/refs?service=git-upload-pack`]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("an unidentified owner cannot reach a named loopback origin, but starts from the local base", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      f.git("remote", "add", "origin", "http://127.0.0.1/private.git");
      const created = await f.run(
        Effect.gen(function* () {
          const env = yield* preparedRemoteEnvironment({
            policy: makeSourcePolicy({
              profile: "operator",
              allowedHosts: [],
              resolve: async () => [],
            }),
            source: null,
            actor: { isOperator: false },
            mode: "bridge",
            userId: null,
            env: { ...f.env, ...proxy.env },
          });
          const store = yield* Store;
          const refused = yield* store.refreshFromOrigin(f.repositoryPath, env).pipe(Effect.flip);
          expect(refused.stderr).toContain("operator");
          return yield* store.createWorktree(
            f.repositoryPath,
            { directory: "offline", branch: "mend/offline" },
            "main",
            env,
          );
        }).pipe(
          Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(f.home)))),
          Effect.provide(noSignerServices),
        ),
      );
      expect(created.baseSha).toBe(f.git("rev-parse", "main").trim());
      expect(proxy.requests).toEqual([]);
      expect(f.git("rev-parse", "mend/offline").trim()).toBe(created.baseSha);
    } finally {
      await proxy.close();
      await f.close();
    }
  });
});

describe("Git operation destination resolution", () => {
  it.each(["local", "conditional", "worktree", "parameters"])(
    "matches actual URL push with %s rules",
    async (scope) => {
      const f = await fixture();
      const proxy = await recorder();
      try {
        if (scope === "local") f.git("config", `url.${target}.pushInsteadOf`, source);
        if (scope === "worktree") {
          f.git("config", "extensions.worktreeConfig", "true");
          f.git("config", "--worktree", `url.${target}.pushInsteadOf`, source);
        }
        if (scope === "conditional") {
          const included = join(f.home, "included");
          await writeFile(included, `[url "${target}"]\n pushInsteadOf = ${source}\n`);
          await writeFile(
            f.global,
            `[includeIf "gitdir:${f.repositoryPath}/.git"]\n path = ${included}\n`,
          );
        }
        const env = {
          ...f.env,
          ...proxy.env,
          ...(scope === "parameters"
            ? { GIT_CONFIG_PARAMETERS: `'url.${target}.pushInsteadOf'='${source}'` }
            : {}),
        };
        const before = await readFile(join(f.repositoryPath, ".git/config"), "utf8");
        expect(
          await f.run(
            resolveGitRemote({
              remote: source,
              direction: "push",
              repositoryPath: f.repositoryPath,
              env,
            }),
          ),
        ).toEqual([target]);
        await transport(
          ["push", "--dry-run", source, "HEAD:refs/heads/probe"],
          f.repositoryPath,
          env,
        );
        expect(proxy.requests).toEqual([`${target}/info/refs?service=git-receive-pack`]);
        expect(await readFile(join(f.repositoryPath, ".git/config"), "utf8")).toBe(before);
      } finally {
        await proxy.close();
        await f.close();
      }
    },
  );

  it("refuses multiple matching bases while named remote resolution matches transport", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      await writeFile(
        f.global,
        `[url "${target}"]\n insteadOf = http://unmatched.invalid/\n[url "${other}"]\n pushInsteadOf = ${source}\n[url "${target}"]\n pushInsteadOf = ${source}\n`,
      );
      const env = { ...f.env, ...proxy.env };
      const operation = {
        remote: source,
        direction: "push" as const,
        repositoryPath: f.repositoryPath,
        env,
      };
      const refused = await f.run(resolveGitRemote(operation).pipe(Effect.flip));
      expect(refused.stage).toBe("ambiguous-push");
      const policy = makeSourcePolicy({
        profile: "operator",
        allowedHosts: [],
        resolve: async () => [],
      });
      const policyRefusal = await f.run(
        policy.prepare(source, { isOperator: true }, operation).pipe(Effect.flip),
      );
      expect(policyRefusal.message).toContain("Use a named remote");
      expect(policyRefusal.message).not.toContain(source);
      await transport(
        ["push", "--dry-run", source, "HEAD:refs/heads/probe"],
        f.repositoryPath,
        env,
      );
      expect(proxy.requests).toEqual([`${other}/info/refs?service=git-receive-pack`]);
      proxy.requests.length = 0;
      f.git("config", "remote.origin.url", source);
      expect(await f.run(resolveGitRemote({ ...operation, remote: "origin" }))).toEqual([other]);
      await transport(
        ["push", "--dry-run", "origin", "HEAD:refs/heads/probe"],
        f.repositoryPath,
        env,
      );
      expect(proxy.requests).toEqual([`${other}/info/refs?service=git-receive-pack`]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it.each([
    ["insteadOf", "pushInsteadOf"],
    ["pushInsteadOf", "insteadOf"],
    ["insteadOf", "insteadOf"],
    ["pushInsteadOf", "pushInsteadOf"],
  ])("compares intermediate %s then %s rules with actual explicit push", async (first, second) => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      await writeFile(
        f.global,
        `[url "${target}"]\n ${first} = ${source}\n[url "${other}"]\n ${second} = ${target}\n`,
      );
      const env = { ...f.env, ...proxy.env };
      const urls = await f.run(
        resolveGitRemote({
          remote: source,
          direction: "push",
          repositoryPath: f.repositoryPath,
          env,
        }),
      );
      await transport(
        ["push", "--dry-run", source, "HEAD:refs/heads/probe"],
        f.repositoryPath,
        env,
      );
      expect(proxy.requests).toEqual([`${urls[0]}/info/refs?service=git-receive-pack`]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it.each(
    [source, "http://140.82.112.3/", "http://"].flatMap((readPrefix) =>
      [source, "http://140.82.112.3/", "http://"].map((pushPrefix) => [readPrefix, pushPrefix]),
    ),
  )(
    "matches actual push for one base with read %s and push %s prefixes",
    async (readPrefix, pushPrefix) => {
      const f = await fixture();
      const proxy = await recorder();
      try {
        await writeFile(
          f.global,
          `[url "${target}"]\n insteadOf = ${readPrefix}\n pushInsteadOf = ${pushPrefix}\n`,
        );
        const env = { ...f.env, ...proxy.env };
        const urls = await f.run(
          resolveGitRemote({
            remote: source,
            direction: "push",
            repositoryPath: f.repositoryPath,
            env,
          }),
        );
        expect(urls).toHaveLength(1);
        await transport(
          ["push", "--dry-run", source, "HEAD:refs/heads/probe"],
          f.repositoryPath,
          env,
        );
        expect(proxy.requests).toEqual([`${urls[0]}/info/refs?service=git-receive-pack`]);
      } finally {
        await proxy.close();
        await f.close();
      }
    },
  );

  it("ignores GIT_CONFIG's config-command-only redirect when reading push rules", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      f.git("config", `url.${target}.pushInsteadOf`, source);
      const redirectedConfig = join(f.home, "config-command-only");
      await writeFile(redirectedConfig, `[url "${other}"]\n pushInsteadOf = ${source}\n`);
      const env = { ...f.env, ...proxy.env, GIT_CONFIG: redirectedConfig };
      expect(
        await f.run(
          resolveGitRemote({
            remote: source,
            direction: "push",
            repositoryPath: f.repositoryPath,
            env,
          }),
        ),
      ).toEqual([target]);
      await transport(
        ["push", "--dry-run", source, "HEAD:refs/heads/probe"],
        f.repositoryPath,
        env,
      );
      expect(proxy.requests).toEqual([`${target}/info/refs?service=git-receive-pack`]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("retains one-pass URL semantics and pins the effective redirect policy", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      await writeFile(
        f.global,
        `[url "${target}"]\n insteadOf = ${source}\n[url "${other}"]\n insteadOf = ${target}\n[http "${target}"]\n followRedirects = true\n`,
      );
      const env = { ...f.env, ...proxy.env };
      proxy.redirect();
      const policy = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
      });
      const original = await f.run(policy.check(source, { isOperator: false }));
      await transport(["ls-remote", source], f.repositoryPath, policy.pinnedEnv(original, env));
      expect(proxy.requests).toEqual([
        `${target}/info/refs?service=git-upload-pack`,
        proxy.redirected,
      ]);
      proxy.requests.length = 0;
      const cleared = await f.run(
        policy.prepare(
          source,
          { isOperator: false },
          { remote: source, direction: "read", repositoryPath: f.repositoryPath, env },
        ),
      );
      expect(cleared.urls).toEqual([target]);
      await transport(["ls-remote", source], f.repositoryPath, cleared.pinnedEnv(noSignerGitEnv()));
      expect(proxy.requests).toEqual([`${target}/info/refs?service=git-upload-pack`]);
      expect(
        await f.run(
          resolveGitRemote({
            remote: target,
            direction: "read",
            repositoryPath: f.repositoryPath,
            env,
          }),
        ),
      ).toEqual([other]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("reads every named pushurl and refuses tenant ambiguity without changing operator config", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      f.git("config", "remote.origin.url", source);
      for (const url of [target, other]) f.git("config", "--add", "remote.origin.pushurl", url);
      const operation = {
        remote: "origin",
        direction: "push" as const,
        repositoryPath: f.repositoryPath,
        env: { ...f.env, ...proxy.env },
      };
      expect(await f.run(resolveGitRemote(operation))).toEqual([target, other]);
      const tenant = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
      });
      const refused = await f.run(
        tenant.prepare(source, { isOperator: false }, operation).pipe(Effect.flip),
      );
      expect(refused._tag).toBe("SourceRefused");
      const operator = makeSourcePolicy({
        profile: "operator",
        allowedHosts: [],
        resolve: async () => [],
      });
      const cleared = await f.run(operator.prepare(source, { isOperator: true }, operation));
      const authentication = {
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        SSH_AUTH_SOCK: "/synthetic/agent",
      };
      expect(cleared.urls).toEqual([target, other]);
      expect(cleared.pinnedEnv(authentication)).toEqual({ ...operation.env, ...authentication });
      await transport(
        ["push", "--dry-run", "origin", "HEAD:refs/heads/probe"],
        f.repositoryPath,
        cleared.pinnedEnv(authentication),
      );
      // This recorder returns404, so Git aborts at the first destination. Reorder the fixture
      // and resolve it again to prove each first destination agrees with actual transport.
      expect(proxy.requests).toEqual([`${target}/info/refs?service=git-receive-pack`]);
      proxy.requests.length = 0;
      f.git("config", "--unset-all", "remote.origin.pushurl");
      for (const url of [other, target]) f.git("config", "--add", "remote.origin.pushurl", url);
      const reordered = await f.run(operator.prepare(source, { isOperator: true }, operation));
      expect(reordered.urls).toEqual([other, target]);
      await transport(
        ["push", "--dry-run", "origin", "HEAD:refs/heads/probe"],
        f.repositoryPath,
        reordered.pinnedEnv(authentication),
      );
      expect(proxy.requests).toEqual([`${other}/info/refs?service=git-receive-pack`]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("composes captured command rules before resolution and preserves explicit resets", async () => {
    const f = await fixture();
    const proxy = await recorder();
    try {
      const policy = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
        gitConfig: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${target}.insteadOf`,
          GIT_CONFIG_VALUE_0: source,
          GIT_CONFIG_PARAMETERS: `'http.proxy'='${proxy.env.GIT_CONFIG_VALUE_0}'`,
        },
      });
      const { GIT_CONFIG_COUNT: _count, GIT_CONFIG_PARAMETERS: _parameters, ...env } = f.env;
      const prepared = await f.run(
        policy.prepare(
          source,
          { isOperator: false },
          { remote: source, direction: "read", repositoryPath: f.repositoryPath, env },
        ),
      );
      expect(prepared.urls).toEqual([target]);
      const pinned = prepared.pinnedEnv({
        ...noSignerGitEnv(),
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: `'url.${other}.insteadOf'='${source}'`,
      });
      await transport(["ls-remote", source], f.repositoryPath, pinned);
      expect(proxy.requests).toEqual([`${target}/info/refs?service=git-upload-pack`]);
      const reset = await f.run(
        policy.prepare(
          source,
          { isOperator: false },
          { remote: source, direction: "read", repositoryPath: f.repositoryPath, env: f.env },
        ),
      );
      expect(reset.urls).toEqual([source]);
    } finally {
      await proxy.close();
      await f.close();
    }
  });

  it("pins only the rewritten SSH host with SSH's first-option semantics", async () => {
    const f = await fixture();
    try {
      const original = "ssh://git@source.invalid/repo";
      const rewritten = "ssh://git@target.invalid/repo";
      await writeFile(f.global, `[url "${rewritten}"]\n insteadOf = ${original}\n`);
      const policy = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async (host) => (host === "source.invalid" ? ["140.82.112.3"] : ["140.82.114.3"]),
      });
      const prepared = await f.run(
        policy.prepare(
          original,
          { isOperator: false },
          { remote: original, direction: "read", repositoryPath: f.repositoryPath, env: f.env },
        ),
      );
      const pinned = prepared.pinnedEnv({ GIT_SSH_COMMAND: "ssh -F /dev/null" });
      const resolved = execFileSync(
        "sh",
        ["-c", `${pinned["GIT_SSH_COMMAND"]} -T -G target.invalid`],
        { env: f.env, encoding: "utf8" },
      );
      expect(resolved.split("\n")).toContain("hostname 140.82.114.3");
      expect(resolved.split("\n")).toContain("hostkeyalias target.invalid");
      expect(pinned["GIT_SSH_COMMAND"]).not.toContain("140.82.112.3");
    } finally {
      await f.close();
    }
  });

  it("refuses a failed configuration probe without exposing its text", async () => {
    const f = await fixture();
    try {
      await writeFile(f.global, '[url "PrivateSyntheticToken\n');
      const failure = await f.run(
        resolveGitRemote({
          remote: source,
          direction: "push",
          repositoryPath: f.repositoryPath,
          env: f.env,
        }).pipe(Effect.flip),
      );
      expect(failure._tag).toBe("GitRemoteResolutionError");
      expect(JSON.stringify(failure)).not.toContain("PrivateSyntheticToken");
      const policy = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
      });
      const refused = await f.run(
        policy
          .prepare(
            source,
            { isOperator: false },
            { remote: source, direction: "read", repositoryPath: f.repositoryPath, env: f.env },
          )
          .pipe(Effect.flip),
      );
      expect(refused._tag).toBe("SourceRefused");
      expect(JSON.stringify(refused)).not.toContain("PrivateSyntheticToken");
    } finally {
      await f.close();
    }
  });

  it.each([
    "http://127.0.0.1/repo",
    "http://169.254.169.254/repo",
    "http://user:PrivateSyntheticToken@140.82.114.3/repo",
  ])("refuses an unchecked rewrite without publishing raw config: %s", async (rewrite) => {
    const f = await fixture();
    try {
      await writeFile(f.global, `[url "${rewrite}"]\n insteadOf = ${source}\n`);
      const policy = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
      });
      const refused = await f.run(
        policy
          .prepare(
            source,
            { isOperator: false },
            { remote: source, direction: "read", repositoryPath: f.repositoryPath, env: f.env },
          )
          .pipe(Effect.flip),
      );
      expect(refused._tag).toBe("SourceRefused");
      expect(JSON.stringify(refused)).not.toContain("PrivateSyntheticToken");
      expect(JSON.stringify(refused)).not.toContain(rewrite);
    } finally {
      await f.close();
    }
  });
});
