import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Exit, Result } from "effect";
import { describe, expect, it } from "vitest";

import { classifyAddress, makeSourcePolicy, type SourceProfile } from "../src/source-policy.ts";

describe("classifyAddress", () => {
  it("tells public addresses from private, loopback, link-local and metadata ones", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["140.82.112.3", "public"],
      ["10.0.0.5", "private"],
      ["100.100.1.2", "private"],
      ["172.20.0.1", "private"],
      ["192.168.1.20", "private"],
      ["127.0.0.1", "loopback"],
      ["127.0.0.2", "loopback"],
      ["169.254.10.1", "link-local"],
      ["169.254.169.254", "metadata"],
      ["2606:50c0:8000::153", "public"],
      ["::1", "loopback"],
      ["fe80::1", "link-local"],
      ["fd12:3456::1", "private"],
      ["fd00:ec2::254", "metadata"],
      ["::ffff:10.0.0.5", "private"],
      ["::ffff:169.254.169.254", "metadata"],
      ["::", "private"],
    ];
    expect(cases.map(([address]) => [address, classifyAddress(address)])).toEqual(cases);
  });
});

const names: Record<string, ReadonlyArray<string>> = {
  "github.com": ["140.82.112.3"],
  "git.lan": ["10.0.0.5"],
  "rebind.example": ["140.82.112.3", "127.0.0.1"],
};

const policy = (profile: SourceProfile, allowedHosts: ReadonlyArray<string> = []) =>
  makeSourcePolicy({
    profile,
    allowedHosts,
    resolve: async (host) => {
      const answer = names[host];
      if (answer === undefined) throw new Error("no such host");
      return answer;
    },
  });

const outcome = (
  profile: SourceProfile,
  source: string,
  options: { readonly operator?: boolean; readonly allowed?: ReadonlyArray<string> } = {},
) =>
  Effect.runPromise(
    policy(profile, options.allowed)
      .check(source, { isOperator: options.operator ?? false })
      .pipe(
        Effect.exit,
        Effect.map((exit) => (Exit.isSuccess(exit) ? "allowed" : "refused")),
      ),
  );

describe("the source policy", () => {
  it("lets both profiles reach public hosts, and neither the metadata service or local paths", async () => {
    for (const profile of ["operator", "tenant"] as const) {
      expect(await outcome(profile, "git@github.com:acme/api.git")).toBe("allowed");
      expect(
        await outcome(profile, "https://169.254.169.254/latest/x.git", { operator: true }),
      ).toBe("refused");
      expect(
        await outcome(profile, "http://metadata.google.internal/x.git", { operator: true }),
      ).toBe("refused");
      expect(await outcome(profile, "file:///etc/x.git", { operator: true })).toBe("refused");
      expect(await outcome(profile, "/srv/git/api.git", { operator: true })).toBe("refused");
    }
  });

  it("operator profile: private networks for everyone, this machine for the operator only", async () => {
    expect(await outcome("operator", "ssh://git@git.lan/acme/api.git")).toBe("allowed");
    expect(await outcome("operator", "http://localhost/acme/api.git")).toBe("refused");
    expect(await outcome("operator", "http://localhost/acme/api.git", { operator: true })).toBe(
      "allowed",
    );
  });

  it("tenant profile: no private, local or unauthenticated remotes unless a private host is allowed", async () => {
    expect(await outcome("tenant", "ssh://git@git.lan/acme/api.git")).toBe("refused");
    expect(
      await outcome("tenant", "ssh://git@git.lan/acme/api.git", { allowed: ["git.lan"] }),
    ).toBe("allowed");
    expect(
      await outcome("tenant", "https://10.0.0.5/acme/api.git", { allowed: ["10.0.0.0/8"] }),
    ).toBe("allowed");
    expect(
      await outcome("tenant", "https://[::1]/acme/api.git", {
        operator: true,
        allowed: ["::1/128"],
      }),
    ).toBe("refused");
    expect(await outcome("tenant", "git://github.com/acme/api.git")).toBe("refused");
    // A name that answers with any local address is refused, whatever else it answers.
    expect(await outcome("tenant", "https://rebind.example/acme/api.git")).toBe("refused");
    expect(await outcome("tenant", "https://nowhere.example/acme/api.git")).toBe("refused");
    expect(await outcome("tenant", "https://127.0.0.2/acme/api.git")).toBe("refused");
  });

  it("refuses a host that is neither a DNS name nor an IP literal, before it reaches ssh", async () => {
    for (const profile of ["operator", "tenant"] as const) {
      for (const source of [
        "ssh://git@a$(id).evil.com/acme/api.git",
        "ssh://git@a`id`.evil.com/acme/api.git",
        "ssh://git@a;id.evil.com/acme/api.git",
      ]) {
        expect(await outcome(profile, source, { operator: true })).toBe("refused");
      }
    }
  });

  it("never names the addresses a host resolved to", async () => {
    const exit = await Effect.runPromise(
      policy("tenant")
        .check("ssh://git@git.lan/acme/api.git", { isOperator: false })
        .pipe(Effect.exit),
    );
    expect(JSON.stringify(exit)).not.toContain("10.0.0.5");
  });
});

const clearance = (
  scheme: "https" | "ssh",
  host: string,
  port: number | null,
  address: string,
) => ({
  source: `${scheme}://${host}${port === null ? "" : `:${port}`}/repo.git`,
  scheme,
  host,
  port,
  addresses: [address],
});

describe("pinning a checked remote (DNS rebinding)", () => {
  it.each([
    "http://140.82.112.3/acme/api.git",
    "https://140.82.112.3:8443/acme/api.git",
    "http://[2606:50c0:8000::153]:8080/acme/api.git",
    "https://[2606:50c0:8000::153]/acme/api.git",
  ])(
    "tenant: blocks redirects from an IP literal without adding DNS configuration: %s",
    async (source) => {
      const tenant = policy("tenant");
      const checked = await Effect.runPromise(tenant.check(source, { isOperator: false }));
      const env = {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "/a/repository",
        GIT_CONFIG_KEY_1: "http.followRedirects",
        GIT_CONFIG_VALUE_1: "true",
      };
      expect(tenant.pinnedEnv(checked, env)).toEqual({
        ...env,
        GIT_CONFIG_COUNT: "4",
        GIT_CONFIG_PARAMETERS: `'http.followRedirects'='false' 'http.${source}.followRedirects'='false'`,
        GIT_CONFIG_KEY_2: "http.followRedirects",
        GIT_CONFIG_VALUE_2: "false",
        GIT_CONFIG_KEY_3: `http.${source}.followRedirects`,
        GIT_CONFIG_VALUE_3: "false",
      });
      expect(env.GIT_CONFIG_COUNT).toBe("2");
      expect(policy("operator").pinnedEnv(checked, env)).toEqual(env);
    },
  );

  it("tenant: an allowed private IP still cannot redirect to an unchecked destination", async () => {
    const tenant = policy("tenant", ["10.0.0.0/8"]);
    const checked = await Effect.runPromise(
      tenant.check("https://10.0.0.5/acme/api.git", { isOperator: false }),
    );
    expect(tenant.pinnedEnv(checked, {})).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_PARAMETERS:
        "'http.followRedirects'='false' 'http.https://10.0.0.5/acme/api.git.followRedirects'='false'",
      GIT_CONFIG_KEY_0: "http.followRedirects",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "http.https://10.0.0.5/acme/api.git.followRedirects",
      GIT_CONFIG_VALUE_1: "false",
    });
  });

  it.each(["140.82.112.3", "[2606:50c0:8000::153]"])(
    "tenant: SSH to the checked IP %s keeps its existing command",
    async (host) => {
      const tenant = policy("tenant");
      const checked = await Effect.runPromise(
        tenant.check(`ssh://git@${host}/acme/api.git`, { isOperator: false }),
      );
      const env = { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -i /identity" };
      expect(tenant.pinnedEnv(checked, env)).toEqual(env);
    },
  );

  it.each([
    { host: "140.82.112.3", override: "generic" },
    { host: "140.82.112.3", override: "generic", path: "/acme/a=b.git" },
    { host: "[2606:50c0:8000::153]", override: "generic" },
    { host: "140.82.112.3", override: "env-parent" },
    { host: "[2606:50c0:8000::153]", override: "env-exact" },
    { host: "github.com", override: "env-exact" },
    { host: "140.82.112.3", override: "global-parent" },
    { host: "github.com", override: "global-exact" },
    { host: "140.82.112.3", override: "parameters-exact" },
    { host: "[2606:50c0:8000::153]", override: "parameters-exact", path: "/acme/a'!$().git" },
  ])(
    "tenant: real Git refuses a redirect from $host with $override settings",
    async ({ host, override, path = "/acme/api.git" }) => {
      const home = await mkdtemp(join(tmpdir(), "mend-source-redirect-"));
      const requests: Array<string> = [];
      const target = "http://127.0.0.1:1/unchecked.git/info/refs?service=git-upload-pack";
      // This recording proxy never forwards traffic. Both source and target requests stay local.
      const proxy = createServer((request, response) => {
        requests.push(request.url ?? "");
        if (request.url === target) response.writeHead(404).end();
        else response.writeHead(302, { Location: target }).end();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          proxy.once("error", reject);
          proxy.listen(0, "127.0.0.1", resolve);
        });
        const address = proxy.address();
        if (address === null || typeof address === "string")
          throw new Error("proxy did not listen");
        const source = `http://${host}${path}`;
        const configuredUrl = override.endsWith("parent") ? `http://${host}/acme/` : source;
        const globalConfig = join(home, "gitconfig");
        await writeFile(
          globalConfig,
          override.startsWith("global")
            ? `[http "${configuredUrl}"]\n\tfollowRedirects = true\n`
            : "",
        );
        const env = {
          PATH: process.env["PATH"] ?? "",
          HOME: home,
          XDG_CONFIG_HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          NO_PROXY: "",
          no_proxy: "",
          GIT_CONFIG_COUNT: override.startsWith("env") ? "3" : "2",
          GIT_CONFIG_KEY_0: "http.proxy",
          GIT_CONFIG_VALUE_0: `http://127.0.0.1:${address.port}`,
          GIT_CONFIG_KEY_1: "http.followRedirects",
          GIT_CONFIG_VALUE_1: "true",
          GIT_CONFIG_KEY_2: `http.${configuredUrl}.followRedirects`,
          GIT_CONFIG_VALUE_2: "true",
          GIT_CONFIG_PARAMETERS:
            override === "parameters-exact"
              ? `'http.${source.replaceAll("'", "'\\''")}.followRedirects=true'`
              : "",
        };
        const tenant = policy("tenant");
        const checked = await Effect.runPromise(tenant.check(source, { isOperator: false }));
        const read = (gitEnv: Record<string, string>) =>
          new Promise<{ readonly success: boolean; readonly stderr: string }>((resolve, reject) => {
            execFile(
              "git",
              ["ls-remote", source],
              { env: gitEnv, cwd: home, timeout: 5_000 },
              (error, _out, stderr) => {
                if (error?.killed) reject(error);
                else resolve({ success: error === null, stderr });
              },
            );
          });
        // The control must actually reach the target, so a broken proxy cannot pass the refusal.
        const followed = await read(env);
        expect(followed.success).toBe(false);
        expect(requests).toEqual([`${source}/info/refs?service=git-upload-pack`, target]);
        requests.length = 0;
        const blocked = await read(tenant.pinnedEnv(checked, env));
        expect(blocked.success).toBe(false);
        expect(requests).toEqual([`${source}/info/refs?service=git-upload-pack`]);
        expect(blocked.stderr).toContain("302");
      } finally {
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("the live policy preserves ambient Git config unless the caller explicitly clears it", async () => {
    const home = await mkdtemp(join(tmpdir(), "mend-source-config-"));
    try {
      const script = `
        import { Effect } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("effect")).href)};
        import { SourcePolicy, SourcePolicyLive } from ${JSON.stringify(new URL("../src/source-policy.ts", import.meta.url).href)};
        import { noSignerGitEnv } from ${JSON.stringify(new URL("../src/git-auth.ts", import.meta.url).href)};
        import { git } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)};
        const result = await Effect.runPromise(Effect.gen(function* () {
          const policy = yield* SourcePolicy;
          const source = "https://140.82.112.3/acme/api.git";
          const checked = yield* policy.check(source, { isOperator: false });
          const pinned = policy.pinnedEnv(checked, noSignerGitEnv());
          const read = (key, env, codes) => git(["config", "--get", key], process.cwd(), env, codes);
          return {
            beforeCA: yield* read("http.sslCAInfo", noSignerGitEnv()),
            afterCA: yield* read("http.sslCAInfo", pinned),
            proxy: yield* read("http.proxy", pinned),
            redirects: yield* git(["config", "--get-urlmatch", "http.followRedirects", source], process.cwd(), pinned),
            resetCA: yield* read("http.sslCAInfo", policy.pinnedEnv(checked, { GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "" }), [1]),
          };
        }).pipe(Effect.provide(SourcePolicyLive)));
        process.stdout.write(JSON.stringify(result));
      `;
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          ["--experimental-strip-types", "--input-type=module", "--eval", script],
          {
            cwd: home,
            timeout: 5_000,
            env: {
              PATH: process.env["PATH"] ?? "",
              HOME: home,
              XDG_CONFIG_HOME: home,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.sslCAInfo",
              GIT_CONFIG_VALUE_0: "/operator/custom-ca.pem",
              GIT_CONFIG_PARAMETERS:
                "'http.proxy=http://proxy.invalid' 'http.https://140.82.112.3/acme/api.git.followRedirects=true'",
              MEND_SOURCE_POLICY: "tenant",
            },
          },
          (error, output) => {
            if (error === null) resolve(output);
            else reject(error);
          },
        );
      });
      const observed: unknown = JSON.parse(stdout);
      expect(observed).toEqual({
        beforeCA: "/operator/custom-ca.pem",
        afterCA: "/operator/custom-ca.pem",
        proxy: "http://proxy.invalid",
        redirects: "false",
        resetCA: "",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("tenant: HTTPS resolves the name to the checked address, ssh dials it and keeps the host key name", () => {
    const tenant = policy("tenant");
    expect(tenant.pinnedEnv(clearance("https", "git.acme.dev", null, "140.82.112.3"), {})).toEqual({
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_PARAMETERS:
        "'http.curloptResolve'='git.acme.dev:443:140.82.112.3' 'http.https://git.acme.dev/repo.git.curloptResolve'='git.acme.dev:443:140.82.112.3' 'http.followRedirects'='false' 'http.https://git.acme.dev/repo.git.followRedirects'='false'",
      GIT_CONFIG_KEY_0: "http.curloptResolve",
      GIT_CONFIG_VALUE_0: "git.acme.dev:443:140.82.112.3",
      GIT_CONFIG_KEY_1: "http.followRedirects",
      GIT_CONFIG_VALUE_1: "false",
      GIT_CONFIG_KEY_2: "http.https://git.acme.dev/repo.git.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
    });
    expect(
      tenant.pinnedEnv(clearance("https", "git.acme.dev", 8443, "2606:50c0::153"), {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: "*",
      }),
    ).toMatchObject({
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_1: "http.curloptResolve",
      GIT_CONFIG_VALUE_1: "git.acme.dev:8443:[2606:50c0::153]",
      GIT_CONFIG_KEY_2: "http.followRedirects",
      GIT_CONFIG_VALUE_2: "false",
      GIT_CONFIG_KEY_3: "http.https://git.acme.dev:8443/repo.git.followRedirects",
      GIT_CONFIG_VALUE_3: "false",
    });
    expect(
      tenant.pinnedEnv(clearance("ssh", "github.com", null, "140.82.112.3"), {
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      }),
    ).toEqual({
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o HostName=140.82.112.3 -o HostKeyAlias=github.com",
    });
  });

  it("operator: the environment stays as it is, so a team's own ssh configuration keeps working", () => {
    const env = { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };
    expect(
      policy("operator").pinnedEnv(clearance("ssh", "github.com", null, "140.82.112.3"), env),
    ).toEqual(env);
  });
});

describe("a source with a login or token", () => {
  it.each([
    "http://user:se'cret@github.com/org/repo.git",
    'https://user:"secret"@github.com/org/repo.git',
    "https://user:<secret>@github.com/org/repo.git",
    "https://oauth2:TOKEN@github.com/org/repo.git",
  ])("is refused before DNS resolution: %s", async (source) => {
    for (const profile of ["operator", "tenant"] as const) {
      const resolved: Array<string> = [];
      const sourcePolicy = makeSourcePolicy({
        profile,
        allowedHosts: [],
        resolve: async (host) => {
          resolved.push(host);
          return ["140.82.112.3"];
        },
      });
      const result = await Effect.runPromise(
        sourcePolicy.check(source, { isOperator: true }).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("SourceRefused");
      expect(resolved).toEqual([]);

      // The same policy must actually use this resolver for an ordinary repository URL.
      const checked = await Effect.runPromise(
        sourcePolicy.check("https://github.com/org/repo.git", { isOperator: true }),
      );
      expect(checked.host).toBe("github.com");
      expect(resolved).toEqual(["github.com"]);
    }
  });
});
