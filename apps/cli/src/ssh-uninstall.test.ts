// mend uninstall --home and this machine's workspace SSH key; split from ssh-setup.test.ts so neither
// file runs near CI's per-file limit (SLNT-1040).
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { workspaceSshPublicKeyFingerprint } from "@mend/workspace-ssh";
import { expect, it } from "vitest";

import { runMend, runSshCommand } from "./ssh-test-fixtures.ts";
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
  const server = createServer((request, response) => {
    // A failed handler rejects unhandled, which fails the test run.
    void (async () => {
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
    })();
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
