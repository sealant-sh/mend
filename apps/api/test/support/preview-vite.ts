import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer, type Plugin } from "vite";

const APP = fileURLToPath(new URL("../fixtures/preview/vite-app", import.meta.url));

export interface ViteFixture {
  readonly port: number;
  readonly edit: (text: string) => Promise<void>;
  readonly stop: () => Promise<void>;
}

const addWideGraph = async (root: string, modules: number) => {
  await mkdir(join(root, "src/wide"));
  const names = Array.from({ length: modules }, (_, index) => `m${index}`);
  await Promise.all(
    names.map((name, index) =>
      writeFile(join(root, `src/wide/${name}.js`), `export const value = ${index};\n`),
    ),
  );
  await writeFile(
    join(root, "src/wide.js"),
    [
      ...names.map((name) => `import { value as ${name} } from "./wide/${name}.js";`),
      `const values = [${names.join(", ")}];`,
      `document.querySelector("#wide").textContent = String(values.length);`,
      "",
    ].join("\n"),
  );
  const index = join(root, "index.html");
  await writeFile(
    index,
    (await readFile(index, "utf8")).replace(
      "</body>",
      `<p id="wide"></p><script type="module" src="/src/wide.js"></script></body>`,
    ),
  );
};

/** Each wide module answers after `ms`, as a cold dev server's transforms do. */
const slowWideModules = (ms: number): Plugin => ({
  name: "mend-slow-wide-modules",
  configureServer: (server) => {
    server.middlewares.use((request, _response, next) => {
      if (request.url?.startsWith("/src/wide/") === true) setTimeout(next, ms);
      else next();
    });
  },
});

export const startViteFixture = async (
  port = 0,
  modules = 0,
  moduleDelayMs = 0,
): Promise<ViteFixture> => {
  const root = await mkdtemp(join(tmpdir(), "mend-preview-vite-"));
  await cp(APP, root, { recursive: true });
  if (modules > 0) await addWideGraph(root, modules);
  const server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    logLevel: "silent",
    clearScreen: false,
    server: { host: "127.0.0.1", port, strictPort: true },
    plugins: moduleDelayMs > 0 ? [slowWideModules(moduleDelayMs)] : [],
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
