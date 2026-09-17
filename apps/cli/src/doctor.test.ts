import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { exposureCheck, formatCheck } from "./doctor.ts";

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

describe("mend doctor", () => {
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
        fix: "serve it over https and set APP_URL to that origin",
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
