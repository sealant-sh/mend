// The web app's setup step Git access (apps/web `/welcome`, SLNT-1116), driven by
// git-access.md's `mode-choice`, `mend-key`, `key-card`, `key-check` and `bridge-share`:
//
//   pnpm verify drive web --recipe git-access --account
//
// - Who lands here: a new member who joins from an invitation lands on Command line, skips it, and
//   reaches Git access, step 3 of 6,
//   with their name under Account; their Mend key was made before the page opened (`mend-key`).
//   Reopening /welcome keeps them there although the organization has a project (no agent login
//   yet). Signing in with no page to return to opens setup only for someone without Git access or
//   a project: the stack's owner goes to setup with no Mend key, the member (key, project) to /.
// - `key-card`: the key with Copy key, and the link to GitHub's SSH keys page.
// - `key-check`: Check access against real GitHub, held to show "Checking the key with GitHub",
//   then GitHub's real answer about a key it has never seen. "Key works" needs a key GitHub knows,
//   and none is added anywhere: its picture, and those of whichever of refused or unreachable GitHub
//   didn't give, come from answers made in the browser. Continue opens only on "key works", and
//   goes to /welcome/agent-login, the Agent login step.
// - `mode-choice` and `bridge-share`: choosing "Your computer's key" saves it, and the page shows
//   the two commands the CLI has today, waiting for the computer. The verify guard gives the CLI no
//   ssh-agent, so `mend keys share` can't run here: "<machine> connected." and Continue opening
//   come from a git.access answer made in the browser, and the real answer brings "Waiting" back.
// - A save that fails, and a page whose reads fail, with Try again.
//
// Every state is captured light and dark, at 1280px and 390px. The recipe puts the new member's
// mode back to the Mend key at the end; the member itself stays, as in join.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** A tRPC answer made in the browser, with superjson's note that `checkedAt` is a Date. */
const checkAnswer = (answer) =>
  JSON.stringify([
    {
      result: {
        data: { json: answer, meta: { values: { checkedAt: ["Date"] } } },
      },
    },
  ]);

export default async ({ page, web, capture, note, typeSecret, registerSecret, account }) => {
  if (account === null)
    throw new Error("this recipe signs in on the new page: run it with --account");

  const heading = (name) => page.getByRole("heading", { name, exact: true }).waitFor();
  const settled = () => page.waitForTimeout(500);
  const button = (name) => page.getByRole("button", { name, exact: true });
  const radio = (name) => page.getByRole("radio", { name: new RegExp(`^${name}`) });
  const path = () => new URL(page.url()).pathname;
  const open = async (to) => {
    await page.goto("about:blank");
    await page.goto(`${web}${to}`);
  };
  const signedOut = () => page.context().clearCookies();
  // Better Auth lets one address sign in 3 times in 10 seconds.
  const outOfTheLimit = () => page.waitForTimeout(11_000);
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

  /** The signed-in account's API, from the page: what Settings and `mend invite` call. */
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

  // The owner signs in with no page to return to, and lands where their own setup stands.
  await signedOut();
  await open("/login");
  await heading("Sign in");
  await page.getByRole("textbox", { name: "Email" }).fill(account.email);
  await account.typePassword(page.getByLabel("Password", { exact: true }));
  await button("Sign in").click();
  await page.waitForURL((url) => url.pathname !== "/login");
  await page.waitForLoadState("networkidle");
  const ownerLanded = path();
  const ownerAccess = await api("GET", "/api/me/git-access");
  const ownerProjects = await api("GET", "/api/projects");
  const ownerHasProject = (ownerProjects.body?.length ?? 0) > 0;
  note(
    `the owner signed in with no page to return to and landed on ${ownerLanded}; now: mode ${ownerAccess.body?.mode}, Mend key ${ownerAccess.body?.key?.exists ? "made" : "not made"}, ${ownerProjects.body?.length ?? "?"} projects`,
  );
  // Signing in with no page to return to: setup for an owner with no Mend key yet (that visit made
  // one), Mend for one with a key and a project.
  if (ownerLanded === "/welcome") await heading("Git access");
  else if (!ownerHasProject) throw new Error(`an owner with no project went to ${ownerLanded}`);
  else await heading("New session");

  // A new member: an invitation from the owner, and an account made from it.
  const created = await api("POST", "/api/organization/invitations", { role: "member" });
  if (created.status !== 200) throw new Error(`creating an invitation: ${created.status}`);
  registerSecret("invitation-token", created.body.token);
  await signedOut();
  await open(`/join#${created.body.token}`);
  const member = `verify-git-${Date.now()}@example.invalid`;
  const memberPassword = "a-git-access-verify-password";
  await page.getByRole("textbox", { name: "Name" }).fill("Linus Verify");
  await page.getByRole("textbox", { name: "Email" }).fill(member);
  await typeSecret(page.getByLabel("Password", { exact: true }), "member-password", memberPassword);
  await typeSecret(page.getByLabel("Confirm password"), "member-password", memberPassword);
  await button("Create account and join").click();
  // Joining lands on the Command line step (SLNT-1191); the member skips it.
  await page.waitForURL((url) => url.pathname === "/welcome/command-line");
  await heading("Mend's command line");
  await button("Skip for now").click();
  await page.waitForURL((url) => url.pathname === "/welcome/git-access");
  await heading("Git access");

  // mend-key and key-card: the key made before the page opened, with Copy key and GitHub's page.
  const steps = page.getByRole("list", { name: "Setup steps" });
  await steps.getByText("Linus Verify").waitFor({ state: "attached" });
  const current = await steps.locator('[aria-current="step"]').textContent();
  if (!current?.includes("Git access")) throw new Error(`the current step is ${current}`);
  await page.getByText("Step 3 of 6").first().waitFor({ state: "attached" });
  if (!(await radio("A Mend key").isChecked())) throw new Error("A Mend key is not chosen");
  const publicKey = await page.locator('[data-slot="copy-field-value"]').first().textContent();
  if (!publicKey?.startsWith("ssh-ed25519 ")) throw new Error(`the key reads ${publicKey}`);
  const access = await api("GET", "/api/me/git-access");
  if (access.body.key.publicKey !== publicKey)
    throw new Error("the key on the page is not the account's Mend key");
  await button("Copy key").waitFor();
  const github = await page.getByRole("link", { name: "GitHub account" }).getAttribute("href");
  if (github !== "https://github.com/settings/keys") throw new Error(`GitHub account → ${github}`);
  await continueOpen(false);
  await page.getByText("Continue once GitHub accepts the key.").first().waitFor();
  note(
    `joining as ${member} landed on /welcome/command-line, skipped it, and reached 'Git access', step 3 of 6 with 'Linus Verify' under Account, 'A Mend key' chosen, the account's Mend key (${publicKey.slice(0, 32)}…) with Copy key, 'GitHub account' → github.com/settings/keys, Continue disabled`,
  );
  await captureAll("git-access-mend-key");

  // key-check, held: "Checking the key with GitHub · Ns", Check access disabled.
  const { promise: held, resolve: release } = Promise.withResolvers();
  await page.route("**/trpc/git.checkKey**", async (route) => {
    await held;
    await route.continue();
  });
  await button("Check access").click();
  await page.getByText(/^Checking the key with GitHub · \d+s$/).waitFor();
  if (!(await button("Check access").isDisabled()))
    throw new Error("Check access can be pressed while checking");
  note("Check access, held: 'Checking the key with GitHub · Ns' and Check access disabled");
  await captureAll("git-access-checking");

  // GitHub's real answer about a key it has never seen.
  const answered = page.waitForResponse((response) => response.url().includes("git.checkKey"));
  release();
  await answered;
  await page.unroute("**/trpc/git.checkKey**");
  const refusedTitle = page.getByText("GitHub refused the key.");
  const unreachableTitle = page.getByText("Mend couldn't reach GitHub.");
  await refusedTitle.or(unreachableTitle).first().waitFor();
  const real = (await refusedTitle.count()) > 0 ? "refused" : "unreachable";
  const realAlert = await page.locator('[data-slot="inline-alert"]').first().textContent();
  note(`GitHub's real answer from the stack: ${real}: '${realAlert?.trim()}'`);
  await continueOpen(false);
  await captureAll(`git-access-${real}`);

  // The answers GitHub can't give this key here, made in the browser for their pictures.
  const fake = async (answer) => {
    await page.route("**/trpc/git.checkKey**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: checkAnswer(answer) }),
    );
    // Whichever check button the page shows now: Check access, Check again or Try again.
    await page
      .getByRole("button", { name: /^(Check access|Check again|Try again)$/ })
      .first()
      .click();
  };
  const checkedAt = new Date().toISOString();
  if (real === "refused") {
    await fake({
      state: "unreachable",
      observed: "ssh: connect to host github.com port 22: Connection timed out",
      checkedAt,
    });
    await unreachableTitle.waitFor();
    note("unreachable (answered in the browser): 'Mend couldn't reach GitHub.' and Try again");
    await captureAll("git-access-unreachable");
  } else {
    await fake({
      state: "refused",
      observed: "git@github.com: Permission denied (publickey).",
      checkedAt,
    });
    await refusedTitle.waitFor();
    note("refused (answered in the browser): 'GitHub refused the key.' and Check again");
    await captureAll("git-access-refused");
  }
  await page.unroute("**/trpc/git.checkKey**");
  // Key works: needs a key GitHub knows, which no one has added; answered in the browser.
  await fake({
    state: "accepted",
    githubLogin: "linus-p",
    deployKeyRepository: null,
    observed:
      "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
    checkedAt: new Date().toISOString(),
  });
  await page.getByText("Mend reached GitHub as linus-p.").waitFor();
  await page.getByText(/^Checked (just now|\d+s ago)$/).waitFor();
  await continueOpen(true);
  await page.getByText("Mend saves your choice as soon as you pick it.").first().waitFor();
  note(
    "key works (answered in the browser, not end to end): 'Mend reached GitHub as linus-p.', 'Checked just now', Check again, Continue enabled",
  );
  await captureAll("git-access-key-works");
  await page.unroute("**/trpc/git.checkKey**");
  await button("Continue").click();
  await page.waitForURL((url) => url.pathname === "/welcome/agent-login");
  await heading("Agent login");
  note("Continue went to /welcome/agent-login, the Agent login step");

  // The member has a key now and the organization has a project, but no agent login: reopening
  // /welcome stays on Git access.
  await open("/welcome");
  await heading("Git access");
  if (path() !== "/welcome") throw new Error(`reopening /welcome went to ${path()}`);
  const keyAgain = await page.locator('[data-slot="copy-field-value"]').first().textContent();
  if (keyAgain !== publicKey) throw new Error("reopening /welcome showed a different key");
  note(
    "reopening /welcome as the member (key made, a project in the organization, no agent login) stays on Git access",
  );

  // No key (an account whose key went away after the page opened), answered in the browser.
  await fake({ state: "no-key", checkedAt });
  await page.getByText("You don't have a Mend key yet.").first().waitFor();
  await button("Create key").waitFor();
  note("no key (answered in the browser): 'You don't have a Mend key yet.' and Create key");
  await captureAll("git-access-no-key");
  await page.unroute("**/trpc/git.checkKey**");

  // A request that never reached the server: nothing is known about the key.
  await open("/welcome");
  await heading("Git access");
  await page.route("**/trpc/git.checkKey**", (route) => route.abort("connectionrefused"));
  await button("Check access").click();
  await page.getByText("Mend couldn't check the key.").waitFor();
  note("a check that never reached the server: 'Mend couldn't check the key.' and Try again");
  await captureAll("git-access-check-failed");
  await page.unroute("**/trpc/git.checkKey**");

  // mode-choice, refused: the save fails, the radio goes back, and the page says so.
  await page.route("**/trpc/git.setAccess**", (route) => route.abort("connectionrefused"));
  await radio("Your computer's key").click();
  await page.getByText("Mend couldn't save your choice.").waitFor();
  if (!(await radio("A Mend key").isChecked())) throw new Error("the failed choice stayed picked");
  note("a choice that didn't save: 'Mend couldn't save your choice.', A Mend key still chosen");
  await captureAll("git-access-save-failed");
  await page.unroute("**/trpc/git.setAccess**");

  // mode-choice: Your computer's key, saved.
  await open("/welcome");
  await heading("Git access");
  await radio("Your computer's key").click();
  await heading("Connect your computer");
  const modeAfter = await api("GET", "/api/me/git-access");
  if (modeAfter.body.mode !== "bridge") throw new Error(`the mode is ${modeAfter.body.mode}`);
  const commands = await page.locator('[data-slot="copy-field-value"]').allTextContents();
  const origin = new URL(web).origin;
  if (commands[0] !== `mend login --url ${origin}` || commands[1] !== "mend keys share")
    throw new Error(`the commands read ${JSON.stringify(commands)}`);
  await open("/welcome");
  await heading("Connect your computer");
  if (!(await radio("Your computer's key").isChecked()))
    throw new Error("after a reload, Your computer's key is not chosen");
  await page.getByText(/^Waiting for your computer to connect · \d+s$/).waitFor();
  await continueOpen(false);
  await page.getByText("Continue once your computer connects.").first().waitFor();
  note(
    `'Your computer's key' saved (GET /api/me/git-access: bridge); the page shows 'mend login --url ${origin}' and 'mend keys share' with Copy command; after a reload it is still chosen, 'Waiting for your computer to connect · Ns', Continue disabled`,
  );
  await captureAll("git-access-your-computer-waiting");

  // bridge-share, connected: the verify guard keeps every ssh-agent away from the CLI it runs, so
  // `mend keys share` can't run here. The page polls git.access while it waits; that answer, with
  // a computer connected, is made in the browser.
  const machine = "linus-mbp";
  const memberAccess = await api("GET", "/api/me/git-access");
  const connectedAccess = {
    ...memberAccess.body,
    bridge: { connected: true, clientName: machine, since: new Date().toISOString() },
  };
  const ownAccessRead = (route) => {
    if (!new URL(route.request().url()).pathname.endsWith("/trpc/git.access"))
      return route.continue();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          result: {
            data: { json: connectedAccess, meta: { values: { "bridge.since": ["Date"] } } },
          },
        },
      ]),
    });
  };
  await page.route("**/trpc/**", ownAccessRead);
  await page.getByText(`${machine} connected. Mend signs with its ssh-agent.`).waitFor();
  await page.getByText(/^Connected (just now|\d+s ago)$/).waitFor();
  await continueOpen(true);
  await page.getByText(`Mend can't clone or push while ${machine} is offline.`).first().waitFor();
  note(
    `a connected computer (git.access answered in the browser, not end to end): within one poll the page read '${machine} connected. Mend signs with its ssh-agent.', 'Connected just now', Continue enabled`,
  );
  await captureAll("git-access-your-computer-connected");
  await page.unroute("**/trpc/**", ownAccessRead);
  await page
    .getByText(/^Waiting for your computer to connect · \d+s$/)
    .waitFor({ timeout: 30_000 });
  await continueOpen(false);
  note("with the real answer back (no computer connected), the page went back to 'Waiting'");

  // The member signs in again with no page to return to. With Git access in place and a project
  // in the organization, that opens Mend; the agent login is the one step they may skip.
  await signedOut();
  await open("/login");
  await heading("Sign in");
  await outOfTheLimit();
  await page.getByRole("textbox", { name: "Email" }).fill(member);
  await typeSecret(page.getByLabel("Password", { exact: true }), "member-password", memberPassword);
  await button("Sign in").click();
  await page.waitForURL((url) => url.pathname !== "/login");
  if (path() !== "/") throw new Error(`the member's sign-in went to ${path()}`);
  await heading("New session");
  note(
    "the member (Git access in place, a project in the organization) signing in again went to /",
  );
  await open("/welcome");
  await heading("Git access");

  // A page whose reads fail, then Try again.
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
  await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  // The page's loader runs again and its reads fail.
  await page.evaluate(() => window["__TSR_ROUTER__"].invalidate());
  await heading("This page didn't load");
  await page.getByText("The verify recipe failed this read on purpose.").waitFor();
  note(
    "Git access whose reads fail: 'This page didn't load' with the server's words and Try again",
  );
  await captureAll("git-access-error");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Git access");
  note("Try again with the server back shows Git access");

  // The first account on a server goes on to Git access. The stack has its first account already,
  // so the instance read and Better Auth's answer to the sign-up are made in the browser; the
  // member's own session then opens /welcome.
  await page.route("**/trpc/platform.instance**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { result: { data: { json: { users: "none", registration: "open" } } } },
      ]),
    }),
  );
  await page.route("**/api/auth/sign-up/email", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        token: null,
        user: { id: "verify-first", email: "first@example.invalid", name: "First" },
      }),
    }),
  );
  await open("/login");
  await heading("Create the first account");
  await page.getByRole("textbox", { name: "Name" }).fill("First");
  await page.getByRole("textbox", { name: "Email" }).fill("first@example.invalid");
  await typeSecret(page.getByLabel("Password", { exact: true }), "first-password", memberPassword);
  await typeSecret(page.getByLabel("Confirm password"), "first-password", memberPassword);
  await button("Create account and continue").click();
  await page.waitForURL((url) => url.pathname === "/welcome/command-line");
  await heading("Mend's command line");
  note(
    "'Create account and continue' on a server with no accounts (answers made in the browser) went to /welcome/command-line, the Command line step",
  );
  await page.unroute("**/api/auth/sign-up/email");
  await page.unroute("**/trpc/platform.instance**");

  // Put the member's mode back.
  const restored = await api("PUT", "/api/me/git-access", { mode: "mend-key" });
  if (restored.status !== 200) throw new Error(`restoring the mode: ${restored.status}`);
  note("the member's mode is back to the Mend key");
};
