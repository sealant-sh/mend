import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const APP = fileURLToPath(new URL("../fixtures/preview/vite-app", import.meta.url));

export interface ViteFixture {
  readonly port: number;
  readonly edit: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export const startViteFixture = async (port = 0): Promise<ViteFixture> => {
  const root = await mkdtemp(join(tmpdir(), "mend-preview-vite-"));
  await cp(APP, root, { recursive: true });
  const server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "silent",
    clearScreen: false,
    server: { host: "127.0.0.1", port, strictPort: true },
  });
  await server.listen();
  const address: AddressInfo | string | null | undefined = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    await server.close();
    throw new Error("Vite is not listening on TCP");
  }
  return {
    port: address.port,
    edit: (text) =>
      writeFile(join(root, "src/message.js"), `export const message = ${JSON.stringify(text)};\n`),
    stop: async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    },
  };
};
