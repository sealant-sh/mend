// Settings → the organization → Projects in the web app (SLNT-1164; the owner's ruling of 18 Nov
// 2026): projects whose creator left, with Take over…, and the resource volumes kept from removed
// projects, which have no actions. Owners only.
//
//   pnpm verify drive web --recipe settings-org-projects
//
// Real on the stack: the empty page; a member who joins, sees no Projects entry and is sent to
// Profile by address; the project that member creates, left without a creator when the owner
// removes them; the owner taking it over (the confirmation, the toast, the row gone, the project
// now the owner's). Recorded answers (tRPC answers the recipe writes): kept volumes, since a stack
// has no removed project with resources, a take-over the server refuses, and a read that fails.
// The recipe removes the member and the project it made.
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
  if (!ok) throw new Error(`${what}: saw ${String(JSON.stringify(seen)).slice(0, 400)}`);
};

const DAY = 86_400_000;

/** A recorded `organization.resourceArchives`, as the frame draws it. */
const archives = (now) => {
  const at = (days) => new Date(now - days * DAY).toISOString();
  const rows = [
    {
      organizationId: "org",
      projectId: "p-fax",
      projectName: "fax-gateway",
      createdByUserId: null,
      archivedAt: at(17),
      volumes: [
        {
          instanceKey: "db",
          resourceName: "db",
          name: "pgdata",
          dockerName: "mend-fax-gateway-db-pgdata",
          bytes: 1_200_000_000,
        },
        {
          instanceKey: "redis",
          resourceName: "redis",
          name: "data",
          dockerName: "mend-fax-gateway-redis-data",
          bytes: 48_000_000,
        },
      ],
    },
    {
      organizationId: "org",
      projectId: "p-invoice",
      projectName: "invoice-renderer",
      createdByUserId: null,
      archivedAt: at(71),
      volumes: [
        {
          instanceKey: "minio",
          resourceName: "minio",
          name: "objects",
          dockerName: "mend-invoice-renderer-minio-objects",
          bytes: null,
        },
      ],
    },
    {
      organizationId: "org",
      projectId: "p-search",
      projectName: "search-spike",
      createdByUserId: null,
      archivedAt: at(29),
      volumes: [],
    },
  ];
  return {
    json: rows,
    meta: { values: Object.fromEntries(rows.map((_, i) => [`${i}.archivedAt`, ["Date"]])) },
  };
};

export default async ({ page, web, capture, note, typeSecret, registerSecret }) => {
  const now = Date.now();
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
  /** Open the page again through the router, so recorded answers reach it. */
  const reopen = async () => {
    await clearCache();
    await navigate("/settings/profile");
    await heading("Profile");
    await navigate("/settings/organization/projects");
  };
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
  const toast = (text) =>
    visible(page.getByRole("region", { name: /Notifications/ }).getByText(text)).waitFor();
  const dialog = visible(page.getByRole("dialog"));
  const owner = apiOf(page);

  // tRPC answers this recipe writes, by procedure: `{ json, meta }` or `{ error }`.
  const stubs = new Map();
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.replace(/^\/trpc\//, ""),
    )
      .split(",")
      .filter((p) => p !== "");
    if (!paths.some((p) => stubs.has(p))) return route.continue();
    const real = paths.every((p) => stubs.has(p)) ? null : await route.fetch();
    const list = real === null ? [] : await real.json();
    const answers = Array.isArray(list) ? list : [list];
    let status = 200;
    const out = paths.map((p, index) => {
      const stub = stubs.get(p);
      if (stub === undefined) return answers[index];
      if (stub.error !== undefined) {
        status = paths.length === 1 ? 500 : 207;
        return {
          error: {
            json: {
              message: stub.error,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500 },
            },
          },
        };
      }
      return { result: { data: stub.meta === undefined ? { json: stub.json } : stub } };
    });
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(route.request().url().includes("batch=1") ? out : out[0]),
    });
  });

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(DESKTOP);
  await open("/settings/profile");
  const me = await owner("GET", "/api/organization");
  expect("the owner", me.status === 200 && me.body.role === "owner", me);
  const organization = me.body.organization.name;

  // --- As the stack has it: nothing here --------------------------------------------------------
  const before = await owner("GET", "/api/organization/orphaned-projects");
  expect("orphaned projects", before.status === 200, before);
  await navigate("/settings/organization/projects");
  await heading("Projects");
  await visible(page.getByText(`Owners of ${organization}`, { exact: true })).waitFor();
  const entries = await page
    .locator('[data-slot="sidebar"][aria-label="Settings"]')
    .first()
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
  expect(
    "the owner's sidebar lists Projects right before Audit log",
    entries.indexOf("Projects") !== -1 &&
      entries.indexOf("Projects") + 1 === entries.indexOf("Audit log"),
    entries,
  );
  if (before.body.length === 0) {
    await visible(page.getByText(/^No projects without a creator\./)).waitFor();
    await visible(page.getByText(/^No kept resources\./)).waitFor();
    note("as the stack is: no project without a creator, no kept resources; both say so");
    await shot("projects-empty-desktop-light");
  } else {
    note(`the stack already has ${before.body.length} projects without a creator`);
  }

  // --- A member joins, makes a project, and is removed ------------------------------------------
  const invitation = await owner("POST", "/api/organization/invitations", { role: "member" });
  expect("an invitation for the member", invitation.status === 200, invitation.status);
  registerSecret("invitation-token", invitation.body.token);
  const second = await page.context().browser().newContext();
  const memberPage = await second.newPage();
  const name = `left-behind-${String(now).slice(-6)}`;
  let memberId = null;
  let projectId = null;
  try {
    await memberPage.goto(`${web}/join#${invitation.body.token}`);
    await memberPage.getByRole("heading", { name: /^Join / }).waitFor({ timeout: 90_000 });
    await memberPage.getByRole("textbox", { name: "Name" }).fill("Dorothy Verify");
    await memberPage
      .getByRole("textbox", { name: "Email" })
      .fill(`verify-projects-${now}@example.invalid`);
    for (const label of ["Password", "Confirm password"])
      await typeSecret(
        memberPage.getByLabel(label, { exact: true }),
        "member-password",
        "a-projects-verify-password",
      );
    await memberPage.getByRole("button", { name: "Create account and join", exact: true }).click();
    await memberPage.waitForURL((url) => url.pathname === "/welcome/command-line", {
      timeout: 90_000,
    });
    const member = apiOf(memberPage);
    memberId = (await member("GET", "/api/organization")).body?.userId ?? null;
    const made = await member("POST", "/api/projects/new", { name });
    expect("the member's project", made.status === 200, made);
    projectId = made.body.id;
    note(`a member joined and created the private project ${name}`);

    // The member's own view: no Projects entry, and its address goes to Profile.
    await memberPage.goto(`${web}/settings/organization/projects`);
    await memberPage.waitForURL((url) => url.pathname === "/settings/profile", {
      timeout: 90_000,
    });
    const theirs = await memberPage
      .locator('[data-slot="sidebar"][aria-label="Settings"]')
      .first()
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.textContent?.trim() ?? ""));
    expect("a member's sidebar has no Projects", !theirs.includes("Projects"), theirs);
    const refused = await member("GET", "/api/organization/orphaned-projects");
    expect("the server answers a member 404", refused.status === 404, refused.status);
    note("a member: no Projects in the sidebar; its address goes to Profile; the API answers 404");
  } finally {
    if (memberId !== null) {
      const removed = await owner("DELETE", `/api/organization/members/${memberId}`);
      note(`the owner removed the member: ${removed.status}`);
    }
    await second.close();
  }

  // --- The project is without a creator; the owner takes it over --------------------------------
  try {
    await reopen();
    await heading("Projects");
    const row = visible(
      page.getByRole("table", { name: "Projects without a creator" }).getByRole("row", { name }),
    );
    await row.waitFor();
    await row.getByText("Private. Only its creator could open it.").waitFor();
    note(`${name} is listed without a creator, private, with Take over…`);
    await shot("projects-orphan-desktop-light");
    await paint("dark");
    await shot("projects-orphan-desktop-dark");
    await paint("light");

    await row.getByRole("button", { name: `Take over ${name}…` }).click();
    await heading(`Take over ${name}?`);
    await dialog
      .getByText(
        `${name} stays private, so only you can open it until you share it with ${organization}.`,
      )
      .waitFor();
    await shot("projects-take-over-dialog-desktop-light");
    stubs.set("organization.takeOverProject", {
      error: "Only an owner of the organization can take over a project.",
    });
    await dialog.getByRole("button", { name: "Take over", exact: true }).click();
    await dialog.getByText(/^Mend didn't take it over\. Only an owner/).waitFor();
    note("a refused take-over (recorded) is said in the dialog, which stays open");
    stubs.delete("organization.takeOverProject");
    await dialog.getByRole("button", { name: "Take over", exact: true }).click();
    await toast(`You're now the creator of ${name}. It's in your projects.`);
    await row.waitFor({ state: "detached" });
    const listed = await owner("GET", "/api/projects");
    const taken = (listed.body ?? []).find((project) => project.id === projectId);
    expect(
      "the project is the owner's now",
      taken?.createdByUserId === me.body.userId,
      taken ?? listed.status,
    );
    note(`take over (real): the toast, the row gone, and ${name}'s creator is the owner now`);
    await shot("projects-taken-over-desktop-light");
  } finally {
    if (projectId !== null) {
      const removed = await owner("DELETE", `/api/projects/${projectId}`);
      note(`removed ${name} again: ${removed.status}`);
    }
  }

  // --- Kept resources (recorded) ----------------------------------------------------------------
  stubs.set("organization.resourceArchives", archives(now));
  await reopen();
  await visible(page.getByText("mend-fax-gateway-db-pgdata")).waitFor();
  await visible(page.getByText("1.2 GB")).waitFor();
  await visible(page.getByText("Not measured")).waitFor();
  await visible(page.getByText("No volumes declared")).waitFor();
  expect(
    "kept resources have no actions",
    (await page.getByRole("table", { name: "Kept resources" }).getByRole("button").count()) === 0,
    "a button",
  );
  note(
    "kept resources (recorded): a row per volume with its Docker name, when, and size; none has an action",
  );
  await shot("projects-kept-desktop-light");

  // --- A read that fails ------------------------------------------------------------------------
  stubs.set("organization.orphanedProjects", {
    error: "The verify recipe failed this read on purpose.",
  });
  await reopen();
  await heading("This page didn't load");
  note("a read that fails shows the error screen with Try again");
  await shot("projects-error-desktop-light");
  stubs.delete("organization.orphanedProjects");
  await visible(page.getByRole("button", { name: "Try again" })).click();
  await heading("Projects");

  // --- Phone ------------------------------------------------------------------------------------
  stubs.set("organization.orphanedProjects", {
    json: [
      {
        ...(await owner("GET", "/api/projects")).body[0],
        id: "p-billing",
        name: "billing-dashboard",
        visibility: "private",
        createdByUserId: "gone",
      },
    ],
    meta: { values: { "0.createdAt": ["Date"], "0.updatedAt": ["Date"] } },
  });
  await page.setViewportSize(PHONE);
  await open("/settings/profile");
  await reopen();
  await visible(page.getByText("billing-dashboard")).waitFor();
  const take = visible(page.getByRole("button", { name: "Take over billing-dashboard…" }));
  const height = (await take.boundingBox())?.height ?? 0;
  if (height < 44) throw new Error(`Take over… is ${height}px tall on a phone, under 44px`);
  for (const theme of ["light", "dark"]) {
    await paint(theme);
    await shot(`phone-projects-${theme}`);
  }
  await paint("light");
  await take.click();
  await visible(page.getByText("Take over billing-dashboard?", { exact: true })).waitFor();
  await shot("phone-projects-take-over-sheet-light");
  await page.keyboard.press("Escape");
  note("phone (recorded lists): rows with their facts under the name, 44px Take over…, a sheet");
  stubs.clear();
  await page.setViewportSize(DESKTOP);
};
