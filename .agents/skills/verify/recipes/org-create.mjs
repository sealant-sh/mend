// Creating an organization from the web app's data layer (organization.md, `org-create`), on a
// stack, which runs MEND_TENANCY=single: the read says not to offer it, and the create is refused
// with the single-tenant sentence, by the API built from this commit. No screen offers it yet
// (route PR 35); the multi-tenant half runs against an API of its own (the PR's verdict).
//
//   pnpm verify drive web --recipe org-create
const names = (answer) =>
  (answer.body?.result?.data?.json ?? []).map((row) => row.organization.name).join(", ");

export default async ({ page, web, capture, note }) => {
  await page.goto(`${web}/`);
  await page.getByRole("heading", { name: "New session", exact: true }).waitFor();

  const trpc = (path, body) =>
    page.evaluate(
      async ({ path: route, input }) => {
        const response = await fetch(`/trpc/${route}`, {
          method: input === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(input === undefined ? {} : { body: JSON.stringify({ json: input }) }),
        });
        return { status: response.status, body: await response.json() };
      },
      { path, input: body },
    );

  const current = await trpc("organization.current");
  const view = current.body?.result?.data?.json;
  if (current.status !== 200 || view?.tenancy !== "single")
    throw new Error(`organization.current answered ${current.status}`);
  if (view.canCreateOrganizations !== false)
    throw new Error(`a single-tenant server offers creating: ${view.canCreateOrganizations}`);
  note(
    `organization.current: tenancy single, canCreateOrganizations ${view.canCreateOrganizations}`,
  );

  const before = await trpc("organizations.list");
  const created = await trpc("organizations.create", { name: "Difference Engine" });
  const refusal = created.body?.error?.json;
  if (created.status !== 422 || refusal?.data?.tag !== "OrganizationRejected")
    throw new Error(`organizations.create answered ${created.status} ${refusal?.data?.tag}`);
  note(`organizations.create "Difference Engine": ${created.status} ${refusal.data.tag}`);
  note(`  message: ${refusal.message}`);

  const after = await trpc("organizations.list");
  if (names(after) !== names(before))
    throw new Error(`the organizations changed: ${names(before)} → ${names(after)}`);
  note(`organizations.list before and after: ${names(after)}`);

  // Home again after a reload: still the one organization.
  await page.reload();
  await page.getByRole("heading", { name: "New session", exact: true }).waitFor();
  await capture("home-after-refused-create");
};
