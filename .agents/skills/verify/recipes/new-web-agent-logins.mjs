// Settings → Account → Agent logins and Git in the new web app (route PR 38, SLNT-1159):
//
//   pnpm verify drive new-web --recipe new-web-agent-logins
//   # while it waits ("waiting for a CLI to connect"), from another terminal:
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-agent-logins-connect.json
//
// Feature ids: provider-accounts.md `accounts-list`, `connect-web` (an API key only: Yiannis ruled
// on 17 Nov 2026 that Mend's apps take no part in a provider's sign-in, so a login is connected by
// `mend connect` on the person's computer), `disconnect`, `reconnect-state`, `agent-logins`;
// git-access.md `mode-choice`, `mend-key`, `key-card`, `key-check`, `bridge-share`; git-author.md
// `git-author-set-web`, `git-author-refused`, `git-author-clear`.
//
// - `/settings/git-access` lands on `/settings/agent-logins`, "Only you" under the title.
// - With no agent login, Connect Claude Code opens a dialog with Mend's command line (one ticked
//   line: the stack's CLI is signed in) and
//   `mend connect claude` and waits. The CLI batch's login lands on the open page through the
//   `user` event: the dialog closes by itself with a toast, no reload.
// - Codex's Replace login: the API key field refuses an Anthropic key before anything is sent.
//   Claude Code's Replace login saves the fake Anthropic key (held, to show "Saving the key"); the
//   row then says it is an Anthropic API key and shows no part of it.
// - A refused login (status invalid, made in the browser: the platform refuses the fake only when
//   a session uses it) reads Reconnect. Disconnect removes the Claude Code login.
// - "Selected agent's login only" saves, holds across a reload, and reports a failed save.
// - The Git author: refused before sending, saved, then back to the account's.
// - The Mend key to copy; Check access asks GitHub (the stack's key isn't on GitHub, so expect
//   GitHub's refusal); the mode switches to your computer's key and back; a failed save.
// - The page whose reads fail, with Try again.
//
// The recipe puts back the author, the mode and the switch, and removes the Claude Code key it
// saved; the batch's Codex login stays, as new-web-composer expects.

import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
/** The tRPC calls a request carries, in its batch's order. */
const callsOf = (route) =>
  decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/trpc\//, "")).split(",");

export default async ({ page, web, capture, note, registerSecret }) => {
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const text = (value) => visible(page.getByText(value, { exact: false }));
  const settled = () => page.waitForTimeout(500);
  const path = () => new URL(page.url()).pathname;
  const origin = new URL(web).origin;
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (to) => {
    await page.goto(`${web}${to}`);
    // A cold dev server can leave the first load unhydrated: load it once more.
    await hydrated().catch(async () => {
      note(`${to} didn't hydrate in 90s; loading it again`);
      await page.reload();
      await hydrated();
    });
    // The dev server may reload the page once as it bundles a module it hadn't seen.
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  /**
   * One picture. `at` names a section further down the page: on the desk the sheet scrolls inside
   * itself, so the picture is taken in a window tall enough to hold the whole page.
   */
  const shot = async (name, at) => {
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    const size = page.viewportSize();
    const tall = at !== undefined && size !== null && size.width >= 1024;
    if (tall) await page.setViewportSize({ width: size.width, height: 2000 });
    await page.mouse.move(1, 1);
    await settled();
    await capture(name);
    if (tall) {
      await page.setViewportSize(size);
      await settled();
    }
  };
  const paint = (dark) =>
    page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
  /** The page as it is: light at 1280px, and with `all`, dark and at 390px too. */
  const shots = async (name, all = false, at = undefined) => {
    await shot(`${name}-desktop-light`, at);
    if (!all) return;
    await paint(true);
    await shot(`${name}-desktop-dark`, at);
    await page.setViewportSize(PHONE);
    await shot(`${name}-phone-dark`, at);
    await paint(false);
    await shot(`${name}-phone-light`, at);
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
        const raw = await response.text();
        return { status: response.status, body: raw === "" ? null : JSON.parse(raw) };
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
  const removeLogins = async (provider) => {
    for (const one of await agentAccounts()) {
      if (provider !== undefined && one.provider !== provider) continue;
      const removed = await api("DELETE", `/api/me/sealant/accounts/${one.id}`);
      if (removed.status !== 200) throw new Error(`removing ${one.provider}: ${removed.status}`);
    }
  };
  /** Answers one tRPC read with what `change` makes of the server's answer, until unrouted. */
  const rewrite = (call, change) =>
    page.route("**/trpc/**", async (route) => {
      const at = callsOf(route).indexOf(call);
      if (at === -1) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      const entry = Array.isArray(body) ? body[at] : body;
      entry.result.data.json = change(entry.result.data.json);
      await route.fulfill({ response, json: body });
    });
  const failure = {
    error: {
      json: {
        message: "The verify recipe failed this call on purpose.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
      },
    },
  };
  /** Fails every tRPC call named `call` (every call, with none), one error per call in a batch. */
  const fail = (call) =>
    page.route("**/trpc/**", (route) => {
      const calls = callsOf(route);
      if (call !== undefined && !calls.includes(call)) return route.continue();
      const batch = new URL(route.request().url()).searchParams.has("batch");
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(batch ? calls.map(() => failure) : failure),
      });
    });
  const readAgain = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["platform", "sealantIdentity"]],
      }),
    );
  /** Pastes `value` into the focused field, as the browser does: one paste event. */
  const paste = (value) =>
    page.evaluate((pasted) => {
      const data = new DataTransfer();
      data.setData("text/plain", pasted);
      document.activeElement?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, value);
  const keyField = (issuer) => page.getByLabel(`${issuer} API key`, { exact: true });
  const fieldEmpty = async (issuer) => {
    const value = await keyField(issuer).inputValue();
    if (value !== "") throw new Error(`the ${issuer} key field holds ${value.length} characters`);
  };
  /** A toast's words, read in the Notifications region (a toast closes by itself after a while). */
  const toastSays = (words) =>
    page
      .getByRole("region", { name: /Notifications/ })
      .getByText(words, { exact: false })
      .first()
      .waitFor({ timeout: 10_000 });
  const rowLine = (label) =>
    page
      .locator('[data-slot="setting-row"]')
      .filter({ has: page.getByText(label, { exact: true }) })
      .first()
      .locator("p")
      .nth(1)
      .textContent();
  /** Waits until a row's line matches `want`, and answers it. */
  const waitRow = async (label, want, timeout = 30_000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const line = (await rowLine(label)) ?? "";
      if (want.test(line)) return line;
      if (Date.now() > until) throw new Error(`${label} reads '${line}', not ${want}`);
      await page.waitForTimeout(250);
    }
  };
  // A toast is a dialog too (Base UI), so a dialog is always found by its title.
  /** Polls an API read until `want` holds for its body. */
  const until = async (url, want) => {
    for (let tries = 0; tries < 60; tries += 1) {
      if (want((await api("GET", url)).body)) return;
      await page.waitForTimeout(250);
    }
    throw new Error(`${url} never read as expected`);
  };
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const closed = (name, timeout = 30_000) =>
    page.getByRole("dialog", { name }).waitFor({ state: "detached", timeout });
  const commands = async (name) =>
    (await dialog(name).locator('[data-slot="copy-field-value"]').allTextContents()).filter(
      Boolean,
    );

  // --- Before: a Mend key, no agent login, and what the run will put back ---------------------
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  await open("/settings/profile");
  const access = await api("GET", "/api/me/git-access");
  if (!(access.body?.mode === "bridge" || access.body?.key?.exists)) {
    // The Git access step makes the key when there is none.
    await open("/welcome");
    await heading("Git access");
  }
  const before = {
    access: (await api("GET", "/api/me/git-access")).body,
    author: (await api("GET", "/api/me/git-author")).body,
    logins: (await api("GET", "/api/me/agent-logins")).body,
  };
  note(
    `before: mode ${before.access.mode}, author ${before.author.source}, selected only ${before.logins.selectedOnly}`,
  );
  if (before.access.mode !== "mend-key")
    await api("PUT", "/api/me/git-access", { mode: "mend-key" });
  if (before.logins.selectedOnly)
    await api("PUT", "/api/me/agent-logins", { ...before.logins, selectedOnly: false });
  await removeLogins();

  // --- From the composer, which says no login is connected ------------------------------------
  await open("/");
  await visible(page.getByRole("link", { name: "Add agent login" })).click();
  await page.waitForURL((url) => url.pathname === "/settings/agent-logins");
  await heading("Agent logins and Git");
  note("New session with no agent login: its 'Add agent login' link opened /settings/agent-logins");

  // --- The page, from the old address ---------------------------------------------------------
  await page.goto(`${web}/settings/git-access`);
  await page.waitForURL((url) => url.pathname === "/settings/agent-logins");
  await hydrated();
  await heading("Agent logins and Git");
  await text("Only you").waitFor();
  const active = await page
    .locator('[data-slot="sidebar"][aria-label="Settings"] [aria-current="page"]')
    .first()
    .textContent();
  if (active?.trim() !== "Agent logins and Git")
    throw new Error(`the sidebar highlights ${active}`);
  for (const banned of ["Sign in with", "setup token", "setup-token", "auth.json", "credentials"])
    if ((await page.getByText(banned, { exact: false }).count()) > 0)
      throw new Error(`the page says "${banned}"`);
  const claudeNone = await rowLine("Claude Code");
  if (!claudeNone?.startsWith("Not connected.")) throw new Error(`Claude Code reads ${claudeNone}`);
  note(
    `/settings/git-access → ${path()}: 'Agent logins and Git', 'Only you', the sidebar on it; Claude Code '${claudeNone}'; opencode and pi 'No login of its own'; no sign-in button, setup token, credentials file or auth.json`,
  );
  await shots("agent-logins-none", true, "Agent logins");

  // --- accounts-list: connect Claude Code from a terminal -------------------------------------
  await page.getByRole("button", { name: "Connect Claude Code" }).click();
  await heading("Connect Claude Code");
  const claudeCommands = await commands("Connect Claude Code");
  // The stack's CLI is signed in: Mend's command line is one ticked line, then the command.
  if (claudeCommands.join(" | ") !== "mend connect claude")
    throw new Error(`the commands read ${JSON.stringify(claudeCommands)}`);
  await text(/Waiting for Claude Code to connect · \d+s/).waitFor();
  note(
    `Connect… on Claude Code: 'Connect Claude Code' with 'Mend's command line is signed in on …' and 'mend connect claude' with Copy command, and 'Waiting for Claude Code to connect · Ns'`,
  );
  await shot("connect-claude-dialog-desktop-light");
  await page.setViewportSize(PHONE);
  await text("No computer with you?").waitFor();
  await shot("connect-claude-dialog-phone-light");
  await page.setViewportSize(DESKTOP);
  await heading("Connect Claude Code");

  const reloads = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) reloads.push(frame.url());
  });
  note(
    "waiting for a CLI to connect: run new-web-agent-logins-connect.json with `verify drive cli` now",
  );
  await closed("Connect Claude Code", 600_000);
  await toastSays("Claude Code is connected");
  if (reloads.length > 0) throw new Error(`the page reloaded: ${reloads.join(", ")}`);
  const claudeLine = await waitRow("Claude Code", /ubscription\. Connected/);
  note(
    `'mend connect claude --from-stdin' from the stack's CLI closed the open dialog by itself with a toast, no reload; Claude Code reads '${claudeLine}'`,
  );
  await shot("claude-connected-desktop-light");
  note(`Codex reads '${await waitRow("Codex", /ubscription\. Connected/, 120_000)}'`);

  // --- connect-web: an API key, refused, then saved --------------------------------------------
  await page.getByRole("button", { name: "Replace your Codex login" }).click();
  await heading("Replace Codex login");
  await button("Use an API key instead").click();
  await keyField("OpenAI").waitFor();
  if (!(await keyField("OpenAI").evaluate((field) => field === document.activeElement)))
    throw new Error("the key field didn't take focus");
  await paste(FAKES.anthropicKey);
  await text("That isn't an OpenAI API key.").waitFor();
  await fieldEmpty("OpenAI");
  note(
    "Replace login… on Codex, Use an API key instead: an Anthropic key pasted is refused before anything is sent ('That isn't an OpenAI API key.'), the field emptied",
  );
  await shot("codex-key-wrong-issuer-desktop-light");
  await page.setViewportSize(PHONE);
  await keyField("OpenAI").waitFor();
  await shot("codex-key-wrong-issuer-phone-light");
  await page.setViewportSize(DESKTOP);
  // The phone's sheet and the desk's dialog are different elements: settle, then focus the one shown.
  await settled();
  await visible(keyField("OpenAI")).click();
  // A made-up OpenAI key: the stack's platform checks a key's shape, not the key, so it saves.
  const openaiKey = "sk-proj-mendVerifyFake-openai-api-key-000000000000";
  registerSecret("openai-key", openaiKey);
  await paste(openaiKey);
  await closed("Replace Codex login", 60_000);
  await toastSays("Codex is connected with an OpenAI API key.");
  const codexKeyLine = await waitRow("Codex", /^OpenAI API key\. Saved/);
  if ((await page.getByText(openaiKey.slice(0, 16)).count()) > 0)
    throw new Error("the page shows part of the OpenAI key");
  note(
    `an OpenAI key pasted on Codex's Replace login saved: the dialog closed with 'Codex is connected with an OpenAI API key.'; the row reads '${codexKeyLine}', no part of the key`,
  );
  await shot("codex-key-saved-desktop-light");
  const codexAnswered = page.waitForResponse((response) =>
    response.url().includes("platform.disconnectAccount"),
  );
  await page.getByRole("button", { name: "Disconnect your Codex login" }).click();
  await codexAnswered;
  await toastSays("Disconnected your Codex login.");
  const codexAfter = await waitRow("Codex", /ubscription\. Connected/);
  note(
    `Disconnect on Codex: 'Disconnected your Codex login.'; the key is gone and the row reads the subscription the CLI connected, still kept: '${codexAfter}'`,
  );

  await page.getByRole("button", { name: "Replace your Claude Code login" }).click();
  await heading("Replace Claude Code login");
  await button("Use an API key instead").click();
  await keyField("Anthropic").waitFor();
  await shot("claude-key-empty-desktop-light");
  const { promise: held, resolve: release } = Promise.withResolvers();
  await page.route("**/trpc/platform.connectAccount**", async (route) => {
    await held;
    await route.continue();
  });
  await keyField("Anthropic").focus();
  await paste(FAKES.anthropicKey);
  await text(/Saving the key · \d+s/).waitFor();
  await fieldEmpty("Anthropic");
  note("the fake Anthropic key pasted, held: 'Saving the key · Ns', the field already empty");
  await shot("claude-key-saving-desktop-light");
  release();
  await closed("Replace Claude Code login", 60_000);
  await page.unroute("**/trpc/platform.connectAccount**");
  await toastSays("Claude Code is connected with an Anthropic API key.");
  await waitRow("Claude Code", /^Anthropic API key\. Saved/);
  if ((await page.getByText(FAKES.anthropicKey.slice(0, 16)).count()) > 0)
    throw new Error("the page shows part of the key");
  note(
    `released: the dialog closed with 'Claude Code is connected with an Anthropic API key.'; the row reads '${await rowLine("Claude Code")}', no part of the key`,
  );
  await shot("claude-key-saved-desktop-light");

  // --- reconnect-state, from a logins read changed in the browser ------------------------------
  await rewrite("platform.sealantIdentity", (read) => ({
    ...read,
    accounts: read.accounts.map((one) =>
      one.provider === "codex" ? { ...one, status: "invalid" } : one,
    ),
  }));
  await readAgain();
  await page.getByRole("button", { name: "Reconnect Codex" }).waitFor();
  note(
    `fixture, a refused Codex login (status invalid, made in the browser): '${await rowLine("Codex")}' with Reconnect…`,
  );
  await shot("fixture-codex-refused-desktop-light");
  await page.unroute("**/trpc/**");
  await readAgain();
  await page.getByRole("button", { name: "Reconnect Codex" }).waitFor({ state: "detached" });

  // --- GitHub's login for gh: the command, never a pasted token --------------------------------
  await page.getByRole("button", { name: "Add a GitHub login for gh" }).click();
  await heading("Connect GitHub");
  const githubCommands = await commands("Connect GitHub");
  if (githubCommands.join(" | ") !== "mend connect github")
    throw new Error(`GitHub's commands read ${JSON.stringify(githubCommands)}`);
  if ((await dialog("Connect GitHub").getByRole("textbox").count()) > 0)
    throw new Error("GitHub's dialog has a field");
  note("Add login… for gh: 'Connect GitHub' with 'mend connect github' to copy, no token field");
  await shot("connect-github-dialog-desktop-light");
  await button("Cancel").click();
  await closed("Connect GitHub");

  // --- disconnect -----------------------------------------------------------------------------
  // The key was this login; the subscription from the CLI is still kept, so Disconnect it too.
  const lines = [];
  for (let round = 0; round < 3; round += 1) {
    const shown = (await rowLine("Claude Code")) ?? "";
    const answered = page.waitForResponse((response) =>
      response.url().includes("platform.disconnectAccount"),
    );
    await page.getByRole("button", { name: "Disconnect your Claude Code login" }).click();
    await answered;
    if (round === 0) await toastSays("Disconnected your Claude Code login.");
    // The row reads the logins again once the server answered.
    const deadline = Date.now() + 30_000;
    let line = shown;
    while (line === shown && Date.now() < deadline) {
      await page.waitForTimeout(250);
      line = (await rowLine("Claude Code")) ?? "";
    }
    lines.push(line);
    if (line.startsWith("Not connected.")) break;
    // Its Disconnect is enabled again before the next round.
    await page.waitForFunction(() => {
      const control = document.querySelector('[aria-label="Disconnect your Claude Code login"]');
      return control !== null && !control.hasAttribute("disabled");
    });
  }
  if (!lines.at(-1)?.startsWith("Not connected."))
    throw new Error(`Claude Code reads ${lines.at(-1)}`);
  note(
    `Disconnect on Claude Code, each with a toast: the row read ${lines.map((line) => `'${line}'`).join(", then ")}`,
  );
  await shot("claude-disconnected-desktop-light");

  // --- agent-logins: the switch ---------------------------------------------------------------
  const selectedOnly = page.getByRole("switch", { name: "Selected agent's login only" });
  await selectedOnly.click();
  await until("/api/me/agent-logins", (body) => body.selectedOnly === true);
  await open("/settings/agent-logins");
  if ((await selectedOnly.getAttribute("aria-checked")) !== "true")
    throw new Error("the switch is off after a reload");
  await selectedOnly.click();
  await until("/api/me/agent-logins", (body) => body.selectedOnly === false);
  note("Selected agent's login only: on, still on after a reload, then off again; each saved");
  await fail("platform.setAgentLogins");
  await selectedOnly.click();
  await text("This wasn't saved, so the switch is back to Off.").waitFor();
  if ((await selectedOnly.getAttribute("aria-checked")) !== "false")
    throw new Error("the switch stayed on after a failed save");
  note(
    "a failed save (setAgentLogins answered 500 in the browser): the switch is back to Off, with the reason and Try again",
  );
  await shot("switch-not-saved-desktop-light", "Agent logins");
  await page.unroute("**/trpc/**");

  // --- The Git author -------------------------------------------------------------------------
  await open("/settings/agent-logins");
  const email = page.getByLabel("Author email", { exact: true });
  await email.fill("not-an-email");
  await text("Mend can't save this: the email is not an address like you@example.com.").waitFor();
  if (!(await button("Save").isDisabled())) throw new Error("Save is on for a refused email");
  note("Author email 'not-an-email': 'Unsaved changes' says why Mend can't save it; Save is off");
  await shot("author-refused-desktop-light", "Git");
  await button("Discard").click();
  if ((await email.inputValue()) !== before.author.email) throw new Error("Discard kept the edit");
  await email.fill("verify-author@example.com");
  await text(`It was ${before.author.email}.`).waitFor();
  await shot("author-unsaved-desktop-light", "Git");
  await page.setViewportSize(PHONE);
  await shot("author-unsaved-phone-light", "Git");
  await page.setViewportSize(DESKTOP);
  await button("Save").click();
  await text("Saved. Sessions you start from now on commit as this.").waitFor();
  const saved = (await api("GET", "/api/me/git-author")).body;
  if (saved.email !== "verify-author@example.com" || saved.source !== "setting")
    throw new Error(`the server holds ${JSON.stringify(saved)}`);
  note("a new author email saved with Save: the server holds it as the person's own setting");
  await shot("author-saved-desktop-light", "Git");
  await page.getByRole("button", { name: "Use my account's name and email" }).click();
  await text("Your commits use your account's name and email again.").waitFor();
  if ((await api("GET", "/api/me/git-author")).body.source !== "account")
    throw new Error("the author is still the person's own");
  note("Use my account's name and email: the author is the account's again");

  // --- The Mend key and its check -------------------------------------------------------------
  const publicKey = await page.locator('[data-slot="copy-field-value"]').first().textContent();
  if (!publicKey?.startsWith("ssh-")) throw new Error(`the key card shows ${publicKey}`);
  await button("Copy public key").waitFor();
  await button("Check access").click();
  await page.waitForFunction(
    () =>
      ["Mend reached GitHub", "GitHub refused the key.", "Mend couldn't reach GitHub."].some(
        (one) => document.body.textContent?.includes(one),
      ),
    null,
    { timeout: 60_000 },
  );
  const answer = await page
    .locator('[data-slot="setting-row"]')
    .filter({ hasText: "Last check" })
    .textContent();
  note(`the Mend key card with Copy public key; Check access asked GitHub: '${answer?.trim()}'`);
  await shots("key-checked", true, "Git access");

  // --- mode-choice and bridge-share -----------------------------------------------------------
  await button("Your computer's key").click();
  await text("No computer is connected").waitFor();
  await page.getByText("mend keys share", { exact: true }).waitFor();
  if ((await api("GET", "/api/me/git-access")).body.mode !== "bridge")
    throw new Error("the mode wasn't saved");
  note("Your computer's key: saved; the page shows Mend's command line, then 'mend keys share'");
  await shot("mode-computer-desktop-light", "Git access");
  await open("/settings/agent-logins");
  await text("No computer is connected").waitFor();
  note("after a reload the page still reads your computer's key");
  await button("Mend key").click();
  await button("Check access").waitFor();
  await until("/api/me/git-access", (body) => body.mode === "mend-key");
  await open("/settings/agent-logins");
  await button("Check access").waitFor();
  note("Mend key again: saved, and still Mend key after a reload");
  await fail("git.setAccess");
  await button("Your computer's key").click();
  await text("This wasn't saved: Mend still uses your Mend key.").waitFor();
  note("a failed mode save (setAccess answered 500): 'Mend still uses your Mend key.', Try again");
  await shot("mode-not-saved-desktop-light", "Git access");
  await page.unroute("**/trpc/**");

  // --- A page whose reads fail ----------------------------------------------------------------
  await fail();
  await page.evaluate(() => {
    const router = window["__TSR_ROUTER__"];
    router.options.context.queryClient.clear();
    return router.invalidate();
  });
  await heading("This page didn't load");
  note("every read failed: 'This page didn't load' with the server's words and Try again");
  await shot("error-desktop-light");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Agent logins and Git");
  note("Try again with the server back shows the page");

  // --- Put the account back -------------------------------------------------------------------
  if (before.author.source === "setting")
    await api("PUT", "/api/me/git-author", {
      name: before.author.name,
      email: before.author.email,
    });
  await api("PUT", "/api/me/git-access", { mode: before.access.mode });
  await api("PUT", "/api/me/agent-logins", before.logins);
  await removeLogins("claude");
  note(
    `put back the author, mode ${before.access.mode} and the switch; left ${(await agentAccounts()).map((one) => `${one.provider} (${one.status})`).join(", ") || "no agent login"}`,
  );
};
