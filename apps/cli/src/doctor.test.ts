import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readShutdownTimeout } from "./docker-shutdown.ts";
import {
  exposureCheck,
  formatCheck,
  type LocalServerFacts,
  runChecks,
  userNamespacesCheck,
} from "./doctor.ts";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const startFakeMend = async (handle: Handler) => {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

const account = (provider: string, login: string) => ({
  id: `account-${provider}`,
  provider,
  name: "default",
  kind: "oauth",
  status: "active",
  metadata: { login },
  connectedAt: new Date(0).toISOString(),
  lastUsedAt: null,
});

/** A machine where every local fact is already true: the three CLIs, with credentials. */
const readyMachine = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-doctor-test-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  for (const command of ["claude", "codex", "gh"]) {
    const file = path.join(bin, command);
    // `gh auth token` is how main.ts reads the GitHub credential; the others are read from disk.
    fs.writeFileSync(file, "#!/bin/sh\necho gho_testtoken\n");
    fs.chmodSync(file, 0o755);
  }
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
  return { home, bin };
};

const runDoctor = async (
  url: string,
  options: { readonly token?: string; readonly ready?: boolean } = {},
) => {
  const machine =
    options.ready === true
      ? readyMachine()
      : { home: fs.mkdtempSync(path.join(os.tmpdir(), "mend-doctor-test-")), bin: null };
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: machine.home,
    XDG_CONFIG_HOME: path.join(machine.home, "config"),
    // The provider CLIs read these before HOME; the test machine owns both.
    CLAUDE_CONFIG_DIR: path.join(machine.home, ".claude"),
    CODEX_HOME: path.join(machine.home, ".codex"),
    PATH:
      machine.bin === null
        ? (process.env["PATH"] ?? "")
        : `${machine.bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
    MEND_URL: url,
    MEND_DETACH_KEY: "none",
    MEND_TOKEN: options.token,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, "doctor"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
};

const greenServer = (request: IncomingMessage, response: ServerResponse): void => {
  const routes: Record<string, unknown> = {
    "/api/health": { status: "ok", version: "0.5.0" },
    "/api/projects": [{ id: "project-1", name: "fixture" }],
    "/api/sealant/connection": {
      status: "connected",
      baseUrl: "http://127.0.0.1:4000",
      detail: null,
      checkedAt: new Date(0).toISOString(),
    },
    "/api/me/sealant": {
      sealantUserId: "user-1",
      accounts: [
        account("claude", "you@example.com"),
        account("codex", "you@example.com"),
        account("github", "you"),
      ],
    },
    "/api/machine": {
      hostname: "fixture",
      platform: "linux",
      tailnet: { status: "reachable", address: "100.64.1.2" },
      exposure: {
        declared: "private",
        originScheme: "https",
        arrivedVia: "trusted-proxy",
        addressKinds: ["loopback", "private", "cgnat"],
        gateOpen: 4,
      },
    },
  };
  const body = routes[request.url ?? ""];
  if (body === undefined) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

describe("status lines", () => {
  it("marks the state, pads the label, and ends on the command that fixes it", () => {
    expect(
      formatCheck({
        label: "codex",
        state: "todo",
        detail: "not connected",
        fix: "mend connect codex",
      }),
    ).toBe("○ codex       not connected → mend connect codex");
    expect(formatCheck({ label: "server", state: "ok", detail: "mend 0.5.0", fix: null })).toBe(
      "✓ server      mend 0.5.0",
    );
  });
});

// Each test here spawns the CLI from source: on a loaded CI runner the import graph alone can take
// longer than vitest's 5 s default.
describe("mend doctor", { timeout: 30_000 }, () => {
  it("reports every fact and exits 0 when the machine is set up", async () => {
    const fake = await startFakeMend(greenServer);
    try {
      const result = await runDoctor(fake.url, { token: "test-token", ready: true });
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain("✗");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("✓ server      ");
      expect(result.stdout).toContain("✓ signed in   token accepted");
      expect(result.stdout).toContain("✓ sealant     connected · http://127.0.0.1:4000");
      expect(result.stdout).toContain("✓ claude      connected · you@example.com");
      expect(result.stdout).toContain("✓ projects    1 adopted");
      expect(result.stdout).toContain("✓ claude cli  on PATH · credential present");
      expect(result.stdout).toContain("✓ gh cli      on PATH · credential present");
      // A report of what was declared and observed. The interface in 100.64.0.0/10 is not in it:
      // it never said who can reach the instance.
      expect(result.stdout).toContain(
        "✓ exposure    declared private · https origin · arrived via a trusted proxy · 4 gate items open → mend operator exposure",
      );
      expect(result.stdout).not.toContain("tailnet");
    } finally {
      await fake.close();
    }
  });

  it("exits 1 on a rejected token and says which command fixes it", async () => {
    const fake = await startFakeMend((request, response) => {
      if (request.url === "/api/projects") {
        response.writeHead(401).end();
        return;
      }
      greenServer(request, response);
    });
    try {
      const result = await runDoctor(fake.url, { token: "stale-token", ready: true });
      expect(result.stdout).toContain("✗ signed in   token rejected → mend login");
      expect(result.code).toBe(1);
      // A rejected token stops the reads that depend on it — nothing is guessed.
      expect(result.stdout).toContain("○ sealant     not checked");
      expect(result.stdout).toContain("○ exposure    not checked");
    } finally {
      await fake.close();
    }
  });
});

describe("the workspaces line", () => {
  it("says a host that allows rootless Docker is fine", () => {
    expect(userNamespacesCheck({ allowed: true, setting: null })).toEqual({
      label: "workspaces",
      state: "ok",
      detail: "the server's host allows rootless Docker",
      fix: null,
    });
  });

  it("fails a host that refuses user namespaces, with the command that allows them", () => {
    expect(
      userNamespacesCheck({
        allowed: false,
        setting: "kernel.apparmor_restrict_unprivileged_userns = 0",
      }),
    ).toEqual({
      label: "workspaces",
      state: "failed",
      detail: "the server's host refuses user namespaces · no workspace can start",
      fix: "on the server's host: echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system",
    });
  });
});

describe("the exposure line", () => {
  const observed = {
    declared: "loopback",
    originScheme: "http",
    arrivedVia: "direct",
    addressKinds: ["loopback"],
    gateOpen: 0,
  } as const;

  it("reports a loopback install on http as it is, with nothing to do", () => {
    expect(exposureCheck(observed)).toEqual({
      label: "exposure",
      state: "ok",
      detail: "declared loopback · http origin",
      fix: null,
    });
  });

  it("does not count gate items on an install reached from this machine only", () => {
    // Some items only ever close on an operator's statement: a laptop install would say
    // "items open" for ever, which is the tailnet line again under another name.
    expect(exposureCheck({ ...observed, gateOpen: 5 })).toEqual({
      label: "exposure",
      state: "ok",
      detail: "declared loopback · http origin",
      fix: null,
    });
    // The default declaration is `private`; APP_URL on the machine's own loopback still counts
    // as reached from this machine only, so a laptop install is not asked for https.
    expect(
      exposureCheck({ ...observed, declared: "private", originOnMachine: true, gateOpen: 5 }),
    ).toEqual({
      label: "exposure",
      state: "ok",
      detail: "declared private · http origin",
      fix: null,
    });
  });

  it("asks for https only when the instance is declared reachable beyond the machine", () => {
    for (const declared of ["private", "public"] as const) {
      expect(exposureCheck({ ...observed, declared })).toMatchObject({
        state: "todo",
        fix: "serve it over https: on the server's machine, mend server setup --edge <domain>, or mend server setup --url https://<origin> behind HTTPS you run",
      });
    }
  });

  it("points the operator at the gate when items are open, without calling anything safe", () => {
    const check = exposureCheck({
      ...observed,
      declared: "public",
      originScheme: "https",
      gateOpen: 3,
    });
    expect(check).toMatchObject({ state: "ok", fix: "mend operator exposure" });
    expect(check.detail).toBe("declared public · https origin · 3 gate items open");
    expect(`${check.detail} ${check.fix}`.toLowerCase()).not.toMatch(/safe|reachable|secure/);
  });
});

/**
 * The platform holds the same grant and refreshes it, but reports no freshness yet, so doctor reads
 * Mend's local copy and states what it observed
 * (docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md).
 */
const grantLine = async (grant: string | null) => {
  const checks = await runChecks(
    // Nothing is listening: every other check degrades, which is fine, this is about one line.
    { url: "http://127.0.0.1:9", token: null },
    { localCredential: () => null, claudeGrant: () => grant, onPath: () => false },
  );
  return checks.find((check) => check.label === "grant") ?? null;
};

const grantWith = (fields: Record<string, unknown>) =>
  JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01", ...fields } });

describe("the claude grant line", () => {
  it("says when the grant expires while it is good", async () => {
    const line = await grantLine(
      grantWith({ refreshTokenExpiresAt: Date.now() + 20 * 86_400_000 }),
    );
    expect(line?.state).toBe("ok");
    expect(line?.detail).toContain("Mend's own · expires ");
    expect(line?.fix).toBeNull();
  });

  it("names the day it expired, with the one command that fixes it", async () => {
    const line = await grantLine(grantWith({ refreshTokenExpiresAt: Date.now() - 86_400_000 }));
    expect(line?.state).toBe("todo");
    expect(line?.detail).toMatch(/^expired \d{4}-\d{2}-\d{2}$/);
    expect(line?.fix).toBe("mend connect claude");
  });

  /** A grant Claude cleared after `invalid_grant` keeps its shape and loses its tokens. */
  it("reports a cleared grant as signed out, and an unreadable one as failed", async () => {
    const cleared = await grantLine(JSON.stringify({ claudeAiOauth: { refreshToken: "" } }));
    expect({ state: cleared?.state, detail: cleared?.detail }).toEqual({
      state: "failed",
      detail: "signed out",
    });
    const broken = await grantLine("not a credential");
    expect({ state: broken?.state, detail: broken?.detail }).toEqual({
      state: "failed",
      detail: "unreadable",
    });
  });

  /** Someone who connected with --use-my-login has no grant of Mend's own: say nothing. */
  it("prints no line at all when Mend keeps no grant", async () => {
    expect(await grantLine(null)).toBeNull();
  });
});

const dockerLine = async (
  onPath: (command: string) => boolean,
  local: LocalServerFacts | null = null,
  contexts: Array<string | null> = [],
) => {
  const checks = await runChecks(
    { url: "http://127.0.0.1:9", token: null },
    {
      localCredential: () => null,
      claudeGrant: () => null,
      onPath,
      localServer: async () => local,
      dockerShutdown: (context) => {
        contexts.push(context);
        return readShutdownTimeout({
          info: {
            operatingSystem: context === "orbstack" ? "OrbStack" : "Ubuntu 24.04.1 LTS",
            securityOptions: [],
          },
          dockerdArgv: ["/usr/bin/dockerd", "-H", "fd://"],
          readFile: () => ({ kind: "absent" }),
          home: "/home/op",
          xdgConfigHome: null,
        });
      },
    },
  );
  return checks.find((check) => check.label === "docker") ?? null;
};

/** A server `mend server setup` installed on this machine. */
const installedHere = (url: string, more: Partial<LocalServerFacts> = {}): LocalServerFacts => ({
  url,
  dockerContext: "default",
  version: "0.36.0",
  instance: "1".repeat(32),
  ...more,
});

describe("the docker line", () => {
  it("reads this machine's daemon shutdown timeout against the capture grace when docker is here", async () => {
    const line = await dockerLine((command) => command === "docker");
    expect(line === null ? null : formatCheck(line)).toBe(
      '○ docker      shutdown-timeout 15 s · dockerd default · not set in /etc/docker/daemon.json · below the 3600 s capture grace → set "shutdown-timeout": 3600 in /etc/docker/daemon.json, then restart dockerd',
    );
  });

  it("prints no docker line where docker is not on PATH", async () => {
    expect(await dockerLine(() => false)).toBeNull();
  });

  // The RC on a Mac: Docker Desktop current, the server on OrbStack. The line read Docker
  // Desktop's daemon.json and said to restart Docker Desktop.
  it("reads the daemon of the installed server's own context, not the current one", async () => {
    const contexts: Array<string | null> = [];
    const line = await dockerLine(
      (command) => command === "docker",
      installedHere("http://localhost:3115", { dockerContext: "orbstack" }),
      contexts,
    );
    expect(contexts).toEqual(["orbstack"]);
    expect(line?.detail).toContain("/home/op/.orbstack/config/docker.json");
    expect(line?.fix).toContain("restart OrbStack");
    expect(await dockerLine((command) => command === "docker", null, contexts)).not.toBeNull();
    expect(contexts).toEqual(["orbstack", null]);
  });
});

const serverLine = async (local?: string | null, url = "http://127.0.0.1:9") => {
  const checks = await runChecks(
    { url, token: "token" },
    {
      localCredential: () => null,
      claudeGrant: () => null,
      onPath: () => false,
      ...(local === undefined
        ? {}
        : { localServer: async () => (local === null ? null : installedHere(local)) }),
    },
  );
  return checks.find((check) => check.label === "server");
};

describe("the server line when the configured URL does not answer", () => {
  it("says the server on this machine moved, when it answers at its new URL", async () => {
    const mend = await startFakeMend((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ status: "ok", version: "0.36.0" }));
    });
    try {
      expect(await serverLine(mend.url)).toEqual({
        label: "server",
        state: "failed",
        detail: `cannot reach http://127.0.0.1:9 · the Mend server on this machine answers at ${mend.url}, and this CLI points at the old URL`,
        fix: `mend login --url ${mend.url}`,
      });
    } finally {
      await mend.close();
    }
  });

  it("asks for the server to be started only when nothing here answers", async () => {
    const expected = {
      label: "server",
      state: "failed",
      detail: "cannot reach http://127.0.0.1:9",
      fix: "start the Mend server (mend server start on its machine), or, if its URL changed, mend login --url <its URL>",
    };
    expect(await serverLine()).toEqual(expected);
    expect(await serverLine(null)).toEqual(expected);
    expect(await serverLine("http://127.0.0.1:10")).toEqual(expected);
  });
});

/** A fake Mend whose health reports this version and, when given, this instance. */
const fakeMendAt = (version: string, instance?: string) =>
  startFakeMend((request, response) => {
    if (request.url !== "/api/health") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok", version, ...(instance ? { instance } : {}) }));
  });

// The RC on a Mac: no cli.json, so the CLI read http://localhost:3105, where Docker Desktop's
// 0.27.4 answered, while setup had installed 0.36 on OrbStack at :3115.
describe("the server line beside a server installed on this machine", () => {
  it("says when what answers on this machine's loopback is not the server installed here", async () => {
    const other = await fakeMendAt("0.27.4");
    const installed = await fakeMendAt("0.36.0", "1".repeat(32));
    try {
      expect(await serverLine(installed.url, other.url)).toEqual({
        label: "server",
        state: "todo",
        detail: `${other.url} · mend 0.27.4 · not the server installed on this machine, which answers at ${installed.url} (mend 0.36.0)`,
        fix: `mend login --url ${installed.url}`,
      });
    } finally {
      await other.close();
      await installed.close();
    }
  });

  it("tells two installs of one version apart by their instance", async () => {
    const other = await fakeMendAt("0.36.0", "2".repeat(32));
    const installed = await fakeMendAt("0.36.0", "1".repeat(32));
    try {
      expect((await serverLine(installed.url, other.url))?.state).toBe("todo");
      // The installed server itself, reached on another loopback URL, is fine.
      const same = await fakeMendAt("0.36.0", "1".repeat(32));
      try {
        expect(await serverLine(installed.url, same.url)).toMatchObject({ state: "ok" });
      } finally {
        await same.close();
      }
    } finally {
      await other.close();
      await installed.close();
    }
  });
});
