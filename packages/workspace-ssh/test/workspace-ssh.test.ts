import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configuredWorkspaceSshIdentityFile,
  inspectWorkspaceSshReadiness,
  managedWorkspaceSshBlock as renderManagedBlock,
  parseWorkspaceSshTarget,
  pickWorkspaceSshKey,
  readWorkspaceSshConfig,
  reconcileWorkspaceSshConfig,
  stripManagedWorkspaceSshBlocks,
  workspaceSshPublicKeyFingerprint,
  writeWorkspaceSshConfig,
} from "../src/index.ts";

const temporaryDirectories: Array<string> = [];
const agentPids: Array<number> = [];

beforeEach(() => vi.stubEnv("SSH_AUTH_SOCK", ""));

const temporaryDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mend-workspace-ssh-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const target = (serverUrl: string, port: number, hostnameOverride?: string) => {
  const parsed = parseWorkspaceSshTarget({
    serverUrl,
    publishedPort: port,
    ...(hostnameOverride === undefined ? {} : { hostnameOverride }),
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

const managedWorkspaceSshBlock = (...args: Parameters<typeof renderManagedBlock>): string => {
  const rendered = renderManagedBlock(...args);
  if (!rendered.ok) throw rendered.error;
  return rendered.value;
};

afterEach(() => {
  for (const pid of agentPids.splice(0)) process.kill(pid);
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseWorkspaceSshTarget", () => {
  it("uses the configured Mend URL hostname and the server's published SSH port", () => {
    const parsed = target("https://mend-mini.example.test:3105", 22444);
    expect(parsed.hostname).toBe("mend-mini.example.test");
    expect(parsed.port).toBe(22444);
    expect(parsed.alias).toMatch(/^mend-ws-mend-mini-example-test-[a-f0-9]{24}$/);
  });

  it("handles bracketed IPv6 URLs and a hostname-only override", () => {
    const ipv6 = target("http://[fd7a:115c:a1e0::42]:3105", 2222);
    expect(ipv6.hostname).toBe("fd7a:115c:a1e0::42");

    const overridden = target("http://mend-mini:3105", 2299, "mini.tailnet.ts.net");
    expect(overridden.hostname).toBe("mini.tailnet.ts.net");
    expect(overridden.port).toBe(2299);
    expect(overridden.alias).toBe(target("http://mend-mini:3105", 2299).alias);
  });

  it("rejects a scheme or port in the hostname override", () => {
    const scheme = parseWorkspaceSshTarget({
      serverUrl: "http://mend-mini:3105",
      publishedPort: 2222,
      hostnameOverride: "ssh://mend-mini",
    });
    const port = parseWorkspaceSshTarget({
      serverUrl: "http://mend-mini:3105",
      publishedPort: 2222,
      hostnameOverride: "mend-mini:2200",
    });
    expect(scheme.ok).toBe(false);
    expect(port.ok).toBe(false);
  });
});

const effectiveConfig = (config: string, host: string): string => {
  const file = path.join(temporaryDirectory(), "config");
  fs.writeFileSync(file, config);
  const result = spawnSync("ssh", ["-G", "-F", file, host], { encoding: "utf8", timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

describe("managed workspace SSH config", () => {
  it("round-trips combinations of OpenSSH-significant path characters", () => {
    const server = target("http://mini", 2222);
    const fragments = ["space ", '"', "'", "\\", "%", "%Z", "#", "="];
    // Exhaust the two-fragment grammar rather than adding a property-test dependency.
    for (const first of fragments)
      for (const second of fragments) {
        const identity = `/tmp/key-${first}${second}`;
        const config = managedWorkspaceSshBlock(server, identity);
        expect(configuredWorkspaceSshIdentityFile(config, server)).toBe(identity);
        expect(effectiveConfig(config, server.alias)).toContain(
          `identityfile ${identity.replaceAll("%", "%%")}\n`,
        );
      }
  });

  it("refuses to move a relocated scoped block when its tail would acquire another Host scope", () => {
    const server = target("http://mini", 2222);
    const config = `Host unrelated\n${managedWorkspaceSshBlock(server, null)} ServerAliveInterval 13\n`;
    expect(reconcileWorkspaceSshConfig(config, server, null).ok).toBe(false);
  });

  it("does not trust nested Host directives inside another block's managed markers", () => {
    const server = target("http://mini", 2222);
    const other = target("http://other", 2200);
    const poisoned = managedWorkspaceSshBlock(other, null).replace(
      "  Port 2200",
      "  Host *\n  Port 2200",
    );
    const config = poisoned + managedWorkspaceSshBlock(server, null);
    expect(
      inspectWorkspaceSshReadiness({
        config,
        target: server,
        key: { publicKey: "", identityFile: null, fingerprint: "test", source: "agent" },
        registeredFingerprints: ["test"],
      }).ready,
    ).toBe(false);
  });
  it("moves old appended blocks ahead of defaults and preserves other servers and Match scopes", () => {
    const server = target("http://mend-mini:3105", 2222);
    const other = target("https://other.example.test", 2244);
    const oldBlock = managedWorkspaceSshBlock(
      { ...server, hostname: "stale", port: 22 },
      null,
    ).replace("Host *\n# <<<", "# <<<");
    const original = `ServerAliveInterval 19\nHost *\n HostName fallback\n Port 2200\n${managedWorkspaceSshBlock(other, null)}${oldBlock}Host unrelated\n User git\nMatch originalhost unrelated\n Compression yes\nMatch originalhost never\n ServerAliveInterval 999\n`;
    const reconciled = reconcileWorkspaceSshConfig(original, server, null);
    if (!reconciled.ok) throw reconciled.error;
    expect(effectiveConfig(reconciled.value, server.alias)).toContain("hostname mend-mini\n");
    expect(effectiveConfig(reconciled.value, server.alias)).toContain("port 2222\n");
    for (const alias of [other.alias, "unrelated", "never", "random"]) {
      expect(effectiveConfig(reconciled.value, alias)).toBe(effectiveConfig(original, alias));
    }
    expect(reconcileWorkspaceSshConfig(reconciled.value, server, null)).toEqual(reconciled);
  });

  it("does not move a legacy block if trailing directives would change scope", () => {
    const server = target("http://mend-mini:3105", 2222);
    const oldBlock = managedWorkspaceSshBlock(server, null).replace("Host *\n# <<<", "# <<<");
    const config = `Host unrelated\n User git\n${oldBlock}  Compression yes\n`;
    expect(reconcileWorkspaceSshConfig(config, server, null).ok).toBe(false);
  });

  it("keeps original global, Host and Match policy across repeated multi-server setup", () => {
    const servers = [
      target("https://first.example.test", 2201),
      target("https://second.example.test", 2202),
    ];
    const original =
      "Port 2200\nUser user-global\nHost unrelated\n HostName custom\nMatch originalhost unrelated\n Compression yes\nHost *\n ServerAliveInterval 41\n";
    let config = original;
    for (const server of [...servers, ...servers]) {
      const result = reconcileWorkspaceSshConfig(config, server, null);
      if (!result.ok) throw result.error;
      config = result.value;
    }
    for (const server of servers) {
      const effective = effectiveConfig(config, server.alias);
      expect(effective).toContain(`hostname ${server.hostname}\n`);
      expect(effective).toContain(`port ${server.port}\n`);
      expect(effective).toContain("user user-global\n");
      expect(
        inspectWorkspaceSshReadiness({
          config,
          target: server,
          key: { publicKey: "", identityFile: null, fingerprint: "test", source: "agent" },
          registeredFingerprints: ["test"],
        }).ready,
      ).toBe(true);
    }
    for (const alias of ["unrelated", "random"]) {
      expect(effectiveConfig(config, alias)).toBe(effectiveConfig(original, alias));
    }
  });

  it("never calls an appended exact block configured when earlier directives can win", () => {
    const server = target("http://mend-mini:3105", 2222);
    const config = `Host *\n HostName wrong\n${managedWorkspaceSshBlock(server, null)}`;
    expect(
      inspectWorkspaceSshReadiness({
        config,
        target: server,
        key: { publicKey: "", identityFile: null, fingerprint: "test", source: "agent" },
        registeredFingerprints: ["test"],
      }).configReady,
    ).toBe(false);
  });

  it.each(["\n", "\r", "\t", "\0", "\x7f", "\u0085", "${HOME}"])(
    "rejects unsafe identity input %j before writing",
    (unsafe) => {
      const configFile = path.join(temporaryDirectory(), "config");
      const existing = "Host unrelated\n User git\n";
      fs.writeFileSync(configFile, existing);
      expect(
        writeWorkspaceSshConfig(configFile, target("http://mini", 2222), `/tmp/key${unsafe}`).ok,
      ).toBe(false);
      expect(fs.readFileSync(configFile, "utf8")).toBe(existing);
    },
  );
  it("wins over earlier Host * and global values without changing unrelated hosts", () => {
    const server = target("http://mend-mini:3105", 2222);
    const existing =
      "Port 2200\nServerAliveInterval 17\nHost *\n HostName wrong-host\nHost unrelated\n User git\nMatch originalhost unrelated\n Compression yes\n";
    const reconciled = reconcileWorkspaceSshConfig(existing, server, null);
    if (!reconciled.ok) throw reconciled.error;
    const effective = effectiveConfig(reconciled.value, server.alias);
    expect(effective).toContain("hostname mend-mini\n");
    expect(effective).toContain("port 2222\n");
    expect(effectiveConfig(reconciled.value, "unrelated")).toBe(
      effectiveConfig(existing, "unrelated"),
    );
  });

  it("quotes an identity with spaces, quotes, backslashes and literal percent tokens", () => {
    const server = target("http://mend-mini:3105", 2222);
    const identity = '/tmp/key space/quote"slash\\percent%Z';
    const reconciled = reconcileWorkspaceSshConfig("", server, identity);
    if (!reconciled.ok) throw reconciled.error;
    expect(effectiveConfig(reconciled.value, server.alias)).toContain(
      `identityfile ${identity.replaceAll("%", "%%")}\n`,
    );
    expect(configuredWorkspaceSshIdentityFile(reconciled.value, server)).toBe(identity);
  });
  it("is idempotent on disk and preserves hand-written config", () => {
    const root = temporaryDirectory();
    const configFile = path.join(root, ".ssh", "config");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "Host github.com\n  User git\n");
    const server = target("http://mend-mini:3105", 2222);

    expect(writeWorkspaceSshConfig(configFile, server, null).ok).toBe(true);
    const first = fs.readFileSync(configFile, "utf8");
    expect(writeWorkspaceSshConfig(configFile, server, null).ok).toBe(true);
    expect(fs.readFileSync(configFile, "utf8")).toBe(first);
    expect(first).toContain("Host github.com\n  User git");
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(configFile)).mode & 0o777).toBe(0o700);
  });

  it("keeps separate managed aliases for separate Mend servers", () => {
    const root = temporaryDirectory();
    const configFile = path.join(root, ".ssh", "config");
    const first = target("http://mini-one:3105", 2222);
    const second = target("https://mini-two.example.test", 2244);

    expect(writeWorkspaceSshConfig(configFile, first, null).ok).toBe(true);
    expect(writeWorkspaceSshConfig(configFile, second, null).ok).toBe(true);
    const config = fs.readFileSync(configFile, "utf8");
    expect(config).toContain(`Host ${first.alias}`);
    expect(config).toContain(`Host ${second.alias}`);
    expect(first.alias).not.toBe(second.alias);
  });

  it("replaces stale host and port values for the same server identity", () => {
    const server = target("http://mend-mini:3105", 2222);
    const stale = managedWorkspaceSshBlock({ ...server, hostname: "old-host", port: 22 }, null);
    const reconciled = reconcileWorkspaceSshConfig(stale, server, null);
    if (!reconciled.ok) throw reconciled.error;
    expect(reconciled.value).toContain("HostName mend-mini");
    expect(reconciled.value).toContain("Port 2222");
    expect(reconciled.value).not.toContain("old-host");
  });

  it("migrates the old global managed block but leaves a hand-written mend-ws host", () => {
    const legacy = [
      "Host mend-ws",
      "  ProxyJump bastion",
      "# >>> mend workspace ssh (managed by `mend ssh setup`) >>>",
      "Host mend-ws",
      "  HostName old-managed-host",
      "# <<< mend workspace ssh <<<",
      "",
    ].join("\n");
    const server = target("http://mend-mini:3105", 2222);
    const reconciled = reconcileWorkspaceSshConfig(legacy, server, null);
    if (!reconciled.ok) throw reconciled.error;
    expect(reconciled.value).toContain("Host mend-ws\n  ProxyJump bastion");
    expect(reconciled.value).not.toContain("old-managed-host");
    expect(reconciled.value).toContain(`Host ${server.alias}`);
  });

  it("refuses to overwrite a hand-written block that uses the generated alias", () => {
    const server = target("http://mend-mini:3105", 2222);
    const reconciled = reconcileWorkspaceSshConfig(
      `Host ${server.alias}\n  HostName custom\n`,
      server,
      null,
    );
    expect(reconciled.ok).toBe(false);
    if (reconciled.ok) return;
    expect(reconciled.error.message).toContain("left it unchanged");
  });
});

const generateKey = (privatePath: string): void => {
  const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", privatePath], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(result.status, result.stderr).toBe(0);
};

const isolatedAgent = (): void => {
  const socket = path.join(temporaryDirectory(), "agent.sock");
  const started = spawnSync("ssh-agent", ["-s", "-a", socket], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(started.status, started.stderr).toBe(0);
  const pid = /SSH_AGENT_PID=(\d+);/.exec(started.stdout)?.[1];
  if (pid === undefined) throw new Error("No isolated agent PID");
  agentPids.push(Number(pid));
  vi.stubEnv("SSH_AUTH_SOCK", socket);
};

const addKey = (privatePath: string): void => {
  const result = spawnSync("ssh-add", [privatePath], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SSH_ASKPASS_REQUIRE: "never" },
  });
  expect(result.status, result.stderr).toBe(0);
};

describe("workspace SSH key identity", () => {
  it("resolves ~/ identities against the client home", () => {
    const home = temporaryDirectory();
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const privatePath = path.join(home, "my-key");
    generateKey(privatePath);
    const picked = pickWorkspaceSshKey({
      configHome: home,
      explicitKeyPath: "~/my-key",
      create: false,
    });
    if (!picked.ok) throw picked.error;
    expect(picked.value?.identityFile).toBe(privatePath);
  });

  it("rejects private files OpenSSH cannot use without changing their permissions", () => {
    const root = temporaryDirectory();
    const privatePath = path.join(root, "my-key");
    generateKey(privatePath);
    fs.chmodSync(privatePath, 0o644);
    expect(
      pickWorkspaceSshKey({ configHome: root, explicitKeyPath: privatePath, create: false }).ok,
    ).toBe(false);
    expect(fs.statSync(privatePath).mode & 0o777).toBe(0o644);
  });
  it("resolves relative explicit keys before persisting, including a literal %Z", () => {
    const root = temporaryDirectory();
    const privatePath = path.join(root, 'key space %Z "quote" \\slash');
    generateKey(privatePath);
    const key = pickWorkspaceSshKey({
      configHome: root,
      explicitKeyPath: path.relative(process.cwd(), privatePath),
      create: true,
    });
    if (!key.ok || key.value === null) throw new Error("Expected explicit key");
    expect(key.value.identityFile).toBe(privatePath);
    const server = target("http://mini", 2222);
    const config = managedWorkspaceSshBlock(server, key.value.identityFile);
    expect(configuredWorkspaceSshIdentityFile(config, server)).toBe(privatePath);
    expect(effectiveConfig(config, server.alias)).toContain(
      `identityfile ${privatePath.replaceAll("%", "%%")}\n`,
    );
    const file = path.join(root, "config");
    fs.writeFileSync(file, config);
    // -G does not expand percent tokens. A no-network proxy also exercises runtime expansion.
    const probe = spawnSync(
      "ssh",
      [
        "-vv",
        "-F",
        file,
        "-o",
        "ProxyCommand=true",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        server.alias,
      ],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(probe.error).toBeUndefined();
    // Older OpenSSH versions load the identity before this proxy closes, but log no fingerprint.
    // A nonnegative type proves loading; OpenSSH doubles backslashes in diagnostic paths.
    const loadedIdentityPaths = Array.from(
      probe.stderr.matchAll(/^debug1: identity file (.+) type \d+\r?$/gm),
      ([, identity]) => identity,
    );
    expect(loadedIdentityPaths, probe.stderr).toContain(privatePath.replaceAll("\\", "\\\\"));
    expect(probe.stderr).not.toContain("unknown key %");
  });

  it("requires the selected public key in the agent, not its first unrelated identity", () => {
    const root = temporaryDirectory();
    const selected = path.join(root, "selected");
    const unrelated = path.join(root, "unrelated");
    generateKey(selected);
    generateKey(unrelated);
    isolatedAgent();
    addKey(unrelated);
    const saved = fs.readFileSync(selected);
    fs.unlinkSync(selected);
    expect(
      pickWorkspaceSshKey({ configHome: root, explicitKeyPath: selected, create: false }).ok,
    ).toBe(false);
    fs.writeFileSync(selected, saved, { mode: 0o600 });
    addKey(selected);
    fs.unlinkSync(selected);
    const picked = pickWorkspaceSshKey({
      configHome: root,
      explicitKeyPath: `${selected}.pub`,
      create: false,
    });
    if (!picked.ok) throw picked.error;
    expect(picked.value?.identityFile).toBe(`${selected}.pub`);
    expect(picked.value?.publicKey).toBe(fs.readFileSync(`${selected}.pub`, "utf8").trim());
  });

  it("accepts encrypted private keys only while their matching identity is unlocked in the agent", () => {
    const root = temporaryDirectory();
    const selected = path.join(root, "encrypted");
    generateKey(selected);
    isolatedAgent();
    addKey(selected);
    const encrypted = spawnSync(
      "ssh-keygen",
      ["-p", "-P", "", "-N", "test-only-passphrase", "-f", selected],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(encrypted.status, encrypted.stderr).toBe(0);
    const bytes = fs.readFileSync(selected);
    const picked = pickWorkspaceSshKey({
      configHome: root,
      explicitKeyPath: selected,
      create: false,
    });
    if (!picked.ok) throw picked.error;
    expect(picked.value?.identityFile).toBe(`${selected}.pub`);
    vi.stubEnv("SSH_AUTH_SOCK", "");
    expect(
      pickWorkspaceSshKey({ configHome: root, explicitKeyPath: selected, create: true }).ok,
    ).toBe(false);
    expect(fs.readFileSync(selected)).toEqual(bytes);
  });

  it("pins a first-setup agent key and refuses to silently switch on later setup", () => {
    const root = temporaryDirectory();
    const selected = path.join(root, "selected");
    const unrelated = path.join(root, "unrelated");
    generateKey(selected);
    generateKey(unrelated);
    isolatedAgent();
    addKey(selected);
    const picked = pickWorkspaceSshKey({ configHome: root, create: true });
    if (!picked.ok || picked.value === null) throw new Error("Expected agent key");
    expect(picked.value.source).toBe("agent");
    expect(picked.value.identityFile).toMatch(/\.pub$/);
    const server = target("http://mini", 2222);
    const config = managedWorkspaceSshBlock(server, picked.value.identityFile);
    const identity = configuredWorkspaceSshIdentityFile(config, server);
    const rerun = pickWorkspaceSshKey({
      configHome: root,
      configuredIdentityFile: identity,
      create: true,
    });
    if (!rerun.ok) throw rerun.error;
    expect(rerun.value?.fingerprint).toBe(picked.value.fingerprint);
    // Swap to a second isolated agent; never clear or inspect the user's agent.
    isolatedAgent();
    addKey(unrelated);
    expect(
      pickWorkspaceSshKey({ configHome: root, configuredIdentityFile: identity, create: true }).ok,
    ).toBe(false);
  });

  it("keeps dedicated private keys on normal reruns and derives a missing public half", () => {
    const root = temporaryDirectory();
    const picked = pickWorkspaceSshKey({ configHome: root, create: true });
    if (!picked.ok || picked.value?.identityFile == null) throw new Error("Expected key");
    const identity = picked.value.identityFile;
    const bytes = fs.readFileSync(identity);
    fs.unlinkSync(`${identity}.pub`);
    isolatedAgent();
    const unrelated = path.join(root, "unrelated");
    generateKey(unrelated);
    addKey(unrelated);
    const rerun = pickWorkspaceSshKey({ configHome: root, create: true });
    if (!rerun.ok) throw rerun.error;
    expect(rerun.value?.fingerprint).toBe(picked.value.fingerprint);
    expect(fs.readFileSync(identity)).toEqual(bytes);
  });

  it("rejects a mismatched public/private pair without rewriting either file", () => {
    const root = temporaryDirectory();
    const selected = path.join(root, "selected");
    const other = path.join(root, "other");
    generateKey(selected);
    generateKey(other);
    fs.copyFileSync(`${other}.pub`, `${selected}.pub`);
    expect(
      pickWorkspaceSshKey({ configHome: root, explicitKeyPath: selected, create: true }).ok,
    ).toBe(false);
  });
  it("rejects an orphan public key without an agent", () => {
    vi.stubEnv("SSH_AUTH_SOCK", "");
    const root = temporaryDirectory();
    const generated = pickWorkspaceSshKey({ configHome: root, create: true });
    if (!generated.ok || generated.value?.identityFile == null)
      throw new Error("Expected generated key");
    fs.unlinkSync(generated.value.identityFile);
    expect(
      pickWorkspaceSshKey({
        configHome: root,
        configuredIdentityFile: generated.value.identityFile,
        create: false,
      }).ok,
    ).toBe(false);
  });
  it("requires this client's exact key and config, not any registered key and block", () => {
    const publicKey = "ssh-ed25519 AQIDBA== laptop";
    const fingerprint = workspaceSshPublicKeyFingerprint(publicKey);
    if (!fingerprint.ok) throw fingerprint.error;
    const key = {
      publicKey,
      identityFile: null,
      source: "agent" as const,
      fingerprint: fingerprint.value,
    };
    const server = target("http://mend-mini:3105", 2222);
    const config = managedWorkspaceSshBlock(server, null);

    expect(
      inspectWorkspaceSshReadiness({
        config,
        target: server,
        key,
        registeredFingerprints: ["SHA256:some-other-machine"],
      }),
    ).toEqual({ ready: false, configReady: true, keyRegistered: false });
    expect(
      inspectWorkspaceSshReadiness({
        config,
        target: server,
        key,
        registeredFingerprints: [fingerprint.value],
      }).ready,
    ).toBe(true);
  });

  it("uses real ssh-keygen output and reads the resulting key from disk", () => {
    vi.stubEnv("SSH_AUTH_SOCK", "");
    const root = temporaryDirectory();
    const picked = pickWorkspaceSshKey({ configHome: root, create: true });
    if (!picked.ok) throw picked.error;
    expect(picked.value?.source).toBe("generated");
    expect(picked.value?.fingerprint).toMatch(/^SHA256:/);
    expect(fs.existsSync(path.join(root, "ssh", "id_ed25519"))).toBe(true);
    if (picked.value === null) throw new Error("Expected a generated key.");
    const server = target("http://mend-mini:3105", 2222);
    const configured = managedWorkspaceSshBlock(server, picked.value.identityFile);
    const reused = pickWorkspaceSshKey({
      configHome: temporaryDirectory(),
      configuredIdentityFile: configuredWorkspaceSshIdentityFile(configured, server),
      create: false,
    });
    if (!reused.ok) throw reused.error;
    expect(reused.value?.fingerprint).toBe(picked.value.fingerprint);
    const recovered = pickWorkspaceSshKey({
      configHome: root,
      configuredIdentityFile: path.join(root, "removed-key"),
      create: false,
    });
    expect(recovered.ok).toBe(false);
    expect(readWorkspaceSshConfig(path.join(root, ".ssh", "missing")).ok).toBe(true);
  });
});

describe("stripManagedWorkspaceSshBlocks", () => {
  const server = parseWorkspaceSshTarget({
    serverUrl: "http://mend.example:3105",
    publishedPort: 2222,
  });
  const other = parseWorkspaceSshTarget({
    serverUrl: "http://other.example:3105",
    publishedPort: 2222,
  });
  if (!server.ok || !other.ok) throw new Error("targets");

  it("removes every managed block, current and legacy, and keeps the rest byte for byte", () => {
    const hand = "Host unrelated\n  HostName unrelated.example\n  ServerAliveInterval 13\n";
    const legacy =
      "# >>> mend workspace ssh (managed by `mend ssh setup`) >>>\nHost mend-ws\n  HostName old.example\nHost *\n# <<< mend workspace ssh <<<\n";
    const config = `${managedWorkspaceSshBlock(server.value, null)}${managedWorkspaceSshBlock(other.value, null)}${legacy}${hand}`;
    const stripped = stripManagedWorkspaceSshBlocks(config);
    expect(stripped.ok).toBe(true);
    if (!stripped.ok) return;
    expect(stripped.value.removed).toBe(3);
    expect(stripped.value.config).toBe(hand);
  });

  it("leaves a config without managed blocks alone", () => {
    const stripped = stripManagedWorkspaceSshBlocks("Host a\n  HostName a.example\n");
    expect(stripped.ok && stripped.value).toEqual({
      config: "Host a\n  HostName a.example\n",
      removed: 0,
    });
  });

  it("refuses an unterminated block like reconciliation does", () => {
    const broken = managedWorkspaceSshBlock(server.value, null).split("# <<<")[0] ?? "";
    expect(stripManagedWorkspaceSshBlocks(broken).ok).toBe(false);
  });
});
