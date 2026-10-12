import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { preparePackagedSshAcceptance } from "./packaged-ssh-acceptance.mjs";

const exec = promisify(execFile);
const alias = "mend-ws-127-0-0-1-0123456789abcdef01234567";
const ownedId = "a".repeat(64);
const proof = "MEND_PACKAGED_NATIVE_SSH_PROOF\n";

const quotePath = (path) =>
  `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

// A fixture for the documented block, not a substitute implementation of installed CLI setup.
function block(key) {
  return [
    `# >>> mend workspace ssh ${alias} (managed) >>>`,
    `Host ${alias}`,
    "  HostName 127.0.0.1",
    "  Port 32123",
    `  HostKeyAlias ${alias}`,
    `  IdentityFile ${quotePath(key)}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking accept-new",
    "Host *",
    `# <<< mend workspace ssh ${alias} <<<`,
    "",
  ].join("\n");
}

async function fixture(t) {
  const scratch = await mkdtemp(join(tmpdir(), "mend ssh acceptance %-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const privateHome = join(scratch, "home");
  await mkdir(privateHome, { mode: 0o700 });
  const environment = { ...process.env, HOME: privateHome, SSH_ASKPASS_REQUIRE: "never" };
  delete environment.SSH_AUTH_SOCK;
  const native = async (command, args, options = {}) =>
    (
      await exec(command, args, {
        env: environment,
        cwd: scratch,
        timeout: options.timeout ?? 3000,
      })
    ).stdout;
  const hostKeyFile = join(scratch, "fixture-host-key");
  await native("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyFile]);
  const hostKey = await native("ssh-keygen", ["-y", "-f", hostKeyFile]);
  const calls = [];
  const state = {
    hostKey,
    config: block,
    ssh: async () => proof,
    metadata: {
      // Deliberately not the client address. CLI takes that from its Mend URL.
      gateway: { host: "gateway.internal", port: 32123, usernamePrefix: "workspace" },
      keys: [
        {
          sshKeyId: "key-1",
          name: "acceptance",
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:fixture",
          createdAt: "2026-09-05T00:00:00Z",
        },
      ],
    },
  };
  const options = {
    scratch,
    privateHome,
    mendContainerId: ownedId,
    async run(command, args, processOptions) {
      calls.push({ kind: "run", command, args, options: processOptions });
      return command === "ssh"
        ? state.ssh(args, processOptions)
        : native(command, args, processOptions);
    },
    async cli(args) {
      calls.push({ kind: "cli", args });
      assert.deepEqual(args.slice(0, 3), ["ssh", "setup", "--key"]);
      assert.equal(args.length, 4);
      await writeFile(join(privateHome, ".ssh/config"), state.config(args[3]), { mode: 0o600 });
      // Alias discovery must ignore stdout entirely.
      return "Host malicious-stdout-alias\n";
    },
    async docker(args) {
      calls.push({ kind: "docker", args });
      return state.hostKey;
    },
    async api(path) {
      calls.push({ kind: "api", path });
      return state.metadata;
    },
    async until(description, probe) {
      calls.push({ kind: "until", description });
      for (let i = 0; i < 100; i++) {
        const value = await probe();
        if (value) return value;
      }
      throw new Error("Test poll exceeded its bound");
    },
  };
  return { options, state, calls, native, hostKeyFile };
}

const sshCalls = (calls) => calls.filter((call) => call.command === "ssh");
const setupCall = (calls) => calls.find((call) => call.kind === "cli");
const trustFile = (calls) =>
  calls.find((call) => call.command === "ssh-keygen" && call.args[0] === "-l").args[2];

test("preparation uses isolated child HOME, installed CLI boundary and owned-container public host key", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  const key = setupCall(f.calls).args[3];
  assert.ok(key.startsWith(`${f.options.scratch}/native-ssh-`));
  assert.equal(f.calls[0].command, process.execPath);
  assert.match(f.calls[0].args[2], /homedir/);
  assert.deepEqual(f.calls.find((call) => call.kind === "docker").args, [
    "exec",
    ownedId,
    "ssh-keygen",
    "-y",
    "-f",
    "/var/lib/mend/ssh/ssh_gateway_host_key",
  ]);
  assert.equal(f.calls.find((call) => call.kind === "api").path, "/workspace-ssh");
  const knownHosts = trustFile(f.calls);
  const expectedPublicKey = f.state.hostKey.trim().split(" ").slice(0, 2).join(" ");
  assert.equal(await readFile(knownHosts, "utf8"), `${alias} ${expectedPublicKey}\n`);
  assert.equal((await stat(knownHosts)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(knownHosts))).mode & 0o777, 0o700);
  assert.equal((await stat(key)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(f.options.privateHome, ".ssh")), ["config"]);
  assert.match(await f.native("ssh-keygen", ["-F", alias, "-f", knownHosts]), /found: line 1/);
  assert.ok(!f.calls.some((call) => call.command === "ssh-keyscan"));
  assert.equal(sshCalls(f.calls).length, 0, "preparation must precede the short-lived workspace");
  await check("ws_123", "expected-marker");
});

test("native OpenSSH evaluates the installed config with strict isolated argv, not its accept-new default", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  await check("ws_123", "expected-marker");
  const call = sshCalls(f.calls)[0];
  assert.deepEqual(call.options, { timeout: 2500 });
  const args = call.args;
  assert.deepEqual(args.slice(0, 4), [
    "-F",
    join(f.options.privateHome, ".ssh/config"),
    "-T",
    "-n",
  ]);
  assert.deepEqual(args.slice(-4, -1), ["-l", "workspace-ws_123", alias]);
  for (const value of [
    "BatchMode=yes",
    "GlobalKnownHostsFile=/dev/null",
    "StrictHostKeyChecking=yes",
    "IdentityAgent=none",
    "IdentitiesOnly=yes",
    "ConnectionAttempts=1",
    "ConnectTimeout=2",
    "UpdateHostKeys=no",
    "VerifyHostKeyDNS=no",
  ])
    assert.ok(args.includes(value), value);
  // Real ssh process, no connection. This catches -o quoting and OpenSSH precedence mistakes.
  const evaluated = await f.native("ssh", ["-G", ...args]);
  for (const line of [
    "hostname 127.0.0.1",
    "port 32123",
    "user workspace-ws_123",
    `hostkeyalias ${alias}`,
    "batchmode yes",
    "stricthostkeychecking true",
    "identityagent none",
    "globalknownhostsfile /dev/null",
    "identitiesonly yes",
  ])
    assert.ok(evaluated.split("\n").includes(line), line);
  assert.ok(evaluated.includes(`userknownhostsfile ${trustFile(f.calls)}`));
});

test("wrong child HOME refuses before setup, key generation, Docker or API", async (t) => {
  const f = await fixture(t);
  f.options.run = async (command, args, options) =>
    (
      await exec(command, args, {
        env: { ...process.env, HOME: f.options.scratch },
        timeout: options.timeout,
      })
    ).stdout;
  await assert.rejects(preparePackagedSshAcceptance(f.options), /child Node os.homedir/);
  assert.deepEqual(f.calls, []);
  assert.ok(!(await readdir(f.options.privateHome)).includes(".ssh"));
});

test("outside, sibling-prefix, symlink and permissive homes are refused before CLI", async (t) => {
  for (const kind of ["equal", "sibling", "symlink", "permissions"]) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      if (kind === "equal") f.options.privateHome = f.options.scratch;
      if (kind === "sibling") f.options.privateHome = `${f.options.scratch}-not-inside/home`;
      if (kind === "permissions") await chmod(f.options.privateHome, 0o755);
      if (kind === "symlink") {
        const link = join(f.options.scratch, "linked-home");
        await symlink(f.options.privateHome, link);
        f.options.privateHome = link;
      }
      await assert.rejects(
        preparePackagedSshAcceptance(f.options),
        /private scratch HOME|0700 directories/,
      );
      assert.deepEqual(f.calls, []);
    });
  }
});

test("pre-existing SSH directory or symlink is never read or changed by setup", async (t) => {
  for (const linked of [false, true]) {
    await t.test(String(linked), async (subtest) => {
      const f = await fixture(subtest);
      const sshDirectory = join(f.options.privateHome, ".ssh");
      const target = linked ? join(f.options.scratch, "unrelated-ssh") : sshDirectory;
      await mkdir(target, { mode: 0o700 });
      const sentinel = "Match exec do-not-run\n";
      await writeFile(join(target, "config"), sentinel);
      if (linked) await symlink(target, sshDirectory);
      await assert.rejects(preparePackagedSshAcceptance(f.options), { code: "EEXIST" });
      assert.equal(setupCall(f.calls), undefined);
      assert.equal(await readFile(join(target, "config"), "utf8"), sentinel);
    });
  }
});

test("container names and short IDs cannot supply trusted host keys", async (t) => {
  const f = await fixture(t);
  f.options.mendContainerId = "mend";
  await assert.rejects(preparePackagedSshAcceptance(f.options), /immutable ID/);
  assert.deepEqual(f.calls, []);
});

test("public metadata must match the contract and managed port", async (t) => {
  for (const gateway of [
    null,
    { host: "localhost", port: "32123", usernamePrefix: "ws" },
    { host: "localhost", port: 70000, usernamePrefix: "ws" },
    { host: "localhost", port: 32123, usernamePrefix: "ws\nProxyCommand evil" },
    { host: "localhost", port: 2222, usernamePrefix: "ws" },
  ]) {
    await t.test(JSON.stringify(gateway), async (subtest) => {
      const f = await fixture(subtest);
      f.state.metadata.gateway = gateway;
      await assert.rejects(preparePackagedSshAcceptance(f.options), /workspace-ssh|published port/);
      assert.ok(!f.calls.some((call) => call.kind === "docker"));
    });
  }
});

test("only the exact managed block is accepted; no Include, extra alias or identity escape", async (t) => {
  const variants = [
    (key) => `${block(key)}Include ~/.ssh/other\n`,
    (key) => block(key) + block(key),
    (key) => block(key).replace(`Host ${alias}`, `Host ${alias} other`),
    (key) => block(key).replace("  Port 32123", "  Port 32123\n  ProxyCommand evil"),
    () => block("/outside/private-key"),
  ];
  for (const [index, config] of variants.entries()) {
    await t.test(String(index), async (subtest) => {
      const f = await fixture(subtest);
      f.state.config = config;
      await assert.rejects(preparePackagedSshAcceptance(f.options), /exactly one managed alias/);
      assert.ok(!f.calls.some((call) => call.kind === "docker"));
    });
  }
});

test("host trust rejects private material, keyscan records, multiple keys and malformed public blobs", async (t) => {
  for (const kind of ["private", "keyscan", "multiple", "bad-base64", "truncated"]) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      const wireHeader = Buffer.from("0000000b7373682d65643235353139", "hex");
      f.state.hostKey = {
        private: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key\n",
        keyscan: `127.0.0.1 ${f.state.hostKey}`,
        multiple: f.state.hostKey + f.state.hostKey,
        "bad-base64": "ssh-ed25519 AAAA\n",
        truncated: `ssh-ed25519 ${Buffer.concat([wireHeader, Buffer.from([1])]).toString("base64")}\n`,
      }[kind];
      await assert.rejects(preparePackagedSshAcceptance(f.options));
      assert.equal(sshCalls(f.calls).length, 0);
    });
  }
});

test("retries are bounded, retain identical pins and argv, and require exact proof output", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  let attempts = 0;
  f.state.ssh = async () => {
    attempts++;
    if (attempts === 1) throw new Error("Host key verification failed; never accept-new");
    if (attempts === 2) return `noise ${proof}`;
    return proof;
  };
  await check("ws-1", "expected");
  assert.equal(attempts, 3);
  const initialTrust = await readFile(trustFile(f.calls), "utf8");
  f.state.ssh = async () => {
    throw new Error("sensitive stderr must not be rethrown");
  };
  await assert.rejects(check("ws-1", "expected"), /failed after 8 attempts; output withheld/);
  assert.equal(sshCalls(f.calls).length, 11);
  for (const call of sshCalls(f.calls)) assert.deepEqual(call.args, sshCalls(f.calls)[0].args);
  assert.equal(await readFile(trustFile(f.calls), "utf8"), initialTrust);
});

test("replacement trust/config and unsafe workspace IDs are refused before connecting", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  await assert.rejects(check("-oProxyCommand=evil", "marker"), /workspace ID/);
  await assert.rejects(check("ws-1", "line\nbreak"), /single-line/);
  await writeFile(trustFile(f.calls), `${alias} ${f.state.hostKey}# changed\n`);
  await assert.rejects(check("ws-1", "marker"), /changed after preparation/);
  assert.equal(sshCalls(f.calls).length, 0);
});

test("saved config replacements are refused after successful preparation without reaching ssh", async (t) => {
  for (const kind of ["valid-changed", "Include", "Match exec"]) {
    await t.test(kind, async (subtest) => {
      const f = await fixture(subtest);
      const { check } = await preparePackagedSshAcceptance(f.options);
      const config = join(f.options.privateHome, ".ssh/config");
      const original = await readFile(config, "utf8");
      const key = setupCall(f.calls).args[3];
      const trust = trustFile(f.calls);
      const keyBefore = await readFile(key);
      const trustBefore = await readFile(trust, "utf8");
      assert.equal(sshCalls(f.calls).length, 0);
      const included = join(f.options.scratch, "included-config");
      if (kind === "Include") {
        await writeFile(included, 'Match exec "touch config-executed"\n', { mode: 0o600 });
      }
      const replacements = {
        "valid-changed": original.replace("  Port 32123", "  Port 32124"),
        Include: `${original}Include ${quotePath(included)}\n`,
        "Match exec": `${original}Match exec "touch config-executed"\n`,
      };
      await writeFile(config, replacements[kind]);
      assert.notEqual(await readFile(config, "utf8"), original);
      assert.equal((await stat(config)).mode & 0o777, 0o600);
      assert.deepEqual(await readFile(key), keyBefore);
      assert.equal(await readFile(trust, "utf8"), trustBefore);
      await assert.rejects(check("ws-1", "marker"), /changed after preparation/);
      assert.equal(sshCalls(f.calls).length, 0);
      assert.ok(!(await readdir(f.options.scratch)).includes("config-executed"));
    });
  }
});

test("saved known_hosts replacement is independently refused before reaching ssh", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  const config = join(f.options.privateHome, ".ssh/config");
  const configBefore = await readFile(config, "utf8");
  const key = setupCall(f.calls).args[3];
  const keyBefore = await readFile(key);
  const trust = trustFile(f.calls);
  const original = await readFile(trust, "utf8");
  assert.equal(sshCalls(f.calls).length, 0);
  await writeFile(trust, original.replace(alias, `${alias}-changed`));
  assert.notEqual(await readFile(trust, "utf8"), original);
  assert.equal((await stat(trust)).mode & 0o777, 0o600);
  assert.equal(await readFile(config, "utf8"), configBefore);
  assert.deepEqual(await readFile(key), keyBefore);
  await assert.rejects(check("ws-1", "marker"), /changed after preparation/);
  assert.equal(sshCalls(f.calls).length, 0);
});

test("prepared key, config and known_hosts retain private file boundaries before connection", async (t) => {
  for (const role of ["key", "config", "known_hosts"]) {
    for (const kind of ["permissions", "symlink", "hardlink"]) {
      await t.test(`${role}: ${kind}`, async (subtest) => {
        const f = await fixture(subtest);
        const { check } = await preparePackagedSshAcceptance(f.options);
        const files = {
          key: setupCall(f.calls).args[3],
          config: join(f.options.privateHome, ".ssh/config"),
          known_hosts: trustFile(f.calls),
        };
        const before = new Map(
          await Promise.all(Object.values(files).map(async (file) => [file, await readFile(file)])),
        );
        const file = files[role];
        const contents = await readFile(file);
        assert.equal(sshCalls(f.calls).length, 0);
        if (kind === "permissions") {
          await chmod(file, 0o644);
        } else {
          const replacement = join(f.options.scratch, `${role}-replacement`);
          await writeFile(replacement, contents, { mode: 0o600 });
          await rm(file);
          if (kind === "symlink") await symlink(replacement, file);
          else await link(replacement, file);
        }
        // Identical contents isolate file privacy from the separate saved-content checks.
        for (const [path, content] of before) assert.deepEqual(await readFile(path), content);
        await assert.rejects(check("ws-1", "marker"), /non-symlink, single-link 0600 files/);
        assert.equal(sshCalls(f.calls).length, 0);
      });
    }
  }
});

test("remote command only reads the fixed file, compares a safely quoted marker and prints fixed proof", async (t) => {
  const f = await fixture(t);
  const { check } = await preparePackagedSshAcceptance(f.options);
  const marker = "quote' $(touch should-not-exist); `touch neither`";
  await check("ws-1", marker);
  const command = sshCalls(f.calls)[0].args.at(-1);
  assert.ok(command.includes("cat /workspace/repo/packaged-proof.txt"));
  // Execute the real shell syntax with a cat stand-in. It refuses any other path or extra args.
  const bin = join(f.options.scratch, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "cat"),
    '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = /workspace/repo/packaged-proof.txt ] || exit 90\nprintf "%s\\n" "$FIXTURE_MARKER"\n',
    { mode: 0o700 },
  );
  const env = { ...process.env, PATH: bin, FIXTURE_MARKER: marker };
  assert.equal(
    (await exec("/bin/sh", ["-c", command], { env, cwd: f.options.scratch, timeout: 2500 })).stdout,
    proof,
  );
  await assert.rejects(
    exec("/bin/sh", ["-c", command], {
      env: { ...env, FIXTURE_MARKER: "wrong" },
      cwd: f.options.scratch,
      timeout: 2500,
    }),
  );
  assert.ok(!(await readdir(f.options.scratch)).includes("should-not-exist"));
  assert.ok(!(await readdir(f.options.scratch)).includes("neither"));
});
