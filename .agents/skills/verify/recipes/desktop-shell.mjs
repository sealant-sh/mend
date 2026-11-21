// The rebuilt Electron desktop shell (`apps/desktop`) driven against a local verify stack:
// fresh Connect screen in light and dark → inline error on an unreachable server → connect to the
// live stack → verify `window.mendDesktop` is exposed and `window.mendShell` is withheld on the
// remote origin → Switch Server shows Recent servers and Back → Back returns to the server.
//
//   pnpm --filter @mend/desktop build && pnpm verify drive desktop --recipe desktop-shell
export default async ({ page, web, capture, note }) => {
  await page.getByRole("heading", { name: "Connect to a Mend server" }).waitFor();
  note("fresh desktop launch shows Connect to a Mend server");
  await capture("connect-light");

  // Dark theme on the Sheet Connect shell.
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(200);
  await capture("connect-dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(200);

  // Broken case: unreachable server shows an inline Sheet alert and stays on Connect.
  const input = page.getByLabel("Server address");
  await input.fill("http://127.0.0.1:1");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Couldn't connect.", { exact: true }).waitFor();
  note("unreachable server shows inline error on the Connect screen");
  await capture("connect-error-light");

  // Connect to the live stack: Electron probes /api/health and loads the server directly.
  await input.fill(web);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL((url) => url.origin === new URL(web).origin, { timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20_000 });

  const bridge = await page.evaluate(() => ({
    hasDesktop: typeof window.mendDesktop === "object" && window.mendDesktop !== null,
    hasShell: typeof window.mendShell !== "undefined",
    serverUrl: window.mendDesktop?.serverUrl ?? null,
    platform: window.mendDesktop?.platform ?? null,
  }));
  if (!bridge.hasDesktop) throw new Error("window.mendDesktop is missing on the connected server");
  if (bridge.hasShell) throw new Error("window.mendShell leaked to the remote server origin");
  if (bridge.serverUrl !== web)
    throw new Error(`expected serverUrl ${web}, got ${String(bridge.serverUrl)}`);
  note(
    `connected to ${web} · window.mendDesktop present (${bridge.platform}), window.mendShell withheld`,
  );
  await capture("connected-light");

  // Switch Server returns to the local Connect shell with Recent servers + Back.
  await page.evaluate(() => window.mendDesktop.switchServer());
  await page.getByRole("heading", { name: "Connect to a Mend server" }).waitFor();
  await page.getByRole("heading", { name: "Recent servers" }).waitFor();
  await page.getByRole("button", { name: "Back" }).waitFor();
  note("Switch Server opens Connect with Recent servers and Back");
  await capture("switch-server-light");

  // Back returns to the live Mend server.
  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForURL((url) => url.origin === new URL(web).origin, { timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20_000 });
  note("Back returned to the connected Mend server");
};
