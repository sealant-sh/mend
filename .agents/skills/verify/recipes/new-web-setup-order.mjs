// Setup in the owner's order (SLNT-1191): Account, Command line, Git access, Agent login,
// Organization, First project for the first account; the same without Organization for someone
// who joins from an invitation.
//
//   pnpm verify drive new-web --recipe new-web-setup-order
//
// - Command line (step 2 of 6): waiting with the install and sign-in commands; Skip for now goes to
//   Git access, where the steps say "Skipped" and the full block shows once; a computer signing in
//   lands on the open page through the server's `user` event (no reload), as one ticked line;
//   Continue goes on.
// - Git access: with a computer signed in, one ticked line; the GitHub account section waiting,
//   then connected.
// - Agent login: Mend's command line once above the tabs, the full block while no computer is
//   signed in, then one ticked line; each tab holds only its own command.
// - Organization (step 5 of 6): the name, the runtime choice, a failed save, a real rename, and
//   Continue to First project.
// - First project: no GitHub login, with the connect section; the wait for the list; the list of
//   the person's own login.
// - Joining from an invitation: Command line, step 2 of 5, and five steps with no Organization.
// - How long a first list as the caller takes on this stack (a fake GitHub login, so it ends in
//   gh's refusal once the workspace has started).
//
// What is made in the browser, and why: the stack's account always has its CLI signed in and its
// agent logins, and no real GitHub login may be used. So `devices.list`, `platform.sealantIdentity`,
// `github.status`, `github.repos`, `projects.list` and, for one picture, `organization.settings`
// are answered from the server's own answer, changed. The computer that signs in is a device minted
// by hand (the API mints no `cli` device), which the server announces with the `user` event; the
// page's answer calls it a `cli` device. Everything the recipe makes is removed at its end: the
// device, the organization's name, the fake GitHub login. The member it makes stays, as in
// new-web-join.

import { FAKES } from "../scripts/fakes.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const HOUR = 3_600_000;
const repository = (name, visibility, hours) => ({
  nameWithOwner: `linus-p/${name}`,
  description: null,
  visibility,
  isFork: false,
  language: null,
  stars: 0,
  pushedAt: new Date(Date.now() - hours * HOUR).toISOString(),
  url: `https://github.com/linus-p/${name}`,
});
const REPOSITORIES = [
  repository("checkout-api", "private", 2),
  repository("web", "private", 0.4),
  repository("mobile-app", "private", 3),
  repository("infra", "private", 30),
  repository("design-tokens", "public", 340),
  repository("docs", "public", 500),
  repository("ledger", "private", 600),
];

const visible = (locator) => locator.filter({ visible: true }).first();
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(seen)}`);
};

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  /** Light and dark, desktop and phone. */
  const all = async (name) => {
    for (const [viewport, size] of [
      ["desktop", DESKTOP],
      ["phone", PHONE],
    ]) {
      await page.setViewportSize(size);
      await settled();
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await capture(`${name}-${viewport}-${theme}`);
      }
    }
    await setTheme("light");
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button, textarea")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = async (to) => {
    await page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
    await page.waitForURL((url) => url.pathname === to, { timeout: 30_000 });
  };
  const text = (words) => visible(page.getByText(words));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const heading = (name) => page.getByRole("heading", { name, level: 1 }).waitFor();
  const commands = async () =>
    (
      await page
        .locator('[data-slot="copy-field-value"]')
        .filter({ visible: true })
        .allTextContents()
    )
      .map((one) => one.trim())
      .filter(Boolean);
  const stepsList = () => page.getByRole("list", { name: "Setup steps" });
  const stepNames = async () =>
    (await stepsList().locator("li").allTextContents()).map((one) => one.trim());
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const api = (method, url, body) =>
    page.evaluate(
      async ({ verb, address, payload }) => {
        const response = await fetch(address, {
          method: verb,
          headers: { "content-type": "application/json" },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const read = await response.text();
        return { status: response.status, body: read === "" ? null : JSON.parse(read) };
      },
      { verb: method, address: url, payload: body },
    );
  /** Reads a query again, as the `user` event makes the page do. */
  const readAgain = (key) =>
    page.evaluate(
      (queryKey) =>
        window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({ queryKey }),
      key,
    );

  // Chosen tRPC reads, answered from the server's own answer, changed; `held` delays one.
  let answers = {};
  let held = null;
  let devicesReads = 0;
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    if (paths.includes("devices.list")) devicesReads += 1;
    if (!paths.some((path) => path in answers)) return route.continue();
    if (held !== null && paths.includes(held.path)) await held.until;
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    paths.forEach((path, at) => {
      const answer = answers[path];
      if (answer === undefined) return;
      const real = entries[at]?.result?.data;
      const json = answer(real?.json);
      entries[at] = { result: { data: json === real?.json ? real : { json } } };
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? entries : entries[0]),
    });
  });

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  const me = await call("organization.current");
  expect("the stack's account is the first account", me.operator && me.role === "owner", me);
  const organization = me.organization.name;
  const suffix = Math.random().toString(36).slice(2, 6);
  const computer = `linus-mbp-${suffix}`;
  let minted = null;
  let renamed = false;
  let githubAccount = null;

  // Which `cli` devices the page sees: none, or the one this recipe mints.
  let cliShown = "none";
  answers["devices.list"] = (list) =>
    (list ?? [])
      .filter((device) => device.platform !== "cli")
      .map((device) =>
        device.name === computer && cliShown === "minted" ? { ...device, platform: "cli" } : device,
      );
  // No agent login and no GitHub login: setup as a new person has it.
  answers["platform.sealantIdentity"] = (identity) => ({ ...identity, accounts: [] });
  // A Mend key, as the frames draw Git access.
  answers["git.access"] = (access) => ({ ...access, mode: "mend-key" });
  await page.evaluate(
    (id) => localStorage.removeItem(`mend-setup-skipped-command-line:${id}`),
    me.userId,
  );

  try {
    // ---- Command line, waiting.
    await go("/welcome/command-line");
    await heading("Mend's command line");
    await text("Step 2 of 6").waitFor({ state: "attached" });
    const origin = new URL(web).origin;
    const waiting = await commands();
    expect(
      "the install and sign-in commands",
      waiting.join(" | ") === `npm install --global @sealant/mend | mend login --url ${origin}`,
      waiting,
    );
    await text(/Waiting for your computer to sign in · \d+s/).waitFor();
    expect("Continue waits", await button("Continue").isDisabled(), "enabled");
    expect("six steps", (await stepNames()).length === 6, await stepNames());
    note(
      `/welcome/command-line: 'Mend's command line', step 2 of 6, '${waiting.join("' and '")}' with Copy command, 'Waiting for your computer to sign in · Ns', Continue disabled, Skip for now`,
    );
    await all("cli-waiting");

    // ---- Skip: Git access shows "Skipped" and the full block once.
    await button("Skip for now").click();
    await page.waitForURL((url) => url.pathname === "/welcome");
    await heading("Git access");
    await stepsList().getByText("Skipped").waitFor({ state: "attached" });
    const skipped = await commands();
    expect(
      "the sign-in command once on Git access after a skip",
      skipped.filter((one) => one.startsWith("mend login --url")).length === 1,
      skipped,
    );
    await text("GitHub account").waitFor();
    await text(/Waiting for GitHub to connect · \d+s/).waitFor();
    note(
      `Skip for now went to /welcome: Command line reads 'Skipped' under the steps; Git access shows Mend's command line once (${skipped.join(", ")}) and the GitHub account section waiting`,
    );
    await all("git-cli-skipped");

    // ---- Command line, signed in through the event.
    await go("/welcome/command-line");
    await heading("Mend's command line");
    cliShown = "minted";
    const before = devicesReads;
    const mint = await api("POST", "/api/me/devices", { name: computer, platform: "other" });
    expect("minting the device", mint.status === 200, mint.status);
    registerSecret("minted-device-token", mint.body.token);
    minted = mint.body.device.id;
    await text(`Mend's command line is signed in on ${computer}.`).waitFor({ timeout: 30_000 });
    expect("the page read the devices again by itself", devicesReads > before, devicesReads);
    expect("Continue opens", !(await button("Continue").isDisabled()), "disabled");
    expect("no Skip once signed in", (await button("Skip for now").count()) === 0, "Skip shown");
    note(
      `a device '${computer}' minted on the server (answered as a cli device) reached the open page through the user event: devices.list read again with no reload, 'Mend's command line is signed in on ${computer}.', Continue enabled, no Skip`,
    );
    await all("cli-signed-in");
    await button("Continue").click();
    await page.waitForURL((url) => url.pathname === "/welcome");

    // ---- Git access: one ticked line, GitHub waiting then connected. The key "works" from an
    // answer made in the browser (no key is added to GitHub), as in new-web-git-access.
    await heading("Git access");
    await page.route("**/trpc/git.checkKey**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            result: {
              data: {
                json: {
                  state: "accepted",
                  githubLogin: "linus-p",
                  deployKeyRepository: null,
                  observed:
                    "Hi linus-p! You've successfully authenticated, but GitHub does not provide shell access.",
                  checkedAt: new Date().toISOString(),
                },
                meta: { values: { checkedAt: ["Date"] } },
              },
            },
          },
        ]),
      }),
    );
    await page
      .getByRole("button", { name: /^(Check access|Check again|Try again)$/ })
      .first()
      .click();
    await text("Mend reached GitHub as linus-p.").waitFor();
    await page.unroute("**/trpc/git.checkKey**");
    await stepsList().getByText(computer).waitFor({ state: "attached" });
    const signedInCommands = await commands();
    expect(
      "no install or sign-in line once signed in",
      !signedInCommands.some((one) => one.startsWith("mend login") || one.startsWith("npm ")),
      signedInCommands,
    );
    await text("Without GitHub, you paste a repository's address in the last step.").waitFor();
    note(
      `Git access: '${computer}' under Command line, one ticked line, 'mend connect github' alone, 'Waiting for GitHub to connect', the note 'Without GitHub, you paste a repository's address in the last step.'`,
    );
    await all("git-github-waiting");
    const connectedAt = new Date().toISOString();
    githubAccount = null;
    answers["platform.sealantIdentity"] = (identity) => ({
      ...identity,
      accounts: [
        {
          id: `fixture-github-${suffix}`,
          provider: "github",
          name: "linus-p",
          kind: "gh-cli-token",
          status: "active",
          metadata: { login: "linus-p" },
          connectedAt,
          updatedAt: connectedAt,
          lastUsedAt: null,
          isDefault: true,
        },
      ],
    });
    await readAgain([["platform", "sealantIdentity"]]);
    await text("GitHub connected as linus-p.").waitFor();
    note("fixture, a GitHub login connected: 'GitHub connected as linus-p.' with when, no note");
    await all("git-github-connected");

    // ---- Agent login: the block once above the tabs, then one ticked line.
    cliShown = "none";
    await readAgain([["devices", "list"]]);
    await go("/welcome/agent-login");
    await heading("Agent login");
    await text("Step 4 of 6").waitFor({ state: "attached" });
    const claudeBlock = await commands();
    expect(
      "the full block once, then the tab's own command",
      claudeBlock.join(" | ") ===
        `npm install --global @sealant/mend | mend login --url ${origin} | mend connect claude`,
      claudeBlock,
    );
    await all("agent-cli-not-signed-in");
    await page.getByRole("tab", { name: "Codex", exact: true }).click();
    await page.getByText("mend connect claude", { exact: true }).waitFor({ state: "detached" });
    const codexBlock = await commands();
    expect("Codex's own command", codexBlock.at(-1) === "mend connect codex", codexBlock);
    note(
      `Agent login, no computer signed in: '${claudeBlock.join("', '")}' (Claude Code), then '${codexBlock.at(-1)}' alone in the Codex tab, the block above the tabs once`,
    );
    cliShown = "minted";
    await readAgain([["devices", "list"]]);
    await text(`Mend's command line is signed in on ${computer}.`).waitFor();
    const codexSigned = await commands();
    expect(
      "one command per tab once signed in",
      codexSigned.join(" | ") === "mend connect codex",
      codexSigned,
    );
    await all("agent-cli-signed-in-codex");
    await page.getByRole("tab", { name: "Claude Code", exact: true }).click();
    await page.getByText("mend connect codex", { exact: true }).waitFor({ state: "detached" });
    const claudeSigned = await commands();
    expect(
      "one command per tab once signed in",
      claudeSigned.join(" | ") === "mend connect claude",
      claudeSigned,
    );
    note(
      "Agent login, signed in: one ticked line above the tabs; each tab holds only its own command",
    );
    await all("agent-cli-signed-in-claude");
    await button("Skip for now").click();
    await page.waitForURL((url) => url.pathname === "/welcome/organization");

    // ---- Organization, step 5 of 6.
    await heading("Your organization");
    await text("Step 5 of 6").waitFor({ state: "attached" });
    const nameField = page.getByLabel("Name", { exact: true });
    expect(
      "the name the server gave it",
      (await nameField.inputValue()) === organization,
      await nameField.inputValue(),
    );
    const settings = await call("organization.settings");
    note(`the server offers ${JSON.stringify(settings.sessionRuntime.offered)} for sessions`);
    if (settings.sessionRuntime.offered.length < 2) {
      expect(
        "no runtime section with one runtime",
        (await page.getByText("Where sessions run").count()) === 0,
        "shown",
      );
      await all("org-name");
      answers["organization.settings"] = (view) => ({
        ...view,
        sessionRuntime: { ...view.sessionRuntime, offered: ["docker", "boat"] },
      });
      await readAgain([["organization", "settings"]]);
      await text("Where sessions run").waitFor();
      note(
        "fixture, a server that offers Docker and Boat: 'Where sessions run' with the Runtime page's two lines",
      );
      await all("org-runtimes");
      delete answers["organization.settings"];
      await readAgain([["organization", "settings"]]);
      await page.getByText("Where sessions run").waitFor({ state: "detached" });
    } else {
      await text("Where sessions run").waitFor();
      await all("org-runtimes");
    }
    const newName = `${organization} ${suffix}`;
    await nameField.fill(newName);
    await page.route("**/trpc/organization.rename**", (route) => route.abort("connectionrefused"));
    await button("Continue").click();
    await text("Mend didn't save the name.").waitFor();
    note(
      "a rename the server didn't answer: 'Mend didn't save the name.' in an Inline alert; the page stays",
    );
    await all("org-failed");
    await page.unroute("**/trpc/organization.rename**");
    await button("Continue").click();
    await page.waitForURL((url) => url.pathname === "/welcome/first-project", { timeout: 30_000 });
    renamed = true;
    const after = await call("organization.current");
    expect(
      "the organization was renamed",
      after.organization.name === newName,
      after.organization.name,
    );
    note(`Continue renamed the organization to '${newName}' and went to /welcome/first-project`);

    // ---- First project: no GitHub login, then the list.
    answers["projects.list"] = () => [];
    answers["github.status"] = () => ({
      available: false,
      authenticated: false,
      login: null,
      detail: null,
    });
    answers["platform.sealantIdentity"] = (identity) => ({ ...identity, accounts: [] });
    await readAgain([["projects"]]);
    await readAgain([["github"]]);
    await readAgain([["platform", "sealantIdentity"]]);
    await open("/welcome/first-project");
    await heading("Add a project");
    await text("Step 6 of 6").waitFor({ state: "attached" });
    await stepsList().getByText(newName).waitFor({ state: "attached" });
    await text(/Waiting for GitHub to connect · \d+s/).waitFor();
    await button("Paste a Git URL instead").waitFor();
    note(
      `First project with no GitHub login: the GitHub account section in place of the list, above 'Paste a Git URL instead'; '${newName}' under Organization`,
    );
    await all("project-no-github");

    const gate = Promise.withResolvers();
    held = { path: "github.repos", until: gate.promise };
    answers["github.status"] = () => ({
      available: true,
      authenticated: true,
      login: "linus-p",
      detail: null,
    });
    answers["github.repos"] = () => REPOSITORIES;
    answers["platform.sealantIdentity"] = (identity) => ({
      ...identity,
      accounts: [
        {
          id: `fixture-github-${suffix}`,
          provider: "github",
          name: "linus-p",
          kind: "gh-cli-token",
          status: "active",
          metadata: { login: "linus-p" },
          connectedAt,
          updatedAt: connectedAt,
          lastUsedAt: null,
          isDefault: true,
        },
      ],
    });
    await readAgain([["platform", "sealantIdentity"]]);
    await readAgain([["github"]]);
    await text(/Asking GitHub for the repositories linus-p can reach · \d+s/).waitFor();
    await page.waitForTimeout(3_000);
    note(
      "fixture, a GitHub login connected: the page waits, 'Asking GitHub for the repositories linus-p can reach · Ns', and says Mend asks from a short-lived workspace",
    );
    await capture("project-list-waiting-desktop-light");
    gate.resolve();
    held = null;
    await text("Repositories").waitFor();
    await text("checkout-api").waitFor({ state: "attached" });
    note("the list arrived without a reload: 'Repositories linus-p can reach on GitHub'");
    await all("project-list");
  } finally {
    delete answers["github.repos"];
    held = null;
    if (renamed)
      await call("organization.rename", { name: organization }, "mutate").catch(() => undefined);
    if (minted !== null) await api("DELETE", `/api/me/devices/${minted}`).catch(() => undefined);
  }
  note(`put back: the organization's name '${organization}', the minted device revoked`);

  // ---- How long a first list as the caller takes here: a fake GitHub login, so gh refuses it once
  // the workspace has started.
  answers = {};
  const connect = await api("POST", "/api/me/sealant/accounts", {
    provider: "github",
    secret: FAKES.github,
  });
  if (connect.status === 200) {
    githubAccount = connect.body.id;
    try {
      const status = await api("GET", "/api/github/status");
      note(
        `with a GitHub login connected, /api/github/status answered ${JSON.stringify(status.body)}`,
      );
      const started = Date.now();
      const listed = await api("GET", "/api/github/repos");
      note(
        `a first /api/github/repos as the caller took ${((Date.now() - started) / 1000).toFixed(1)} s and answered ${listed.status}: ${JSON.stringify(listed.body).slice(0, 300)}`,
      );
      const again = Date.now();
      await api("GET", "/api/github/repos");
      note(`a second one took ${((Date.now() - again) / 1000).toFixed(1)} s`);
    } finally {
      await api("DELETE", `/api/me/sealant/accounts/${githubAccount}`);
      note("the fake GitHub login was removed");
    }
  } else {
    note(`the platform refused a fake GitHub login (${connect.status}): no caller list timed here`);
  }

  // ---- Joining from an invitation: five steps, no Organization.
  const invitation = await api("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("setup-order-invitation", invitation.body.token);
  const owner = await page.context().cookies();
  await page.context().clearCookies();
  await open(`/join#${invitation.body.token}`);
  await page.getByRole("textbox", { name: "Name" }).fill("Mae Verify");
  await page.getByRole("textbox", { name: "Email" }).fill(`mae-${suffix}@example.invalid`);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "joiner-password",
    `joiner-${suffix}-password`,
  );
  await typeSecret(
    page.getByLabel("Confirm password"),
    "joiner-password",
    `joiner-${suffix}-password`,
  );
  await button("Create account and join").click();
  await page.waitForURL((url) => url.pathname === "/welcome/command-line", { timeout: 60_000 });
  await hydrated();
  await heading("Mend's command line");
  await text("Step 2 of 5").waitFor({ state: "attached" });
  const joined = await stepNames();
  expect(
    "five steps and no Organization",
    joined.length === 5 && !joined.some((one) => one.startsWith("Organization")),
    joined,
  );
  note(
    `a person who joined landed on /welcome/command-line: step 2 of 5, steps ${joined.join(" · ")}`,
  );
  await all("join-cli-waiting");
  await page.context().clearCookies();
  await page.context().addCookies(owner);
};
