// A project's settings frame and its General page in the web app (route PR 52, SLNT-1171):
// `/projects/<id>/settings` and `/projects/<id>/settings/general`, the project's pages in the
// settings sidebar and the phone's list of them, the old `/projects/<id>/configuration#…` and
// `…/settings/<old section>` addresses, renaming a project (server gap S20), who can see it,
// removing it, and restoring or purging it from its own page.
//
//   pnpm verify drive web --recipe project-general
//
// Feature ids: project-settings.md `settings-visibility`, `settings-remove`, `settings-retention`;
// organization.md `visibility`. New with this page: `projects.rename` over `POST /projects/:id/name`.
//
// What is real and what is rewritten:
// - Real: a project the recipe creates (no repository, so removal has nothing in its way); its
//   General page as its owner; renaming it (a name Mend won't take, a taken one, Save, Enter, the
//   audit entry); making it shared and private; Remove project…, the removed view with Restore and
//   Purge…; a second person, who joins through an invitation in a second browser, reading the
//   shared project's page as a member (their sign-in is moved into this page for the picture and
//   the owner's put back); the phone's list and page; the old addresses; the project's "…".
// - Rewritten: a read of the project that fails (a 500), for the error screen and Try again.
//
// The recipe removes the person it added, and purges the project it made (or, when the server
// still refuses the purge, leaves it removed for the next run to purge), so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const personName = "Mae Verify";
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
/** One person's API, from their signed-in page. */
const apiOf = (on) => (method, url, body) =>
  on.evaluate(
    async ({ verb, address, payload }) => {
      const response = await fetch(address, {
        method: verb,
        headers: { "content-type": "application/json" },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text) };
    },
    { verb: method, address: url, payload: body },
  );
const expect = (what, ok, seen) => {
  if (!ok) throw new Error(`${what}: saw ${JSON.stringify(seen).slice(0, 400)}`);
};
const pathsOf = (request) =>
  decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
    .split(",")
    .filter((path) => path !== "");

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const settled = () => page.waitForTimeout(500);
  const path = () => new URL(page.url()).pathname;
  const heading = (name) => visible(page.getByRole("heading", { name, exact: true })).waitFor();
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
    await hydrated();
    await page.waitForTimeout(1_000);
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
  };
  const navigate = (to) => page.evaluate((href) => window["__TSR_ROUTER__"].navigate({ href }), to);
  const clearCache = () =>
    page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
  /** A tRPC call from the page, as the signed-in person. */
  const call = (route, input, kind = "query") =>
    page.evaluate(
      async ({ route: name, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of name.split(".")) target = target[part];
        return target[verb](value);
      },
      { route, input, kind },
    );
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
    // Vite's overlay can cover the page when a proxied socket closes (ECONNRESET): not the page's.
    await page.locator("vite-error-overlay").evaluateAll((all) => all.forEach((el) => el.remove()));
    await capture(name);
  };
  const paint = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const owner = apiOf(page);
  const nameField = () => visible(page.getByLabel("Name", { exact: true }));
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const text = (words) => visible(page.getByText(words, { exact: true }));
  const toastSays = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words)).waitFor();
  const crumbs = async () =>
    (await visible(page.getByRole("navigation", { name: "Breadcrumb" })).innerText()).replace(
      /\s+/g,
      " ",
    );

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await owner("GET", "/api/organization");
  expect("the owner's organization", me.status === 200 && me.body.role === "owner", me);
  const organization = me.body.organization.name;
  const roster = await owner("GET", "/api/organization/members");
  const ownerName = roster.body.find((member) => member.userId === me.body.userId)?.name ?? "";
  note(`signed in as ${ownerName}, owner of ${organization}`);

  // Projects an earlier run left when it stopped partway go first.
  const LEFT = /^general-[a-z0-9]{4}(-renamed)?$/;
  for (const left of (await call("projects.list")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.remove", { id: left.id }, "mutate").catch(() => undefined);
  for (const left of (await call("projects.removed")).filter((entry) => LEFT.test(entry.name)))
    await call("projects.purge", { id: left.id, confirm: left.name }, "mutate").catch(
      () => undefined,
    );
  const name = `general-${Math.random().toString(36).slice(2, 6)}`;
  const project = await call("projects.createNew", { name }, "mutate");
  const other = (await call("projects.list")).find((entry) => entry.id !== project.id);
  note(`made ${name} (${project.id}), private, with no repository`);
  const home = `/projects/${project.id}/settings`;
  let memberId = null;
  const second = await page.context().browser().newContext();

  try {
    // --- The frame: the address, the sidebar, the breadcrumb ----------------------------------
    await open(home);
    await heading("General");
    await text(`Everyone who can open ${name}`).waitFor();
    expect("the breadcrumb", (await crumbs()) === `Settings / ${name} / General`, await crumbs());
    const settings = page.locator('[data-slot="sidebar"][aria-label="Settings"]');
    const active = await settings.locator('[aria-current="page"]').first().textContent();
    expect("the sidebar highlights the project's General", active?.trim() === "General", active);
    const pages = await visible(settings.getByRole("list", { name })).innerText();
    note(`${home}: General; sidebar lists ${name}'s pages: ${pages.replace(/\s+/g, ", ")}`);
    await shot("project-general-owner-desktop-light");
    await open(`${home}/general`);
    await heading("General");
    note(`${home}/general is the same page`);
    await visible(settings.getByRole("link", { name: "Services", exact: true })).click();
    await page.waitForURL((url) => url.pathname === `${home}/services`);
    await heading("Services");
    note("the sidebar's Services opens the project's Services page");
    await navigate(`${home}/general`);
    await heading("General");

    // --- Old addresses ---------------------------------------------------------------------
    for (const [old, now] of [
      [`/projects/${project.id}/configuration#visibility`, `${home}/general`],
      [`/projects/${project.id}/configuration`, `${home}/general`],
      [`/projects/${project.id}/configuration#cluster-bindings`, `${home}/secrets`],
      [`/projects/${project.id}/configuration#skills`, `/projects/${project.id}/skills`],
      [`${home}/landing`, "/settings/automation"],
      [`${home}/git`, "/settings/agent-logins"],
    ]) {
      await page.goto(`${web}${old}`);
      await page.waitForURL((url) => url.pathname === now, { timeout: 60_000 });
      note(`${old} → ${path()}`);
    }

    // --- The project's "…" opens its settings -------------------------------------------------
    await open(`/projects/${project.id}`);
    await visible(page.getByRole("button", { name: `${name} menu`, exact: true })).click();
    const item = visible(page.getByRole("menuitem", { name: "Project settings" }));
    expect("the project's settings item", (await item.getAttribute("href")) === home, home);
    await item.click();
    await page.waitForURL((url) => url.pathname === home);
    await heading("General");
    note(`the project's "…" → Project settings opens ${home}`);

    // --- Rename -------------------------------------------------------------------------------
    await hydrated();
    await nameField().fill("Not A Name");
    await text("Unsaved changes").waitFor();
    await button("Save").click();
    await visible(page.getByText(/^Use lowercase letters, digits/)).waitFor();
    note("a name Mend won't take is refused beside the field, before anything is sent");
    await shot("project-general-name-refused-desktop-light");
    if (other !== undefined) {
      await nameField().fill(other.name);
      await button("Save").click();
      await text(`${organization} already has a project named ${other.name}.`).waitFor();
      note(`a taken name (${other.name}) is refused beside the field`);
    }
    await nameField().press("Escape");
    expect("Escape discards", (await nameField().inputValue()) === name, "");
    const renamed = `${name}-renamed`;
    await nameField().fill(renamed);
    await visible(
      page.getByText(`Each project in ${organization} needs its own name. It was ${name}.`),
    ).waitFor();
    await shot("project-general-name-unsaved-desktop-light");
    await button("Save").click();
    await toastSays(`Renamed to ${renamed}.`);
    await visible(
      page.getByRole("navigation", { name: "Breadcrumb" }).getByText(renamed),
    ).waitFor();
    await visible(settings.getByText(renamed)).waitFor();
    note(`Save renames it: the toast, the breadcrumb and the sidebar read "${renamed}"`);
    await shot("project-general-renamed-desktop-light");
    const audit = await owner("GET", "/api/organization/audit?limit=5");
    const renameEntry = (audit.body ?? []).find((row) => row.event.action === "project.renamed");
    expect("the rename's audit entry", renameEntry?.event.data?.name === renamed, audit);
    note(
      `audit log: project.renamed ${renameEntry.event.data.previousName} → ${renameEntry.event.data.name}`,
    );
    await open(`${home}/general`);
    expect("the name holds across a reload", (await nameField().inputValue()) === renamed, "");
    await nameField().fill(name);
    await nameField().press("Enter");
    await toastSays(`Renamed to ${name}.`);
    note(`Enter saves: renamed back to ${name}`);

    // --- Who can see it ---------------------------------------------------------------------
    const visibleTo = visible(page.getByRole("group", { name: "Visible to" }));
    await text("Only you can see it and its sessions.").waitFor();
    await visibleTo.getByRole("button", { name: `Everyone in ${organization}` }).click();
    await visible(
      page.getByText(
        /^Everyone in .* can see its sessions and start their own\. Making it private/,
      ),
    ).waitFor();
    // The line changes while the save is in flight: wait for the server's answer.
    let shared = await call("projects.detail", { id: project.id });
    for (let tries = 0; tries < 20 && shared.project.visibility !== "shared"; tries += 1) {
      await page.waitForTimeout(500);
      shared = await call("projects.detail", { id: project.id });
    }
    expect(
      "shared on the server",
      shared.project.visibility === "shared",
      shared.project.visibility,
    );
    note(`settings-visibility: Everyone in ${organization} saved (the server reads shared)`);
    await shot("project-general-shared-desktop-light");

    // --- A second person reads the shared project's page ---------------------------------------
    const invitation = await owner("POST", "/api/organization/invitations", { role: "member" });
    expect("an invitation", invitation.status === 200, invitation.status);
    registerSecret("invitation-token", invitation.body.token);
    const memberPage = await second.newPage();
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await memberPage.getByRole("heading", { name: /^Join / }).waitFor();
    const email = `verify-project-general-${Date.now()}@example.invalid`;
    await memberPage.getByRole("textbox", { name: "Name" }).fill(personName);
    await memberPage.getByRole("textbox", { name: "Email" }).fill(email);
    await typeSecret(
      memberPage.getByLabel("Password", { exact: true }),
      "member-password",
      "a-project-general-verify-password",
    );
    await typeSecret(
      memberPage.getByLabel("Confirm password"),
      "member-password",
      "a-project-general-verify-password",
    );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome");
    const memberMe = await apiOf(memberPage)("GET", "/api/organization");
    expect("the member joined", memberMe.body?.role === "member", memberMe);
    memberId = memberMe.body.userId;
    note(`${personName} joined as a member`);

    const ownerCookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(await second.cookies());
    await open(`${home}/general`);
    await heading("General");
    expect(
      "a member's name field is read-only",
      (await nameField().getAttribute("readonly")) !== null,
      "",
    );
    await visible(
      page.getByText(
        `${ownerName}, who added ${name}, and ${organization}'s owners can change these settings. You can read them.`,
        { exact: false },
      ),
    ).waitFor();
    await visible(page.getByText(`Only ${ownerName} can change this.`, { exact: false })).waitFor();
    await text(`Only ${ownerName} can remove it.`).waitFor();
    expect(
      "no Remove project… for a member",
      (await page.getByRole("button", { name: "Remove project…" }).count()) === 0,
      "",
    );
    expect(
      "no visibility switch for a member",
      (await page.getByRole("group", { name: "Visible to" }).count()) === 0,
      "",
    );
    note(`as ${personName}: read-only name, who can change it by name, no switch, no Remove`);
    await shot("project-general-member-desktop-light");
    const refused = await apiOf(page)("POST", `/api/projects/${project.id}/name`, {
      name: "not-mine",
    });
    expect("the server refuses a member's rename", refused.status === 404, refused);
    note("the server answers a member's rename 404");
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);

    await open(`${home}/general`);
    await visible(page.getByRole("group", { name: "Visible to" }))
      .getByRole("button", { name: "Only you" })
      .click();
    await text("Only you can see it and its sessions.").waitFor();
    note("made private again");

    // --- Dark, and the phone ------------------------------------------------------------------
    await paint("dark");
    await shot("project-general-owner-desktop-dark");
    await paint("light");
    await page.setViewportSize(PHONE);
    await open(home);
    await visible(page.getByRole("list", { name: `${name} settings` })).waitFor();
    await text("Only you can see this project.").waitFor();
    note("phone: /settings lists the project's pages under its name");
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`project-settings-list-phone-${theme}`);
    }
    await paint("light");
    await visible(page.getByRole("link", { name: "General" })).click();
    await page.waitForURL((url) => url.pathname === `${home}/general`);
    await visible(page.getByRole("heading", { name: "General" })).waitFor();
    for (const theme of ["light", "dark"]) {
      await paint(theme);
      await shot(`project-general-owner-phone-${theme}`);
    }
    await paint("light");
    const back = visible(page.getByRole("link", { name: `${name} settings` }));
    expect("Back goes to the project's list", (await back.getAttribute("href")) === home, "");
    await button("Remove project…").click();
    await visible(page.getByRole("dialog", { name: `Remove ${name}?` })).waitFor();
    await shot("project-general-remove-phone-light");
    await page.keyboard.press("Escape");
    await page.setViewportSize(DESKTOP);

    // --- Remove, restore and purge from the page ------------------------------------------------
    await open(`${home}/general`);
    await button("Remove project…").click();
    const removeDialog = visible(page.getByRole("dialog", { name: `Remove ${name}?` }));
    await removeDialog.getByText(`${name} leaves the Projects list.`, { exact: false }).waitFor();
    await shot("project-general-remove-desktop-light");
    await removeDialog.getByRole("button", { name: "Remove project", exact: true }).click();
    await toastSays(`${name} was removed. You can restore it here.`);
    await visible(page.getByRole("list", { name: "Removed project" })).waitFor();
    expect("still on the page", path() === `${home}/general`, path());
    const listed = (await call("projects.list")).some((entry) => entry.id === project.id);
    expect("gone from the project list", !listed, listed);
    note("settings-remove: removed from its page; the page now shows it removed");
    await shot("project-general-removed-desktop-light");
    await button("Restore").click();
    await toastSays(`${name} is back in ${organization}'s projects.`);
    await heading("General");
    await visible(page.getByRole("button", { name: "Remove project…" })).waitFor();
    note("settings-retention: Restore brings it back, and its General page draws again");
    await button("Remove project…").click();
    await visible(page.getByRole("dialog", { name: `Remove ${name}?` }))
      .getByRole("button", { name: "Remove project", exact: true })
      .click();
    await visible(page.getByRole("list", { name: "Removed project" })).waitFor();
    await button("Purge…").click();
    const purge = visible(page.getByRole("dialog", { name: `Purge ${name}?` }));
    await purge.getByLabel(/^Type/).fill(name);
    await shot("project-general-purge-desktop-light");
    await purge.getByRole("button", { name: "Purge project", exact: true }).click();
    // The server refuses a purge for a while after removal, while an upload the project started may
    // still land, and says until when: the dialog shows its words. Either answer is the real one.
    const gone = visible(page.getByRole("heading", { name: "Page not found", exact: true }));
    const refusedPurge = purge.getByText(`${name} wasn't purged.`);
    await gone.or(refusedPurge).waitFor({ timeout: 60_000 });
    if (await refusedPurge.isVisible()) {
      note(
        `settings-retention: Purge… refused by the server in its words: ${(await purge.innerText()).replace(/\s+/g, " ").slice(0, 300)}`,
      );
      await shot("project-general-purge-refused-desktop-light");
      await page.keyboard.press("Escape");
      await purge.waitFor({ state: "hidden" });
    } else {
      const left = (await call("projects.removed")).some((entry) => entry.id === project.id);
      expect("purged", !left, left);
      note("settings-retention: Purge… with the name typed deletes it; its address is not found");
      await shot("project-general-purged-desktop-light");
    }

    // --- A read that fails --------------------------------------------------------------------
    const kept = other ?? null;
    if (kept !== null) {
      await open("/settings/profile");
      await page.route("**/trpc/**", async (route) => {
        const paths = pathsOf(route.request());
        if (!paths.includes("projects.detail")) return route.continue();
        const failure = {
          error: {
            json: {
              message: "The verify recipe failed this read on purpose.",
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
        const response = await route.fetch();
        const answers = await response.json();
        const list = Array.isArray(answers) ? answers : [answers];
        const changed = paths.map((p, index) => (p === "projects.detail" ? failure : list[index]));
        await route.fulfill({
          status: paths.length === 1 ? 500 : 207,
          contentType: "application/json",
          body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
        });
      });
      await clearCache();
      await navigate(`/projects/${kept.id}/settings/general`);
      await heading("This page didn't load");
      note("General's read failing shows the error screen with Try again");
      await shot("project-general-error-desktop-light");
      await page.unroute("**/trpc/**");
      await button("Try again").click();
      await heading("General");
      note("Try again reads again and General draws");
    }
  } finally {
    if (memberId !== null) {
      const removed = await owner("DELETE", `/api/organization/members/${memberId}`);
      note(`${personName} removed again: ${removed.status}`);
    }
    await second.close();
    const live = (await call("projects.list")).find((entry) => entry.id === project.id);
    if (live !== undefined)
      await call("projects.remove", { id: live.id }, "mutate").catch(() => {});
    const removed = (await call("projects.removed")).find((entry) => entry.id === project.id);
    if (removed !== undefined)
      await call("projects.purge", { id: removed.id, confirm: removed.name }, "mutate").catch(
        () => {},
      );
  }
};
