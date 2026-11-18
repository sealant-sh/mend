// The new web app's setup step Agent login (apps/web `/welcome/agent-login`, SLNT-1121), driven by
// provider-accounts.md's `accounts-list`, `connect-web` (as an API key only: Yiannis ruled on
// 17 Nov 2026 that Mend's apps take no part in a provider's sign-in) and `reconnect-state`:
//
//   pnpm verify drive new-web --recipe new-web-agent-login
//   # while it waits ("waiting for a CLI to connect"), from another terminal:
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-agent-login-connect.json
//
// - The stack's account starts with no Claude Code or Codex login (the recipe removes them). The
//   step shows `mend login --url <server>` and `mend connect claude`, each with Copy command, and
//   "Waiting for Claude Code to connect". Copy command puts the command on the clipboard. The
//   Agent segment switches to Codex's commands. Skip for now goes to /welcome/first-project (not
//   found until that step's route lands), and Continue is off.
// - A login connected from the stack's CLI (`mend connect codex|claude --from-stdin`, the CLI the
//   stack built from this commit) lands on the open page by itself, through the `user` event: no
//   reload. Codex reads connected, Continue opens and Skip goes; Claude Code reads connected too.
//   The platform refuses the fake Claude login only when a session uses it, so the refused state
//   (`reconnect-state`) is drawn from a logins read changed in the browser (`fixture-…`). Removing
//   the Claude login through the API puts the page back to waiting, again without a reload.
// - An API key for Claude Code, from "Use an API key instead": the other issuer's key is refused on the page; a
//   Claude setup token pasted as a key is refused by the platform with its own words; a fake
//   Anthropic key is saved ("Saving the key" held, then saved). The field is empty after every
//   send, so no part of a key stays on the page.
// - A page whose reads fail, with Try again.
//
// Every state is captured light and dark, at 1280px and 390px. At the end the recipe removes the
// Claude API key it saved; the fake Codex login from the CLI batch stays, as new-web-composer
// expects.

import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

export default async ({ page, web, capture, note, typeSecret, registerSecret, account }) => {
  if (account === null)
    throw new Error("this recipe signs in on the new page: run it with --account");

  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const settled = () => page.waitForTimeout(500);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const visibleText = (text) => page.getByText(text, { exact: false }).filter({ visible: true });
  const path = () => new URL(page.url()).pathname;
  const open = async (to) => {
    await page.goto("about:blank");
    await page.goto(`${web}${to}`);
  };
  const keyField = (issuer) => page.getByLabel(`${issuer} API key`, { exact: true });
  const continueOpen = async (want) => {
    const disabled = await button("Continue").isDisabled();
    if (disabled === want) throw new Error(`Continue is ${disabled ? "disabled" : "enabled"}`);
  };

  // A page's buttons on a phone are 44px touch targets. A link inside a sentence is text, not one.
  const touchTargets = async () => {
    for (const control of await page.locator("main button, main a[href]").all()) {
      if (!(await control.isVisible())) continue;
      if (await control.evaluate((element) => element.closest("p") !== null)) continue;
      const name = (await control.textContent())?.trim() ?? "";
      if (name === "") continue;
      let height = 0;
      for (let tries = 0; tries < 20 && height < 44; tries += 1) {
        if (tries > 0) await page.waitForTimeout(100);
        height = (await control.boundingBox())?.height ?? 0;
      }
      if (height < 44) throw new Error(`${name} is ${height}px tall on a phone, under 44px`);
    }
  };

  /** The page as it is now, light and dark, desktop and phone, without reloading it. */
  const captureAll = async (name) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (on) => document.documentElement.classList.toggle("dark", on),
          theme === "dark",
        );
        await settled();
        if (viewport === "phone") await touchTargets();
        await capture(`${name}-${viewport}-${theme}`);
      }
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize(DESKTOP);
    await settled();
  };

  /** The signed-in account's API, from the page. */
  const api = (method, url, body) =>
    page.evaluate(
      async (request) => {
        const response = await fetch(request.url, {
          method: request.method,
          headers: { "content-type": "application/json" },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        });
        const text = await response.text();
        return { status: response.status, body: text === "" ? null : JSON.parse(text) };
      },
      { method, url, body },
    );
  const agentAccounts = async () => {
    const identity = await api("GET", "/api/me/sealant");
    if (identity.status !== 200) throw new Error(`reading the logins: ${identity.status}`);
    return identity.body.accounts.filter(
      (one) => one.provider !== "github" && one.status !== "archived",
    );
  };
  const removeAgentLogins = async () => {
    for (const one of await agentAccounts()) {
      const removed = await api("DELETE", `/api/me/sealant/accounts/${one.id}`);
      if (removed.status !== 200) throw new Error(`removing ${one.provider}: ${removed.status}`);
    }
  };
  /** Answers one tRPC read with what `change` makes of the server's answer, until `unroute`. */
  const rewrite = async (call, change) =>
    page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      const at = calls.indexOf(call);
      if (at === -1) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const entry = Array.isArray(body) ? body[at] : body;
      entry.result.data.json = change(entry.result.data.json);
      await route.fulfill({ response, json: body });
    });
  /** Reads the person's logins again, as the `user` event makes the page do. */
  const readAgain = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["platform", "sealantIdentity"]],
      }),
    );
  /** Pastes `value` into the focused field, as the browser does: one paste event. */
  const paste = (value) =>
    page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, value);
  const fieldEmpty = async (issuer) => {
    const value = await keyField(issuer).inputValue();
    if (value !== "")
      throw new Error(`the ${issuer} key field still holds ${value.length} characters`);
  };

  // Signed in by the driver. The step comes after Git access: give the account its Mend key by
  // opening /welcome, which makes one when there is none.
  await open("/");
  await page.waitForLoadState("networkidle");
  const access = await api("GET", "/api/me/git-access");
  if (!(access.body?.mode === "bridge" || access.body?.key?.exists)) {
    await open("/welcome");
    await heading("Git access");
  }
  const identity = await api("GET", "/api/me/sealant");
  note(
    `the stack's account had ${(await agentAccounts()).map((one) => `${one.provider} (${one.status})`).join(", ") || "no agent login"}; the platform runs sessions on API keys: ${identity.body?.apiKeys}`,
  );
  await removeAgentLogins();

  // accounts-list, none connected: the commands and the wait.
  await open("/welcome/agent-login");
  await heading("Agent login");
  await page.getByText("Step 3 of 4").first().waitFor({ state: "attached" });
  const steps = page.getByRole("list", { name: "Setup steps" });
  const current = await steps.locator('[aria-current="step"]').textContent();
  if (!current?.includes("Agent login")) throw new Error(`the current step is ${current}`);
  if ((await tab("Claude Code").getAttribute("aria-selected")) !== "true")
    throw new Error("the step didn't open on Claude Code");
  await heading("Connect Claude Code");
  const origin = new URL(web).origin;
  const commands = async () =>
    (await page.locator('[data-slot="copy-field-value"]').allTextContents()).filter(Boolean);
  const claudeCommands = await commands();
  if (claudeCommands.join(" | ") !== `mend login --url ${origin} | mend connect claude`)
    throw new Error(`the commands read ${JSON.stringify(claudeCommands)}`);
  await visibleText(/Waiting for Claude Code to connect · \d+s/)
    .first()
    .waitFor();
  await continueOpen(false);
  await page.getByText("You need an agent login to start a session.").first().waitFor();
  for (const banned of ["Sign in with", "setup token", "setup-token", "auth.json", "credentials"]) {
    if ((await page.getByText(banned, { exact: false }).count()) > 0)
      throw new Error(`the step says "${banned}"`);
  }
  note(
    `/welcome/agent-login with no agent login: 'Agent login', step 3 of 4, Claude Code chosen, 'mend login --url ${origin}' and 'mend connect claude' with Copy command, 'Waiting for Claude Code to connect · Ns', Continue disabled, Skip for now; no sign-in button, setup token, credentials file or auth.json`,
  );

  // The command on the clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const copyButtons = page.getByRole("button", { name: "Copy command" });
  await copyButtons.nth(1).click();
  await page.getByRole("button", { name: "Copied" }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  if (copied !== "mend connect claude") throw new Error(`the clipboard holds ${copied}`);
  note("Copy command beside 'mend connect claude' put 'mend connect claude' on the clipboard");
  await captureAll("agent-login-claude-waiting");

  await tab("Codex").click();
  await heading("Connect Codex");
  // The Claude Code panel leaves once the switch has finished.
  await page.getByText("mend connect claude", { exact: true }).waitFor({ state: "detached" });
  const codexCommands = await commands();
  if (codexCommands.join(" | ") !== `mend login --url ${origin} | mend connect codex`)
    throw new Error(`the Codex commands read ${JSON.stringify(codexCommands)}`);
  await visibleText(/Waiting for Codex to connect · \d+s/)
    .first()
    .waitFor();
  note("the Codex segment shows 'Connect Codex' with 'mend connect codex'");
  await captureAll("agent-login-codex-waiting");

  // Skip for now: on to First project, whose route a later PR adds.
  await button("Skip for now").click();
  await page.waitForURL((url) => url.pathname === "/welcome/first-project");
  await heading("Page not found");
  note(
    "Skip for now went to /welcome/first-project (not found until the First project step lands)",
  );
  await page.goBack();
  await heading("Agent login");

  // A login connected from a terminal lands without a reload.
  await tab("Codex").click();
  await heading("Connect Codex");
  const reloads = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads.push(frame.url());
  });
  note(
    "waiting for a CLI to connect: run new-web-agent-login-connect.json with `verify drive cli` now",
  );
  await capture("agent-login-ready-for-cli");
  const codexConnected = page.getByText(
    "Codex is connected. Codex sessions will use this ChatGPT account.",
  );
  await codexConnected.first().waitFor({ timeout: 600_000 });
  if (reloads.length > 0) throw new Error(`the page reloaded: ${reloads.join(", ")}`);
  if (path() !== "/welcome/agent-login") throw new Error(`the page moved to ${path()}`);
  await visibleText(/^Connected (just now|\d+s ago)$/)
    .first()
    .waitFor();
  await continueOpen(true);
  if ((await button("Skip for now").count()) > 0) throw new Error("Skip for now is still there");
  await page.getByText("You can change this login later in Settings.").first().waitFor();
  const facts = await page
    .getByText(/ · subscription$/)
    .first()
    .textContent();
  note(
    `with the page open and untouched, 'mend connect codex --from-stdin' from the stack's CLI made the page read 'Codex is connected. Codex sessions will use this ChatGPT account.' with '${facts}' and 'Connected just now'; no reload; Continue enabled, Skip for now gone`,
  );
  await captureAll("agent-login-codex-connected");

  // Claude: connected by the same batch.
  await tab("Claude Code").click();
  await heading("Connect Claude Code");
  await page
    .getByText("Claude Code is connected. Claude Code sessions will use this Claude account.")
    .first()
    .waitFor({ timeout: 120_000 });
  note("the Claude Code segment reads 'Claude Code is connected.' (the CLI batch's fake login)");
  await captureAll("agent-login-claude-connected");

  // reconnect-state. The platform refuses the fake Claude login only when a session uses it, so
  // the refusal is drawn from the logins read changed in the browser: Claude's status invalid.
  await rewrite("platform.sealantIdentity", (read) => ({
    ...read,
    accounts: read.accounts.map((one) =>
      one.provider === "claude" ? { ...one, status: "invalid" } : one,
    ),
  }));
  await readAgain();
  await page.getByText("Your Claude Code login needs connecting again.").first().waitFor();
  await page.getByRole("button", { name: "Use an API key instead" }).waitFor();
  note(
    "fixture, a refused Claude login (status invalid, made in the browser): 'Your Claude Code login needs connecting again.' with 'Claude refused it, so Claude Code sessions can't start. Run the command again.' and 'Use an API key instead'",
  );
  await captureAll("fixture-agent-login-claude-refused");
  await page.unroute("**/trpc/**");
  await readAgain();
  await page
    .getByText("Claude Code is connected. Claude Code sessions will use this Claude account.")
    .first()
    .waitFor();

  // Removing the Claude login lands on the page by itself too: back to waiting.
  for (const one of await agentAccounts()) {
    if (one.provider !== "claude") continue;
    const removed = await api("DELETE", `/api/me/sealant/accounts/${one.id}`);
    if (removed.status !== 200) throw new Error(`removing claude: ${removed.status}`);
  }
  await visibleText(/Waiting for Claude Code to connect · \d+s/)
    .first()
    .waitFor();
  if (reloads.length > 0) throw new Error(`the page reloaded: ${reloads.join(", ")}`);
  note(
    "removing the Claude login through the API put the open page back to 'Waiting for Claude Code to connect', no reload",
  );

  // connect-web as an API key.
  await page.getByRole("button", { name: "Use an API key instead" }).click();
  await keyField("Anthropic").waitFor();
  const focused = await keyField("Anthropic").evaluate((field) => field === document.activeElement);
  if (!focused) throw new Error("the key field didn't take focus");
  if (!identity.body?.apiKeys) {
    await page.getByText("This Mend server can't run sessions on an API key yet.").waitFor();
    note("the stack's platform doesn't run sessions on API keys: the key half shows that note");
    await captureAll("agent-login-key-unsupported");
  } else {
    note("'Use an API key instead' opened the Anthropic API key field, focused");
    await captureAll("agent-login-key-empty");

    // The other issuer's key, refused on the page before anything is sent.
    registerSecret("openai-shaped", "sk-proj-mendVerifyFake-not-anthropic-000000");
    await paste("sk-proj-mendVerifyFake-not-anthropic-000000");
    await page.getByText("That isn't an Anthropic API key.").waitFor();
    await fieldEmpty("Anthropic");
    note("pasting an OpenAI-shaped key: 'That isn't an Anthropic API key.', the field emptied");
    await captureAll("agent-login-key-wrong-issuer");

    // A Claude setup token sent as a key: the platform refuses it with its own words.
    await keyField("Anthropic").focus();
    await typeSecret(keyField("Anthropic"), "claude-fake", FAKES.claude);
    await keyField("Anthropic").press("Enter");
    await page.getByText("Mend couldn't save this key.").waitFor();
    await fieldEmpty("Anthropic");
    const refusal = await page.locator('[data-slot="inline-alert"]').last().textContent();
    note(
      `a Claude setup token typed and sent with Enter: the platform refused it: '${refusal?.trim()}'`,
    );
    await captureAll("agent-login-key-rejected");

    // A key the platform takes, held to show the wait.
    const { promise: held, resolve: release } = Promise.withResolvers();
    await page.route("**/trpc/platform.connectAccount**", async (route) => {
      await held;
      await route.continue();
    });
    await keyField("Anthropic").focus();
    await paste(FAKES.anthropicKey);
    await visibleText(/^Saving the key · \d+s$/)
      .first()
      .waitFor();
    await fieldEmpty("Anthropic");
    note("a pasted Anthropic key, held: 'Saving the key · Ns', the field already empty");
    await captureAll("agent-login-key-saving");
    release();
    await page
      .getByText("Mend saved your Anthropic API key. Claude Code sessions will use it.")
      .waitFor();
    await page.unroute("**/trpc/platform.connectAccount**");
    await page.getByText("Mend stores the key and never shows it again.").first().waitFor();
    if ((await page.getByText(FAKES.anthropicKey.slice(-4)).count()) > 0)
      throw new Error("the page shows the key's last characters");
    await continueOpen(true);
    note(
      "released: 'Mend saved your Anthropic API key. Claude Code sessions will use it.', 'Saved just now', no part of the key on the page, Continue enabled",
    );
    await captureAll("agent-login-key-saved");
  }

  // Continue: on to First project.
  await button("Continue").click();
  await page.waitForURL((url) => url.pathname === "/welcome/first-project");
  note("Continue went to /welcome/first-project");

  // A page whose reads fail, then Try again.
  await open("/welcome/agent-login");
  await heading("Agent login");
  await page.route("**/trpc/**", (route) => {
    const url = new URL(route.request().url());
    const calls = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const failure = {
      error: {
        json: {
          message: "The verify recipe failed this read on purpose.",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
        },
      },
    };
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify(url.searchParams.has("batch") ? calls.map(() => failure) : failure),
    });
  });
  await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  await page.evaluate(() => {
    const router = window["__TSR_ROUTER__"];
    router.options.context.queryClient.clear();
    return router.invalidate();
  });
  await heading("This page didn't load");
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  note(
    "Agent login whose reads fail: 'This page didn't load' with the server's words and Try again",
  );
  await captureAll("agent-login-error");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Agent login");
  note("Try again with the server back shows Agent login");

  // Put the account back: the Claude key goes; the CLI batch's Codex login stays.
  for (const one of await agentAccounts()) {
    if (one.provider !== "claude") continue;
    const removed = await api("DELETE", `/api/me/sealant/accounts/${one.id}`);
    if (removed.status !== 200) throw new Error(`removing claude: ${removed.status}`);
  }
  note(
    `left the account with ${(await agentAccounts()).map((one) => `${one.provider} (${one.status})`).join(", ") || "no agent login"}`,
  );
};
