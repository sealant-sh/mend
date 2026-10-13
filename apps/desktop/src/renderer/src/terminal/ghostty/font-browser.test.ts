// @vitest-environment node
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";
import { createServer } from "vite";
import { expect, it } from "vitest";

it("rejects a loaded proportional face and accepts a loaded fixed-width face with real canvas metrics", async () => {
  const server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL("../../../../..", import.meta.url)),
    assetsInclude: ["**/*.wasm"],
    plugins: [
      {
        name: "font-test-page",
        configureServer(fixture) {
          fixture.middlewares.use((request, response, next) => {
            if (request.url !== "/font-test") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              '<!doctype html><body><script type="module" src="/src/renderer/src/terminal/ghostty/font-probe.fixture.ts"></script>',
            );
          });
        },
      },
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (address === undefined || address === null || typeof address === "string")
      throw new Error("No owned Vite port");
    const browser = await chromium.launch({ headless: true, timeout: 10_000 });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`http://127.0.0.1:${address.port}/font-test`);
      await page.waitForFunction(() => document.body.dataset.state !== undefined);
      expect(
        await page.locator("body").getAttribute("data-state"),
        await page.locator("body").innerText(),
      ).toBe("complete");
      const result: unknown = JSON.parse(await page.locator("body").innerText());
      expect(result).toMatchObject({
        loaded: Array(8).fill("loaded"),
        proportionalIsMeasured: true,
        monospaceIsMeasured: true,
        rejected: true,
        accepted: true,
      });
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}, 30_000);
