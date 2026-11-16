import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Other programs on the machine may probe any new loopback listener (T3 Code's port discovery
 * sends `GET /`), so the fake hands the test only requests on Mend's API.
 */
export const startFakeMend = async (handle: Handler) => {
  const server = createServer((request, response) =>
    request.url?.startsWith("/api/") === true ? handle(request, response) : response.end(),
  );
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

/** The CLI as a user runs it, with a home of its own so the machine's own config cannot leak in. */
export const runCli = async (
  url: string,
  args: ReadonlyArray<string>,
  options: { readonly token?: string } = {},
) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-pair-test-"));
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    MEND_URL: url,
    MEND_DETACH_KEY: "none",
    MEND_TOKEN: options.token,
  };
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env,
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
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
};
