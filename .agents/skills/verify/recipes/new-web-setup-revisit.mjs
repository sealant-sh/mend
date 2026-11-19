// Going back to an earlier setup step (SLNT-1193): the steps beside the sheet lead back, and each
// step's page opens with what was saved and continues forward again.
//
//   pnpm verify drive new-web --recipe new-web-setup-revisit
//
// - The first account (the stack's account) goes forward from Command line to First project. On
//   each page, only the steps it is past are links ("Git access, done"); Account, the current step
//   and the steps not reached yet are not.
// - From First project it goes back to each earlier step by its link. Each page shows what was
//   saved (the signed-in computer, the Mend key, the connected agent, the organization's name),
//   and the steps after it stay links, with First project as where it left off. On Organization
//   it renames the organization, and Continue goes forward to First project, whose steps show the
//   new name. Every Continue goes forward; none sends it back.
// - Keyboard: Tab reaches each link, by its name. A link has the kit's sidebar hover and focus.
// - At 390px the header's back arrow goes to the step before, for every step after Command line.
// - Someone who joins from an invitation skips Command line and Agent login, reaches First project,
//   goes back to each step by its link (a skipped step opens as it was), goes forward again, and
//   signing in again lands on the first step they owe.
//
// The signed-in computer is real: a `mend login` through the guard, approved on the Authorize page,
// with a CLI config of the run's own; its device is revoked at the end.
//
// What is made in the browser, and why: `projects.list` is answered empty (the stack's
// organization has a project, which would end setup), the first account's agent logins hold a
// Claude Code login (the stack's account has none, and no real one may be used), and GitHub accepting the Mend key comes
// from an answer made in the browser (no key is added to GitHub), as in new-web-setup-order. The
// organization's name is put back at the end; the member stays, as in new-web-join.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const stackWeb = () =>
  JSON.parse(readFileSync(resolve(".verify/stack/current.json"), "utf8")).web.replace(/\/$/, "");
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(seen)}`);
};

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const settled = () => page.waitForTimeout(500);
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
    // A cold dev server can miss the first load: load it once more.
    await hydrated().catch(async () => {
      await page.goto(`${web}${path}`);
      await hydrated();
    });
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const at = (path) => page.waitForURL((url) => url.pathname === path, { timeout: 30_000 });
  const visible = (locator) => locator.filter({ visible: true }).first();
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const heading = (name) =>
    page.getByRole("heading", { name, level: 1 }).filter({ visible: true }).first().waitFor();
  const stepsList = () => page.getByRole("list", { name: "Setup steps" });
  /** The links among the steps beside the sheet, by their names. */
  const railLinks = async () =>
    (await stepsList().getByRole("link").all()).length === 0
      ? []
      : await Promise.all(
          (await stepsList().getByRole("link").all()).map(
            async (link) => (await link.getAttribute("aria-label")) ?? "",
          ),
        );
  const railLink = (name) => stepsList().getByRole("link", { name, exact: true });
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
  const forget = (userId) =>
    page.evaluate((id) => {
      localStorage.removeItem(`mend-setup-skipped-command-line:${id}`);
      localStorage.removeItem(`mend-setup-reached:${id}`);
    }, userId);
  const shot = async (name, sizes = ["desktop"]) => {
    for (const size of sizes) {
      await page.setViewportSize(size === "desktop" ? DESKTOP : PHONE);
      await settled();
      await capture(`${name}-${size}-light`);
    }
    await page.setViewportSize(DESKTOP);
    await settled();
  };
  const dark = async (name) => {
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await settled();
    await capture(`${name}-desktop-dark`);
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await settled();
  };

  // No project yet, so setup isn't over; for the first account, a Claude Code login (the stack's
  // account has none, and no real one may be used here).
  let claudeConnected = true;
  const connectedAt = new Date().toISOString();
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const identity = claudeConnected && paths.includes("platform.sealantIdentity");
    if (!paths.includes("projects.list") && !identity) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      if (path === "projects.list") entries[index] = { result: { data: { json: [] } } };
      if (path === "platform.sealantIdentity" && claudeConnected) {
        const real = entries[index]?.result?.data?.json;
        entries[index] = {
          result: {
            data: {
              json: {
                ...real,
                accounts: [
                  {
                    id: "fixture-claude",
                    provider: "claude",
                    name: "Claude Code",
                    kind: "oauth-token",
                    status: "active",
                    metadata: {},
                    connectedAt,
                    updatedAt: connectedAt,
                    lastUsedAt: null,
                    isDefault: true,
                  },
                ],
              },
              meta: {
                values: {
                  "accounts.0.connectedAt": ["Date"],
                  "accounts.0.updatedAt": ["Date"],
                },
              },
            },
          },
        };
      }
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? entries : entries[0]),
    });
  });
  /** GitHub takes the Mend key, from an answer made here. */
  const keyWorks = async () => {
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
                  observed: "Hi linus-p! You've successfully authenticated.",
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
    await page.getByText("Mend reached GitHub as linus-p.").first().waitFor();
    await page.unroute("**/trpc/git.checkKey**");
  };

  await page.setViewportSize(DESKTOP);
  await page.addInitScript(() => localStorage.setItem("mend-theme", "light"));
  await open("/");
  const me = await call("organization.current");
  expect("the stack's account is the first account", me.operator && me.role === "owner", me);
  const organization = me.organization.name;
  const suffix = Math.random().toString(36).slice(2, 6);
  const newName = `${organization} ${suffix}`;
  let renamed = false;
  await forget(me.userId);

  // A computer signs in: a real `mend login`, approved here.
  const privateDir = process.env.MEND_VERIFY_PRIVATE;
  if (!privateDir) throw new Error("no MEND_VERIFY_PRIVATE: run it with pnpm verify drive");
  const cliHome = mkdtempSync(join(privateDir, "setup-revisit-cli-"));
  mkdirSync(join(cliHome, "mend"));
  const before = (await call("devices.list")).map((device) => device.id);
  const login = spawn("mend", ["login", "--url", stackWeb(), "--no-open"], {
    env: { ...process.env, XDG_CONFIG_HOME: cliHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let printed = "";
  login.stdout.on("data", (chunk) => {
    printed += chunk;
  });
  login.stderr.on("data", (chunk) => {
    printed += chunk;
  });
  const loggedIn = new Promise((done) => login.on("close", (code) => done(code)));
  let code;
  for (let waited = 0; waited < 60_000 && code === undefined; waited += 250) {
    code = /code\s+([0-9A-Z]{4}-[0-9A-Z]{4})/.exec(printed.replace(COLOUR, ""))?.[1];
    if (code === undefined) await page.waitForTimeout(250);
  }
  if (code === undefined) throw new Error(`mend login printed no code:\n${printed}`);
  registerSecret("setup-revisit-cli-code", code);
  await open(`/authorize?code=${code}`);
  await button("Approve").click();
  await page.getByRole("heading", { name: "Terminal authorized" }).waitFor();
  expect("mend login signed in", (await loggedIn) === 0, printed.replace(COLOUR, ""));
  const computer = (await call("devices.list")).find((device) => !before.includes(device.id));
  expect("a new device", computer !== undefined, "none");
  note(`a real mend login, approved on the Authorize page, signed in '${computer.name}'`);

  try {
    // ---- Forward, the first time: no step ahead is a link.
    await open("/welcome/command-line");
    await heading("Mend's command line");
    expect("Command line: no links", (await railLinks()).length === 0, await railLinks());
    expect("Account is no link", (await stepsList().getByRole("link").count()) === 0, "link");
    note("Command line, the first time: Account is ticked and no step is a link");
    await shot("first-cli");
    await button("Continue").click();
    await at("/welcome/git-access");
    await heading("Git access");
    expect(
      "Git access: Command line links back",
      JSON.stringify(await railLinks()) === JSON.stringify(["Command line, done"]),
      await railLinks(),
    );
    if (await button("Continue").isDisabled()) await keyWorks();
    note("Command line's Continue opened /welcome/git-access; only 'Command line, done' is a link");
    await button("Continue").click();
    await at("/welcome/agent-login");
    await heading("Agent login");
    await button("Continue").click();
    await at("/welcome/organization");
    await heading("Your organization");
    await button("Continue").click();
    await at("/welcome/first-project");
    await heading("Add a project");
    const atEnd = await railLinks();
    expect(
      "First project: every earlier step but Account links back",
      JSON.stringify(atEnd) ===
        JSON.stringify([
          "Command line, done",
          "Git access, done",
          "Agent login, done",
          "Organization, done",
        ]),
      atEnd,
    );
    const saved = (await stepsList().locator("li").allTextContents()).map((one) =>
      one.replace(/\s+/g, " ").trim(),
    );
    note(
      `forward to /welcome/first-project through each Continue; the steps read ${saved.join(" · ")}; links: ${atEnd.join(" · ")}`,
    );
    await shot("first-project");
    await dark("first-project");

    // ---- Hover and keyboard on a link.
    await railLink("Git access, done").hover();
    await settled();
    await capture("rail-hover-desktop-light");
    await page.mouse.move(900, 600);
    await page.locator("body").focus();
    const reached = [];
    for (let presses = 0; presses < 8 && reached.length < 4; presses += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element.closest('[aria-label="Setup steps"]') === null) return null;
        return element.getAttribute("aria-label");
      });
      if (focused !== null && !reached.includes(focused)) reached.push(focused);
      if (reached.length === 2) await capture("rail-focus-desktop-light");
    }
    expect("Tab reaches each link by name", reached.length === 4, reached);
    note(`Tab from the top of the page reaches ${reached.join(" → ")}`);

    // ---- Back to each step by its link.
    await railLink("Command line, done").click();
    await at("/welcome/command-line");
    await heading("Mend's command line");
    await page
      .getByText(/Mend's command line is signed in on /)
      .first()
      .waitFor();
    const fromCli = await railLinks();
    expect(
      "back on Command line, the later steps stay links",
      JSON.stringify(fromCli) ===
        JSON.stringify([
          "Git access, done",
          "Agent login, done",
          "Organization, done",
          "First project, not finished",
        ]),
      fromCli,
    );
    note(
      `'Command line, done' opened /welcome/command-line with 'Mend's command line is signed in on …'; links: ${fromCli.join(" · ")}`,
    );
    await shot("back-cli");

    await railLink("Git access, done").click();
    await at("/welcome/git-access");
    await heading("Git access");
    const chosen = (await page.getByRole("radio", { name: "A Mend key" }).isChecked())
      ? "A Mend key"
      : "Your computer's key";
    expect("Continue open on a visit back", !(await button("Continue").isDisabled()), "disabled");
    note(
      `'Git access, done' opened /welcome/git-access (not sent on), the saved choice checked (${chosen}), and Continue open without checking the key again`,
    );
    await shot("back-git");

    await railLink("Agent login, done").click();
    await at("/welcome/agent-login");
    await heading("Agent login");
    expect("the agent is connected", !(await button("Continue").isDisabled()), "disabled");
    note("'Agent login, done' opened /welcome/agent-login with the connected login and Continue");
    await shot("back-agent");

    await railLink("Organization, done").click();
    await at("/welcome/organization");
    await heading("Your organization");
    const nameField = page.getByLabel("Name", { exact: true });
    expect("the saved name", (await nameField.inputValue()) === organization, organization);
    await nameField.fill(newName);
    note(`'Organization, done' opened /welcome/organization with '${organization}'; renamed it`);
    await shot("back-organization");
    await button("Continue").click();
    await at("/welcome/first-project");
    renamed = true;
    await heading("Add a project");
    await stepsList().getByText(newName, { exact: true }).waitFor({ state: "attached" });
    note(`Continue saved '${newName}' and went forward to /welcome/first-project, which shows it`);
    await shot("again-first-project");

    // ---- The phone's back arrow, from First project down to Command line.
    await page.setViewportSize(PHONE);
    await settled();
    const arrows = [];
    for (const [label, path, title] of [
      ["Back to Organization", "/welcome/organization", "Your organization"],
      ["Back to Agent login", "/welcome/agent-login", "Agent login"],
      ["Back to Git access", "/welcome/git-access", "Git access"],
      ["Back to Command line", "/welcome/command-line", "Mend's command line"],
    ]) {
      await capture(`phone-before-${path.split("/").at(-1)}`);
      await page.getByRole("link", { name: label, exact: true }).click();
      await at(path);
      await heading(title);
      arrows.push(`${label} → ${path}`);
    }
    expect(
      "Command line has no back arrow",
      (await page.getByRole("link", { name: /^Back to / }).count()) === 0,
      "arrow",
    );
    await capture("phone-cli");
    note(`at 390px: ${arrows.join("; ")}; Command line has no back arrow`);
    await page.setViewportSize(DESKTOP);
    await settled();
  } finally {
    await api("DELETE", `/api/me/devices/${computer.id}`);
    note(`revoked '${computer.name}'`);
    if (renamed) await call("organization.rename", { name: organization }, "mutate");
    note(renamed ? `put the organization's name back to '${organization}'` : "name unchanged");
  }

  // ---- Someone who joins: five steps, skipping Command line and Agent login.
  claudeConnected = false;
  const invitation = await api("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("setup-revisit-invitation", invitation.body.token);
  const owner = await page.context().cookies();
  await page.context().clearCookies();
  const email = `rosalind-${suffix}@example.invalid`;
  await open(`/join#${invitation.body.token}`);
  await page.getByRole("textbox", { name: "Name" }).fill("Rosalind Verify");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "joiner-password",
    `rf-${suffix}-pw-1`,
  );
  await typeSecret(page.getByLabel("Confirm password"), "joiner-password", `rf-${suffix}-pw-1`);
  await button("Create account and join").click();
  await at("/welcome/command-line");
  await hydrated();
  await heading("Mend's command line");
  await button("Skip for now").click();
  await at("/welcome/git-access");
  await heading("Git access");
  await keyWorks();
  await button("Continue").click();
  await at("/welcome/agent-login");
  await heading("Agent login");
  await button("Skip for now").click();
  await at("/welcome/first-project");
  await heading("Add a project");
  const joinedLinks = await railLinks();
  expect(
    "a joiner's links",
    JSON.stringify(joinedLinks) ===
      JSON.stringify(["Command line, skipped", "Git access, done", "Agent login, skipped"]),
    joinedLinks,
  );
  note(
    `a person who joined skipped two steps and reached First project; links: ${joinedLinks.join(" · ")}`,
  );
  await shot("joiner-first-project", ["desktop", "phone"]);

  await railLink("Command line, skipped").click();
  await at("/welcome/command-line");
  await heading("Mend's command line");
  await button("Skip for now").waitFor();
  const joinerBack = await railLinks();
  note(
    `'Command line, skipped' opened the step as it was: the commands, the wait and Skip for now; links: ${joinerBack.join(" · ")}`,
  );
  await shot("joiner-back-cli");
  await railLink("Agent login, skipped").click();
  await at("/welcome/agent-login");
  await heading("Agent login");
  await button("Skip for now").waitFor();
  note("'Agent login, skipped' opened the step with Skip for now, to connect an agent now");
  await railLink("Git access, done").click();
  await at("/welcome/git-access");
  await heading("Git access");
  await button("Continue").click();
  await at("/welcome/agent-login");
  await button("Skip for now").click();
  await at("/welcome/first-project");
  await heading("Add a project");
  note(
    "back on Git access, Continue went to Agent login and Skip for now to First project: forward each time",
  );

  // Signing in again lands on the first step they owe: Git access through /welcome (no agent
  // login, so the way into setup keeps them there).
  await page.context().clearCookies();
  await open("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await typeSecret(
    page.getByLabel("Password", { exact: true }),
    "joiner-password",
    `rf-${suffix}-pw-1`,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/welcome"), { timeout: 30_000 });
  const landed = new URL(page.url()).pathname;
  note(`signing in again as the member landed on ${landed}`);
  expect("signing in lands on Git access", landed === "/welcome", landed);
  await page.context().clearCookies();
  await page.context().addCookies(owner);
};
