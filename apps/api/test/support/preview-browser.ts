import { chromium, type Page } from "playwright-core";

export interface ChromiumOptions {
  readonly loopbackHosts?: ReadonlyArray<string>;
  /** Defaults to the headless shell playwright-core finds in ~/.cache/ms-playwright. */
  readonly executablePath?: string;
}

export interface ChromiumPage {
  readonly page: Page;
  readonly close: () => Promise<void>;
}

export const openInChromium = async (
  url: string,
  options: ChromiumOptions = {},
): Promise<ChromiumPage> => {
  const rules = (options.loopbackHosts ?? []).map((host) => `MAP ${host} 127.0.0.1`).join(", ");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", ...(rules === "" ? [] : [`--host-resolver-rules=${rules}`])],
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
  });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(url);
    return { page, close: () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
};
