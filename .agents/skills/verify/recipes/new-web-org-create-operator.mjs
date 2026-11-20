// An operator creates an organization from the new web app on a server running several
// organizations with MEND_ORGANIZATION_CREATION at its default, `operator` (organization.md
// `org-create`, SLNT-1220). Nothing in the page is rewritten: the server says this operator may
// create one, the switcher offers "Create organization…", and the create makes them its owner.
// Settings → Server then names who may create, and the source items read as one business's.
//
//   pnpm verify drive new-web --box --recipe new-web-org-create-operator
//
// Needs a multi-tenant server whose signed-in account holds the operator role (on a check VM:
// `mend server setup --offline --tenancy multi`, as the checker). It creates one organization,
// named for the time it ran, and leaves it there.
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const visible = (locator) => locator.filter({ visible: true });

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
  const trpc = (path) =>
    page.evaluate(async (route) => {
      const response = await fetch(`/trpc/${route}`);
      return { status: response.status, body: await response.json() };
    }, path);
  const menuItem = (name) => visible(page.getByRole("menuitem", { name }));
  const menuNames = () =>
    visible(page.getByRole("menu"))
      .first()
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ""));
  const switcher = () =>
    visible(page.getByRole("button", { name: /, switch organization$/ })).first();
  const current = async () => {
    const answer = await trpc("organization.current");
    const view = answer.body?.result?.data?.json;
    if (answer.status !== 200 || view === undefined)
      throw new Error(`organization.current answered ${answer.status}`);
    return view;
  };

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-sidebar-expanded=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await open("/");

  // --- What the server says this operator may do -------------------------------------------
  const before = await current();
  note(
    `organization.current: tenancy ${before.tenancy}, operator ${before.operator}, organizationCreation ${before.organizationCreation}, canCreateOrganizations ${before.canCreateOrganizations}`,
  );
  if (before.tenancy !== "multi") throw new Error(`the server runs ${before.tenancy} tenancy`);
  if (before.operator !== true) throw new Error("the signed-in account is not an operator");
  if (before.organizationCreation !== "operator")
    throw new Error(`MEND_ORGANIZATION_CREATION reads ${before.organizationCreation}`);
  if (before.canCreateOrganizations !== true)
    throw new Error("the server does not let its operator create an organization");

  // --- The switcher offers it, and the create makes them its owner -------------------------
  await switcher().click();
  await menuItem("Create organization…").waitFor();
  note(`org-create: the operator's switcher reads ${(await menuNames()).join(" | ")}`);
  await both("operator-switcher-desktop");
  await menuItem("Create organization…").click();
  const dialog = visible(page.getByRole("dialog", { name: "Create organization" }));
  await dialog.waitFor();
  const name = `Operator check ${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`;
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await capture("operator-create-typed-light");
  await dialog.getByRole("button", { name: "Create organization" }).click();
  await page
    .getByRole("button", { name: `${name}, switch organization` })
    .first()
    .waitFor({ timeout: 30_000 });
  await hydrated();
  await settled();
  const after = await current();
  note(
    `org-create: created "${after.organization.name}": role ${after.role}, ${after.memberCount} member(s); this sign-in moved to it`,
  );
  if (after.organization.name !== name || after.role !== "owner")
    throw new Error(
      `after the create the sign-in is in ${after.organization.name} as ${after.role}`,
    );
  await both("operator-created-home-desktop");

  // --- Settings → Server names who may create, and the source items as one business's ------
  await open("/settings/server");
  const who = visible(
    page.getByText("Only an operator creates organizations, and owns each one they create."),
  );
  await who.first().waitFor({ timeout: 30_000 });
  note('Settings → Server: "Who may create one" reads Only operators');
  const gate = visible(page.getByText("Mend's git may reach private networks"));
  note(
    `Settings → Server: "Mend's git may reach private networks" shown ${await gate.count()} time(s)`,
  );
  await both("server-settings-organizations-desktop");

  // --- The phone: the same switcher, as a sheet from the Settings tab ----------------------
  await page.setViewportSize(PHONE);
  await open("/settings");
  await switcher().click();
  await visible(page.getByRole("menuitem", { name: "Create organization…" })).waitFor();
  note("org-create: the phone sheet offers Create organization… to the operator");
  await both("operator-switcher-phone");
  await page.keyboard.press("Escape");
};
