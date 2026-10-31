import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { dopplerImports, parseDopplerLocalConfig } from "./doppler.ts";
import { mainTestFixtures } from "./main-test-fixtures.ts";

const { startCli, startFakeMend, json, spawning } = mainTestFixtures();

describe("Doppler local import", () => {
  it("reads real YAML dotted keys, inherited scopes and write-only tokens", () => {
    const local = parseDopplerLocalConfig(
      "scoped:\n  /:\n    token: dp.ct.fake-canary\n  /repo:\n    enclave.project: backend\n    enclave.config: dev\n  /repo/child:\n    enclave.config: dev_me\n",
      "/repo/child",
    );
    expect(Redacted.value(local.token)).toBe("dp.ct.fake-canary");
    expect(JSON.stringify(local)).not.toContain("dp.ct.fake-canary");
    expect(local.scopes).toContainEqual({
      directory: "/repo/child",
      dopplerProject: "backend",
      config: "dev_me",
    });
    expect(() => parseDopplerLocalConfig('scoped: {"/": {token: secret-uuid}}', "/repo")).toThrow(
      "Run doppler login",
    );
    expect(() => parseDopplerLocalConfig("[token: [canary", "/repo")).toThrow("could not be read");
  });

  it("maps a laptop scope to an adopted project by Git remote across HTTPS/SSH forms", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-doppler-import-"));
    try {
      execFileSync("git", ["init", root], { stdio: "ignore" });
      execFileSync("git", [
        "-C",
        root,
        "remote",
        "add",
        "origin",
        "git@github.com:sealant-sh/mend.git",
      ]);
      const local = parseDopplerLocalConfig(
        JSON.stringify({
          scoped: {
            "/": { token: "fake-token" },
            [root]: { "enclave.project": "backend", "enclave.config": "dev_me" },
          },
        }),
        root,
      );
      expect(
        dopplerImports(local, [
          {
            id: "p1",
            name: "Mend",
            originUrl: "https://github.com/sealant-sh/mend.git",
            storePath: "/unrelated/server/path",
          },
        ]),
      ).toEqual([{ projectId: "p1", dopplerProject: "backend", config: "dev_me" }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mend doppler", spawning, () => {
  it("connects through a keyring-resolving local CLI, imports mappings, uses and disconnects without printing credentials", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-doppler-cli-"));
    const repo = path.join(root, "repo"),
      bin = path.join(root, "bin"),
      home = path.join(root, "home");
    fs.mkdirSync(repo);
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(home, ".doppler"), { recursive: true });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/sealant-sh/mend.git",
    ]);
    fs.writeFileSync(
      path.join(home, ".doppler/.doppler.yaml"),
      'scoped: {"/": {token: secret-fake-keyring-reference}}',
    );
    const scopes = {
      "/": { token: "dp.ct.resolved-fake-canary" },
      [repo]: { "enclave.project": "backend", "enclave.config": "dev_me" },
    };
    fs.writeFileSync(
      path.join(bin, "doppler"),
      `#!/bin/sh\nprintf '%s' '${JSON.stringify(scopes)}'\n`,
      { mode: 0o755 },
    );
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fake = await startFakeMend((request, response) => {
      let text = "";
      request.on("data", (data) => (text += String(data)));
      request.on("end", () => {
        calls.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body: text ? JSON.parse(text) : null,
        });
        if (request.url === "/api/projects")
          return json(response, [
            {
              id: "p1",
              name: "Mend",
              originUrl: "git@github.com:sealant-sh/mend.git",
              storePath: "/server/path",
            },
          ]);
        if (request.method === "GET")
          return json(response, {
            connected: true,
            name: null,
            updatedAt: null,
            mappings: [{ projectName: "Mend", dopplerProject: "backend", config: "dev_me" }],
          });
        json(response, { connected: true, removed: true });
      });
    });
    try {
      const env = { HOME: home, PATH: `${bin}:${process.env["PATH"]}` };
      for (const args of [
        ["doppler", "connect"],
        ["doppler", "use", "backend", "dev_next", "--project", "Mend"],
        ["doppler", "status"],
        ["doppler", "disconnect"],
      ]) {
        const cli = startCli(fake.url, args, env, repo);
        expect((await cli.exited).code, cli.stderr()).toBe(0);
        expect(cli.stdout() + cli.stderr()).not.toContain("resolved-fake-canary");
        if (args[1] === "connect") expect(cli.stdout()).toContain("Mend · backend/dev_me");
      }
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/me/doppler",
        body: { token: "dp.ct.resolved-fake-canary" },
      });
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/me/doppler/projects/p1",
        body: { dopplerProject: "backend", config: "dev_me" },
      });
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/me/doppler/projects/p1",
        body: { dopplerProject: "backend", config: "dev_next" },
      });
      expect(fs.readFileSync(path.join(home, ".doppler/.doppler.yaml"), "utf8")).toContain(
        "secret-fake-keyring-reference",
      );
    } finally {
      await fake.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
