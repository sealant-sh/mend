import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeSourcePolicy } from "../src/source-policy.ts";

const git = (cwd: string, env: Record<string, string>, args: ReadonlyArray<string>) =>
  new Promise<{ readonly code: number | string; readonly stdout: string; readonly stderr: string }>(
    (resolve, reject) => {
      execFile("git", args, { cwd, env, timeout: 5_000 }, (error, stdout, stderr) => {
        if (error?.killed) reject(error);
        else resolve({ code: error?.code ?? 0, stdout: stdout.trim(), stderr });
      });
    },
  );

const isolatedEnv = (home: string) => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
});

it.each([
  {
    scope: "parameters",
    key: "generic",
    source: "https://git.example/repo.git",
    address: "140.82.112.3",
    pin: "git.example:443:140.82.112.3",
  },
  {
    scope: "parameters",
    key: "exact",
    source: "http://git.example:8080/repo.git",
    address: "140.82.112.3",
    pin: "git.example:8080:140.82.112.3",
  },
  {
    scope: "counted",
    key: "exact",
    source: "https://git.example:8443/repo.git",
    address: "2606:50c0::153",
    pin: "git.example:8443:[2606:50c0::153]",
  },
  {
    scope: "global",
    key: "exact",
    source: "https://git.example/repo.git",
    address: "140.82.112.3",
    pin: "git.example:443:140.82.112.3",
  },
  {
    scope: "parameters",
    key: "exact",
    source: "https://git.example/acme/a'!$().git",
    address: "2606:50c0::153",
    pin: "git.example:443:[2606:50c0::153]",
  },
])(
  "real Git uses the approved DNS pin over $scope $key configuration for $source",
  async ({ scope, key, source, address, pin }) => {
    const home = await mkdtemp(join(tmpdir(), "mend-source-dns-config-"));
    try {
      const configKey = key === "exact" ? `http.${source}.curloptResolve` : "http.curloptResolve";
      const unchecked = "git.example:443:127.0.0.1";
      await writeFile(
        join(home, "gitconfig"),
        scope === "global" ? `[http "${source}"]\n\tcurloptResolve = ${unchecked}\n` : "",
      );
      const tenant = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [address],
        gitConfig: {
          GIT_CONFIG_COUNT: scope === "counted" ? "2" : "1",
          GIT_CONFIG_KEY_0: "http.sslCAInfo",
          GIT_CONFIG_VALUE_0: "/operator/custom-ca.pem",
          GIT_CONFIG_KEY_1: configKey,
          GIT_CONFIG_VALUE_1: unchecked,
          GIT_CONFIG_PARAMETERS: [
            "'http.proxy=http://proxy.invalid'",
            ...(scope === "parameters"
              ? [`'${`${configKey}=${unchecked}`.replaceAll("'", "'\\''")}'`]
              : []),
          ].join(" "),
        },
      });
      const checked = await Effect.runPromise(tenant.check(source, { isOperator: false }));
      const env = tenant.pinnedEnv(checked, isolatedEnv(home));
      expect(
        await git(home, env, ["config", "--get-urlmatch", "http.curloptResolve", source]),
      ).toMatchObject({ code: 0, stdout: pin });
      expect(await git(home, env, ["config", "--get", "http.sslCAInfo"])).toMatchObject({
        code: 0,
        stdout: "/operator/custom-ca.pem",
      });
      expect(await git(home, env, ["config", "--get", "http.proxy"])).toMatchObject({
        code: 0,
        stdout: "http://proxy.invalid",
      });
      const reset = tenant.pinnedEnv(checked, {
        ...isolatedEnv(home),
        GIT_CONFIG_COUNT: "0",
        GIT_CONFIG_PARAMETERS: "",
      });
      expect(await git(home, reset, ["config", "--get", "http.sslCAInfo"])).toMatchObject({
        code: 1,
        stdout: "",
      });
      expect(await git(home, reset, ["config", "--get", "http.proxy"])).toMatchObject({
        code: 1,
        stdout: "",
      });
      expect(
        await git(home, reset, ["config", "--get-urlmatch", "http.curloptResolve", source]),
      ).toMatchObject({ code: 0, stdout: pin });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(["generic", "exact", "reset-then-exact"])(
  "real Git connects only to the pinned listener after %s overrides",
  async (override) => {
    const home = await mkdtemp(join(tmpdir(), "mend-source-dns-connect-"));
    const requests: Array<string> = [];
    // The supplied clearance is synthetic: tenant policy correctly refuses loopback at check().
    const listener = () =>
      createServer((request, response) => {
        requests.push(request.socket.localAddress ?? "");
        response.writeHead(404).end();
      });
    const server = listener();
    const uncheckedServer = listener();
    try {
      await writeFile(join(home, "gitconfig"), "");
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("listener did not start");
      await new Promise<void>((resolve, reject) => {
        uncheckedServer.once("error", reject);
        uncheckedServer.listen(address.port, "127.0.0.2", resolve);
      });
      const source = `http://git.example:${address.port}/repo.git`;
      const key = override === "generic" ? "http.curloptResolve" : `http.${source}.curloptResolve`;
      const env = {
        ...isolatedEnv(home),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.proxy",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_PARAMETERS: [
          ...(override === "reset-then-exact"
            ? [`'${key}='`, `'${key}=-git.example:${address.port}'`]
            : []),
          `'${key}=git.example:${address.port}:127.0.0.2'`,
        ].join(" "),
      };
      const control = await git(home, env, ["ls-remote", source]);
      expect(control.code).not.toBe(0);
      expect(requests).toEqual(["127.0.0.2"]);
      requests.length = 0;
      const tenant = makeSourcePolicy({
        profile: "tenant",
        allowedHosts: [],
        resolve: async () => [],
      });
      const pinned = tenant.pinnedEnv(
        {
          source,
          scheme: "http",
          host: "git.example",
          port: address.port,
          addresses: ["127.0.0.1"],
        },
        env,
      );
      const result = await git(home, pinned, ["ls-remote", source]);
      expect(result.code).not.toBe(0);
      expect(requests).toEqual(["127.0.0.1"]);
      expect(result.stderr).toContain("not found");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => uncheckedServer.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    }
  },
);
