// Creating an organization and leaving one in the web app (apps/web, route PR 35, SLNT-1144):
// the organization switcher's "Create organization…" and "Leave <organization>…", their dialogs
// on the desk and their sheets on a phone.
//
//   pnpm verify drive web --recipe organizations
//
// Feature ids (organization.md):
// - `org-create`: a stack runs one organization (MEND_TENANCY=single), so `canCreateOrganizations`
//   is false and the switcher offers no "Create organization…", on the desk or the phone. With the
//   read rewritten in the page to say true, the item opens the dialog; an empty and a taken name
//   are said beside the field, and the server's own single-tenant refusal is the dialog's alert.
// - `org-leave`: with one organization there is no "Leave …" item. With the list rewritten to add
//   a second one, the stack's only owner gets "You can't leave yet"; with the roster rewritten to
//   make them a member, the dialog says what leaving does, and the server's own refusal of leaving
//   one's only organization is the dialog's alert.
// - The toasts after the reload that a create and a leave end with, from the note they leave in
//   the tab's storage.
// Creating for real, and leaving for real, need a multi-tenant server: the PR shows that run.
//
// On a multi-tenant server (a check VM copy, since mend#1916) the recipe reads the real
// `organization.current` first and says what it offers: an operator, or anyone where creation is
// open, is offered "Create organization…". It then rewrites the read to `canCreateOrganizations:
// false` (what a single-tenant server, or a person who may not create, reads) for the "neither"
// state, and answers the dialog's last create with the single-tenant server's own refusal in the
// page, so nothing is created. With other owners in the roster, the only-owner state rewrites
// the roster so the account is its only owner. Leaving is the server's own refusal either way:
// the account is in one organization.
//
// Every state is captured light and dark, on the desk at 1280px and on the phone at 390px. The
// recipe changes nothing on the server: every create and leave it sends is refused.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const OTHER = { id: "0b6d1c55-8f0e-4c55-9b55-5f0a1c2f1144", name: "Verify Labs" };
const visible = (locator) => locator.filter({ visible: true });

const tagged = (message, code, httpStatus, tag) => ({
  error: {
    json: { message, code, data: { code, httpStatus, path: "organizations.create", tag } },
  },
});
/** A create refused by name before it reaches the server: empty, or the name already taken. */
const nameRefusal = (name) =>
  name.trim() === ""
    ? tagged("An organization needs a name.", -32022, 422, "OrganizationNameEmpty")
    : name.trim().toLowerCase() === "taken"
      ? tagged(
          `There's already an organization called ${name.trim()}. Pick another name.`,
          -32009,
          409,
          "OrganizationNameTaken",
        )
      : null;
/** The single-tenant server's refusal of a create, as the web server's tRPC answers it. */
const SINGLE = "This Mend runs one organization (MEND_TENANCY=single).";
const singleRefusal = () => tagged(SINGLE, -32022, 422, "OrganizationRejected");
const inputOf = (request, index) => {
  const body = request.postDataJSON() ?? {};
  const entry = body[String(index)] ?? body;
  return entry?.json ?? entry;
};

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() => {
      const control = document.querySelector("[data-slot=sidebar] button, main button");
      return control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"));
    });
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await settled();
  };
  /**
   * The server renders who is signed in and the roster into the page, so rewritten answers only
   * arrive when the page reads them again: on focus once they are 5 seconds old (the app's stale
   * time), which this stands in for.
   */
  const readCurrentAgain = async () => {
    await page.waitForTimeout(5_500);
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes("/trpc/") &&
        decodeURIComponent(response.url()).includes("organization.current"),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await answered;
    await settled();
  };
  const menu = () => visible(page.getByRole("menu")).first();
  const menuItem = (name) => visible(page.getByRole("menuitem", { name }));
  const menuNames = () =>
    menu()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  const switcher = () =>
    visible(page.getByRole("button", { name: /, switch organization$/ })).first();
  const dialog = (name) => visible(page.getByRole("dialog", { name }));

  // --- What the rewritten answers say -------------------------------------------------------
  // `none`: the reads say nobody may create here. `singleCreate`: a create past the name checks
  // gets the single-tenant refusal in the page (set on a multi-tenant server, where it would
  // create). `onlyOwner`: other owners are made members, so the account is the only owner.
  const rewrite = {
    multi: false,
    member: false,
    none: false,
    singleCreate: false,
    onlyOwner: false,
  };
  let viewerId = null;
  await page.route("**/trpc/**", async (route) => {
    const request = route.request();
    const paths = decodeURIComponent(new URL(request.url()).pathname.replace(/^\/trpc\//, ""))
      .split(",")
      .filter((path) => path !== "");
    const watched = ["organization.current", "organizations.list", "organization.members"];
    const create = paths.indexOf("organizations.create");
    if (create !== -1) {
      const refusal = nameRefusal(String(inputOf(request, create)?.name ?? ""));
      const refused = refusal ?? (rewrite.singleCreate ? singleRefusal() : null);
      if (refused !== null) {
        const status = refused.error.json.data.httpStatus;
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify([refused]),
        });
        return;
      }
    }
    if (!(rewrite.multi || rewrite.none) || !paths.some((path) => watched.includes(path)))
      return route.continue();
    const response = await route.fetch();
    const answers = await response.json();
    const changed = paths.map((path, index) => {
      const answer = Array.isArray(answers) ? answers[index] : answers;
      const json = answer?.result?.data?.json;
      if (json === undefined) return answer;
      if (path === "organization.current") json.canCreateOrganizations = !rewrite.none;
      if (rewrite.none) return answer;
      if (path === "organizations.list" && !json.some((row) => row.organization.id === OTHER.id)) {
        const [first] = json;
        json.push({
          ...first,
          organization: { ...first.organization, ...OTHER },
          role: "owner",
          active: false,
        });
      }
      if (path === "organization.members" && rewrite.member)
        for (const member of json) member.role = "member";
      else if (path === "organization.members" && rewrite.onlyOwner)
        for (const member of json) member.role = member.userId === viewerId ? "owner" : "member";
      return answer;
    });
    await route.fulfill({
      response,
      body: JSON.stringify(Array.isArray(answers) ? changed : changed[0]),
    });
  });

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-sidebar-expanded=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await open("/");

  // --- What this server offers, as it is ---------------------------------------------------
  const readOf = async (path) =>
    page.evaluate(async (procedure) => {
      const response = await fetch(`/trpc/${procedure}`, { credentials: "include" });
      return (await response.json())?.result?.data?.json;
    }, path);
  const current = await readOf("organization.current");
  const memberships = await readOf("organizations.list");
  const roster = await readOf("organization.members");
  viewerId = current.userId;
  const organization = (await switcher().getAttribute("aria-label")).replace(
    /, switch organization$/,
    "",
  );
  const multi = current.tenancy === "multi";
  note(
    `this server: tenancy ${current.tenancy}, operator ${current.operator}, creation ${current.organizationCreation}, canCreateOrganizations ${current.canCreateOrganizations}, ${memberships.length} organization(s) for this account`,
  );
  if (memberships.length !== 1)
    throw new Error(`the account is in ${memberships.length} organizations; the recipe needs one`);
  await switcher().click();
  await menuItem(`${organization} settings`).waitFor();
  const real = await menuNames();
  const offersCreate = real.some((name) => name.startsWith("Create organization"));
  if (offersCreate !== current.canCreateOrganizations)
    throw new Error(
      `canCreateOrganizations is ${current.canCreateOrganizations}, and the switcher reads ${real.join(" | ")}`,
    );
  if (real.some((name) => name.startsWith("Leave ")))
    throw new Error("the switcher offers Leave with one organization");
  note(`org-create: as this server answers, the switcher reads ${real.join(" | ")}`);
  await page.keyboard.press("Escape");
  if (multi) rewrite.singleCreate = true;
  if (!current.canCreateOrganizations) {
    // Already what a server that lets nobody create says.
  } else {
    rewrite.none = true;
    await readCurrentAgain();
    note("org-create: the read rewritten in the page to canCreateOrganizations false");
  }

  // --- A server that lets nobody create offers neither --------------------------------------
  await switcher().click();
  await menuItem(`${organization} settings`).waitFor();
  const single = await menuNames();
  if (single.some((name) => name.startsWith("Create organization")))
    throw new Error("a single-tenant server offers Create organization…");
  if (single.some((name) => name.startsWith("Leave ")))
    throw new Error("the switcher offers Leave with one organization");
  note(`org-create: nobody may create, the switcher reads ${single.join(" | ")}`);
  await both("single-switcher-desktop");
  await page.keyboard.press("Escape");

  await page.setViewportSize(PHONE);
  await open("/settings");
  if (rewrite.none) await readCurrentAgain();
  await switcher().click();
  await visible(page.getByRole("dialog")).first().waitFor();
  const phoneSingle = await visible(page.getByRole("menuitem")).allTextContents();
  if (phoneSingle.some((name) => name.includes("Create organization") || name.startsWith("Leave ")))
    throw new Error(`the phone sheet offers ${phoneSingle.join(" | ")}`);
  note(`org-create: nobody may create, the phone sheet reads ${phoneSingle.join(" | ")}`);
  await both("single-switcher-phone");
  await page.keyboard.press("Escape");

  // --- As if multi-tenant, with a second organization ---------------------------------------
  rewrite.none = false;
  rewrite.multi = true;
  const otherOwners = roster.filter(
    (member) => member.role === "owner" && member.userId !== viewerId,
  );
  if (otherOwners.length > 0) {
    rewrite.onlyOwner = true;
    note(
      `the roster has ${otherOwners.length} other owner(s): rewritten in the page so the account is the only owner`,
    );
  }
  await page.setViewportSize(DESKTOP);
  await open("/");
  await readCurrentAgain();
  await switcher().click();
  await menuItem("Create organization…").waitFor();
  note(`with the reads rewritten, the switcher reads ${(await menuNames()).join(" | ")}`);
  await both("multi-switcher-desktop");
  await menuItem("Create organization…").click();
  const create = dialog("Create organization");
  await create.waitFor();
  await both("create-dialog-desktop");
  const name = create.getByRole("textbox", { name: "Name" });
  const submit = create.getByRole("button", { name: "Create organization" });
  await submit.click();
  await create.getByText("An organization needs a name.").waitFor();
  note("org-create: an empty name is said beside the field");
  await both("create-empty-desktop");
  await name.fill("Taken");
  await submit.click();
  await create
    .getByText("There's already an organization called Taken. Pick another name.")
    .waitFor();
  if (!(await submit.isDisabled())) throw new Error("Create stays on for the refused name");
  note("org-create: a taken name is said beside the field, and Create waits for a new name");
  await both("create-taken-desktop");
  await name.fill("Difference Engine");
  await submit.click();
  if (rewrite.singleCreate)
    note(
      "org-create: this server is multi-tenant, so the single-tenant refusal is answered in the page; nothing is created",
    );
  const alert = create.getByRole("alert").filter({ hasText: "The organization wasn't created." });
  await alert.waitFor();
  note(`org-create: the server's refusal is the dialog's alert: ${await alert.textContent()}`);
  await both("create-refused-desktop");
  await create.getByRole("button", { name: "Cancel" }).click();
  await create.waitFor({ state: "hidden" });

  // The stack's account is the organization's only owner.
  await switcher().click();
  await menuItem(`Leave ${organization}…`).click();
  const leave = dialog(`Leave ${organization}?`);
  await leave.getByText("You can't leave yet.").waitFor();
  if ((await leave.getByRole("button", { name: `Leave ${organization}` }).count()) !== 0)
    throw new Error("the only owner is offered Leave");
  note('org-leave: the only owner reads "You can\'t leave yet." with no Leave button');
  await both("leave-only-owner-desktop");
  await leave.getByRole("button", { name: "Close" }).first().click();
  await leave.waitFor({ state: "hidden" });
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  note(`focus after closing: ${focused}`);

  // As a member: the dialog says what leaving does; the server refuses the only organization.
  rewrite.member = true;
  await open("/");
  await readCurrentAgain();
  await switcher().click();
  await menuItem(`Leave ${organization}…`).click();
  await leave.getByText(`You'll go to ${OTHER.name}, your other organization.`).waitFor();
  note(`org-leave: ${(await leave.getByRole("listitem").allTextContents()).join(" | ")}`);
  await both("leave-member-desktop");
  await leave.getByRole("button", { name: `Leave ${organization}` }).click();
  const still = leave.getByRole("alert").filter({ hasText: `You're still in ${organization}.` });
  await still.waitFor();
  note(`org-leave: the server's refusal: ${await still.textContent()}`);
  await both("leave-refused-desktop");
  await leave.getByRole("button", { name: "Cancel" }).click();

  // --- The phone: the same, as sheets from the Settings tab --------------------------------
  rewrite.member = false;
  await page.setViewportSize(PHONE);
  await open("/settings");
  await readCurrentAgain();
  await switcher().click();
  await visible(page.getByRole("menuitem", { name: "Create organization…" })).waitFor();
  await both("multi-switcher-phone");
  await visible(page.getByRole("menuitem", { name: "Create organization…" })).click();
  const phoneCreate = dialog("Create organization");
  await phoneCreate.getByRole("textbox", { name: "Name" }).fill("Taken");
  await phoneCreate.getByRole("button", { name: "Create", exact: true }).click();
  await phoneCreate
    .getByText("There's already an organization called Taken.", { exact: false })
    .waitFor();
  await both("create-taken-phone");
  await phoneCreate.getByRole("button", { name: "Cancel" }).click();
  await phoneCreate.waitFor({ state: "hidden" });
  await switcher().click();
  await visible(page.getByRole("menuitem", { name: `Leave ${organization}…` })).click();
  await dialog(`Leave ${organization}?`).getByText("You can't leave yet.").waitFor();
  await both("leave-only-owner-phone");
  await page.keyboard.press("Escape");

  // --- What home says after the reload a create or a leave ends with ------------------------
  rewrite.multi = false;
  rewrite.onlyOwner = false;
  const arrive = async (stored, words, captured) => {
    await page.evaluate(
      (value) => sessionStorage.setItem("mend-switched-organization", value),
      JSON.stringify(stored),
    );
    await open("/");
    await visible(page.getByText(words)).waitFor();
    note(`toast: ${words}`);
    await both(captured);
  };
  await page.setViewportSize(DESKTOP);
  await arrive(
    { kind: "created", name: "Difference Engine" },
    "Created Difference Engine. You're its owner.",
    "created-toast-desktop",
  );
  await arrive(
    { kind: "left", left: "Northwind", now: organization },
    `You left Northwind. You're now in ${organization}.`,
    "left-toast-desktop",
  );
  await page.getByRole("button", { name: "Switch organization", exact: true }).click();
  await menu().waitFor();
  note("the toast's Switch organization opens the switcher");
  await page.keyboard.press("Escape");
  await page.setViewportSize(PHONE);
  await arrive(
    { kind: "created", name: "Difference Engine" },
    "Created Difference Engine. You're its owner.",
    "created-toast-phone",
  );
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
};
