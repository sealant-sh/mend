import { execFile, execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RepositoryCloneUrl } from "@mend/domain/workbench";
import { Effect, Layer, Scope, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { AgentBridge } from "../src/agent-bridge.ts";
import { MendKeys, noSignerGitEnv } from "../src/git-auth.ts";
import { resolveRemoteEnvForUrls } from "../src/remote-env.ts";
import { preparedRemoteEnvironment, gitRemoteEnvironment } from "../src/remote-operation-env.ts";
import { makeSourcePolicy } from "../src/source-policy.ts";
import { Store, StoreConfig } from "../src/store.ts";

const source = "http://140.82.112.3/source.git";
const target = "http://140.82.114.3/target.git";

const fixture = async () => {
  const scope = Effect.runSync(Scope.make());
  const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Effect.provideService(effect, Scope.Scope, scope));
  const home = await mkdtemp(join(tmpdir(), "mend-clone-source-test-"));
  const cwd = join(home, "caller");
  const global = join(home, "global");
  const destinationPath = join(home, "actual-destination");
  await writeFile(global, "");
  const requests: string[] = [];
  const proxy = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("no recorder");
  const env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.proxy",
    GIT_CONFIG_VALUE_0: `http://127.0.0.1:${address.port}`,
    GIT_CONFIG_PARAMETERS: "",
    NO_PROXY: "",
    no_proxy: "",
    GIT_TERMINAL_PROMPT: "0",
  };
  execFileSync("git", ["init", "-q", "--template=", cwd], { env });
  execFileSync("git", ["-C", cwd, "config", `url.${target}.insteadOf`, source], { env });
  const clone = (gitEnv: Record<string, string>, cloneKind: "bare" | "checkout" = "bare") =>
    new Promise<void>((resolve, reject) =>
      execFile(
        "git",
        ["clone", ...(cloneKind === "bare" ? ["--bare"] : []), "--", source, destinationPath],
        { cwd, env: gitEnv, timeout: 5_000 },
        (error) => {
          if (error?.killed) reject(error);
          else resolve();
        },
      ),
    );
  return {
    home,
    cwd,
    global,
    destinationPath,
    env,
    requests,
    clone,
    run,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
};

const policy = () =>
  makeSourcePolicy({ profile: "tenant", allowedHosts: [], resolve: async () => ["140.82.114.3"] });
const missing = async (path: string) =>
  access(path).then(
    () => false,
    () => true,
  );

describe("Git clone source preparation", () => {
  it.each([false, true])(
    "a successful real Store clone binds its empty or regular custom template: %s",
    async (configured) => {
      const f = await fixture();
      const reserved = createTcpServer();
      await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
      const address = reserved.address();
      if (address === null || typeof address === "string") throw new Error("No fixture port.");
      const port = address.port;
      await new Promise<void>((resolve, reject) => {
        reserved.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      const daemon = spawn(
        "git",
        [
          "daemon",
          "--reuseaddr",
          "--export-all",
          `--base-path=${f.home}`,
          "--listen=127.0.0.1",
          `--port=${port}`,
        ],
        { stdio: "ignore" },
      );
      let snapshot: string | undefined;
      try {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const ready = await new Promise<boolean>((resolve) => {
            // A Git request itself establishes readiness on the owned daemon.
            execFile(
              "git",
              ["ls-remote", `git://127.0.0.1:${port}/caller`],
              { env: f.env, timeout: 1000 },
              (error) => resolve(error === null),
            );
          });
          if (ready) break;
          if (attempt === 49) throw new Error("Owned Git daemon did not listen.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const run = (...args: string[]) =>
          execFileSync("git", [...args], {
            cwd: f.cwd,
            env: {
              ...f.env,
              GIT_AUTHOR_NAME: "synthetic",
              GIT_AUTHOR_EMAIL: "synthetic@invalid",
              GIT_COMMITTER_NAME: "synthetic",
              GIT_COMMITTER_EMAIL: "synthetic@invalid",
            },
            encoding: "utf8",
          }).trim();
        const tree = run("hash-object", "-t", "tree", "--stdin");
        const head = run("commit-tree", tree, "-m", "fixture");
        run("update-ref", "refs/heads/main", head);
        run("symbolic-ref", "HEAD", "refs/heads/main");
        const template = join(f.home, "success-template");
        await mkdir(join(template, "hooks"), { recursive: true });
        await writeFile(join(template, "config"), "[core]\n quotePath = false\n");
        const hook = "#!/bin/sh\nexit 0\n";
        await writeFile(join(template, "hooks/post-checkout"), hook, { mode: 0o755 });
        const cloneSource = RepositoryCloneUrl.make(`git://127.0.0.1:${port}/caller`);
        const storeRoot = join(f.home, "store");
        const cloned = await f.run(
          Effect.gen(function* () {
            const provider = yield* preparedRemoteEnvironment({
              policy: makeSourcePolicy({
                profile: "operator",
                allowedHosts: [],
                resolve: async () => [],
              }),
              source: cloneSource,
              actor: { isOperator: true },
              mode: "bridge",
              userId: "owner",
              env: { ...f.env, ...(configured ? { GIT_TEMPLATE_DIR: template } : {}) },
            });
            return yield* (yield* Store).adopt("success", cloneSource, (operation) =>
              gitRemoteEnvironment(provider, operation).pipe(
                Effect.tap((env) =>
                  Effect.sync(() => {
                    snapshot = env["GIT_TEMPLATE_DIR"];
                    expect(snapshot).toBeDefined();
                    expect(snapshot).not.toBe(template);
                    if (!configured) expect(snapshot).toBe("");
                  }),
                ),
              ),
            );
          }).pipe(
            Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot)))),
            Effect.provide(
              Layer.mergeAll(
                Layer.mock(MendKeys, {}),
                Layer.mock(AgentBridge, { socketPath: () => "/unused/socket" }),
              ),
            ),
          ),
        );
        expect(cloned.headSha).toBe(head);
        if (configured) {
          expect(
            execFileSync("git", ["-C", cloned.storePath, "config", "core.quotePath"], {
              env: f.env,
              encoding: "utf8",
            }).trim(),
          ).toBe("false");
          expect(await readFile(join(cloned.storePath, "hooks/post-checkout"), "utf8")).toBe(hook);
          // Mend's shared-store permission policy adds group read/write to Git's copied 0755 file.
          expect((await stat(join(cloned.storePath, "hooks/post-checkout"))).mode & 0o777).toBe(
            0o775,
          );
        } else {
          expect(await missing(join(cloned.storePath, "hooks"))).toBe(true);
        }
        expect(await missing(snapshot ?? "")).toBe(true);
        expect(await readFile(join(template, "config"), "utf8")).toBe(
          "[core]\n quotePath = false\n",
        );
      } finally {
        if (daemon.exitCode === null && daemon.signalCode === null)
          await new Promise<void>((resolve) => {
            daemon.once("close", resolve);
            daemon.kill("SIGKILL");
          });
        await f.close();
      }
    },
  );

  it.each(["bare", "checkout"] as const)(
    "ignores caller local rules for an actual %s clone",
    async (cloneKind) => {
      const f = await fixture();
      try {
        const operation = {
          direction: "clone" as const,
          remote: source,
          cwd: f.cwd,
          destinationPath: f.destinationPath,
          cloneKind,
          env: f.env,
        };
        const prepared = await f.run(policy().prepare(source, { isOperator: false }, operation));
        expect(prepared.urls).toEqual([source]);
        expect(prepared.pinnedEnv(noSignerGitEnv())["GIT_TEMPLATE_DIR"]).toBe("");
        expect(await missing(f.destinationPath)).toBe(true);
        await f.clone(prepared.pinnedEnv(noSignerGitEnv()), cloneKind);
        expect(f.requests).toEqual([`${source}/info/refs?service=git-upload-pack`]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["global", "system", "counted", "parameters", "reset"])(
    "matches actual clone with %s configuration",
    async (scope) => {
      const f = await fixture();
      try {
        const config = `[url "${target}"]\n insteadOf = ${source}\n[url "http://140.82.116.3/other.git"]\n insteadOf = ${target}\n`;
        let env: Record<string, string> = { ...f.env };
        if (scope === "global" || scope === "reset") await writeFile(f.global, config);
        if (scope === "system") {
          const system = join(f.home, "system");
          await writeFile(system, config);
          env = { ...env, GIT_CONFIG_NOSYSTEM: "0", GIT_CONFIG_SYSTEM: system };
        }
        if (scope === "counted")
          env = {
            ...env,
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_1: `url.${target}.insteadOf`,
            GIT_CONFIG_VALUE_1: source,
          };
        if (scope === "parameters")
          env = { ...env, GIT_CONFIG_PARAMETERS: `'url.${target}.insteadOf'='${source}'` };
        if (scope === "reset")
          env = {
            ...env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_COUNT: "0",
            GIT_CONFIG_PARAMETERS: "",
            http_proxy: f.env.GIT_CONFIG_VALUE_0,
          };
        const prepared = await f.run(
          policy().prepare(
            source,
            { isOperator: false },
            {
              direction: "clone",
              remote: source,
              cwd: f.cwd,
              destinationPath: f.destinationPath,
              cloneKind: "bare",
              env,
            },
          ),
        );
        const effective = scope === "reset" ? source : target;
        expect(prepared.urls).toEqual([effective]);
        expect(await missing(f.destinationPath)).toBe(true);
        await f.clone(prepared.pinnedEnv(noSignerGitEnv()));
        expect(f.requests).toEqual([`${effective}/info/refs?service=git-upload-pack`]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["GIT_DIR", "GIT_WORK_TREE"])(
    "refuses unsupported %s even though actual clone ignores caller rules",
    async (name) => {
      const f = await fixture();
      try {
        const env = { ...f.env, [name]: name === "GIT_DIR" ? join(f.cwd, ".git") : f.cwd };
        const refused = await f.run(
          policy()
            .prepare(
              source,
              { isOperator: false },
              {
                direction: "clone",
                remote: source,
                cwd: f.cwd,
                destinationPath: f.destinationPath,
                cloneKind: "bare",
                env,
              },
            )
            .pipe(Effect.flip),
        );
        expect(refused._tag).toBe("SourceRefused");
        expect(refused.message).toContain("location overrides");
        expect(await missing(f.destinationPath)).toBe(true);
        expect(f.requests).toEqual([]);
        await f.clone(env);
        expect(f.requests).toEqual([`${source}/info/refs?service=git-upload-pack`]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["direct", "nested"])(
    "refuses %s destination conditional includes that actual clone follows",
    async (scope) => {
      const f = await fixture();
      try {
        const rule = join(f.home, "rule");
        await writeFile(rule, `[url "${target}"]\n insteadOf = ${source}\n`);
        const conditional = `[includeIf "gitdir:${f.destinationPath}"]\n path = ${rule}\n`;
        if (scope === "direct") await writeFile(f.global, conditional);
        else {
          const outer = join(f.home, "outer");
          await writeFile(outer, conditional);
          await writeFile(f.global, `[include]\n path = ${outer}\n`);
        }
        const refusal = await f.run(
          policy()
            .prepare(
              source,
              { isOperator: false },
              {
                direction: "clone",
                remote: source,
                cwd: f.cwd,
                destinationPath: f.destinationPath,
                cloneKind: "bare",
                env: f.env,
              },
            )
            .pipe(Effect.flip),
        );
        expect(refusal.message).toContain("conditional includes");
        expect(f.requests).toEqual([]);
        expect(await missing(f.destinationPath)).toBe(true);
        await f.clone(f.env);
        expect(f.requests).toEqual([`${target}/info/refs?service=git-upload-pack`]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["url", "nested-include", "remote"])(
    "refuses template %s configuration before clone transport",
    async (scope) => {
      const f = await fixture();
      try {
        const template = join(f.home, "template");
        await mkdir(template);
        let configuration = `[url "${target}"]\n insteadOf = ${source}\n`;
        if (scope === "nested-include") {
          const inner = join(f.home, "inner");
          const outer = join(f.home, "outer");
          await writeFile(inner, configuration);
          await writeFile(outer, `[include]\n path = ${inner}\n`);
          configuration = `[include]\n path = ${outer}\n`;
        }
        if (scope === "remote") configuration = `[remote "origin"]\n url = ${target}\n`;
        await writeFile(join(template, "config"), configuration);
        const env = { ...f.env, GIT_TEMPLATE_DIR: template };
        const refusal = await f.run(
          policy()
            .prepare(
              source,
              { isOperator: false },
              {
                direction: "clone",
                remote: source,
                cwd: f.cwd,
                destinationPath: f.destinationPath,
                cloneKind: "bare",
                env,
              },
            )
            .pipe(Effect.flip),
        );
        expect(refusal.message).toContain("URL, include or remote settings");
        expect(f.requests).toEqual([]);
        expect(await missing(f.destinationPath)).toBe(true);
        await f.clone(env);
        // Remote defaults are conservatively unsupported even where clone replaces them itself.
        expect(f.requests).toEqual([
          `${scope === "remote" ? source : target}/info/refs?service=git-upload-pack`,
        ]);
      } finally {
        await f.close();
      }
    },
  );

  it("retains an ordinary custom template without executing its hooks during preparation", async () => {
    const f = await fixture();
    try {
      const template = join(f.home, "ordinary-template");
      await mkdir(join(template, "hooks"), { recursive: true });
      await writeFile(join(template, "config"), "[core]\n quotePath = false\n");
      const marker = join(f.home, "hook-ran");
      await writeFile(
        join(template, "hooks/post-checkout"),
        `#!/bin/sh\necho ran > '${marker}'\n`,
        { mode: 0o755 },
      );
      const env = { ...f.env, GIT_TEMPLATE_DIR: template };
      const prepared = await f.run(
        policy().prepare(
          source,
          { isOperator: false },
          {
            direction: "clone",
            remote: source,
            cwd: f.cwd,
            destinationPath: f.destinationPath,
            cloneKind: "checkout",
            env,
          },
        ),
      );
      expect(prepared.urls).toEqual([source]);
      expect(await missing(marker)).toBe(true);
      expect(await missing(f.destinationPath)).toBe(true);
      const bound = prepared.pinnedEnv(noSignerGitEnv())["GIT_TEMPLATE_DIR"];
      expect(bound).toBeDefined();
      expect(bound).not.toBe(template);
      expect(await readFile(join(bound ?? "", "config"), "utf8")).toBe(
        "[core]\n quotePath = false\n",
      );
      expect((await stat(join(bound ?? "", "hooks/post-checkout"))).mode & 0o111).toBe(0o111);
      await f.clone(prepared.pinnedEnv(noSignerGitEnv()), "checkout");
      expect(f.requests).toEqual([`${source}/info/refs?service=git-upload-pack`]);
      expect(await missing(marker)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(["config", "HEAD", "objects", "hooks/post-checkout"])(
    "refuses a custom template %s link without changing its external target",
    async (name) => {
      const f = await fixture();
      try {
        const template = join(f.home, "linked-template");
        const external = join(f.home, "external");
        await mkdir(join(template, "hooks"), { recursive: true });
        if (name === "objects") await mkdir(external);
        else await writeFile(external, "[core]\n quotePath = false\n");
        const before = name === "objects" ? null : await readFile(external);
        await symlink(external, join(template, name));
        const refusal = await f.run(
          policy()
            .prepare(
              source,
              { isOperator: false },
              {
                direction: "clone",
                remote: source,
                env: { ...f.env, GIT_TEMPLATE_DIR: template },
                cwd: f.cwd,
                destinationPath: f.destinationPath,
                cloneKind: "bare",
              },
            )
            .pipe(Effect.flip),
        );
        expect(refusal.message).toContain("template links");
        if (before !== null) expect(await readFile(external)).toEqual(before);
        else
          expect(
            await access(join(external, "info")).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        expect(f.requests).toEqual([]);
        expect(await missing(f.destinationPath)).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("uses Git's configured template path and removes its bound snapshot only after the operation scope", async () => {
    const f = await fixture();
    let snapshot: string | undefined;
    try {
      const template = join(f.home, "configured-template");
      await mkdir(template);
      await writeFile(join(template, "config"), "[core]\n quotePath = false\n");
      execFileSync("git", ["config", "--file", f.global, "init.templateDir", template], {
        env: f.env,
      });
      const prepared = await f.run(
        policy().prepare(
          source,
          { isOperator: false },
          {
            direction: "clone",
            remote: source,
            env: f.env,
            cwd: f.cwd,
            destinationPath: f.destinationPath,
            cloneKind: "checkout",
          },
        ),
      );
      const env = prepared.pinnedEnv(noSignerGitEnv());
      snapshot = env["GIT_TEMPLATE_DIR"];
      expect(snapshot).toBeDefined();
      expect(snapshot).not.toBe(template);
      expect(await readFile(join(snapshot ?? "", "config"), "utf8")).toBe(
        "[core]\n quotePath = false\n",
      );
      await f.clone(env, "checkout");
      expect(f.requests).toEqual([`${source}/info/refs?service=git-upload-pack`]);
      expect(await missing(snapshot ?? "")).toBe(false);
    } finally {
      await f.close();
    }
    expect(await missing(snapshot ?? "")).toBe(true);
  });

  it("uses the account's signer for an authenticated rewritten clone target", async () => {
    const f = await fixture();
    try {
      const rewritten = "ssh://git@target.invalid/repo";
      await writeFile(f.global, `[url "${rewritten}"]\n insteadOf = ${source}\n`);
      const bin = join(f.home, "bin");
      await mkdir(bin);
      const capture = join(f.home, "ssh-arguments");
      await writeFile(
        join(bin, "ssh"),
        `#!/bin/sh\nprintf '%s\\n' "$@" >> '${capture}'\nexit 255\n`,
        { mode: 0o755 },
      );
      const env = { ...f.env, PATH: `${bin}:${f.env.PATH}`, GIT_SSH_VARIANT: "ssh" };
      const prepared = await f.run(
        policy().prepare(
          source,
          { isOperator: false },
          {
            direction: "clone",
            remote: source,
            cwd: f.cwd,
            destinationPath: f.destinationPath,
            cloneKind: "bare",
            env,
          },
        ),
      );
      expect(prepared.urls).toEqual([rewritten]);
      const ensured: Array<string | null> = [];
      const authentication = await f.run(
        resolveRemoteEnvForUrls("mend-key", "anna", prepared.urls).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(MendKeys, {
                ensure: (userId) =>
                  Effect.sync(() => {
                    ensured.push(userId);
                    return {
                      publicKey: "synthetic",
                      fingerprint: "synthetic",
                      privateKeyPath: join(f.home, "synthetic-key"),
                    };
                  }),
                read: () => Effect.succeed(null),
              }),
              Layer.mock(AgentBridge, {
                socketPath: () => join(f.home, "unused-socket"),
                status: () => Effect.succeed({ connected: false, clientName: null, since: null }),
              }),
            ),
          ),
        ),
      );
      await f.clone(prepared.pinnedEnv(authentication));
      const sshArguments = (await readFile(capture, "utf8")).split("\n");
      expect(ensured).toEqual(["anna"]);
      expect(sshArguments).toContain(join(f.home, "synthetic-key"));
      expect(sshArguments).toContain("HostName=140.82.114.3");
      expect(sshArguments).toContain("HostKeyAlias=target.invalid");
      expect(sshArguments).toContain("git@target.invalid");
      expect(f.requests).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("fails closed for malformed configuration without publishing private text", async () => {
    const f = await fixture();
    try {
      await writeFile(f.global, '[url "PrivateSyntheticToken\n');
      const refusal = await f.run(
        policy()
          .prepare(
            source,
            { isOperator: false },
            {
              direction: "clone",
              remote: source,
              cwd: f.cwd,
              destinationPath: f.destinationPath,
              cloneKind: "bare",
              env: f.env,
            },
          )
          .pipe(Effect.flip),
      );
      expect(refusal._tag).toBe("SourceRefused");
      expect(JSON.stringify(refusal)).not.toContain("PrivateSyntheticToken");
      expect(f.requests).toEqual([]);
      expect(await missing(f.destinationPath)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
