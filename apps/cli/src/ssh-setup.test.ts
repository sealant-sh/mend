import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parseWorkspaceSshTarget, workspaceSshPublicKeyFingerprint } from "@mend/workspace-ssh";
import { expect, it } from "vitest";

const runMend = async (home: string, url: string, args: ReadonlyArray<string>) => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(new URL("./main.ts", import.meta.url)), ...args],
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        MEND_URL: url,
        MEND_TOKEN: "test-token",
        SSH_AUTH_SOCK: "",
        SSH_ASKPASS_REQUIRE: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
};

const runSshCommand = (home: string, url: string, args: ReadonlyArray<string>) =>
  runMend(home, url, ["ssh", ...args]);

it("mend ssh setup/status reconcile real OpenSSH config without claiming host trust or rotating keys", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ssh-cli-test-"));
  const keys: Array<{ fingerprint: string }> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/workspace-ssh") {
      response.end(
        JSON.stringify({
          gateway: { host: "0.0.0.0", port: 22444, usernamePrefix: "workspace" },
          keys,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspace-ssh/keys") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed: unknown = JSON.parse(body);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("publicKey" in parsed) ||
        typeof parsed.publicKey !== "string"
      ) {
        response.writeHead(400).end();
        return;
      }
      const fingerprint = workspaceSshPublicKeyFingerprint(parsed.publicKey);
      if (!fingerprint.ok) {
        response.writeHead(400).end();
        return;
      }
      const key = { fingerprint: fingerprint.value };
      if (!keys.some((existing) => existing.fingerprint === key.fingerprint)) keys.push(key);
      response.end(JSON.stringify(key));
      return;
    }
    response.writeHead(404).end();
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    const url = `http://127.0.0.1:${address.port}`;
    const configFile = path.join(home, ".ssh", "config");
    const knownHosts = path.join(home, ".ssh", "known_hosts");
    fs.mkdirSync(path.dirname(configFile));
    const original = "Port 22\nHost *\n HostName wrong-host\nHost unrelated\n User git\n";
    fs.writeFileSync(configFile, original);
    fs.writeFileSync(knownHosts, "fixture known_hosts contents must not change\n");
    const privatePath = path.join(home, 'key space %Z "quote"');
    const generated = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-f", privatePath],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const bytes = fs.readFileSync(privatePath);
    const setup = await runSshCommand(home, url, ["setup", "--key", path.basename(privatePath)]);
    expect(setup.code, setup.stderr + setup.stdout).toBe(0);
    expect(setup.stdout).toContain("host trust      not checked");
    expect(setup.stdout).not.toContain("SSH is ready");
    const config = fs.readFileSync(configFile, "utf8");
    expect(config.endsWith(original)).toBe(true);
    const target = parseWorkspaceSshTarget({ serverUrl: url, publishedPort: 22444 });
    if (!target.ok) throw target.error;
    const effective = spawnSync("ssh", ["-G", "-F", configFile, target.value.alias], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(effective.status, effective.stderr).toBe(0);
    expect(effective.stdout).toContain("hostname 127.0.0.1\n");
    expect(effective.stdout).toContain("port 22444\n");
    const status = await runSshCommand(home, url, ["status"]);
    expect(status.code, status.stderr + status.stdout).toBe(0);
    expect(status.stdout).toContain("registered");
    expect(status.stdout).toContain("host trust      not checked");
    expect(status.stdout).not.toContain("missing or stale");
    const rerun = await runSshCommand(home, url, ["setup"]);
    expect(rerun.code, rerun.stderr + rerun.stdout).toBe(0);
    expect(fs.readFileSync(configFile, "utf8")).toBe(config);
    expect(fs.readFileSync(privatePath)).toEqual(bytes);
    expect(keys).toHaveLength(1);
    fs.unlinkSync(privatePath);
    const missing = await runSshCommand(home, url, ["status"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain(
      "no usable matching private material or unlocked agent identity",
    );
    const failedSetup = await runSshCommand(home, url, ["setup"]);
    expect(failedSetup.code).toBe(1);
    expect(keys).toHaveLength(1);
    expect(fs.readFileSync(configFile, "utf8")).toBe(config);
    expect(fs.readFileSync(knownHosts, "utf8")).toBe(
      "fixture known_hosts contents must not change\n",
    );
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 20_000);

it("mend ssh keys lists only what the server returns for this account and removes one by fingerprint", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ssh-keys-test-"));
  interface Key {
    sshKeyId: string;
    name: string;
    algorithm: string;
    fingerprint: string;
    createdAt: string;
  }
  // Another machine of the same account, registered before this one.
  const keys: Array<Key> = [
    {
      sshKeyId: "key-other",
      name: "old-laptop",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:0ld+laptop/key",
      createdAt: "2026-09-01T10:00:00.000Z",
    },
  ];
  const deleted: Array<string> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/workspace-ssh") {
      response.end(
        JSON.stringify({ gateway: { host: "0.0.0.0", port: 22444, usernamePrefix: "ws" }, keys }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspace-ssh/keys") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed: unknown = JSON.parse(body);
      const publicKey =
        typeof parsed === "object" && parsed !== null && "publicKey" in parsed
          ? String(parsed.publicKey)
          : "";
      const fingerprint = workspaceSshPublicKeyFingerprint(publicKey);
      if (!fingerprint.ok) {
        response.writeHead(400).end();
        return;
      }
      const key = {
        sshKeyId: "key-this",
        name: "this-laptop",
        algorithm: "ssh-ed25519",
        fingerprint: fingerprint.value,
        createdAt: "2026-10-10T10:00:00.000Z",
      };
      keys.push(key);
      response.end(JSON.stringify(key));
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/me/devices/dev-1") {
      deleted.push("device:dev-1");
      response.end(JSON.stringify({ revoked: true }));
      return;
    }
    const removal = /^\/api\/workspace-ssh\/keys\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && removal !== null) {
      const id = decodeURIComponent(removal[1] ?? "");
      deleted.push(id);
      const index = keys.findIndex((key) => key.sshKeyId === id);
      if (index === -1) {
        response
          .writeHead(404)
          .end(JSON.stringify({ _tag: "WorkspaceSshKeyNotFound", sshKeyId: id }));
        return;
      }
      const [removed] = keys.splice(index, 1);
      // The old laptop's key on a platform that keeps open connections; this machine's on one
      // that ends them.
      response.end(
        JSON.stringify(
          id === "key-other"
            ? {
                ...removed,
                openConnections: "stay",
                runningSessions: [{ sessionId: "session-1", label: "reaper retry storm" }],
              }
            : { ...removed, openConnections: "end", runningSessions: [] },
        ),
      );
      return;
    }
    response.writeHead(404).end();
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    const url = `http://127.0.0.1:${address.port}`;
    fs.mkdirSync(path.join(home, ".ssh"));

    const setup = await runSshCommand(home, url, ["setup"]);
    expect(setup.code, setup.stderr + setup.stdout).toBe(0);
    const local = keys.find((key) => key.sshKeyId === "key-this")?.fingerprint;
    if (local === undefined) throw new Error("setup registered no key");

    const listed = await runSshCommand(home, url, ["keys"]);
    expect(listed.code, listed.stderr + listed.stdout).toBe(0);
    const lines = listed.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("SHA256:0ld+laptop/key  old-laptop");
    expect(lines[0]).toContain("registered 2026-09-01");
    expect(lines[0]).not.toContain("this machine");
    expect(lines[1]).toContain(local);
    expect(lines[1]).toContain("● this machine");

    const json = await runSshCommand(home, url, ["keys", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual([
      { ...keys[0], thisMachine: false },
      { ...keys[1], thisMachine: true },
    ]);

    // A fingerprint the account does not hold is refused before anything is deleted.
    const unknown = await runSshCommand(home, url, ["keys", "remove", "SHA256:nobody"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("none of your registered keys has fingerprint SHA256:nobody");
    const usage = await runSshCommand(home, url, ["keys", "remove"]);
    expect(usage.code).toBe(1);
    expect(usage.stdout).toContain("usage: mend ssh keys remove <fingerprint>");
    expect(deleted).toEqual([]);

    // The SHA256: prefix is optional, and the key id travels URL-encoded.
    const other = await runSshCommand(home, url, ["keys", "remove", "0ld+laptop/key"]);
    expect(other.code, other.stderr + other.stdout).toBe(0);
    expect(other.stdout).toContain("removed         SHA256:0ld+laptop/key");
    expect(other.stdout).toContain("the gateway refuses it from the next connection");
    expect(other.stdout).toContain(
      "connections already open with it stay open until you stop your running sessions",
    );
    expect(other.stdout).toContain("mend stop session-1  · reaper retry storm");
    expect(other.stdout).not.toContain("this machine's key");
    expect(deleted).toEqual(["key-other"]);

    const mine = await runSshCommand(home, url, ["keys", "remove", local]);
    expect(mine.code, mine.stderr + mine.stdout).toBe(0);
    expect(mine.stdout).toContain("this machine's key");
    expect(mine.stdout).toContain("ends the connections open with it within a minute");
    expect(mine.stdout).not.toContain("mend stop");
    expect(deleted).toEqual(["key-other", "key-this"]);

    const empty = await runSshCommand(home, url, ["keys"]);
    expect(empty.stdout).toContain("no workspace ssh keys registered");

    // `mend uninstall --home` removes this machine's key, and only it, before the device token.
    const again = await runSshCommand(home, url, ["setup"]);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    keys.unshift({
      sshKeyId: "key-desk",
      name: "desk",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:desk",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    const cliHome = path.join(home, "config", "mend");
    fs.writeFileSync(
      path.join(cliHome, "cli.json"),
      JSON.stringify({ url, token: "test-token", deviceId: "dev-1" }),
    );
    const uninstalled = await runMend(home, url, ["uninstall", "--home", "--yes"]);
    expect(uninstalled.code, uninstalled.stderr + uninstalled.stdout).toBe(0);
    expect(uninstalled.stdout).toContain(
      `removed workspace ssh key ${local} on ${url} · the gateway refuses it from the next connection`,
    );
    expect(deleted).toEqual(["key-other", "key-this", "key-this", "device:dev-1"]);
    expect(keys.map((key) => key.sshKeyId)).toEqual(["key-desk"]);
    expect(fs.existsSync(path.join(cliHome, "ssh"))).toBe(false);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

/** A Mend server holding one account's workspace SSH keys, as the CLI's routes see it. */
const keyServer = async () => {
  interface Key {
    sshKeyId: string;
    name: string;
    algorithm: string;
    fingerprint: string;
    createdAt: string;
  }
  const keys: Array<Key> = [
    {
      sshKeyId: "key-desk",
      name: "desk",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:desk",
      createdAt: "2026-09-02T10:00:00.000Z",
    },
  ];
  const calls: Array<string> = [];
  /** Off: the server reports no gateway, as the contract allows, with the same keys. */
  const gateway = { on: true };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/api/workspace-ssh") {
      response.end(
        JSON.stringify({
          gateway: gateway.on ? { host: "0.0.0.0", port: 22444, usernamePrefix: "ws" } : null,
          keys,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/workspace-ssh/keys") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const parsed: unknown = JSON.parse(body);
      const publicKey =
        typeof parsed === "object" && parsed !== null && "publicKey" in parsed
          ? String(parsed.publicKey)
          : "";
      const fingerprint = workspaceSshPublicKeyFingerprint(publicKey);
      if (!fingerprint.ok) {
        response.writeHead(400).end();
        return;
      }
      const key = {
        sshKeyId: "key-this",
        name: "this-laptop",
        algorithm: "ssh-ed25519",
        fingerprint: fingerprint.value,
        createdAt: "2026-10-10T10:00:00.000Z",
      };
      keys.push(key);
      response.end(JSON.stringify(key));
      return;
    }
    if (request.method === "DELETE" && request.url === "/api/me/devices/dev-1") {
      calls.push("device:dev-1");
      response.end(JSON.stringify({ revoked: true }));
      return;
    }
    const removal = /^\/api\/workspace-ssh\/keys\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && removal !== null) {
      const id = decodeURIComponent(removal[1] ?? "");
      calls.push(id);
      const index = keys.findIndex((key) => key.sshKeyId === id);
      const [removed] = index === -1 ? [] : keys.splice(index, 1);
      response.writeHead(removed === undefined ? 404 : 200).end(JSON.stringify(removed ?? {}));
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    keys,
    calls,
    gateway,
    close: async () => {
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
};

it("mend uninstall --home removes this machine's key by its public half when the private key is encrypted, and fails loudly when it cannot tell which key is this machine's", async () => {
  for (const scenario of ["public half readable", "public half gone"] as const) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ssh-uninstall-test-"));
    const fake = await keyServer();
    try {
      fs.mkdirSync(path.join(home, ".ssh"));
      const setup = await runSshCommand(home, fake.url, ["setup"]);
      expect(setup.code, setup.stderr + setup.stdout).toBe(0);
      const local = fake.keys.find((key) => key.sshKeyId === "key-this")?.fingerprint;
      if (local === undefined) throw new Error("setup registered no key");
      const cliHome = path.join(home, "config", "mend");
      const privatePath = path.join(cliHome, "ssh", "id_ed25519");
      // Encrypted after setup, with no agent: this machine can no longer sign with it.
      const encrypted = spawnSync(
        "ssh-keygen",
        ["-q", "-p", "-P", "", "-N", "review-test-passphrase", "-f", privatePath],
        { encoding: "utf8", timeout: 5_000 },
      );
      expect(encrypted.status, encrypted.stderr).toBe(0);
      if (scenario === "public half gone") fs.unlinkSync(`${privatePath}.pub`);
      fs.writeFileSync(
        path.join(cliHome, "cli.json"),
        JSON.stringify({ url: fake.url, token: "test-token", deviceId: "dev-1" }),
      );

      const listed = await runSshCommand(home, fake.url, ["keys", "--json"]);
      const marked = JSON.parse(listed.stdout).filter(
        (key: { readonly thisMachine: boolean }) => key.thisMachine,
      );

      const uninstalled = await runMend(home, fake.url, ["uninstall", "--home", "--yes"]);
      // Either way the device token is revoked and the local files go.
      expect(fake.calls.at(-1)).toBe("device:dev-1");
      expect(fs.existsSync(path.join(cliHome, "ssh"))).toBe(false);
      if (scenario === "public half readable") {
        expect(marked).toHaveLength(1);
        expect(uninstalled.code, uninstalled.stderr + uninstalled.stdout).toBe(0);
        expect(uninstalled.stdout).toContain(`removed workspace ssh key ${local} on ${fake.url}`);
        expect(fake.calls).toEqual(["key-this", "device:dev-1"]);
        // Another machine's key stays.
        expect(fake.keys.map((key) => key.sshKeyId)).toEqual(["key-desk"]);
      } else {
        expect(marked).toHaveLength(0);
        // Not taken for absence: the uninstall fails and says what may still be registered.
        expect(uninstalled.code).toBe(1);
        expect(uninstalled.stderr).toContain(
          `this machine's workspace ssh key on ${fake.url} may still be registered`,
        );
        expect(uninstalled.stderr).toContain("mend ssh keys remove <fingerprint>");
        expect(fake.calls).toEqual(["device:dev-1"]);
        expect(fake.keys.map((key) => key.sshKeyId)).toEqual(["key-desk", "key-this"]);
      }
    } finally {
      await fake.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}, 40_000);

it("mend uninstall --home removes a key chosen with --key outside the config directory when the server reports no gateway", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ssh-uninstall-nogw-"));
  const fake = await keyServer();
  try {
    fs.mkdirSync(path.join(home, ".ssh"));
    const external = path.join(home, "external-key");
    const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", external], {
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(generated.status, generated.stderr).toBe(0);
    const setup = await runSshCommand(home, fake.url, ["setup", "--key", external]);
    expect(setup.code, setup.stderr + setup.stdout).toBe(0);
    const local = fake.keys.find((key) => key.sshKeyId === "key-this")?.fingerprint;
    if (local === undefined) throw new Error("setup registered no key");
    // Encrypted, no agent, and the server stops reporting a gateway: only the managed block's
    // IdentityFile and its readable public half name this machine's key.
    const encrypted = spawnSync(
      "ssh-keygen",
      ["-q", "-p", "-P", "", "-N", "review-test-passphrase", "-f", external],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(encrypted.status, encrypted.stderr).toBe(0);
    fake.gateway.on = false;
    const cliHome = path.join(home, "config", "mend");
    fs.mkdirSync(cliHome, { recursive: true });
    fs.writeFileSync(
      path.join(cliHome, "cli.json"),
      JSON.stringify({ url: fake.url, token: "test-token", deviceId: "dev-1" }),
    );
    const uninstalled = await runMend(home, fake.url, ["uninstall", "--home", "--yes"]);
    expect(uninstalled.code, uninstalled.stderr + uninstalled.stdout).toBe(0);
    expect(uninstalled.stdout).toContain(`removed workspace ssh key ${local} on ${fake.url}`);
    expect(fake.calls).toEqual(["key-this", "device:dev-1"]);
    expect(fake.keys.map((key) => key.sshKeyId)).toEqual(["key-desk"]);
    // The key file is the person's own, outside Mend's directory: it stays.
    expect(fs.existsSync(external)).toBe(true);
  } finally {
    await fake.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
