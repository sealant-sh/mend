// The organization's General settings page in the new web app (route PR 45, SLNT-1164):
// `/settings/organization`, its name (an owner renames it, server gap S15), the person's role, the
// owners, and leaving the organization.
//
//   pnpm verify drive new-web --recipe new-web-org-general
//
// Feature ids (organization.md): leaving, from General (`org-leave`'s dialog, opened from the
// page). New with this page: an owner renames the organization (`PUT /organization/name`), and a
// member reads the name and who may change it.
//
// What is real and what is rewritten:
// - Real: the owner's page; the rename (Unsaved changes, an empty name refused beside the field,
//   Save, the toast, the breadcrumb and sidebar reading the new name, its audit entry, a reload);
//   a second person who joins through an invitation in a second browser, made an owner and back
//   by the stack's API; that person's own page as a member (their sign-in is moved into this
//   page for the picture, then the owner's is put back); the Leave row on a stack whose people
//   each have one organization (no Leave button, and why); a read that fails, and Try again.
// - Rewritten in the page: a taken name (a stack has no other organization to take it), and a
//   second organization in the person's list (a stack runs one), which
//   is what offers Leave. The dialog's words, and the server's own refusal when Leave is pressed,
//   are real.
//
// The recipe puts the name back and removes the person it added, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const OTHER = { id: "0b6d1c55-8f0e-4c55-9b55-5f0a1c2f1164", name: "Verify Labs" };

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
  const shot = async (name) => {
    await page.mouse.move(1, 1);
    await settled();
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

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await owner("GET", "/api/organization");
  expect("the owner's organization", me.status === 200 && me.body.role === "owner", me);
  const organization = me.body.organization.name;
  const roster = await owner("GET", "/api/organization/members");
  const ownerName = roster.body.find((member) => member.userId === me.body.userId)?.name ?? "";
  note(`signed in as ${ownerName}, owner of ${organization}`);

  // --- The page, as its owner -----------------------------------------------------------------
  await open("/settings/organization");
  await heading("General");
  await text(`Everyone in ${organization}`).waitFor();
  await text(`The name and owners of ${organization}. Only owners can change them.`).waitFor();
  const active = await page
    .locator('[data-slot="sidebar"][aria-label="Settings"] [aria-current="page"]')
    .first()
    .textContent();
  expect("the sidebar highlights General", active?.trim() === "General", active);
  expect("the name field", (await nameField().inputValue()) === organization, organization);
  await text("Owner").waitFor();
  await visible(page.getByRole("list", { name: `${organization}'s owners` })).waitFor();
  await text(
    `${organization} is your only organization on this server, so you can't leave it. An owner can remove you instead.`,
  ).waitFor();
  if ((await page.getByRole("button", { name: `Leave ${organization}…` }).count()) !== 0)
    throw new Error("Leave is offered in the person's only organization");
  note(
    "General: name field, role Owner, the owners list, and no Leave in the only organization (said why)",
  );
  await shot("general-owner-desktop-light");

  // --- Old addresses, and the switcher's settings item -----------------------------------------
  for (const old of ["/settings/organization/", "/settings/organization/defaults"]) {
    await page.goto(`${web}${old}`);
    await page.waitForURL((url) => url.pathname.replace(/\/$/, "") === "/settings/organization");
    await heading("General");
    note(`${old} → ${path()}`);
  }
  await open("/");
  await visible(page.getByRole("button", { name: /, switch organization$/ })).click();
  const item = visible(page.getByRole("menuitem", { name: `${organization} settings` }));
  expect(
    "the switcher's settings item",
    (await item.getAttribute("href")) === "/settings/organization",
    await item.getAttribute("href"),
  );
  await item.click();
  await page.waitForURL((url) => url.pathname === "/settings/organization");
  await heading("General");
  note(`the organization switcher's "${organization} settings" opens General`);

  // --- Rename ---------------------------------------------------------------------------------
  const renamed = `${organization} Verify`;
  await hydrated();
  await nameField().fill(renamed);
  await text("Unsaved changes").waitFor();
  await visible(
    page.getByText(
      `People see it in the sidebar and when they open an invitation. It was ${organization}.`,
    ),
  ).waitFor();
  note(`typing a new name shows Unsaved changes, and "It was ${organization}."`);
  await shot("general-name-unsaved-desktop-light");
  await nameField().press("Escape");
  expect("Escape discards", (await nameField().inputValue()) === organization, "");
  if ((await page.getByText("Unsaved changes", { exact: true }).count()) !== 0)
    throw new Error("Unsaved changes stays after Escape");
  note("Escape puts the saved name back");
  await nameField().fill("   ");
  await button("Save").click();
  await text("An organization needs a name.").waitFor();
  note("an empty name is refused beside the field, before anything is sent");
  await shot("general-name-empty-desktop-light");
  // A stack runs one organization, so no name is taken: the server's 409 is written into the
  // page's answer, as the API sends it (organization.test.ts proves the server's side).
  const taken = `There's already an organization called ${OTHER.name}. Pick another name.`;
  await page.route("**/trpc/**", async (route) => {
    if (!pathsOf(route.request()).includes("organization.rename")) return route.continue();
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify([
        {
          error: {
            json: {
              message: taken,
              code: -32009,
              data: {
                code: "CONFLICT",
                httpStatus: 409,
                path: "organization.rename",
                tag: "OrganizationNameTaken",
              },
            },
          },
        },
      ]),
    });
  });
  await nameField().fill(OTHER.name);
  await button("Save").click();
  await text(taken).waitFor();
  note("a taken name (rewritten answer) is refused beside the field in the server's words");
  await shot("general-name-taken-desktop-light");
  await page.unroute("**/trpc/**");
  await nameField().fill(renamed);
  await button("Save").click();
  await visible(
    page.getByRole("region", { name: /Notifications/ }).getByText(`Renamed to ${renamed}.`),
  ).waitFor();
  await visible(page.getByRole("navigation", { name: "Breadcrumb" }).getByText(renamed)).waitFor();
  await text(`Everyone in ${renamed}`).waitFor();
  note(`Save renames it: the toast, the breadcrumb and the audience line read "${renamed}"`);
  await shot("general-renamed-desktop-light");
  const audit = await owner("GET", "/api/organization/audit?limit=1");
  const [entry] = audit.body ?? [];
  expect(
    "the rename's audit entry",
    entry?.event.action === "organization.renamed" && entry.event.data?.name === renamed,
    audit,
  );
  note(`audit log: ${entry.actorName} organization.renamed → ${entry.event.data.name}`);
  await open("/settings/organization");
  expect("the name holds across a reload", (await nameField().inputValue()) === renamed, "");
  await nameField().fill(organization);
  await nameField().press("Enter");
  await visible(
    page.getByRole("region", { name: /Notifications/ }).getByText(`Renamed to ${organization}.`),
  ).waitFor();
  note(`Enter saves: renamed back to ${organization}`);

  // --- A second person joins, and is made an owner ------------------------------------------
  const invitation = await owner("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  const personName = "Mae Verify";
  let memberId = null;
  try {
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await memberPage.getByRole("heading", { name: /^Join / }).waitFor();
    const email = `verify-general-${Date.now()}@example.invalid`;
    await memberPage.getByRole("textbox", { name: "Name" }).fill(personName);
    await memberPage.getByRole("textbox", { name: "Email" }).fill(email);
    await typeSecret(
      memberPage.getByLabel("Password", { exact: true }),
      "member-password",
      "a-general-verify-password",
    );
    await typeSecret(
      memberPage.getByLabel("Confirm password"),
      "member-password",
      "a-general-verify-password",
    );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome");
    const memberMe = await apiOf(memberPage)("GET", "/api/organization");
    expect("the member joined", memberMe.body?.role === "member", memberMe);
    memberId = memberMe.body.userId;
    note(`${personName} joined as a member (${email})`);

    // --- That person's own page, as a member ------------------------------------------------
    const ownerCookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(await second.cookies());
    await open("/settings/organization");
    await heading("General");
    const field = nameField();
    expect(
      "a member's name field is read-only",
      (await field.getAttribute("readonly")) !== null,
      "",
    );
    await visible(
      page.getByText(
        `People see it in the sidebar and when they open an invitation. Only an owner can rename it: ${ownerName}.`,
      ),
    ).waitFor();
    await text("Member").waitFor();
    note(`as ${personName}: the name is read-only, "Only an owner can rename it: ${ownerName}."`);
    await shot("general-member-desktop-light");
    const refused = await apiOf(page)("PUT", "/api/organization/name", { name: "Not mine" });
    expect("the server refuses a member's rename", refused.status === 404, refused);
    note("the server answers a member's rename 404");
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);

    // --- Two owners ---------------------------------------------------------------------------
    const promoted = await owner("PUT", `/api/organization/members/${memberId}/role`, {
      role: "owner",
    });
    expect("made an owner", promoted.status === 200, promoted);
    await open("/settings/organization");
    const owners = visible(page.getByRole("list", { name: `${organization}'s owners` }));
    await owners.getByText(personName).waitFor();
    await visible(owners.getByText("Joined today")).waitFor();
    note(`${personName} made an owner: the owners list has both, each with when they joined`);
    await shot("general-two-owners-desktop-light");

    // --- Leave, with a second organization written into the list -----------------------------
    await page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes("organizations.list")) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const changed = paths.map((p, index) => {
        const answer = Array.isArray(answers) ? answers[index] : answers;
        const json = answer?.result?.data?.json;
        if (p !== "organizations.list" || !Array.isArray(json)) return answer;
        const [first] = json;
        if (first !== undefined && !json.some((row) => row.organization.id === OTHER.id))
          json.push({
            ...first,
            organization: { ...first.organization, ...OTHER },
            active: false,
          });
        return answer;
      });
      await route.fulfill({
        status: response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization");
    await heading("General");
    await text(
      `${personName} is also an owner, so you can leave. If you were the only owner, you'd need to make someone else an owner first.`,
    ).waitFor();
    await button(`Leave ${organization}…`).click();
    const dialog = visible(page.getByRole("dialog", { name: `Leave ${organization}?` }));
    await dialog.getByText(`${personName} stays as ${organization}'s owner.`).waitFor();
    await dialog.getByText(`You'll go to ${OTHER.name}, your other organization.`).waitFor();
    note("with a second organization (rewritten), Leave opens the dialog: what the person loses");
    await shot("general-leave-dialog-desktop-light");
    await dialog.getByRole("button", { name: `Leave ${organization}`, exact: true }).click();
    await dialog.getByText(`You're still in ${organization}.`).waitFor();
    note("the server's own refusal (it is really the only organization) shows in the dialog");
    await shot("general-leave-refused-desktop-light");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    const demoted = await owner("PUT", `/api/organization/members/${memberId}/role`, {
      role: "member",
    });
    expect("back to member", demoted.status === 200, demoted);
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization");
    await heading("General");
    await text(
      `You're ${organization}'s only owner. Make someone else an owner on the Members page before you leave.`,
    ).waitFor();
    await button(`Leave ${organization}…`).click();
    const onlyOwner = visible(page.getByRole("dialog", { name: `Leave ${organization}?` }));
    await onlyOwner.getByText("You can't leave yet.").waitFor();
    note("as the only owner, the row says so and the dialog says to make someone else an owner");
    await shot("general-leave-only-owner-desktop-light");
    await page.keyboard.press("Escape");
    await onlyOwner.waitFor({ state: "hidden" });
    await page.unroute("**/trpc/**");
  } finally {
    if (memberId !== null) {
      const removed = await owner("DELETE", `/api/organization/members/${memberId}`);
      note(`${personName} removed again: ${removed.status}`);
    }
    await second.close();
  }

  // --- Dark, and the phone ----------------------------------------------------------------------
  await clearCache();
  await open("/settings/organization");
  await heading("General");
  await paint("dark");
  await shot("general-owner-desktop-dark");
  await paint("light");
  await page.setViewportSize(PHONE);
  await open("/settings/organization");
  await visible(page.getByRole("heading", { name: "General" })).waitFor();
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`general-owner-phone-${theme}`);
  }
  await paint("light");
  await nameField().fill(`${organization} Verify`);
  await text("Unsaved changes").waitFor();
  note("on a phone, Discard and Save sit at the foot of the page");
  await shot("general-name-unsaved-phone-light");
  await nameField().press("Escape");
  await page.setViewportSize(DESKTOP);

  // --- A read that fails --------------------------------------------------------------------
  await open("/settings/profile");
  await page.route("**/trpc/**", async (route) => {
    const paths = pathsOf(route.request());
    if (!paths.includes("organizations.list")) return route.continue();
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
    const changed = paths.map((p, index) => (p === "organizations.list" ? failure : list[index]));
    await route.fulfill({
      status: paths.length === 1 ? 500 : 207,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
    });
  });
  await clearCache();
  await navigate("/settings/organization");
  await heading("This page didn't load");
  note("General's read failing shows the error screen with Try again");
  await shot("general-error-desktop-light");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("General");
  note("Try again reads again and General draws");
};
