// The rebuilt Electron desktop shell (`apps/desktop`) driven against a local verify stack:
// 1. Fresh launch on "Connect to a Mend server" (empty address, no Recent servers), light & dark.
// 2. Unreachable address keeps the window on Connect with an inline "Couldn't connect." alert.
// 3. Connecting to the local stack loads Mend's sign-in page; signing in lands in the web app with
//    `window.mendDesktop` (matching serverUrl) and no `window.mendShell`.
// 4. Switch server opens Connect with Recent servers listing the stack and a Back button; Back
//    returns to the stack still signed in.
// 5. Stopping the server behind a connected proxy triggers "Can't reach Mend" with
//    "Reconnecting… Mend will reload as soon as the server answers." and automatically reloads into
//    Mend once the server answers again.
//
//   pnpm --filter @mend/desktop build && pnpm verify drive desktop --recipe desktop-shell
import http from "node:http";

const startToggleProxy = (targetUrl) => {
  const target = new URL(targetUrl);
  const createServer = () =>
    http.createServer((request, response) => {
      const upstream = http.request(
        {
          host: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          method: request.method,
          path: request.url,
          headers: { ...request.headers, host: target.host },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("upstream unreachable");
      });
      request.pipe(upstream);
    });

  let server = null;
  let port = 0;

  const listen = () =>
    new Promise((resolve, reject) => {
      server = createServer();
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        const addr = server.address();
        if (typeof addr === "object" && addr !== null) port = addr.port;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

  const stop = () =>
    new Promise((resolve) => {
      if (server === null) {
        resolve();
        return;
      }
      const closing = server;
      server = null;
      closing.closeAllConnections?.();
      closing.close(() => resolve());
    });

  return { listen, stop };
};

export default async ({ page, web, capture, note, account }) => {
  if (!account) throw new Error("desktop-shell requires the stack's first account (--account)");

  // 1. Fresh launch: Connect to a Mend server, empty field, no Recent servers.
  await page.getByRole("heading", { name: "Connect to a Mend server" }).waitFor();
  const input = page.getByLabel("Server address");
  if ((await input.inputValue()) !== "") {
    throw new Error(
      `expected empty Server address on fresh launch, got ${await input.inputValue()}`,
    );
  }
  if ((await page.getByRole("heading", { name: "Recent servers" }).count()) !== 0) {
    throw new Error("expected no Recent servers list on fresh launch");
  }
  note("fresh launch opens Connect to a Mend server with empty address and no Recent servers");
  await capture("connect-light");

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(200);
  await capture("connect-dark");
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.waitForTimeout(200);

  // 2. Unreachable address keeps the person on Connect with inline alert.
  await input.fill("http://127.0.0.1:41999");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByText("Couldn't connect.", { exact: true }).waitFor();
  await page.getByText("Connection refused", { exact: false }).waitFor();
  note("unreachable address stays on Connect with inline Couldn't connect. alert");
  await capture("connect-error-light");

  // 3. Connect to the local stack, sign in on Mend's own web login page, verify bridge isolation.
  await input.fill(web);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL((url) => url.origin === new URL(web).origin, { timeout: 20_000 });
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await account.typePassword(page.getByLabel("Password", { exact: true }));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 20_000 });
  // Clear the welcome gate if this is the first sign-in on a fresh stack.
  if (new URL(page.url()).pathname === "/welcome") {
    const onward = page.getByRole("button", { name: "Continue to Mend" });
    if (
      await onward.waitFor({ timeout: 5_000 }).then(
        () => true,
        () => false,
      )
    ) {
      await onward.click();
      await page.waitForURL((url) => url.pathname !== "/welcome", { timeout: 15_000 });
    }
  }

  await page.getByRole("navigation").first().waitFor({ timeout: 20_000 });
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
    `signed in on ${web} (${new URL(page.url()).pathname}) · window.mendDesktop present (${bridge.platform}), window.mendShell withheld`,
  );
  await capture("signed-in-light");

  // 4. Switch server returns to Connect with Recent servers + Back; Back returns still signed in.
  await page.evaluate(() => window.mendDesktop.switchServer());
  await page.getByRole("heading", { name: "Connect to a Mend server" }).waitFor();
  await page.getByRole("heading", { name: "Recent servers" }).waitFor();
  await page.getByRole("button", { name: "Back" }).waitFor();
  note("Switch server shows Connect with Recent servers listing the stack and Back");
  await capture("switch-server-light");

  await page.getByRole("button", { name: "Back" }).click();
  await page.waitForURL((url) => url.origin === new URL(web).origin, { timeout: 20_000 });
  await page.waitForTimeout(500);
  if (new URL(page.url()).pathname === "/login") {
    throw new Error("Back returned to /login instead of keeping the signed-in session");
  }
  note(`Back returned to ${web} (${new URL(page.url()).pathname}) still signed in`);
  await capture("returned-signed-in-light");

  // 5. Server goes away while connected → Can't reach Mend offline screen → auto-reloads when back.
  const proxy = startToggleProxy(web);
  try {
    const proxyUrl = await proxy.listen();
    await page.evaluate(() => window.mendDesktop.switchServer());
    await page.getByRole("heading", { name: "Connect to a Mend server" }).waitFor();
    await page.getByLabel("Server address").fill(proxyUrl);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForURL((url) => url.origin === new URL(proxyUrl).origin, { timeout: 20_000 });

    await proxy.stop();
    await page.reload().catch(() => undefined);
    await page.getByRole("heading", { name: "Can't reach Mend" }).waitFor({ timeout: 15_000 });
    await page.getByRole("main").getByText(proxyUrl, { exact: true }).waitFor();
    await page
      .getByText("Reconnecting… Mend will reload as soon as the server answers.", { exact: true })
      .waitFor();
    note(`stopped server ${proxyUrl} shows Can't reach Mend offline screen with Reconnecting…`);
    await capture("offline-light");

    await proxy.listen();
    await page.waitForURL((url) => url.origin === new URL(proxyUrl).origin, { timeout: 20_000 });
    await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20_000 });
    note(`restarted server ${proxyUrl} and desktop automatically reloaded into Mend`);
    await capture("reconnected-light");
  } finally {
    await proxy.stop();
  }
};
