// The new web app (apps/web) with no routes yet, signed in as the stack's first account through the
// stack's own sign-in page: home shows the not-found screen in light and dark, on a desktop and at
// phone width; a read that fails shows the error screen, and Try again recovers with a tRPC call
// from the browser; a visit with no session goes to sign-in. The pattern every route PR's recipe
// copies (SKILL.md, Drive):
//
//   pnpm verify drive new-web --recipe new-web-shell
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

export default async ({ page, web, capture, note }) => {
  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  // Whether <html> was dark when <body> first appeared, before anything painted.
  await page.addInitScript(() => {
    new MutationObserver((_, observer) => {
      if (document.body === null) return;
      window.__darkAtFirstPaint = document.documentElement.classList.contains("dark");
      observer.disconnect();
    }).observe(document, { childList: true, subtree: true });
  });
  // The person's theme, under the key the old app stores it by; the page applies it before first
  // paint, so it never flashes the other one.
  const withTheme = async (theme, path) => {
    await page.evaluate((value) => localStorage.setItem("mend-theme", value), theme);
    await page.goto(`${web}${path}`);
    const want = theme === "dark";
    if ((await dark()) !== want) throw new Error(`the page is not ${theme}`);
    if ((await page.evaluate(() => window.__darkAtFirstPaint)) !== want)
      throw new Error(`the page was not ${theme} before its first paint`);
  };
  // A page's actions on a phone are 44px touch targets. The kit's buttons animate a size change,
  // so after a resize the check waits out the transition.
  const touchTargets = async () => {
    for (const name of ["Go home", "Try again"]) {
      const control = page.getByRole(name === "Go home" ? "link" : "button", { name });
      if ((await control.count()) === 0) continue;
      let height = 0;
      for (let tries = 0; tries < 20 && height < 44; tries += 1) {
        if (tries > 0) await page.waitForTimeout(100);
        height = (await control.boundingBox())?.height ?? 0;
      }
      if (height < 44) throw new Error(`${name} is ${height}px tall on a phone, under 44px`);
    }
  };

  // Timers the recipe can move: the signed-in read is fresh for a minute, and the error below
  // needs the browser to read it again.
  await page.clock.install();

  await page.goto(`${web}/`);
  await heading("Page not found");
  if (new URL(page.url()).pathname !== "/")
    throw new Error(`a signed-in visit went to ${page.url()}`);
  await page.getByText("Mend", { exact: true }).first().waitFor();
  note("signed in, home stays at / and shows the not-found screen on the sheet, Mend on the desk");
  for (const [viewport, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await withTheme(theme, "/");
      await heading("Page not found");
      if (viewport === "phone") await touchTargets();
      await capture(`not-found-${viewport}-${theme}`);
    }
  }
  await page.setViewportSize(DESKTOP);
  await withTheme("light", "/");

  // A read that fails: the signed-in read, made stale, fails as the browser asks again on a
  // navigation.
  await page.clock.fastForward("01:05");
  await page.route("**/trpc/**", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        },
      ]),
    }),
  );
  // The router the page hydrated with (TanStack Router keeps it on `window` in a browser).
  await page.waitForFunction(() => window.__TSR_ROUTER__ !== undefined);
  await page.evaluate(() => window.__TSR_ROUTER__.navigate({ to: "/forced-error" }));
  await heading("This page didn't load");
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  note("a failed read shows the error screen with what the server said");
  // Dark as the theme module sets it, without a reload that would read the page again. The kit's
  // controls animate colour and size changes, so each capture waits for them to finish.
  const settled = () => page.waitForTimeout(500);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await page.setViewportSize(DESKTOP);
    await settled();
    await capture(`error-desktop-${theme}`);
    await page.setViewportSize(PHONE);
    await touchTargets();
    await settled();
    await capture(`error-phone-${theme}`);
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.setViewportSize(DESKTOP);

  // Try again reads it again from the browser, through the app's /trpc, and the page recovers.
  await page.unroute("**/trpc/**");
  const answered = page.waitForResponse((response) => response.url().includes("/trpc/"));
  await page.getByRole("button", { name: "Try again" }).click();
  const response = await answered;
  if (response.status() !== 200)
    throw new Error(`the browser's tRPC call answered ${response.status()}`);
  note(`Try again: the browser's tRPC call answered ${response.status()}`);
  await heading("Page not found");
  await capture("recovered-desktop-light");

  // No session: home walks to sign-in, which the new app does not have yet.
  await page.context().clearCookies();
  await page.goto(`${web}/`);
  await heading("Page not found");
  const at = new URL(page.url()).pathname;
  if (at !== "/login") throw new Error(`a signed-out visit went to ${at}, not /login`);
  note("signed out, home goes to /login, which shows the not-found screen until its route lands");
  await capture("signed-out-desktop-light");
};
