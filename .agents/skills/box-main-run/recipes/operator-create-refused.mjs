// The second account's side of organization.new-web-operator-create (flows.md): on a server where
// only an operator creates organizations, an account that is not one is not offered Create
// organization…, and a create it sends anyway is refused. Mend's CLI has no command that creates an
// organization, so this reads it in the second account's browser, through the app's own procedures:
//
//   ~/.local/state/mend-main-run/lanes/<lane>/bin/web2 <out dir> \
//     .agents/skills/box-main-run/recipes/operator-create-refused.mjs
//
// It creates nothing: it fails when the create is not refused.
const REFUSAL =
  "On this Mend, only an operator creates organizations (MEND_ORGANIZATION_CREATION=operator). Ask one for an organization.";

export default async ({ page, web, capture, note }) => {
  await page.goto(`${web}/`);
  await page.waitForFunction(
    () => window["__TSR_ROUTER__"]?.options.context.trpcClient !== undefined,
    null,
    { timeout: 90_000 },
  );
  const seen = await page.evaluate(
    async (name) => {
      const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
      const current = await trpc.organization.current.query();
      const create = await trpc.organizations.create
        .mutate({ name })
        .then((created) => ({ created }))
        .catch((error) => ({ refused: error.message }));
      return {
        operator: current.operator,
        organizationCreation: current.organizationCreation,
        canCreateOrganizations: current.canCreateOrganizations,
        create,
      };
    },
    `Refused member check ${Date.now().toString(36)}`,
  );
  note(
    `organization.current: operator ${seen.operator}, organizationCreation ${seen.organizationCreation}, canCreateOrganizations ${seen.canCreateOrganizations}`,
  );
  if (seen.operator !== false) throw new Error("the second account is an operator");
  if (seen.canCreateOrganizations !== false)
    throw new Error("the server lets the second account create an organization");
  if (seen.create.refused !== REFUSAL)
    throw new Error(`the create was not refused as expected: ${JSON.stringify(seen.create)}`);
  note(`organizations.create refused: ${seen.create.refused}`);

  const switcher = page.getByRole("button", { name: /, switch organization$/ }).first();
  if ((await switcher.count()) > 0) {
    await switcher.click();
    const menu = page.getByRole("menu").first();
    await menu.waitFor();
    const items = await menu
      .locator('[role="menuitem"], [role="menuitemradio"]')
      .evaluateAll((all) => all.map((item) => item.textContent?.trim() ?? ""));
    if (items.includes("Create organization…"))
      throw new Error(
        `the second account's switcher offers Create organization…: ${items.join(" | ")}`,
      );
    note(`the second account's switcher reads ${items.join(" | ")}, with no Create organization…`);
    await capture("member-switcher");
    await page.keyboard.press("Escape");
  } else {
    note("the second account's sidebar has no organization switcher, so no Create organization…");
    await capture("member-no-switcher");
  }
};
