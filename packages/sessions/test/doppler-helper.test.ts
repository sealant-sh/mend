import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { dopplerConfigContents } from "@mend/domain/workbench";
import { afterEach, describe, expect, it } from "vitest";

import { secretFilesRemoveExec } from "../src/secret-files.ts";
import { SESSION_HELPER_SCRIPT } from "../src/session-socket.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-doppler-helper-"));
  roots.push(root);
  return root;
};

const realDoppler = process.env["MEND_TEST_DOPPLER_BINARY"];
it.skipIf(realDoppler === undefined)(
  "the real Doppler CLI reads Mend's scoped YAML with a fake token, offline",
  () => {
    if (realDoppler === undefined) return;
    const root = temp(),
      dir = path.join(root, ".doppler"),
      repo = path.join(root, "repo");
    fs.mkdirSync(dir);
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(dir, ".doppler.yaml"),
      dopplerConfigContents("dp.ct.fake-real-cli", repo, {
        dopplerProject: "backend",
        config: "dev_person",
      }),
    );
    const get = (name: string) => {
      const result = spawnSync(
        realDoppler,
        ["--config-dir", dir, "--no-check-version", "configure", "get", name, "--plain"],
        { cwd: repo, env: { HOME: root, PATH: process.env["PATH"] }, encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    expect(get("project")).toBe("backend");
    expect(get("config")).toBe("dev_person");
    expect(get("token")).toBe("dp.ct.fake-real-cli");
  },
);

describe("workspace mend doppler helper", () => {
  const fixture = async (refusal?: string) => {
    const root = temp(),
      home = path.join(root, "home"),
      bin = path.join(root, "bin"),
      repo = path.join(root, "repo");
    fs.mkdirSync(home);
    fs.mkdirSync(bin);
    fs.mkdirSync(repo);
    const script = path.join(root, "mend.cjs"),
      channelToken = path.join(home, "session-token");
    fs.writeFileSync(script, SESSION_HELPER_SCRIPT);
    fs.writeFileSync(channelToken, "fake-person-channel-token");
    const configPath = path.join(home, ".doppler/.doppler.yaml");
    const credential = "dp.ct.fake-helper-canary";
    const calls: Array<unknown> = [];
    const server = http.createServer((request, response) => {
      expect(request.headers["authorization"]).toBe("Bearer fake-person-channel-token");
      let body = "";
      request.on("data", (data) => (body += String(data)));
      request.on("end", () => {
        const input = JSON.parse(body);
        calls.push(input);
        if (refusal !== undefined) {
          response.writeHead(422, { "content-type": "application/json" });
          response.end(JSON.stringify({ message: refusal }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        if (input.action === "projects")
          return response.end(
            JSON.stringify({
              projects: [
                { id: "p1", name: "Mend", originUrl: "https://github.com/sealant-sh/mend.git" },
              ],
            }),
          );
        if (input.action === "use")
          return response.end(JSON.stringify({ ...input, current: true, projectName: "Mend" }));
        response.end(
          JSON.stringify({
            connected: true,
            removed: true,
            mappings: [{ projectName: "Mend", dopplerProject: "backend", config: "dev" }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const run = async (args: ReadonlyArray<string>, missingBinary = false) => {
      const child = spawn(process.execPath, [script, "doppler", ...args], {
        cwd: repo,
        env: {
          HOME: home,
          PATH: missingBinary ? path.join(root, "empty-bin") : `${bin}:${process.env["PATH"]}`,
          MEND_SESSION_TOKEN_FILE: channelToken,
          MEND_SESSION_ID: "session1",
          MEND_SESSION_ENDPOINT: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => (stdout += String(data)));
      child.stderr.on("data", (data) => (stderr += String(data)));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(stdout + stderr).not.toContain(credential);
      return { stdout, stderr, code };
    };
    return {
      root,
      home,
      bin,
      repo,
      credential,
      configPath,
      calls,
      run,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  it("prints a concise setup error when connect has no local login", async () => {
    const f = await fixture();
    try {
      const refused = await f.run(["connect"], true);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe("mend: No local Doppler token found. Run doppler login first.\n");
      expect(f.calls).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("prints a server refusal without an unhandled rejection or stack trace", async () => {
    const f = await fixture("Connect Doppler first.");
    try {
      const refused = await f.run(["status"], true);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toBe("mend: Connect Doppler first.\n");
    } finally {
      await f.close();
    }
  });

  it("imports a resolved CLI token and says which project/config mapped; use defaults to the session and writes immediately", async () => {
    const f = await fixture();
    try {
      spawnSync("git", ["init", f.repo]);
      spawnSync("git", [
        "-C",
        f.repo,
        "remote",
        "add",
        "origin",
        "git@github.com:sealant-sh/mend.git",
      ]);
      const all = {
        "/": { token: f.credential },
        [f.repo]: { "enclave.project": "backend", "enclave.config": "dev_me" },
      };
      fs.writeFileSync(
        path.join(f.bin, "doppler"),
        `#!/bin/sh\nprintf '%s' '${JSON.stringify(all)}'`,
        { mode: 0o755 },
      );
      const connect = await f.run(["connect"]);
      expect(connect.code, connect.stderr).toBe(0);
      expect(connect.stdout).toContain("Mend · backend/dev_me");
      expect(f.calls).toContainEqual({ action: "connect", token: f.credential });
      const use = await f.run(["use", "backend", "dev_next"]);
      expect(use.code, use.stderr).toBe(0);
      expect(f.calls).toContainEqual({
        action: "use",
        dopplerProject: "backend",
        config: "dev_next",
      });
      expect(JSON.parse(fs.readFileSync(f.configPath, "utf8")).scoped["/workspace/repo"]).toEqual({
        "enclave.project": "backend",
        "enclave.config": "dev_next",
      });
      expect(fs.statSync(f.configPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(f.configPath)).mode & 0o777).toBe(0o700);
      const status = await f.run(["status"], true);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain("CLI isn't installed");
      const disconnect = await f.run(["disconnect"]);
      expect(disconnect.code, disconnect.stderr).toBe(0);
      expect(fs.existsSync(f.configPath)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("preserves a later login or edit and refuses a symlink into the worktree", async () => {
    const f = await fixture();
    try {
      fs.mkdirSync(path.dirname(f.configPath));
      const changed = JSON.parse(dopplerConfigContents(f.credential, "/workspace/repo", null));
      changed.scoped["/"].token = "dp.ct.fake-new-login";
      fs.writeFileSync(f.configPath, JSON.stringify(changed));
      expect((await f.run(["disconnect"])).code).toBe(0);
      expect(fs.existsSync(f.configPath)).toBe(true);
      fs.rmSync(path.dirname(f.configPath), { recursive: true });
      fs.symlinkSync(f.repo, path.dirname(f.configPath));
      fs.writeFileSync(
        path.join(f.repo, ".doppler.yaml"),
        dopplerConfigContents(f.credential, "/workspace/repo", null),
      );
      const refused = await f.run(["use", "backend", "dev"], true);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/^mend: /);
      expect(refused.stderr).not.toContain("    at ");
      expect(
        JSON.parse(fs.readFileSync(path.join(f.repo, ".doppler.yaml"), "utf8")).scoped[
          "/workspace/repo"
        ],
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

it("next delivery removes an unchanged Mend config after local use, but preserves a later manual login", () => {
  const home = temp(),
    file = path.join(home, ".doppler/.doppler.yaml");
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    dopplerConfigContents("fake-token", "/workspace/repo", {
      dopplerProject: "backend",
      config: "dev_after_use",
    }),
  );
  const argv = secretFilesRemoveExec(
    [{ path: ".doppler/.doppler.yaml", sha256: "0".repeat(64) }],
    true,
  );
  expect(
    spawnSync("sh", argv.slice(1), {
      env: { HOME: home, PATH: process.env["PATH"] },
      encoding: "utf8",
    }).status,
  ).toBe(0);
  expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file, '{"scoped":{"/":{"token":"fake-manual-login"}}}');
  spawnSync("sh", argv.slice(1), { env: { HOME: home, PATH: process.env["PATH"] } });
  expect(fs.existsSync(file)).toBe(true);
});
