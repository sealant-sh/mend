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
  // The person's theme, as the old app stores it; the page applies it before first paint.
  const withTheme = async (theme, path) => {
    await page.evaluate((value) => localStorage.setItem("mend-theme", value), theme);
    await page.goto(`${web}${path}`);
    if ((await dark()) !== (theme === "dark")) throw new Error(`the page is not ${theme}`);
  };

  // Timers the recipe can move: the signed-in read is fresh for a minute, and the error below
  // needs the browser to read it again.
  await page.clock.install();

  await page.goto(`${web}/`);
  await heading("Page not found");
  if (new URL(page.url()).pathname !== "/")
    throw new Error(`a signed-in visit went to ${page.url()}`);
  note("signed in, home stays at / and shows the not-found screen");
  for (const [viewport, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await withTheme(theme, "/");
      await heading("Page not found");
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
  await page.evaluate(() => window.__TSR_ROUTER__.navigate({ to: "/forced-error" }));
  await heading("This page didn't load");
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  note("a failed read shows the error screen with what the server said");
  await capture("error-desktop-light");
  await page.setViewportSize(PHONE);
  await capture("error-phone-light");
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
