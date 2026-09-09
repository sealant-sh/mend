import { access } from "node:fs/promises";
import * as net from "node:net";

const checkHttp = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
  if (response.status >= 500) throw new Error(`${url} returned ${String(response.status)}`);
};

const checkTcp = (port) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(2_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`127.0.0.1:${String(port)} timed out`));
    });
    socket.once("error", reject);
  });

try {
  await access("/run/mend-bundle/ready");
  await Promise.all([
    checkHttp("http://127.0.0.1:3105/api/health"),
    checkHttp("http://127.0.0.1:4000/healthz"),
    checkTcp(2222),
  ]);
} catch (error) {
  console.error(`[health] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
