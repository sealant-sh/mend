import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { MembershipDto } from "./organization.ts";

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export const startFakeMend = async (
  answer: (request: Recorded) => { status: number; body: unknown },
) => {
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

export const runCli = async (url: string, args: ReadonlyArray<string>) => {
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

export const membership = (
  id: string,
  name: string,
  role: "owner" | "member",
  active: boolean,
): MembershipDto => ({
  organization: { id, name },
  role,
  joinedAt: id === "org-1" ? "2026-09-01T10:00:00Z" : "2026-11-08T10:00:00Z",
  active,
});

export const acmeAndGlobex = (active: "org-1" | "org-2"): ReadonlyArray<MembershipDto> => [
  membership("org-1", "Acme", "owner", active === "org-1"),
  membership("org-2", "Globex", "member", active === "org-2"),
];
