import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  renderGate,
  renderMembers,
  renderOrganizations,
  scanFolder,
  uploadBatches,
} from "./organization.ts";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const startFakeMend = async (answer: (request: Recorded) => { status: number; body: unknown }) => {
  const recorded: Array<Recorded> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on("end", () => {
      const entry = {
        method: request.method ?? "GET",
        url: request.url ?? "/",
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      recorded.push(entry);
      const { status, body } = answer(entry);
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    recorded,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
};

const runCli = async (url: string, args: ReadonlyArray<string>) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-organization-test-"));
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, "config"),
      MEND_URL: url,
      MEND_TOKEN: "token",
      MEND_DETACH_KEY: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    const [code] = await once(child, "close");
    return { code: typeof code === "number" ? code : null, stdout, stderr };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};

const organization = (role: "owner" | "member", operator = false) => ({
  organization: { id: "org-1", name: "Acme" },
  userId: "alice",
  role,
  operator,
  memberCount: 2,
  mountDelivery: "bind",
});

describe("members", () => {
  it("marks you and aligns the roster", () => {
    expect(
      renderMembers(organization("owner"), [
        {
          userId: "alice",
          name: "Alice",
          email: "a@acme.dev",
          role: "owner",
          joinedAt: "2026-09-01T10:00:00Z",
        },
        {
          userId: "sam",
          name: "Sam",
          email: "sam@acme.dev",
          role: "member",
          joinedAt: "2026-09-02T10:00:00Z",
        },
      ]),
    ).toEqual([
      "Acme · 2 members",
      "▸ Alice  a@acme.dev    owner   joined 2026-09-01",
      "  Sam    sam@acme.dev  member  joined 2026-09-02",
    ]);
  });
});

const staged = (name: string, size: number) => ({ path: name, size });

describe("folder push", () => {
  it("sends files relative to the directory, skipping version control, symlinks and oversize files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-folder-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "docs"));
      fs.mkdirSync(path.join(dir, ".git"));
      fs.writeFileSync(path.join(dir, "docs", "a.md"), "a");
      fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");
      fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(1024 * 1024 + 1));
      fs.symlinkSync(path.join(dir, "docs", "a.md"), path.join(dir, "link.md"));
      const scanned = scanFolder(dir);
      expect(scanned.files.map((file) => file.path)).toEqual(["docs/a.md"]);
      expect(scanned.skipped).toEqual([
        { path: ".git", reason: "skipped" },
        { path: "big.bin", reason: "over 1 MiB" },
        { path: "link.md", reason: "symlink" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("packs files into requests under the cap", () => {
    expect(
      uploadBatches([staged("a", 3), staged("b", 3), staged("c", 3)], 6).map((batch) =>
        batch.map((entry) => entry.path),
      ),
    ).toEqual([["a", "b"], ["c"]]);
  });
});

describe("the commands against a server", () => {
  it("invite prints the link and its limits for an owner, and refuses a member", async () => {
    let role: "owner" | "member" = "owner";
    const fake = await startFakeMend((request) =>
      request.url === "/api/organization"
        ? { status: 200, body: organization(role) }
        : {
            status: 200,
            body: {
              path: "/join/tok",
              token: "tok",
              invitation: { expiresAt: "2026-09-24T10:00:00Z" },
            },
          },
    );
    try {
      const owner = await runCli(fake.url, [
        "invite",
        "--role",
        "owner",
        "--email",
        "sam@acme.dev",
      ]);
      expect(owner.code).toBe(0);
      expect(owner.stdout).toContain(`${fake.url}/join/tok`);
      expect(owner.stdout).toContain("works once · owner · for sam@acme.dev · expires 2026-09-24");
      expect(fake.recorded.at(-1)?.body).toEqual({ role: "owner", email: "sam@acme.dev" });

      role = "member";
      const member = await runCli(fake.url, ["invite"]);
      expect(member.code).toBe(1);
      expect(member.stderr).toContain("only an owner can invite");
    } finally {
      await fake.close();
    }
  });

  it("session share turns shared control on for the one session the prefix names", async () => {
    const fake = await startFakeMend((request) =>
      request.url.startsWith("/api/sessions?")
        ? {
            status: 200,
            body: [
              { id: "3f2a0001", harness: "codex" },
              { id: "9b000002", harness: "claude" },
            ],
          }
        : { status: 200, body: {} },
    );
    try {
      const result = await runCli(fake.url, ["session", "share", "3f2a", "on"]);
      expect(result.code).toBe(0);
      expect(fake.recorded.at(-1)).toEqual({
        method: "PUT",
        url: "/api/sessions/3f2a0001/shared-control",
        body: { enabled: true },
      });
    } finally {
      await fake.close();
    }
  });

  it("adopt sends the visibility it was asked for, private by default", async () => {
    const fake = await startFakeMend(() => ({
      status: 200,
      body: { name: "api", storePath: "/store/api", defaultBranch: "main", gitAuthMode: "ambient" },
    }));
    try {
      await runCli(fake.url, ["adopt", "https://example.invalid/acme/api.git"]);
      await runCli(fake.url, ["adopt", "https://example.invalid/acme/api.git", "--shared"]);
      expect(
        fake.recorded.map((entry) =>
          typeof entry.body === "object" && entry.body !== null && "visibility" in entry.body
            ? entry.body.visibility
            : null,
        ),
      ).toEqual(["private", "shared"]);
    } finally {
      await fake.close();
    }
  });
});

describe("operator", () => {
  it("prints the gate item by item and says what multi still needs", () => {
    const lines = renderGate([
      { id: "source-policy", ok: true, detail: "tenant source policy", fix: null },
      {
        id: "daemon-declares-sizes",
        ok: false,
        detail: "sealantd sizes only multipart uploads",
        fix: "a newer sealantd",
      },
    ]);
    expect(lines).toEqual([
      "✓ source-policy          tenant source policy",
      "· daemon-declares-sizes  sealantd sizes only multipart uploads · a newer sealantd",
      "1 of 2 items open; MEND_TENANCY=multi refuses to start",
    ]);
  });

  it("lists organizations and says when one has no owner", () => {
    expect(
      renderOrganizations([
        { organization: { id: "o1", name: "Acme", createdAt: "" }, memberCount: 3, ownerCount: 1 },
        {
          organization: { id: "o2", name: "Globex", createdAt: "" },
          memberCount: 1,
          ownerCount: 0,
        },
      ]),
    ).toEqual(["Acme    3 members · 1 owner", "Globex  1 member · no owner"]);
  });

  it("prints a reset link for the operator and refuses anyone else before asking for one", async () => {
    let operator = true;
    const fake = await startFakeMend((request) =>
      request.url === "/api/operator/organizations"
        ? operator
          ? { status: 200, body: [] }
          : { status: 404, body: { _tag: "NotFound", id: "operator" } }
        : { status: 200, body: { path: "/reset/tok", expiresAt: "2026-09-18T10:00:00Z" } },
    );
    try {
      const issued = await runCli(fake.url, ["operator", "reset-link", "sam@acme.dev"]);
      expect(issued.code).toBe(0);
      expect(issued.stdout).toContain(`${fake.url}/reset/tok`);
      expect(fake.recorded.at(-1)).toEqual({
        method: "POST",
        url: "/api/operator/password-resets",
        body: { email: "sam@acme.dev" },
      });

      operator = false;
      const before = fake.recorded.length;
      const refused = await runCli(fake.url, ["operator", "reset-link", "sam@acme.dev"]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("not the operator");
      expect(fake.recorded.slice(before).map((entry) => entry.url)).toEqual([
        "/api/operator/organizations",
      ]);
    } finally {
      await fake.close();
    }
  });
});
