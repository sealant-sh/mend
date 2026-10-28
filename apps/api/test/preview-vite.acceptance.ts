import { afterEach, expect, it } from "vitest";

import { openInChromium } from "./support/preview-browser.ts";
import { startViteFixture } from "./support/preview-vite.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

it("Chromium loads the Vite app and sees an edit through HMR without a reload", async () => {
  const vite = await startViteFixture();
  disposers.push(vite.stop);
  const { page, close } = await openInChromium(`http://localhost:${vite.port}/`);
  disposers.push(close);

  const message = page.locator("#message");
  await message.waitFor();
  expect(await message.textContent(), "the module graph rendered").toBe("hello from the fixture");
  expect(
    await message.evaluate((element) => getComputedStyle(element).color),
    "the imported CSS applied",
  ).toBe("rgb(1, 2, 3)");
  expect(
    await page
      .locator("#logo")
      .evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth),
    "the absolute /logo.svg asset loaded",
  ).toBe(32);

  await page.evaluate(() => {
    Reflect.set(window, "__firstLoad", true);
  });
  await vite.edit("edited through HMR");
  await page.waitForFunction(
    () => document.querySelector("#message")?.textContent === "edited through HMR",
    undefined,
    { timeout: 15_000 },
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "__firstLoad")),
    "the page was not reloaded",
  ).toBe(true);
});
