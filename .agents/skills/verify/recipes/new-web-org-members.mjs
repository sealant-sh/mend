// The organization's Members page in the new web app (route PR 46, SLNT-1164):
// `/settings/organization/members`, the roster for everyone, invitations, roles, password reset
// links and removal for its owners.
//
//   pnpm verify drive new-web --recipe new-web-org-members
//
// Feature ids (organization.md): `members-web` (one row each with email, role and join day),
// `invite-web` (a one-time link, optionally bound to an email), `invite-revoke` (revoke an open
// link; used, expired and revoked ones behind a fold), `role-change` (member to owner and back;
// the last owner is refused), `password-reset` (a one-time reset link for a member, owners only),
// `member-removal` (remove someone; their open browser goes to `/login?reason=access`); operator.md
// owner invitations land in the same list (an owner link is made here as the owner, the operator's
// path is the CLI's).
//
// What is real and what is rewritten:
// - Real: every action. The owner makes a link bound to an email through the dialog, a second
//   person joins with it in a second browser, the page says so, the owner makes them an owner and
//   undoes it, makes a reset link for them, revokes another link, then removes them. Their own
//   view of the page is captured with their sign-in moved into this page. A page that shows a live
//   link is recorded by its ARIA snapshot only (the driver redacts the link and withholds the
//   picture).
// - Rewritten in the page: the pictures of the link dialogs and the reset panel (the link answered
//   as `/join#<token>`, `/reset#<token>`), the server refusing a role change (its last-owner words),
//   and a first read that fails.
//
// The recipe removes the person it adds and revokes every link it makes, so it can run again.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const visible = (locator) => locator.filter({ visible: true }).first();
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
const failure = (message, code, httpStatus, tag) => ({
  error: {
    json: {
      message,
      code,
      data: {
        code: tag === null ? "INTERNAL_SERVER_ERROR" : "UNPROCESSABLE_CONTENT",
        httpStatus,
        ...(tag === null ? {} : { tag }),
      },
    },
  },
});

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const settled = () => page.waitForTimeout(500);
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
  const button = (name) => visible(page.getByRole("button", { name, exact: true }));
  const dialog = (name) => visible(page.getByRole("dialog", { name }));
  const toastSays = (words) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(words)).waitFor();
  /** Answer one procedure with a refusal, without sending the call: nothing changes on the server. */
  const refuse = (procedure, answer) =>
    page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes(procedure)) return route.continue();
      await route.fulfill({
        status: paths.length === 1 ? answer.error.json.data.httpStatus : 207,
        contentType: "application/json",
        body: JSON.stringify(paths.map(() => answer)),
      });
    });
  /** Rewrite one procedure's answers: `change(json)` edits a success, or returns a failure. */
  const rewrite = (procedure, change) =>
    page.route("**/trpc/**", async (route) => {
      const paths = pathsOf(route.request());
      if (!paths.includes(procedure)) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const list = Array.isArray(answers) ? answers : [answers];
      let failed = false;
      const changed = paths.map((p, index) => {
        const answer = list[index];
        if (p !== procedure) return answer;
        const out = change(answer?.result?.data?.json, answer);
        if (out?.error !== undefined) failed = true;
        return out ?? answer;
      });
      await route.fulfill({
        status: failed
          ? paths.length === 1
            ? changed[0].error.json.data.httpStatus
            : 207
          : response.status(),
        contentType: "application/json",
        body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
      });
    });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await owner("GET", "/api/organization");
  expect("the owner", me.status === 200 && me.body.role === "owner", me);
  const organization = me.body.organization.name;
  const made = [];
  // Links an earlier run of this recipe left open (it stopped part way): revoked, so the run starts
  // from the same page.
  const left = await owner("GET", "/api/organization/invitations");
  for (const invitation of left.body ?? [])
    if (
      invitation.acceptedAt === null &&
      invitation.revokedAt === null &&
      (invitation.email === null ||
        invitation.email.startsWith("verify-members-") ||
        invitation.email === "someone@example.invalid")
    )
      await owner("DELETE", `/api/organization/invitations/${invitation.id}`);

  // --- The roster, as its only owner -------------------------------------------------------------
  await page.goto(`${web}/settings/organization/invitations`);
  await page.waitForURL((url) => url.pathname === "/settings/organization/members");
  note("/settings/organization/invitations → /settings/organization/members");
  // Settle the page as every other step does: the dev server may reload it once on first load.
  await open("/settings/organization/members");
  await heading("Members");
  await visible(page.getByText(`Everyone in ${organization}`, { exact: true })).waitFor();
  await visible(page.getByText(`You're ${organization}'s only owner.`)).waitFor();
  await visible(page.getByLabel("Locked: the only owner")).waitFor();
  note("the only owner: their role is locked, and the page says why");
  await shot("members-only-owner-desktop-light");

  // --- Invite someone (real) ---------------------------------------------------------------------
  const email = `verify-members-${Date.now()}@example.invalid`;
  await button("Create invitation…").click();
  const create = dialog("Create invitation");
  await create.waitFor();
  await create.getByRole("button", { name: "Member", exact: true }).click();
  await create.getByRole("textbox", { name: /Email/ }).fill(email);
  await create.getByLabel("Expires after").selectOption("7");
  note("Create invitation: role, an email the link is bound to, and how long it lasts");
  await shot("invite-dialog-desktop-light");
  await create.getByRole("button", { name: "Create invitation link" }).click();
  const created = dialog("Invitation link created");
  await created.waitFor();
  const link = (await created.locator("[data-slot=copy-field]").innerText()).split("\n")[0].trim();
  const token = new URL(link).hash.replace(/^#/, "");
  registerSecret("invitation-token", token);
  await created.getByText(`Only someone signing up as ${email}`).waitFor();
  note("the link is shown once, with Copy, and who can use it (real: recorded by ARIA only)");
  await capture("invite-created-real");
  await created.getByRole("button", { name: "Done" }).click();
  await created.waitFor({ state: "hidden" });
  const openTable = visible(page.getByRole("table", { name: "Open invitations" }));
  const mine = openTable.getByRole("row").filter({ hasText: email });
  await mine.waitFor();
  await mine.getByText(/^By you · today/).waitFor();
  note("the open link is listed: sent to the email, by you today, Member, its expiry, Revoke");
  await shot("invitation-open-desktop-light");

  // The same dialog's picture, with the link answered as a placeholder.
  await rewrite("organization.createInvitation", (json) => {
    if (json === undefined) return null;
    made.push(json.invitation.id);
    json.path = "/join#<token>";
    json.token = "<token>";
    return null;
  });
  await button("Create invitation…").click();
  await create.waitFor();
  await create.getByRole("textbox", { name: /Email/ }).fill("someone@example.invalid");
  await create.getByRole("button", { name: "Create invitation link" }).click();
  await created.waitFor();
  await shot("invite-created-desktop-light");
  await created.getByRole("button", { name: "Done" }).click();
  await page.unroute("**/trpc/**");

  // --- Someone joins with it (real) --------------------------------------------------------------
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  const person = "Linus Verify";
  let memberId = null;
  try {
    await memberPage.goto(`${web}/join#${token}`);
    await memberPage.getByRole("heading", { name: /^Join / }).waitFor();
    await memberPage.getByRole("textbox", { name: "Name" }).fill(person);
    await memberPage.getByRole("textbox", { name: "Email" }).fill(email);
    for (const label of ["Password", "Confirm password"])
      await typeSecret(
        memberPage.getByLabel(label, { exact: true }),
        "member-password",
        "a-members-verify-password",
      );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome");
    memberId = (await apiOf(memberPage)("GET", "/api/organization")).body?.userId ?? null;
    note(`${person} joined with the link (${email})`);
    await toastSays(`${person} joined ${organization} with your invitation.`);
    const roster = visible(page.getByRole("table", { name: `${organization}'s members` }));
    await roster.getByText(person).waitFor();
    await roster.getByText("New", { exact: true }).waitFor();
    note("the owner's open page says who joined with their link, and lists them as New");
    await shot("member-joined-desktop-light");

    // --- Change a role, and undo it (real) ---------------------------------------------------------
    await visible(page.getByRole("combobox", { name: `${person}'s role` })).click();
    await visible(page.getByRole("option", { name: /^Owner/ })).click();
    await toastSays(`${person} is now an owner of ${organization}.`);
    note("a role change applies at once, with Undo in the toast");
    await shot("role-changed-desktop-light");
    await visible(
      page.getByRole("region", { name: /Notifications/ }).getByRole("button", { name: "Undo" }),
    ).click();
    await page.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[role="combobox"]')].some(
          (box) =>
            box.getAttribute("aria-label") === `${name}'s role` &&
            box.textContent?.includes("Member"),
        ),
      person,
    );
    note("Undo made them a member again");

    // The server's refusal, beside the row (rewritten: the last-owner words).
    const lastOwner =
      "An organization needs an owner. Make someone else an owner before this one steps down.";
    await refuse(
      "organization.setMemberRole",
      failure(lastOwner, -32022, 422, "OrganizationRejected"),
    );
    await visible(page.getByRole("combobox", { name: `${person}'s role` })).click();
    await visible(page.getByRole("option", { name: /^Owner/ })).click();
    await visible(page.getByRole("alert").getByText(lastOwner)).waitFor();
    note("a refused role change is said under the person's row, in the server's words (rewritten)");
    await shot("role-refused-desktop-light");
    await page.unroute("**/trpc/**");

    // --- A password reset link (real, then its picture) -----------------------------------------
    await button(`${person}, more`).click();
    await visible(page.getByRole("menuitem", { name: /^Create password reset link/ })).click();
    const panel = visible(page.getByRole("region", { name: `Password reset link for ${person}` }));
    await panel.waitFor();
    const resetLink = (await panel.locator("[data-slot=copy-field]").innerText())
      .split("\n")[0]
      .trim();
    registerSecret("reset-token", new URL(resetLink).hash.replace(/^#/, ""));
    note("a reset link for a member, shown once above the roster (real: recorded by ARIA only)");
    await capture("reset-link-real");
    await panel.getByRole("button", { name: "Close the reset link" }).click();
    await panel.waitFor({ state: "hidden" });
    await rewrite("organization.issuePasswordReset", (json) => {
      if (json !== undefined) json.path = "/reset#<token>";
      return null;
    });
    await button(`${person}, more`).click();
    await visible(page.getByRole("menuitem", { name: /^Create password reset link/ })).click();
    await panel.waitFor();
    await shot("reset-link-desktop-light");
    await panel.getByRole("button", { name: "Close the reset link" }).click();
    await page.unroute("**/trpc/**");
    await button("Your membership").click();
    await visible(page.getByText("Change your own password in Profile.")).waitFor();
    note("your own row offers no reset link, and says where to change your password");
    await page.keyboard.press("Escape");

    // --- Revoke a link (real) ---------------------------------------------------------------------
    const spare = await owner("POST", "/api/organization/invitations", { role: "member" });
    expect("a spare link", spare.status === 200, spare.status);
    registerSecret("spare-token", spare.body.token);
    await open("/settings/organization/members");
    await visible(
      page.getByRole("button", { name: "Revoke the invitation for Anyone with the link" }),
    ).click();
    await toastSays("Revoked the invitation for anyone with the link.");
    note("Revoke ends a link at once and says so");
    for (const id of made) await owner("DELETE", `/api/organization/invitations/${id}`);
    await open("/settings/organization/members");
    await visible(
      page.getByRole("button", { name: /^Show \d+ used, expired or revoked links?$/ }),
    ).click();
    await visible(
      page
        .getByRole("list", { name: "Used, expired and revoked links" })
        .getByText(/^Used by Linus Verify/),
    ).waitFor();
    note("used, expired and revoked links are behind the fold, each saying what became of it");
    await shot("closed-links-desktop-light");

    // --- That person's own view -------------------------------------------------------------------
    const ownerCookies = await page.context().cookies();
    await page.context().clearCookies();
    await page.context().addCookies(await second.cookies());
    await open("/settings/organization/members");
    await heading("Members");
    if ((await page.getByRole("button", { name: "Create invitation…" }).count()) !== 0)
      throw new Error("a member is offered Create invitation");
    if ((await page.getByRole("combobox").count()) !== 0)
      throw new Error("a member can change roles");
    note("as a member: the roster with roles as words, no invitations, no role menus");
    await shot("members-member-view-desktop-light");
    await page.context().clearCookies();
    await page.context().addCookies(ownerCookies);
    await open("/settings/organization/members");

    // --- Remove them (real) -----------------------------------------------------------------------
    await button(`${person}, more`).click();
    await visible(page.getByRole("menuitem", { name: `Remove from ${organization}…` })).click();
    const remove = dialog(`Remove ${person} from ${organization}?`);
    await remove.waitFor();
    await remove.getByText(`To add Linus again, create a new invitation.`).waitFor();
    note("Remove says what it does to their access and sessions first");
    await shot("remove-dialog-desktop-light");
    await remove.getByRole("button", { name: `Remove ${person}` }).click();
    await toastSays(`Removed ${person} from ${organization}`);
    memberId = null;
    await memberPage
      .waitForURL((url) => url.pathname === "/login", { timeout: 30_000 })
      .catch(() => {});
    note(
      `removed; their open browser went to ${new URL(memberPage.url()).pathname}${new URL(memberPage.url()).search}`,
    );
    await shot("member-removed-desktop-light");
  } finally {
    if (memberId !== null) await owner("DELETE", `/api/organization/members/${memberId}`);
    await second.close();
  }

  // --- A first read that fails ---------------------------------------------------------------------
  await rewrite("organization.members", () =>
    failure("The verify recipe failed this read on purpose.", -32603, 500, null),
  );
  await clearCache();
  await navigate("/settings/profile").catch(() => {});
  await navigate("/settings/organization/members");
  await heading("This page didn't load");
  note("the roster's read failing shows the error screen with Try again");
  await shot("members-error-desktop-light");
  await page.unroute("**/trpc/**");
  await button("Try again").click();
  await heading("Members");

  // --- Dark, and the phone -------------------------------------------------------------------------
  await paint("dark");
  await shot("members-desktop-dark");
  await paint("light");
  await page.setViewportSize(PHONE);
  await open("/settings/organization/members");
  await visible(page.getByRole("heading", { name: "Members" })).waitFor();
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`members-phone-${theme}`);
  }
  await paint("light");
  await button("Create invitation…").click();
  await dialog("Create invitation").waitFor();
  note("on a phone, Create invitation is a sheet");
  await shot("invite-sheet-phone-light");
  await page.keyboard.press("Escape");
};
